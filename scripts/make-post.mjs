// deals.json으로 텔레그램 채널 포스트(일반 텍스트)를 만드는 스크립트 (Node 18+, 외부 패키지 없음)
// 사용법: node scripts/make-post.mjs --mode morning|evening [--file deals.json]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DISCLOSURE = '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';
export const FOOTER = ['가격과 재고는 수시로 바뀌어요. 구매 전에 쿠팡에서 확인하세요.', '전체 목록: https://hotdeal.sooinlab.com/'];
export const TELEGRAM_LIMIT = 4096;
export const CATEGORY_TAGS = { 육아: '#육아소모품', 뷰티: '#뷰티', 생활: '#생활주방', 반려동물: '#반려동물', 패션잡화: '#패션잡화' };
const COUNTS = { morning: 20, evening: 3 };

export const DEFAULT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deals.json');

const isValid = (d) => d && typeof d.title === 'string' && d.title.trim() && Number.isFinite(d.salePrice) && d.salePrice > 0 && typeof d.url === 'string' && d.url.trim();

export const formatWon = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원';

// KST 기준 "M/D" (0 채움 없음)
export function kstMonthDay(date) {
  const t = new Date(new Date(date).getTime() + 9 * 3600 * 1000);
  if (Number.isNaN(t.getTime())) throw new Error(`날짜를 읽을 수 없습니다: ${date}`);
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()}`;
}

function priceLabel(d) {
  if (d.priceType === 'coupon' || d.coupon === true) return '쿠폰가';
  if (d.priceType === 'wow' || d.wow === true) return '와우가';
  return '';
}

export function priceLine(d) {
  const notes = [];
  if (Number.isFinite(d.originalPrice) && d.originalPrice > d.salePrice) {
    notes.push(`-${Math.round((1 - d.salePrice / d.originalPrice) * 100)}%`);
  }
  const label = priceLabel(d);
  if (label) notes.push(label);
  return formatWon(d.salePrice) + (notes.length ? ` (${notes.join(', ')})` : '');
}

// morning: top:true 먼저, 나머지는 파일 순서로 최대 20개
// evening: morning에 쓴 것 다음 3개, 부족하면 파일 순서 첫 3개
export function pickDeals(deals, mode) {
  if (!COUNTS[mode]) throw new Error(`mode는 morning 또는 evening이어야 합니다: ${mode}`);
  const valid = (deals || []).filter(isValid);
  const ordered = [...valid.filter((d) => d.top === true), ...valid.filter((d) => d.top !== true)];
  if (mode === 'morning') return ordered.slice(0, COUNTS.morning);
  const rest = ordered.slice(COUNTS.morning);
  return rest.length >= COUNTS.evening ? rest.slice(0, COUNTS.evening) : valid.slice(0, COUNTS.evening);
}

// 메시지 조각(part) 배열을 돌려줌. 4096자를 넘으면 상품 단위로 나눔.
// 첫 조각에 헤더, 마지막 조각에 안내 문구·전체 목록 링크, 모든 조각의 마지막 줄은 대가성 문구.
export function buildPost(data, { mode = 'morning', date } = {}) {
  const items = pickDeals(data?.deals, mode);
  if (!items.length) throw new Error('포스트에 넣을 수 있는 상품이 없습니다 (title/salePrice/url 필요).');
  const md = kstMonthDay(date ?? data.updatedAt);
  const header = mode === 'morning'
    ? `🔥 ${md} 오늘의 핫딜 오이데~ TOP ${items.length}`
    : `🌙 ${md} 아직 할인 중인 핫딜 오이데~ ${items.length}`;

  const blocks = items.map((d, i) => {
    const lines = [`${i + 1}) ${d.title.trim()}`, `   ${priceLine(d)}`, `   ${d.url.trim()}`];
    const tag = CATEGORY_TAGS[d.category];
    if (tag) lines.push(`   ${tag}`);
    return lines.join('\n');
  });
  const midTail = DISCLOSURE;
  const lastTail = [...FOOTER, DISCLOSURE].join('\n');

  // 어느 조각이 마지막이 될지 모르므로 긴 꼬리(lastTail) 기준으로 채움
  const groups = [];
  let cur = [header];
  for (const block of blocks) {
    const next = [...cur, block];
    if (cur.length > (groups.length ? 0 : 1) && [...next, lastTail].join('\n\n').length > TELEGRAM_LIMIT) {
      groups.push(cur);
      cur = [block];
    } else {
      cur = next;
    }
  }
  groups.push(cur);

  return groups.map((g, i) => {
    const message = [...g, i === groups.length - 1 ? lastTail : midTail].join('\n\n');
    if (message.length > TELEGRAM_LIMIT) throw new Error(`메시지가 텔레그램 한도(${TELEGRAM_LIMIT}자)를 넘습니다: ${message.length}자`);
    return message;
  });
}

// 조각이 여러 개면 '----- part i/n -----' 줄로 구분해서 출력용 문자열로 만듦
export const formatParts = (parts) =>
  parts.length > 1 ? parts.map((p, i) => `----- part ${i + 1}/${parts.length} -----\n${p}`).join('\n') : parts[0];

export function parseArgs(argv) {
  const args = { mode: 'morning', file: DEFAULT_FILE, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') args.mode = argv[++i];
    else if (a.startsWith('--mode=')) args.mode = a.slice(7);
    else if (a === '--file') args.file = argv[++i];
    else if (a.startsWith('--file=')) args.file = a.slice(7);
    else if (a === '--dry-run') args.dryRun = true;
    else throw new Error(`알 수 없는 옵션: ${a}`);
  }
  if (!COUNTS[args.mode]) throw new Error(`--mode는 morning 또는 evening이어야 합니다: ${args.mode}`);
  return args;
}

export async function loadData(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { mode, file } = parseArgs(process.argv.slice(2));
    console.log(formatParts(buildPost(await loadData(file), { mode })));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
