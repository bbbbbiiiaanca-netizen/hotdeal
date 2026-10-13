// deals.json으로 텔레그램 채널 포스트(일반 텍스트)를 만드는 스크립트 (Node 18+, 외부 패키지 없음)
// 사용법: node scripts/make-post.mjs --slot 1|2|3|4 [--file deals.json]
// 하루 4번(09·13·17·21시 KST) 올림. 할인율 높은 순 최대 20개를 5개씩 나눠 slot k에 k번째 묶음을 씀.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DISCLOSURE = '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';
export const FOOTER = ['가격과 재고는 수시로 바뀌어요. 구매 전에 쿠팡에서 확인하세요.', '전체 목록: https://hotdeal.sooinlab.com/'];
export const TELEGRAM_LIMIT = 4096;
export const TITLE_MAX = 200;
export const CATEGORY_TAGS = { 육아: '#육아소모품', 뷰티: '#뷰티', 생활: '#생활주방', 반려동물: '#반려동물', 패션잡화: '#패션잡화' };
export const SLOTS = 4;
export const PER_SLOT = 5;
const isSlot = (k) => Number.isInteger(k) && k >= 1 && k <= SLOTS;

export const DEFAULT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deals.json');

// 판매가는 원 단위 양의 정수로 반올림. 0 이하·숫자 아님이면 null
export const wonPrice = (n) => (Number.isFinite(n) && Math.round(n) > 0 ? Math.round(n) : null);

const isValid = (d) => d && typeof d.title === 'string' && d.title.trim() && wonPrice(d.salePrice) !== null && typeof d.url === 'string' && d.url.trim();

export const formatWon = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원';

// 긴 제목은 max자(코드 포인트 기준, '…' 포함)로 자름. 서로게이트 쌍(이모지 등)을 반으로 쪼개지 않음
export function truncateTitle(title, max = TITLE_MAX) {
  const chars = Array.from(String(title).trim());
  return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('').trimEnd() + '…';
}

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

// 할인율: 정상가 > 판매가일 때만, 반올림해서 0%면 생략, 100%로 반올림되면 99%로 맞춤
export function discountPct(salePrice, originalPrice) {
  const sale = wonPrice(salePrice);
  if (sale === null || !Number.isFinite(originalPrice) || originalPrice <= sale) return null;
  const pct = Math.min(99, Math.round((1 - sale / originalPrice) * 100));
  return pct > 0 && pct < 100 ? pct : null;
}

export function priceLine(d) {
  const notes = [];
  const pct = discountPct(d.salePrice, d.originalPrice);
  if (pct !== null) notes.push(`-${pct}%`);
  const label = priceLabel(d);
  if (label) notes.push(label);
  return formatWon(wonPrice(d.salePrice)) + (notes.length ? ` (${notes.join(', ')})` : '');
}

// 유효한 상품을 할인율 높은 순으로(할인율 없으면 뒤로, 같으면 파일 순서) 최대 20개
export function rankDeals(deals) {
  const pct = (d) => discountPct(d.salePrice, d.originalPrice) ?? -1;
  return (deals || []).filter(isValid).sort((a, b) => pct(b) - pct(a)).slice(0, SLOTS * PER_SLOT);
}

// slot k(1~4)는 순위 5(k-1)+1 ~ 5k번째. 상품이 모자라면 빈 배열
export function pickDeals(deals, slot) {
  if (!isSlot(slot)) throw new Error(`slot은 1~${SLOTS} 사이 정수여야 합니다: ${slot}`);
  return rankDeals(deals).slice((slot - 1) * PER_SLOT, slot * PER_SLOT);
}

// 메시지 조각(part) 배열을 돌려줌. 4096자를 넘으면 상품 단위로 나눔.
// 첫 조각에 헤더, 마지막 조각에 안내 문구·전체 목록 링크, 모든 조각의 마지막 줄은 대가성 문구.
// 헤더와 첫 상품이 한 메시지에 안 들어가면 헤더만 따로 첫 조각이 됨.
// 유효한 상품이 아예 없으면 에러, 상품은 있는데 이 slot 몫이 없으면 빈 배열(건너뜀).
export function buildPost(data, { slot, date } = {}) {
  if (!rankDeals(data?.deals).length) throw new Error('포스트에 넣을 수 있는 상품이 없습니다 (title/salePrice/url 필요).');
  const items = pickDeals(data.deals, slot);
  if (!items.length) return [];
  const md = kstMonthDay(date ?? data.updatedAt);
  const header = `🔥 ${md} 핫딜 오이데~ TOP ${items.length} (${slot}/${SLOTS})`;

  const blocks = items.map((d, i) => {
    const lines = [`${i + 1}) ${truncateTitle(d.title)}`, `   ${priceLine(d)}`, `   ${d.url.trim()}`];
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
    if ([...next, lastTail].join('\n\n').length > TELEGRAM_LIMIT) {
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
  const args = { slot: null, file: DEFAULT_FILE, dryRun: false };
  let slot;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slot') slot = argv[++i];
    else if (a.startsWith('--slot=')) slot = a.slice(7);
    else if (a === '--file') args.file = argv[++i];
    else if (a.startsWith('--file=')) args.file = a.slice(7);
    else if (a === '--dry-run') args.dryRun = true;
    else throw new Error(`알 수 없는 옵션: ${a}`);
  }
  args.slot = /^[1-9]$/.test(slot ?? '') ? Number(slot) : NaN;
  if (!isSlot(args.slot)) throw new Error(`--slot은 1~${SLOTS} 중 하나여야 합니다: ${slot ?? '(없음)'}`);
  return args;
}

export const emptySlotMessage = (slot) => `slot ${slot}에 올릴 상품이 없습니다. 건너뜁니다.`;

export async function loadData(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { slot, file } = parseArgs(process.argv.slice(2));
    const parts = buildPost(await loadData(file), { slot });
    console.log(parts.length ? formatParts(parts) : emptySlotMessage(slot));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
