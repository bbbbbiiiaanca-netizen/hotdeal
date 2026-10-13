// make-post.mjs로 만든 포스트를 텔레그램 채널(@hotdeal_oide)에 올리는 스크립트 (Node 18+, 외부 패키지 없음)
// 사용법: TELEGRAM_BOT_TOKEN=... node scripts/post-telegram.mjs --mode morning|evening [--file deals.json] [--dry-run]
// --dry-run은 메시지만 출력합니다(토큰 불필요, 네트워크 호출 없음).
// 토큰은 절대 코드/깃/로그에 남기지 말고 환경변수(또는 GitHub Actions Secrets)로만 넘기세요.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPost, parseArgs, loadData } from './make-post.mjs';

export const CHAT_ID = '@hotdeal_oide';
const TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_STATE_FILE = path.join(ROOT, 'state', 'posted.json');

export const isValidToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);

// 에러 메시지에서 토큰과 봇 API 경로를 지움
export function sanitize(text, token) {
  let s = String(text ?? '');
  if (token) s = s.split(token).join('[REDACTED]');
  return s.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]').replace(/\d{5,}:[A-Za-z0-9_-]{30,}/g, '[REDACTED]');
}

// KST 기준 YYYY-MM-DD
export function kstDate(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export const isDuplicate = (entries, date, mode) => entries.some((e) => e.date === date && e.mode === mode);
export const addEntry = (entries, date, mode, message_id) => [...entries, { date, mode, message_id }];

export async function readState(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`상태 파일을 읽을 수 없습니다(${file}): ${e.message}`);
  }
}

export async function writeState(file, entries) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(entries, null, 2) + '\n');
}

export async function sendMessage(token, text, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      disable_web_page_preview: true,
      link_preview_options: { is_disabled: true },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(`Telegram ${res.status}: ${json.description || 'unknown error'}`);
  return json.result.message_id;
}

// 실패하면 delayMs 뒤 한 번 더 시도
export async function withRetry(fn, { delayMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onRetry } = {}) {
  try {
    return await fn();
  } catch (e) {
    onRetry?.(e);
    await sleep(delayMs);
    return await fn();
  }
}

async function main() {
  const { mode, file, dryRun } = parseArgs(process.argv.slice(2));
  const message = buildPost(await loadData(file), { mode });
  if (dryRun) {
    console.log(message);
    return;
  }

  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!isValidToken(token)) throw new Error('TELEGRAM_BOT_TOKEN 환경변수가 없거나 형식이 올바르지 않습니다.');

  const stateFile = process.env.STATE_FILE || DEFAULT_STATE_FILE;
  const date = kstDate();
  const entries = await readState(stateFile);
  if (isDuplicate(entries, date, mode)) {
    console.log(`이미 올린 포스트입니다 (${date} ${mode}). 건너뜁니다.`);
    return;
  }

  try {
    const messageId = await withRetry(() => sendMessage(token, message), {
      onRetry: (e) => console.error(`전송 실패, 3초 뒤 다시 시도합니다: ${sanitize(e.message, token)}`),
    });
    await writeState(stateFile, addEntry(entries, date, mode, messageId));
    console.log(`전송 완료 (${date} ${mode}, message_id ${messageId})`);
  } catch (e) {
    throw new Error(sanitize(e.message, token));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(sanitize(e.message, (process.env.TELEGRAM_BOT_TOKEN || '').trim()));
    process.exit(1);
  });
}
