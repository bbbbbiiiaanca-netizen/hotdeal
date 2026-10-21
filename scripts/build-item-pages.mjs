#!/usr/bin/env node
/**
 * 품목별 정적 페이지 생성 — deals.json + data/item-pages.json → deal/<slug>/index.html, sitemap.xml
 * 페이지는 지우지 않는다. 내용이 바뀐 파일만 쓰고, 바뀐 페이지 URL 목록(JSON)을 stdout에 출력한다.
 *
 * 사용: node scripts/build-item-pages.mjs [--indexnow] [--dry-run]
 *   --indexnow  제출 대기 URL(바뀐 페이지 누적)을 scripts/indexnow-submit.mjs로 제출, 성공하면 대기 목록을 비운다
 *   --dry-run   --indexnow와 함께 쓰면 제출 직전까지만 확인(indexnow-submit.mjs --dry-run). 대기 목록은 그대로 둔다
 * 상태(깃에 커밋): state/item-history.json (품목별 최근 딜 10개, 일별 최저가 기록 daily(기간 제한 없음), 페이지 마지막 변경일)
 *                  state/indexnow-pending.json (아직 제출하지 못한 URL)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');
export const ORIGIN = 'https://hotdeal.sooinlab.com';
export const PARTNERS_PREFIX = 'https://link.coupang.com/';
export const DISCLOSURE = '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';
export const HISTORY_MAX = 10;
const TG_URL = 'https://t.me/hotdeal_oide';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원';
const pct = d => d.originalPrice > d.salePrice ? Math.round((1 - d.salePrice / d.originalPrice) * 100) : 0;

export const pagePath = slug => `/deal/${encodeURIComponent(slug)}/`;
export const pageUrl = slug => ORIGIN + pagePath(slug);

/** 오늘 딜도 기록도 없는(준비 중) 페이지는 검색에 내보내지 않는다: noindex, 사이트맵·IndexNow 제외 */
export const NOINDEX_META = '<meta name="robots" content="noindex">';
export const isIndexable = ({ today, history }) => (today?.length ?? 0) > 0 || (history?.length ?? 0) > 0;
const hasNoindex = html => html.includes(NOINDEX_META);

// KST 기준 날짜·시각 부품
function kst(date) {
  const t = new Date(new Date(date).getTime() + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: p(t.getUTCHours()), mm: p(t.getUTCMinutes()), ymd: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}` };
}
export const kstDate = date => kst(date).ymd;

/**
 * subId 붙이기. 쿠팡 단축 링크(link.coupang.com/a/...)는 subId를 받을 수 없어 그대로 둔다.
 * lptag·subId 파라미터가 이미 있는 긴 파트너스 URL만 subId 값을 넣는다(기존 키 대소문자 유지).
 * 그 밖의 URL도 그대로 둔다.
 */
export function withSubId(url, subId) {
  if (!subId || typeof url !== 'string') return url;
  let u;
  try { u = new URL(url); } catch { return url; }
  if (u.hostname === 'link.coupang.com' && u.pathname.startsWith('/a/')) return url;
  const keys = [...u.searchParams.keys()];
  const subKey = keys.find(k => k.toLowerCase() === 'subid');
  const hasLptag = keys.some(k => k.toLowerCase() === 'lptag');
  if (!subKey && !hasLptag) return url;
  u.searchParams.set(subKey ?? 'subId', subId);
  return u.toString();
}

export const isPartnersUrl = url => typeof url === 'string' && url.startsWith(PARTNERS_PREFIX);

/**
 * 제목 매칭 규칙(대소문자 무시). 문자열 → 포함, 배열 → 하나라도(any), { all: [...] } → 모두,
 * { any: [...] } → 하나라도, all·any를 같이 쓰면 둘 다 만족. 안쪽 규칙도 같은 형식으로 중첩된다.
 * 예: { "all": ["톤업", { "any": ["선", "spf"] }] }
 */
export function titleMatches(title, rule) {
  const t = String(title).toLowerCase();
  const test = r => {
    if (typeof r === 'string') return r !== '' && t.includes(r.toLowerCase());
    if (Array.isArray(r)) return r.some(test);
    if (r && typeof r === 'object' && (Array.isArray(r.all) || Array.isArray(r.any))) {
      return (!Array.isArray(r.all) || (r.all.length > 0 && r.all.every(test)))
        && (!Array.isArray(r.any) || r.any.some(test));
    }
    return false;
  };
  return test(rule ?? []);
}

/** 제목이 item.match 규칙에 맞고 파트너스 링크인 딜. url 기준 중복 제거. */
export function matchDeals(deals, item) {
  const seen = new Set();
  return (deals ?? []).filter(d => {
    if (!d || typeof d.title !== 'string' || !isPartnersUrl(d.url) || !(d.salePrice > 0)) return false;
    if (!titleMatches(d.title, item.match) || seen.has(d.url)) return false;
    seen.add(d.url);
    return true;
  });
}

/** 오늘 딜을 앞에, 이전 기록은 url 중복을 빼고 뒤에 붙여 최근 HISTORY_MAX개만 남긴다. */
export function mergeHistory(prev, matched, seenAt) {
  const today = matched.map(d => ({
    title: d.title, salePrice: d.salePrice, originalPrice: d.originalPrice ?? d.salePrice,
    image: d.image ?? '', url: d.url, seenAt,
  }));
  const urls = new Set(today.map(d => d.url));
  return [...today, ...(prev ?? []).filter(d => !urls.has(d.url))].slice(0, HISTORY_MAX);
}

/**
 * 품절대란 표시. 지금 deals.json에는 품절·재고 필드가 없어 가격·할인율로 추정하지 않는다.
 * 수집기가 soldOut/lowStock을 true로 넣어 줄 때만 붙이므로, 현재 데이터로는 절대 표시되지 않는다.
 */
const stockRush = d => d.soldOut === true || d.lowStock === true;

function card(d, item, seenNote) {
  const p = pct(d);
  const href = withSubId(d.url, item.subId);
  const missing = item.subId && href === d.url ? ' data-subid-missing="1"' : '';
  const img = d.image
    ? `<img src="${esc(d.image)}" alt="${esc(d.title)}" loading="lazy">`
    : '<div class="ph" aria-hidden="true">🛒</div>';
  return `<article class="card">
    <div class="thumb">${img}${p ? `<span class="badge">-${p}%</span>` : ''}</div>
    <div class="body">
      <div class="tags"><span class="tag">${esc(item.category)}</span>${seenNote ? `<span class="tag">${esc(seenNote)}</span>` : ''}${stockRush(d) ? '<span class="tag">품절대란</span>' : ''}</div>
      <h3>${esc(d.title)}</h3>
      <div class="price">${p ? `<s>${won(d.originalPrice)}</s>` : ''}<b>${won(d.salePrice)}</b>${p ? ` <span class="muted">${p}% 할인</span>` : ''}</div>
      <a class="btn-now-price" data-track="1" data-id="${esc(d.id ?? '')}" data-cat="${esc(d.category ?? item.category)}" data-title="${esc(d.title)}" href="${esc(href)}"${missing} target="_blank" rel="sponsored nofollow noopener">쿠팡에서 지금 가격 보기</a>
    </div></article>`;
}

/**
 * '비슷한 핫딜': 오늘 deals.json에서 같은 카테고리(item.category)의 파트너스 딜 중
 * 이 품목에 이미 보이는 딜(today)을 뺀 최대 RELATED_MAX개. 그 딜에 맞는 다른 품목 페이지가 있으면 그 페이지로,
 * 없으면 쿠팡 파트너스 링크로 연결한다. 실제 데이터만 쓰고, 없으면 빈 배열(섹션 생략).
 */
export const RELATED_MAX = 4;
export function relatedDeals({ deals, item, items, today }) {
  const shown = new Set((today ?? []).map(d => d.url));
  const seen = new Set();
  const out = [];
  for (const d of deals ?? []) {
    if (out.length >= RELATED_MAX) break;
    if (!d || typeof d.title !== 'string' || !isPartnersUrl(d.url) || !(d.salePrice > 0)) continue;
    if (d.category !== item.category || shown.has(d.url) || seen.has(d.url)) continue;
    if (titleMatches(d.title, item.match)) continue;
    seen.add(d.url);
    const page = (items ?? []).find(i => i.slug !== item.slug && titleMatches(d.title, i.match));
    out.push({ deal: d, page: page ? pagePath(page.slug) : null });
  }
  return out;
}

function relatedCard({ deal: d, page }) {
  const p = pct(d);
  const img = d.image
    ? `<img src="${esc(d.image)}" alt="" loading="lazy">`
    : '<div class="ph" aria-hidden="true">🛒</div>';
  const attrs = page
    ? `href="${esc(page)}"`
    : `href="${esc(d.url)}" data-track="1" data-id="${esc(d.id ?? '')}" data-cat="${esc(d.category ?? '')}" data-title="${esc(d.title)}" target="_blank" rel="sponsored nofollow noopener"`;
  return `<article class="rel-card"><a ${attrs}>
      <div class="rel-thumb">${img}</div>
      <h3>${esc(d.title)}</h3>
      <div class="rel-price">${p ? `<span class="rel-pct">${p}%</span>` : ''}<b>${won(d.salePrice)}</b></div>
      ${p ? `<s class="rel-was">${won(d.originalPrice)}</s>` : ''}
    </a></article>`;
}

// ── 일별 최저가 기록 (state.items[slug].daily = [{ date: 'YYYY-MM-DD'(KST), minPrice }]) ──
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validPrice = n => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * 일별 기록에 (date, price)를 합친다. 같은 날짜는 더 낮은 값으로만 갱신, 날짜 중복 없음, 날짜순 정렬.
 * 0·음수·숫자 아님·날짜 형식 틀림은 버린다(기존 기록의 잘못된 항목도 함께 정리). 입력은 바꾸지 않는다.
 */
export function mergeDaily(daily, date, price) {
  const byDate = new Map();
  const put = (d, p) => {
    if (!DATE_RE.test(d ?? '') || !validPrice(p)) return;
    if (!byDate.has(d) || p < byDate.get(d)) byDate.set(d, p);
  };
  for (const e of daily ?? []) put(e?.date, e?.minPrice);
  put(date, price);
  return [...byDate].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, minPrice]) => ({ date, minPrice }));
}

/** 1회 이관: 기존 딜 기록 중 seenAt(유효한 시각)과 salePrice(양수)가 둘 다 있는 것만 그 KST 날짜의 기록으로 만든다. 추정하지 않는다. */
export function dailyFromDeals(deals) {
  let daily = [];
  for (const d of deals ?? []) {
    if (!d?.seenAt || Number.isNaN(new Date(d.seenAt).getTime())) continue;
    daily = mergeDaily(daily, kstDate(d.seenAt), d.salePrice);
  }
  return daily;
}

/** 일별 최저가 통계. 기록이 없으면 null. avg는 일별 최저가의 평균(반올림). */
export function priceStats(daily) {
  const d = mergeDaily(daily);
  if (!d.length) return null;
  const prices = d.map(e => e.minPrice);
  return {
    days: d.length, start: d[0].date, end: d[d.length - 1].date,
    min: Math.min(...prices), max: Math.max(...prices),
    avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
  };
}

/**
 * 역대 최저가 판정: date 이전의 서로 다른 날짜 기록이 2일 이상이고, price가 그 모든 일별 최저가보다 엄격히 낮을 때만
 * { prev(이전 기록 최저), price, pct(내림 %) }, 아니면 null. 같은 값(동률)은 최저가가 아니다.
 */
export function isRecordLow(daily, date, price) {
  if (!validPrice(price) || !DATE_RE.test(date ?? '')) return null;
  const before = mergeDaily(daily).filter(e => e.date < date);
  if (before.length < 2) return null;
  const prev = Math.min(...before.map(e => e.minPrice));
  if (!(price < prev)) return null;
  return { prev, price, pct: Math.round((1 - price / prev) * 100) };
}

/** 'YYYY-MM-DD' → 1970-01-01부터의 일수(그래프 x축용) */
const dayNum = ymd => Math.round(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 86400000);

/**
 * 가격 그래프 섹션. x는 실제 날짜 간격, 선은 하루 차이로 이어진 기록끼리만 잇는다(빈 날은 끊고 보간·0 채움 없음).
 * 점은 기록마다 하나. 기록 1일이면 점 하나와 안내, 0일이면 안내 문구만.
 */
export function priceGraph(daily) {
  const d = mergeDaily(daily);
  const st = priceStats(d);
  if (!st) {
    return `<section class="pg" aria-labelledby="pg-h">
    <h2 class="sec" id="pg-h">가격 그래프</h2>
    <p class="pg-empty">아직 가격 기록이 없어요</p>
  </section>`;
  }
  const W = 600, H = 180, PX = 16, PY = 18;
  const span = Math.max(1, dayNum(st.end) - dayNum(st.start));
  const x = e => (d.length === 1 ? W / 2 : PX + ((dayNum(e.date) - dayNum(st.start)) / span) * (W - 2 * PX));
  const y = e => (st.max === st.min ? H / 2 : PY + ((st.max - e.minPrice) / (st.max - st.min)) * (H - 2 * PY));
  const f = n => +n.toFixed(1);
  const segs = [];
  for (let i = 1; i < d.length; i++) {
    if (dayNum(d[i].date) - dayNum(d[i - 1].date) !== 1) continue;
    segs.push(`M${f(x(d[i - 1]))} ${f(y(d[i - 1]))}L${f(x(d[i]))} ${f(y(d[i]))}`);
  }
  const grid = st.max === st.min ? '' : [PY, H - PY].map(gy => `<line x1="0" x2="${W}" y1="${gy}" y2="${gy}" class="pg-grid"/>`).join('');
  const dots = d.map(e => `<circle cx="${f(x(e))}" cy="${f(y(e))}" r="5" class="pg-dot${e.minPrice === st.min ? ' pg-min' : ''}"><title>${e.date} ${won(e.minPrice)}</title></circle>`).join('');
  const label = d.length === 1
    ? `${st.start} 일별 최저가 ${won(st.min)}`
    : `일별 최저가 그래프, ${st.start}부터 ${st.end}까지 ${st.days}일 기록, 최고 ${won(st.max)}, 평균 ${won(st.avg)}, 최저 ${won(st.min)}`;
  const svg = `<svg class="pg-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${grid}${segs.length ? `<path d="${segs.join('')}" class="pg-line"/>` : ''}${dots}</svg>`;
  const info = d.length === 1
    ? `<p class="pg-one"><b>${won(st.min)}</b> <span class="muted">${st.start}</span></p>
    <p class="pg-note">기록 1일 · 추이를 판단하기엔 기록이 부족해요</p>`
    : `<dl class="pg-stats"><div><dt>최고</dt><dd>${won(st.max)}</dd></div><div><dt>평균</dt><dd>${won(st.avg)}</dd></div><div class="pg-lo"><dt>최저</dt><dd>${won(st.min)}</dd></div></dl>
    <p class="pg-note">기록 기준: ${st.start} ~ ${st.end} (일별 최저가, ${st.days}일)</p>`;
  const table = d.length > 1 ? `
    <details class="pg-table"><summary>일별 기록 보기</summary><table><thead><tr><th>날짜</th><th>최저가</th></tr></thead><tbody>${[...d].reverse().map(e => `<tr><td>${e.date}</td><td>${won(e.minPrice)}</td></tr>`).join('')}</tbody></table></details>` : '';
  return `<section class="pg" aria-labelledby="pg-h">
    <h2 class="sec" id="pg-h">가격 그래프</h2>
    <div class="pg-chart">${svg}</div>
    ${info}${table}
  </section>`;
}

// 그래프·최저가 배지 스타일(품목 페이지 전용). 흰 바탕, 선·점은 브랜드 주황, 최저는 빨강.
const PAGE_CSS = `<style>
.pg{margin:8px 0 28px;padding:16px;border:1px solid var(--line);border-radius:14px;background:#fff}
.pg-chart{width:100%;max-width:100%;overflow:hidden}
.pg-svg{display:block;width:100%;height:auto}
.pg-grid{stroke:var(--line);stroke-width:1;stroke-dasharray:4 4;vector-effect:non-scaling-stroke}
.pg-line{fill:none;stroke:var(--brand);stroke-width:2;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.pg-dot{fill:#fff;stroke:var(--brand);stroke-width:2;vector-effect:non-scaling-stroke}.pg-dot.pg-min{fill:var(--red);stroke:#fff}
.pg-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:12px 0 6px}
.pg-stats div{padding:8px 10px;border-radius:10px;background:#f7f8fa;min-width:0}
.pg-stats dt{font-size:12px;color:var(--muted)}.pg-stats dd{margin:2px 0 0;font-size:15px;font-weight:700;overflow-wrap:anywhere}.pg-lo dd{color:var(--red)}
.pg-one{margin:12px 0 4px;font-size:16px}.pg-note,.pg-empty{margin:4px 0 0;font-size:13px;color:var(--muted)}
.pg-table{margin-top:10px;font-size:13px}.pg-table summary{cursor:pointer;color:var(--muted)}
.pg-table table{width:100%;border-collapse:collapse;margin-top:6px}.pg-table th,.pg-table td{padding:4px 0;border-bottom:1px solid var(--line);text-align:left}.pg-table td+td,.pg-table th+th{text-align:right}
.pg-low{display:inline-block;max-width:100%;box-sizing:border-box;margin:6px 0 8px;padding:8px 12px;border-radius:10px;background:#fff1eb;color:#c2410c;font-size:15px;font-weight:700;overflow-wrap:anywhere}
</style>`;

/**
 * 오늘 딜이 끝난 품목: 마지막 딜과 최근 딜 기록은 링크 없는 텍스트(날짜·가격)로만 보여 준다.
 * 쿠팡 링크는 '쿠팡에서 지금 가격 보기' 버튼 하나뿐(.btn-now-price, 카드 구매 버튼 .btn 아님). 고지문은 푸터에 한 번만.
 */
function endedBody(item, history) {
  const kw = item.keyword;
  const last = history[0];
  return `<h2 class="sec">지난 ${esc(kw)} 딜</h2>
    <p class="muted">오늘 갱신에는 ${esc(kw)} 딜이 없었어요. 아래 가격은 확인 당시 기록일 뿐 지금 가격이 아닙니다.</p>
    <div class="ended-deal">
      <p>${esc(last.title)}</p>
      <p>기록 가격 <b>${won(last.salePrice)}</b> <span class="muted">(${kstDate(last.seenAt)} 확인, 지난 기록)</span></p>
      <a class="btn-now-price" href="${esc(withSubId(last.url, item.subId))}" target="_blank" rel="sponsored nofollow noopener">쿠팡에서 지금 가격 보기</a>
    </div>`;
}

/**
 * 페이지 HTML. 오늘 딜 → 오늘 딜 목록, 없고 기록 있음 → 끝난 딜 + 최근 딜 기록, 둘 다 없음 → 준비 중(noindex).
 * 헤더·푸터는 index.html과 같은 마크업(경로만 /로 시작). 쿠팡 파트너스 고지문은 푸터에 한 번만.
 * MY 버튼은 assets/my.js만 싣는다(설정은 이 브라우저에 저장돼 메인 추천에 반영). app.js는 #q·#sort와
 * 상대경로 deals.json을 전제해 품목 페이지에선 오류가 나므로 싣지 않는다.
 * 제목·h1·og는 기본 '{품목} 가격 비교'. isRecordLow를 충족할 때만 '{품목} 최저가' + h1 아래 최저가 배지.
 * daily는 오늘 가격까지 합친 일별 기록, date는 오늘 딜을 확인한 KST 날짜(기본: updatedAt의 KST 날짜).
 */
export function renderPage({ item, items, today, history, updatedAt, daily = [], date, related = [] }) {
  const kw = item.keyword;
  const day = date ?? (updatedAt ? kstDate(updatedAt) : null);
  const nowPrice = today.length ? Math.min(...today.map(d => d.salePrice)) : null;
  const low = day && nowPrice !== null ? isRecordLow(daily, day, nowPrice) : null;
  const title = low ? `${kw} 최저가` : `${kw} 가격 비교`;
  const lowBadge = low
    ? `\n    <p class="pg-low">🔥 지금까지 본 것 중 최저가 · ${won(low.prev)} → ${won(low.price)} (▼${low.pct >= 1 ? `${low.pct}%` : '1% 미만'})</p>`
    : '';
  const desc = `${title} | 오늘의 쿠팡 핫딜·특가 모음, 핫딜 오이데`;
  const canonical = pageUrl(item.slug);
  const t = updatedAt ? kst(updatedAt) : null;
  const updated = t ? `업데이트: ${t.y}년 ${t.m}월 ${t.d}일 ${t.hh}:${t.mm} (KST)` : '';
  const robots = isIndexable({ today, history }) ? '' : `\n${NOINDEX_META}`;

  const ended = !today.length && history.length > 0;
  let body;
  if (today.length) {
    body = `<h2 class="sec">오늘의 ${esc(kw)} 핫딜 ${today.length}개</h2>
    <div class="grid item-grid">${today.map(d => card(d, item)).join('')}</div>`;
  } else if (ended) {
    body = endedBody(item, history);
  } else {
    body = `<h2 class="sec">준비 중</h2>
    <p class="muted">준비 중: 아직 이 품목의 확인된 쿠팡 파트너스 상품이 없어요. 매일 아침 갱신 때 들어오면 여기에 표시됩니다.</p>`;
  }

  const relatedHtml = related.length ? `
  <section class="related">
    <h2 class="sec">비슷한 핫딜</h2>
    <div class="rel-grid">${related.map(relatedCard).join('')}</div>
  </section>` : '';

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">${robots}
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="핫딜 오이데">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${ORIGIN}/assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${ORIGIN}/assets/og.png">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🔥</text></svg>"><link rel="manifest" href="/manifest.json"><link rel="stylesheet" href="/assets/style.css">
${PAGE_CSS}
</head>
<body>
<header class="top">
  <a class="logo" href="/"><picture><source srcset="/assets/logo.webp" type="image/webp"><img src="/assets/logo.png" alt="핫딜 오이데" width="178" height="44" decoding="async" fetchpriority="high"></picture></a>
  <div class="top-act"><button type="button" class="inst-btn" id="installBtn" aria-haspopup="dialog">홈 화면 추가</button><button type="button" class="my-btn" id="myBtn" aria-haspopup="dialog" aria-expanded="false" aria-label="MY 맞춤 설정"><span aria-hidden="true">MY</span></button><a class="tg-ico" href="${TG_URL}" target="_blank" rel="noopener" aria-label="텔레그램 채널"><svg aria-hidden="true" focusable="false" width="36" height="36" viewBox="0 0 240 240"><circle cx="120" cy="120" r="120" fill="#229ED9"/><path fill="#fff" d="M53.8 117.6c35-15.2 58.3-25.3 70-30.2 33.3-13.9 40.2-16.3 44.7-16.4 1 0 3.2.2 4.7 1.4 1.2 1 1.5 2.3 1.7 3.3.2.9.4 3.1.2 4.8-1.8 19-9.6 65.1-13.6 86.4-1.7 9-5 12-8.2 12.3-7 .6-12.3-4.6-19-9-10.6-6.9-16.5-11.2-26.8-18-11.9-7.8-4.2-12.1 2.6-19.1 1.8-1.8 32.5-29.8 33.1-32.3.1-.3.1-1.5-.6-2.1-.7-.6-1.7-.4-2.5-.2-1.1.2-17.9 11.4-50.6 33.5-4.8 3.3-9.1 4.9-13 4.8-4.3-.1-12.5-2.4-18.7-4.4-7.5-2.4-13.5-3.7-13-7.9.3-2.2 3.3-4.4 8.9-6.7z"/></svg></a></div>
</header>
<main class="wrap">
  <section class="hero">
    <h1>${esc(title)}</h1>${ended ? '\n    <p class="ended-banner" role="status">끝난 딜이에요</p>' : ''}${lowBadge}
    ${updated ? `<p class="muted">${updated}</p>` : ''}
  </section>
  <section>
    ${body}
  </section>
  ${priceGraph(daily)}
${relatedHtml}
</main>
<footer class="foot">
  <p class="disclosure" role="note"><strong>광고</strong> ${DISCLOSURE}</p>
  <p class="req"><a href="https://t.me/hotdealoide_bot?start=request" target="_blank" rel="noopener">원하는 품목 신청</a></p>
  <p><a href="/about.html">소개</a> · <a href="/privacy.html">개인정보처리방침</a> · © 2026 핫딜 오이데</p>
</footer>
<script src="/assets/my.js"></script>
<script src="/assets/install.js"></script>
</body>
</html>
`;
}

const unesc = s => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));

/** 사이트맵의 loc → lastmod(없으면 '') */
export function sitemapLastmods(xml) {
  const map = new Map();
  for (const u of xml.match(/<url>[\s\S]*?<\/url>/g) ?? []) {
    const loc = u.match(/<loc>\s*([^<]*?)\s*<\/loc>/)?.[1];
    if (loc) map.set(unesc(loc), u.match(/<lastmod>\s*([^<]*?)\s*<\/lastmod>/)?.[1] ?? '');
  }
  return map;
}

/** 기존 사이트맵에서 /deal/ 이 아닌 항목은 그대로 두고, 품목 페이지 항목을 다시 만든다. */
export function buildSitemap(existingXml, dealEntries) {
  const lines = (existingXml.match(/<url>[\s\S]*?<\/url>/g) ?? [])
    .filter(u => !/<loc>[^<]*\/deal\//.test(u))
    .map(u => `  ${u.trim()}`);
  const known = new Set();
  for (const { loc, lastmod } of dealEntries) {
    if (known.has(loc)) continue;
    known.add(loc);
    lines.push(`  <url><loc>${esc(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}<changefreq>daily</changefreq><priority>0.7</priority></url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${lines.join('\n')}
</urlset>
`;
}

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
};

function writeIfChanged(file, content) {
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch {}
  if (old === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
  return true;
}

const pendingFile = root => path.join(root, 'state', 'indexnow-pending.json');
export const readPending = root => readJson(pendingFile(root), { urls: [] }).urls ?? [];
const writePending = (root, urls) => writeIfChanged(pendingFile(root), JSON.stringify({ urls }, null, 2) + '\n');

/** 디스크에 index.html이 있는 품목 페이지 slug 목록 */
function slugsOnDisk(root) {
  const dir = path.join(root, 'deal');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'index.html')))
    .map(e => e.name).sort();
}

/** 디스크의 품목 페이지가 noindex인지(파일을 못 읽으면 noindex로 본다) */
function noindexOnDisk(root, slug) {
  try { return hasNoindex(fs.readFileSync(path.join(root, 'deal', slug, 'index.html'), 'utf8')); } catch { return true; }
}

/**
 * 전체 생성. 바뀐 페이지 URL 목록을 돌려주고, 그 URL을 IndexNow 대기 목록에 더한다. 페이지 파일은 지우지 않는다.
 * noindex(준비 중) 페이지는 바뀌어도 목록에 넣지 않고, 사이트맵과 대기 목록에서도 뺀다.
 * noindex였던 페이지에 딜이 생기면 내용이 바뀌므로 바뀐 페이지로 잡혀 제출된다.
 * lastmod: 기록(state) → 기존 사이트맵 항목 → 오늘 순으로 정한다(파일 mtime은 체크아웃 시각이라 쓰지 않음).
 */
export function buildAll({ root = ROOT, now = new Date() } = {}) {
  const data = readJson(path.join(root, 'deals.json'));
  const { items } = readJson(path.join(root, 'data', 'item-pages.json'));
  const stateFile = path.join(root, 'state', 'item-history.json');
  const state = readJson(stateFile, {});
  state.items ??= {};
  const sitemapFile = path.join(root, 'sitemap.xml');
  const oldSitemap = fs.existsSync(sitemapFile) ? fs.readFileSync(sitemapFile, 'utf8') : '';
  const oldLastmod = sitemapLastmods(oldSitemap);
  const seenAt = data.updatedAt ?? now.toISOString();
  const seenDate = kstDate(seenAt); // 오늘 딜을 확인한 KST 날짜(일별 기록의 날짜)
  const today = kstDate(now);
  const changed = [];
  const noindex = new Set();

  for (const item of items) {
    const rec = state.items[item.slug] ?? { deals: [] };
    const matched = matchDeals(data.deals, item);
    // daily가 없는 예전 기록은 1회 이관: mergeHistory가 같은 url을 오늘 seenAt으로 덮어쓰기 전에 기존 딜로 만든다.
    // 예전 누적 최저가(minSalePrice)는 날짜가 없어 일별 기록으로 옮기지 않고 지운다.
    if (!Array.isArray(rec.daily)) rec.daily = dailyFromDeals(rec.deals);
    delete rec.minSalePrice;
    if (matched.length) rec.daily = mergeDaily(rec.daily, seenDate, Math.min(...matched.map(d => d.salePrice)));
    rec.deals = mergeHistory(rec.deals, matched, seenAt);
    const html = renderPage({ item, items, today: matched, history: rec.deals, updatedAt: data.updatedAt, daily: rec.daily, date: seenDate,
      related: relatedDeals({ deals: data.deals, item, items, today: matched }) });
    const indexable = isIndexable({ today: matched, history: rec.deals });
    if (!indexable) noindex.add(pageUrl(item.slug));
    const file = path.join(root, 'deal', item.slug, 'index.html');
    if (writeIfChanged(file, html)) {
      rec.lastmod = today;
      if (indexable) changed.push(pageUrl(item.slug));
    } else if (!rec.lastmod) {
      rec.lastmod = oldLastmod.get(pageUrl(item.slug)) || today;
    }
    state.items[item.slug] = rec;
  }

  // 설정에서 빠진 품목도 페이지가 디스크에 남아 있으면 사이트맵에 유지
  // (noindex 페이지는 다시 넣지 않는다)
  const entries = items.filter(i => !noindex.has(pageUrl(i.slug)))
    .map(i => ({ loc: pageUrl(i.slug), lastmod: state.items[i.slug].lastmod }));
  for (const slug of slugsOnDisk(root)) {
    if (items.some(i => i.slug === slug)) continue;
    const loc = pageUrl(slug);
    if (noindexOnDisk(root, slug)) { noindex.add(loc); continue; }
    entries.push({ loc, lastmod: state.items[slug]?.lastmod || oldLastmod.get(loc) || '' });
  }
  writeIfChanged(sitemapFile, buildSitemap(oldSitemap, entries));
  writeIfChanged(stateFile, JSON.stringify(state, null, 2) + '\n');
  const pending = readPending(root);
  const nextPending = [...new Set([...pending, ...changed])].filter(u => !noindex.has(u));
  if (nextPending.length !== pending.length || nextPending.some((u, i) => u !== pending[i])) writePending(root, nextPending);
  return { changed };
}

/** URL을 indexnow-submit.mjs에 넘긴다. 그 스크립트 출력은 stdout(JSON 결과)과 섞이지 않게 stderr로 보낸다. */
export function submitIndexNow(urls, { dryRun = false } = {}) {
  const args = [path.join(HERE, 'indexnow-submit.mjs'), ...(dryRun ? ['--dry-run'] : []), ...urls];
  const r = spawnSync(process.execPath, args, { stdio: ['ignore', 2, 2] });
  return r.status ?? 1;
}

/**
 * 대기 중인 URL을 제출한다. dry-run이 아닌 제출이 성공했을 때만 제출한 URL을 대기 목록에서 뺀다.
 * 실패하거나 dry-run이면 그대로 남아 다음 실행에서 다시 제출된다. 종료 코드를 돌려준다.
 */
export function flushIndexNow({ root = ROOT, dryRun = false, submit = submitIndexNow } = {}) {
  const urls = readPending(root);
  if (!urls.length) return 0;
  const status = submit(urls, { dryRun });
  if (status === 0 && !dryRun) {
    const sent = new Set(urls);
    writePending(root, readPending(root).filter(u => !sent.has(u)));
  }
  return status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const { changed } = buildAll();
  console.log(JSON.stringify(changed, null, 2));
  if (argv.includes('--indexnow')) {
    const status = flushIndexNow({ dryRun: argv.includes('--dry-run') });
    if (status !== 0) {
      console.error(`IndexNow 제출 실패 (exit ${status}) — 대기 URL은 state/indexnow-pending.json에 남겨 다음 실행에서 다시 제출`);
      process.exit(1);
    }
  }
}
