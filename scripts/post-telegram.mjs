// make-post.mjs로 만든 포스트를 텔레그램 채널(@hotdeal_oide)에 올리는 스크립트 (Node 18+, 외부 패키지 없음)
// 사용법: TELEGRAM_BOT_TOKEN=... node scripts/post-telegram.mjs --mode morning|evening [--file deals.json] [--dry-run]
// --dry-run은 메시지만 출력합니다(토큰 불필요, 네트워크 호출 없음).
// 토큰은 절대 코드/깃/로그에 남기지 말고 환경변수(또는 GitHub Actions Secrets)로만 넘기세요.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPost, formatParts, parseArgs, loadData } from './make-post.mjs';

export const CHAT_ID = '@hotdeal_oide';
const TOKEN_RE = /\d+:[A-Za-z0-9_-]{30,}/;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_STATE_FILE = path.join(ROOT, 'state', 'posted.json');

// 환경변수 값에 공백이나 다른 글자가 섞여 있어도 첫 번째 토큰 형태만 뽑아냄 (없으면 null)
export const extractToken = (v) => (typeof v === 'string' ? v.match(TOKEN_RE)?.[0] ?? null : null);
export const isValidToken = (t) => extractToken(t) === t;

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

// 기록: { date, mode, parts, message_ids }. 조각을 하나 보낼 때마다 저장해서, 중간에 실패해도 보낸 조각은 다시 보내지 않음.
// (예전 형식 { date, mode, message_id }는 다 보낸 것으로 봄)
export const findEntry = (entries, date, mode) => entries.find((e) => e.date === date && e.mode === mode);
export const sentIds = (entry) => entry?.message_ids ?? (entry?.message_id != null ? [entry.message_id] : []);
export const isDuplicate = (entries, date, mode) => {
  const e = findEntry(entries, date, mode);
  return !!e && (e.message_ids ? e.message_ids.length >= e.parts : true);
};
export const upsertEntry = (entries, date, mode, parts, message_ids) => [
  ...entries.filter((e) => !(e.date === date && e.mode === mode)),
  { date, mode, parts, message_ids },
];

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

// 아직 안 보낸 조각만 순서대로 보냄. 조각마다 한 번씩 재시도하고, 성공할 때마다 onSent(지금까지의 id 목록) 호출.
export async function sendParts(parts, { alreadySent = [], send, onSent, retry } = {}) {
  const ids = [...alreadySent];
  for (let i = ids.length; i < parts.length; i++) {
    ids.push(await withRetry(() => send(parts[i]), retry?.(i)));
    await onSent?.([...ids]);
  }
  return ids;
}

async function main() {
  const { mode, file, dryRun } = parseArgs(process.argv.slice(2));
  const parts = buildPost(await loadData(file), { mode });
  if (dryRun) {
    console.log(formatParts(parts));
    return;
  }

  const token = extractToken(process.env.TELEGRAM_BOT_TOKEN);
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN 환경변수가 없거나 형식이 올바르지 않습니다.');

  const stateFile = process.env.STATE_FILE || DEFAULT_STATE_FILE;
  const date = kstDate();
  let entries = await readState(stateFile);
  if (isDuplicate(entries, date, mode)) {
    console.log(`이미 올린 포스트입니다 (${date} ${mode}). 건너뜁니다.`);
    return;
  }
  const alreadySent = sentIds(findEntry(entries, date, mode));
  if (alreadySent.length) console.log(`이전에 보낸 ${alreadySent.length}/${parts.length}개 조각은 건너뜁니다.`);

  try {
    const ids = await sendParts(parts, {
      alreadySent,
      send: (text) => sendMessage(token, text),
      onSent: async (ids) => {
        entries = upsertEntry(entries, date, mode, parts.length, ids);
        await writeState(stateFile, entries);
      },
      retry: (i) => ({
        onRetry: (e) => console.error(`조각 ${i + 1}/${parts.length} 전송 실패, 3초 뒤 다시 시도합니다: ${sanitize(e.message, token)}`),
      }),
    });
    console.log(`전송 완료 (${date} ${mode}, ${parts.length}개 조각, message_id ${ids.join(', ')})`);
  } catch (e) {
    throw new Error(sanitize(e.message, token));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(sanitize(e.message, extractToken(process.env.TELEGRAM_BOT_TOKEN)));
    process.exit(1);
  });
}
