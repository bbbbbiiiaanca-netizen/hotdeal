// 운영자가 쿠팡 파트너스 '링크 만들기'로 직접 고른 상품(CSV)을 검사해 deals.json으로 바꿉니다. (Node 18+, 외부 패키지 없음)
// 네트워크에 접근하지 않습니다. 절차는 docs/manual-deals.md 참고.
// 사용법:
//   node scripts/import-manual-deals.mjs --check              # 검사만 (아무 파일도 안 바꿈)
//   node scripts/import-manual-deals.mjs                      # 검사 통과 시 deals.json 교체
//   node scripts/import-manual-deals.mjs --in <csv> --out <json>
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_IN = path.join(ROOT, 'data', 'manual-deals.csv');
export const DEFAULT_OUT = path.join(ROOT, 'deals.json');

// 품목 → 이모지 (deals.json에 쓰던 카테고리 그대로)
export const CATEGORIES = { '육아': '👶', '뷰티': '💄', '생활': '🧺', '반려동물': '🐶', '패션잡화': '🧦' };
export const HEADERS = ['날짜', '품목', '상품명', '파트너스링크', '가격(원)', '정상가(원)', '이미지'];
const REQUIRED = ['날짜', '품목', '상품명', '파트너스링크', '가격(원)'];
export const LINK_HOST = 'link.coupang.com';
export const DISCLOSURE = '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';

// CSV → [{ line, cells }] (line = 그 행이 시작하는 줄 번호). BOM, 따옴표, 필드 안 쉼표·줄바꿈, CRLF 지원.
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let cells = [], cell = '', quoted = false, line = 1, start = 1, i = 0;
  const endRow = () => { cells.push(cell); rows.push({ line: start, cells }); cells = []; cell = ''; };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      if (c === '\r' && text[i + 1] === '\n') { cell += '\n'; i += 2; line++; continue; }
      if (c === '\n' || c === '\r') line++;
      cell += c; i++; continue;
    }
    if (c === '"' && cell === '') { quoted = true; i++; continue; }
    if (c === ',') { cells.push(cell); cell = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      endRow();
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line++; start = line; continue;
    }
    cell += c; i++;
  }
  if (quoted) throw new Error(`${start}행: 큰따옴표(")가 닫히지 않았어요`);
  if (cell !== '' || cells.length) endRow();
  return rows;
}

const isRealDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

// '12,900원', ' 12900 ' → 12900. 숫자가 아니면 NaN, 너무 크면 Infinity.
export function parsePrice(s) {
  const t = s.replace(/[\s,원]/g, '');
  if (!/^\d+$/.test(t)) return NaN;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : Infinity;
}

const parseUrl = (s) => { try { return new URL(s); } catch { return null; } };

// 파트너스 링크면 정규화한 주소, 아니면 null
export function partnerLink(s) {
  const u = parseUrl(s);
  if (!u || u.protocol !== 'https:' || u.host !== LINK_HOST || u.username || u.password) return null;
  return u.href;
}

export const dealId = (url) => 'm' + crypto.createHash('sha1').update(url, 'utf8').digest('hex').slice(0, 10);

// 실행 시각을 KST ISO(+09:00)로
export function kstIso(now = new Date()) {
  const k = new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 19);
  return `${k}+09:00`;
}

export const noticeFor = (date) =>
  `${date} 운영자가 쿠팡 파트너스에서 직접 확인한 가격입니다(가격은 바뀔 수 있어요). ${DISCLOSURE}`;

// CSV 글 → { errors: string[], data } (errors가 비어 있을 때만 data가 있음)
export function convert(text, { now = new Date() } = {}) {
  let rows;
  try { rows = parseCsv(text); } catch (e) { return { errors: [e.message] }; }
  const errors = [];
  if (!rows.length) return { errors: ['입력 파일이 비어 있어요. 첫 줄에 머리글(' + HEADERS.join(',') + ')이 있어야 해요'] };

  const header = rows[0].cells.map((h) => h.trim());
  const col = {};
  header.forEach((h, i) => { if (HEADERS.includes(h) && !(h in col)) col[h] = i; });
  const missing = REQUIRED.filter((h) => !(h in col));
  if (missing.length) {
    return { errors: [`1행(머리글): '${missing.join("', '")}' 열이 없어요. 머리글은 ${HEADERS.join(',')} 이어야 해요`] };
  }

  const deals = [];
  const seen = new Map(); // 링크 → 행 번호
  for (const { line, cells } of rows.slice(1)) {
    if (cells.every((c) => c.trim() === '')) continue; // 빈 줄은 건너뜀
    const get = (h) => (h in col ? (cells[col[h]] ?? '') : '').trim();
    const err = (msg) => errors.push(`${line}행: ${msg}`);
    const before = errors.length;

    if (cells.length > header.length && cells.slice(header.length).some((c) => c.trim() !== '')) {
      err('칸이 머리글보다 많아요. 상품명이나 가격에 쉼표(,)가 있으면 그 칸을 큰따옴표(")로 감싸세요');
    }

    const date = get('날짜');
    if (!date) err('날짜가 비어 있어요');
    else if (!isRealDate(date)) err(`날짜는 2026-10-21 처럼 실제 있는 날짜로 적어 주세요 (지금 값: ${date})`);

    const category = get('품목');
    if (!category) err('품목이 비어 있어요');
    else if (!(category in CATEGORIES)) err(`품목은 ${Object.keys(CATEGORIES).join('·')} 중 하나여야 해요 (지금 값: ${category})`);

    const title = get('상품명').replace(/\s+/g, ' ');
    if (!title) err('상품명이 비어 있어요');

    const rawLink = get('파트너스링크');
    const url = rawLink ? partnerLink(rawLink) : null;
    if (!rawLink) err('파트너스링크가 비어 있어요');
    else if (!url) err(`파트너스링크는 https://${LINK_HOST}/ 로 시작하는 주소여야 해요 (지금 값: ${rawLink})`);
    else if (seen.has(url)) err(`${seen.get(url)}행과 같은 파트너스링크예요. 한 상품은 한 번만 적어 주세요`);
    else seen.set(url, line);

    const rawSale = get('가격(원)');
    const sale = parsePrice(rawSale);
    if (!rawSale) err('가격이 비어 있어요');
    else if (Number.isNaN(sale)) err(`가격이 숫자가 아니에요 (지금 값: ${rawSale})`);
    else if (sale === Infinity) err(`가격이 너무 커요 (지금 값: ${rawSale})`);
    else if (sale <= 0) err('가격은 0보다 커야 해요');

    const rawOrig = get('정상가(원)');
    let original = sale;
    if (rawOrig) {
      original = parsePrice(rawOrig);
      if (Number.isNaN(original)) err(`정상가가 숫자가 아니에요 (지금 값: ${rawOrig}). 모르면 비워 두세요`);
      else if (original === Infinity) err(`정상가가 너무 커요 (지금 값: ${rawOrig})`);
      else if (Number.isSafeInteger(sale) && sale > 0 && original < sale) err(`정상가(${rawOrig})가 가격(${rawSale})보다 작아요. 모르면 비워 두세요`);
    }

    const rawImage = get('이미지');
    const img = rawImage ? parseUrl(rawImage) : null;
    if (rawImage && (!img || img.protocol !== 'https:')) err(`이미지는 https:// 로 시작하는 주소여야 해요. 없으면 비워 두세요 (지금 값: ${rawImage})`);

    if (errors.length > before) continue;
    deals.push({
      id: dealId(url), title, category, originalPrice: original, salePrice: sale,
      image: img ? img.href : '', emoji: CATEGORIES[category], rocket: false,
      addedAt: `${date}T00:00:00+09:00`, url, top: false,
    });
  }

  if (!errors.length && !deals.length) errors.push('상품이 한 줄도 없어요. 머리글 아래에 상품을 한 줄씩 적어 주세요');
  if (errors.length) return { errors };
  const latest = deals.map((d) => d.addedAt.slice(0, 10)).sort().at(-1);
  return { errors, data: { updatedAt: kstIso(now), isSample: false, notice: noticeFor(latest), deals } };
}

export function parseArgs(argv) {
  const opts = { check: false, in: DEFAULT_IN, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--in' || a === '--out') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} 뒤에 파일 경로를 적어 주세요`);
      opts[a.slice(2)] = path.resolve(v);
    } else throw new Error(`모르는 옵션이에요: ${a} (쓸 수 있는 옵션: --check, --in <경로>, --out <경로>)`);
  }
  return opts;
}

const countByCategory = (deals) => {
  const n = {};
  for (const d of deals) n[d.category] = (n[d.category] || 0) + 1;
  return Object.entries(n).map(([c, k]) => `${CATEGORIES[c]} ${c} ${k}개`).join(', ');
};

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }

  let text;
  try { text = await fs.readFile(opts.in, 'utf8'); } catch (e) {
    console.error(`입력 파일을 열 수 없어요: ${opts.in} (${e.code || e.message})`);
    process.exit(1);
  }

  const { errors, data } = convert(text);
  if (errors.length) {
    console.error(`고칠 곳이 ${errors.length}개 있어요 (${path.relative(process.cwd(), opts.in) || opts.in}, 머리글이 1행):`);
    for (const e of errors) console.error('  - ' + e);
    console.error(opts.check ? '검사만 했어요. 파일은 바꾸지 않았어요.' : `${opts.out} 은(는) 그대로 두었어요.`);
    process.exit(1);
  }

  const summary = `${data.deals.length}개 (${countByCategory(data.deals)})`;
  if (opts.check) {
    console.log(`검사 통과: ${summary}. --check 라서 파일은 바꾸지 않았어요.`);
    return;
  }
  const tmp = `${opts.out}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
    await fs.rename(tmp, opts.out);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    console.error(`${opts.out} 에 쓰지 못했어요: ${e.message}`);
    process.exit(1);
  }
  console.log(`${opts.out} 에 ${summary} 썼어요.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
