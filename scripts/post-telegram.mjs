// make-post.mjs로 만든 포스트를 텔레그램 채널(@hotdeal_oide)에 올리는 스크립트 (Node 18+, 외부 패키지 없음)
// 사용법: TELEGRAM_BOT_TOKEN=... node scripts/post-telegram.mjs --slot 1|2|3|4 [--file deals.json] [--dry-run] [--force-uncertain]
// --dry-run은 메시지만 출력합니다(토큰 불필요, 네트워크 호출 없음).
// --force-uncertain은 전송 결과가 불확실(uncertain)한 조각을 다시 보냅니다. 채널에서 안 올라간 걸 직접 확인한 뒤에만 쓰세요.
// 토큰은 절대 코드/깃/로그에 남기지 말고 환경변수(또는 GitHub Actions Secrets)로만 넘기세요.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildPost, formatParts, parseArgs, loadData, emptySlotMessage, rankingSnapshot, slotItems } from './make-post.mjs';

export const CHAT_ID = '@hotdeal_oide';
const TOKEN_RE = /\d+:[A-Za-z0-9_-]{30,}/;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_STATE_FILE = path.join(ROOT, 'state', 'posted.json');
export const LOCK_STALE_MS = 10 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 30 * 1000;
export const RETRY_DELAY_MS = 3000;

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

export const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// ---------- 상태 파일 ----------
// 기록: { date, slot, ids, parts: [{ index, text, hash, status, message_id? }] } — 같은 날(KST) 같은 slot은 한 번만
// 하루 순위: { date, updatedAt, ranking: [상품…] } — 그날(KST) 첫 slot 실행 때 저장하고, 이후 slot은 이걸로 만듦.
// 다른 slot 기록의 ids(그 slot에 넣은 상품 id)는 빼고 만듦.
// status: pending(아직 안 보냄) → sending(보내는 중) → sent | uncertain(보냈는지 알 수 없음)
// 처음 실행할 때 모든 조각의 글과 해시를 저장(스냅샷)하고, 다시 돌리면 deals.json이 바뀌었어도 스냅샷을 보냄.
// slot 없는 예전(morning/evening) 기록은 무시함.
export const findEntry = (entries, date, slot) =>
  entries.find((e) => e.date === date && e.slot === slot && Array.isArray(e.parts));
export const sentIds = (entry) => entry.parts.filter((p) => p.status === 'sent').map((p) => p.message_id);
export const isDuplicate = (entries, date, slot) => {
  const e = findEntry(entries, date, slot);
  return !!e && e.parts.every((p) => p.status === 'sent');
};
export const upsertEntry = (entries, entry) => [
  ...entries.filter((e) => !(e.date === entry.date && e.slot === entry.slot)),
  entry,
];

export function snapshotEntry(date, slot, texts, ids) {
  return {
    date,
    slot,
    ...(ids && { ids }),
    parts: texts.map((text, index) => ({ index, text, hash: sha256(text), status: 'pending' })),
  };
}

export const findRanking = (entries, date) => entries.find((e) => e.date === date && Array.isArray(e.ranking));
export const upsertRanking = (entries, date, data) => [
  ...entries.filter((e) => !(e.date === date && Array.isArray(e.ranking))),
  { date, updatedAt: data?.updatedAt, ranking: rankingSnapshot(data?.deals) },
];
// 같은 날 다른 slot에 이미 넣은 상품 id
export const postedIds = (entries, date, slot) =>
  entries.filter((e) => e.date === date && e.slot !== slot && Array.isArray(e.ids)).flatMap((e) => e.ids);

// 저장된 하루 순위(없으면 deals.json으로 새로 만든 순위)로 slot의 상품과 글을 만듦
export function buildSlot(entries, date, slot, data) {
  const day = findRanking(entries, date) ?? { updatedAt: data?.updatedAt, ranking: rankingSnapshot(data?.deals) };
  const exclude = postedIds(entries, date, slot);
  const texts = buildPost({ updatedAt: day.updatedAt }, { slot, ranking: day.ranking, exclude });
  return { texts, ids: texts.length ? slotItems(day.ranking, slot, exclude).map((d) => d.id) : [] };
}

export async function readState(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`상태 파일을 읽을 수 없습니다(${file}): ${e.message}`);
  }
}

// 임시 파일에 쓰고 rename (중간에 죽어도 상태 파일이 반쯤 쓰인 채로 남지 않음)
export async function writeState(file, entries) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(entries, null, 2) + '\n');
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

// ---------- 잠금 ----------
// state/post.lock을 'wx'로 만들어 동시 실행을 막음. 10분 넘은 잠금은 죽은 실행이 남긴 것으로 보고 지움.
export async function acquireLock(lockFile, { now = () => Date.now(), staleMs = LOCK_STALE_MS } = {}) {
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const info = JSON.stringify({ pid: process.pid, timestamp: new Date(now()).toISOString() });
    let fh;
    try {
      fh = await fs.open(lockFile, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let ts = NaN;
      try {
        ts = Date.parse(JSON.parse(await fs.readFile(lockFile, 'utf8')).timestamp);
      } catch {
        // 내용을 못 읽으면 파일 수정 시각으로 판단
        ts = (await fs.stat(lockFile).catch(() => null))?.mtimeMs ?? NaN;
      }
      if (attempt === 0 && Number.isFinite(ts) && now() - ts > staleMs) {
        await fs.rm(lockFile, { force: true });
        continue;
      }
      throw new Error(`다른 전송이 실행 중입니다(잠금 파일 ${lockFile}). 10분이 지나도 남아 있으면 자동으로 풀립니다.`);
    }
    try {
      await fh.writeFile(info);
    } finally {
      await fh.close();
    }
    return async () => {
      // 내가 만든 잠금일 때만 지움
      const cur = await fs.readFile(lockFile, 'utf8').catch(() => null);
      if (cur === info) await fs.rm(lockFile, { force: true });
    };
  }
  throw new Error(`잠금을 얻지 못했습니다(${lockFile}).`);
}

// ---------- 전송 ----------
// kind: 'pre-delivery' = 메시지가 안 올라간 게 확실(한 번 재시도 가능)
//       'ambiguous'    = 올라갔는지 알 수 없음(재시도 금지)
export class SendError extends Error {
  constructor(message, kind, { retryAfterMs } = {}) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

// 연결 자체가 안 된 네트워크 에러 (요청이 서버에 닿지 않음)
const PRE_CONNECT_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'UND_ERR_CONNECT_TIMEOUT',
]);
export function classifyFetchError(e) {
  const code = e?.cause?.code ?? e?.code;
  if (PRE_CONNECT_CODES.has(code)) return new SendError(`네트워크 연결 실패(${code})`, 'pre-delivery');
  const what = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? '응답 시간 초과' : `네트워크 에러(${code || e?.message || 'unknown'})`;
  return new SendError(`${what}: 요청은 보냈지만 응답을 못 받았습니다`, 'ambiguous');
}

export async function sendMessage(token, text, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        disable_web_page_preview: true,
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw classifyFetchError(e);
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new SendError(`Telegram ${res.status}: 응답을 읽을 수 없습니다`, 'ambiguous');
  }
  if (json?.ok === true && json.result?.message_id != null) return json.result.message_id;
  if (json?.ok === false) {
    // 텔레그램이 ok:false로 거절했다 = 메시지는 안 올라감
    const retryAfter = json.parameters?.retry_after;
    throw new SendError(`Telegram ${res.status}: ${json.description || 'unknown error'}`, 'pre-delivery', {
      retryAfterMs: Number.isFinite(retryAfter) ? Math.min(retryAfter, 60) * 1000 : undefined,
    });
  }
  throw new SendError(`Telegram ${res.status}: 예상하지 못한 응답`, 'ambiguous');
}

export class UncertainError extends Error {}

export const uncertainHelp = (entry, stateFile) => {
  const list = entry.parts
    .filter((p) => p.status === 'uncertain')
    .map((p) => `  - 조각 ${p.index + 1}/${entry.parts.length} (sha256 ${p.hash.slice(0, 12)}…, 첫 줄: ${p.text.split('\n')[0]})`)
    .join('\n');
  return [
    `전송 결과를 알 수 없는 조각이 있어 멈춥니다 (${entry.date} slot ${entry.slot}).`,
    list,
    `채널 ${CHAT_ID}에서 이 조각이 올라갔는지 직접 확인하세요.`,
    `  - 올라갔으면: ${stateFile}에서 해당 조각의 status를 "sent"로 바꾼 뒤 다시 실행`,
    `  - 안 올라갔으면: --force-uncertain을 붙여 다시 실행`,
  ].join('\n');
};

// 스냅샷의 조각을 순서대로 보냄. 보내기 직전 status를 sending으로 저장하고,
// 안 올라간 게 확실한 실패만 한 번 재시도. 불확실하면 uncertain으로 저장하고 멈춤.
export async function sendParts(entry, { send, persist, forceUncertain = false, delayMs = RETRY_DELAY_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const n = entry.parts.length;
  const save = () => persist(entry);
  // 전에 sending에서 멈춘 조각(프로세스가 죽음)도 불확실로 봄
  let changed = false;
  for (const p of entry.parts) {
    if (p.status === 'sending') { p.status = 'uncertain'; changed = true; }
  }
  if (changed) await save();
  if (!forceUncertain && entry.parts.some((p) => p.status === 'uncertain')) throw new UncertainError('uncertain');

  for (const p of entry.parts) {
    if (p.status === 'sent') continue;
    if (sha256(p.text) !== p.hash) throw new Error(`조각 ${p.index + 1}/${n}의 내용이 저장된 해시와 다릅니다. 상태 파일을 확인하세요.`);
    if (p.status === 'uncertain') log(`조각 ${p.index + 1}/${n}: --force-uncertain으로 다시 보냅니다.`);
    p.status = 'sending';
    delete p.error;
    await save();
    for (let attempt = 1; ; attempt++) {
      try {
        p.message_id = await send(p.text);
        p.status = 'sent';
        await save();
        break;
      } catch (e) {
        const kind = e instanceof SendError ? e.kind : 'ambiguous';
        if (kind === 'pre-delivery' && attempt === 1) {
          const wait = e.retryAfterMs ?? delayMs;
          log(`조각 ${p.index + 1}/${n} 전송 실패(안 올라감), ${Math.round(wait / 1000)}초 뒤 한 번 더 시도합니다: ${e.message}`);
          await sleep(wait);
          continue;
        }
        p.status = kind === 'pre-delivery' ? 'pending' : 'uncertain';
        p.error = e.message;
        await save();
        if (kind !== 'pre-delivery') throw new UncertainError(e.message);
        throw e;
      }
    }
  }
  return entry.parts.map((p) => p.message_id);
}

// ---------- 실행 ----------
export function parsePostArgs(argv) {
  const forceUncertain = argv.includes('--force-uncertain');
  return { ...parseArgs(argv.filter((a) => a !== '--force-uncertain')), forceUncertain };
}

export async function run({ argv = [], env = {}, fetchImpl = fetch, now = () => new Date(), sleep, log = console.log, warn = console.error } = {}) {
  const { slot, file, dryRun, forceUncertain } = parsePostArgs(argv);
  const stateFile = env.STATE_FILE || DEFAULT_STATE_FILE;
  const date = kstDate(now());
  if (dryRun) {
    // 상태 파일은 읽기만 함 (저장된 하루 순위가 있으면 그걸로 미리 보기)
    const { texts: parts } = buildSlot(await readState(stateFile), date, slot, await loadData(file));
    log(parts.length ? formatParts(parts) : emptySlotMessage(slot));
    return { status: parts.length ? 'dry-run' : 'empty' };
  }

  const token = extractToken(env.TELEGRAM_BOT_TOKEN);
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN 환경변수가 없거나 형식이 올바르지 않습니다.');

  const lockFile = path.join(path.dirname(stateFile), 'post.lock');
  const release = await acquireLock(lockFile, { now: () => now().getTime() });
  try {
    let entries = await readState(stateFile);
    if (isDuplicate(entries, date, slot)) {
      log(`이미 올린 포스트입니다 (${date} slot ${slot}). 건너뜁니다.`);
      return { status: 'duplicate' };
    }
    let entry = findEntry(entries, date, slot);
    if (!entry) {
      if (!findRanking(entries, date)) {
        const data = await loadData(file);
        buildSlot(entries, date, slot, data); // 유효한 상품이 없으면 여기서 에러 (빈 순위는 저장하지 않음)
        entries = upsertRanking(entries, date, data);
        await writeState(stateFile, entries);
      }
      const { texts, ids } = buildSlot(entries, date, slot);
      if (!texts.length) {
        log(emptySlotMessage(slot));
        return { status: 'empty' };
      }
      entry = snapshotEntry(date, slot, texts, ids);
      entries = upsertEntry(entries, entry);
      await writeState(stateFile, entries);
    } else {
      log(`저장된 스냅샷으로 이어서 보냅니다 (${date} slot ${slot}, ${sentIds(entry).length}/${entry.parts.length}개 조각 전송됨).`);
    }

    try {
      const ids = await sendParts(entry, {
        send: (text) => sendMessage(token, text, { fetchImpl }),
        persist: async (e) => {
          entries = upsertEntry(entries, e);
          await writeState(stateFile, entries);
        },
        forceUncertain,
        sleep,
        log: (m) => warn(sanitize(m, token)),
      });
      log(`전송 완료 (${date} slot ${slot}, ${ids.length}개 조각, message_id ${ids.join(', ')})`);
      return { status: 'sent', ids };
    } catch (e) {
      if (e instanceof UncertainError) throw new Error(uncertainHelp(entry, stateFile));
      throw e;
    }
  } catch (e) {
    throw new Error(sanitize(e.message, token));
  } finally {
    await release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run({ argv: process.argv.slice(2), env: process.env }).catch((e) => {
    console.error(sanitize(e.message, extractToken(process.env.TELEGRAM_BOT_TOKEN)));
    process.exit(1);
  });
}
