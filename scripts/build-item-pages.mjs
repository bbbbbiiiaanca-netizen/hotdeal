#!/usr/bin/env node
/**
 * 품목별 정적 페이지 생성 — deals.json + data/item-pages.json → deal/<slug>/index.html, sitemap.xml
 * 페이지는 지우지 않는다. 내용이 바뀐 파일만 쓰고, 바뀐 페이지 URL 목록(JSON)을 stdout에 출력한다.
 *
 * 사용: node scripts/build-item-pages.mjs [--indexnow] [--dry-run]
 *   --indexnow  제출 대기 URL(바뀐 페이지 누적)을 scripts/indexnow-submit.mjs로 제출, 성공하면 대기 목록을 비운다
 *   --dry-run   --indexnow와 함께 쓰면 제출 직전까지만 확인(indexnow-submit.mjs --dry-run). 대기 목록은 그대로 둔다
 * 상태(깃에 커밋): state/item-history.json (품목별 최근 딜 10개, 페이지 마지막 변경일)
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
    <div class="thumb">${img}</div>
    <div class="body">
      <div class="tags"><span class="tag">${esc(item.category)}</span>${seenNote ? `<span class="tag">${esc(seenNote)}</span>` : ''}${stockRush(d) ? '<span class="tag">품절대란</span>' : ''}</div>
      <h3>${esc(d.title)}</h3>
      <div class="price">${p ? `<s>${won(d.originalPrice)}</s>` : ''}<b>${won(d.salePrice)}</b></div>
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
      <div class="rel-price"><b>${won(d.salePrice)}</b></div>
      ${p ? `<s class="rel-was">${won(d.originalPrice)}</s>` : ''}
    </a></article>`;
}

/** 기록 최저가: 이전 누적 최저가(prevMin)와 지금 기록(history) 중 가장 낮은 salePrice. 기록이 없으면 null */
export function recordMin(history, prevMin) {
  const prices = (history ?? []).map(d => d.salePrice).filter(n => n > 0);
  if (prevMin > 0) prices.push(prevMin);
  return prices.length ? Math.min(...prices) : null;
}

/**
 * 오늘 딜 중 가장 싼 것이 기록 최저가 이하면 { price, date }(date = 그 딜의 seenAt, KST 날짜), 아니면 null.
 * 오늘 딜은 이미 기록에 합쳐져 있으므로 "이하" 비교가 곧 "기록상 가장 싸다"가 된다.
 */
export function lowestNow({ today, history, minSalePrice, updatedAt }) {
  if (!today?.length) return null;
  const best = today.reduce((a, d) => (d.salePrice < a.salePrice ? d : a));
  const min = recordMin(history, minSalePrice);
  if (min === null || !(best.salePrice <= min)) return null;
  const seenAt = (history ?? []).find(h => h.url === best.url)?.seenAt ?? best.seenAt ?? updatedAt;
  return seenAt ? { price: best.salePrice, date: kstDate(seenAt) } : null;
}

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
 * 제목·h1·설명은 '{품목} 가격 비교 (YYYY-MM-DD 기준)'(날짜 = 데이터 갱신일, KST). 가격 기록이 쌓이기 전까지 '최저가'·'가장 낮은 가격' 같은 표현은 쓰지 않는다.
 */

/**
 * 품목 설명 블록(선택). data/item-pages.json의 item에 있을 때만 그린다.
 *  - review: { heading, points: [문장...], sources: [{ title, publisher, date, url }] }
 *    우리 말로 요약한 문장만 넣고, 실제로 확인한 출처 링크를 붙인다. 출처가 없으면 그리지 않는다.
 *  - compare: { heading, note, columns: [...], rows: [[...], ...] }  기준별 비교표(검증된 사실·구매 기준만)
 *  - youtube: { id, title, channel }  공식 채널 영상만. youtube-nocookie 임베드
 * 쿠팡 상세페이지 이미지는 쓰지 않는다(이 블록은 글·표·공식 영상만).
 */
const safeHttp = u => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u);
export function renderGuide(item) {
  const out = [];
  const c = item.compare;
  if (c && Array.isArray(c.columns) && c.columns.length && Array.isArray(c.rows) && c.rows.length) {
    out.push(`<section class="guide-sec">
    <h2 class="sec">${esc(c.heading ?? `${item.keyword} 고를 때 비교 기준`)}</h2>
    <div class="cmp-wrap"><table class="cmp">
      <thead><tr>${c.columns.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${c.rows.map(r => `<tr>${r.map((v, i) => i === 0 ? `<th scope="row">${esc(v)}</th>` : `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>${c.note ? `\n    <p class="muted cmp-note">${esc(c.note)}</p>` : ''}
  </section>`);
  }
  const r = item.review;
  const srcs = (r?.sources ?? []).filter(x => x && safeHttp(x.url));
  if (r && Array.isArray(r.points) && r.points.length && srcs.length) {
    out.push(`<section class="guide-sec">
    <h2 class="sec">${esc(r.heading ?? `${item.keyword} 자료 요약`)}</h2>
    <ul class="rv-list">${r.points.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
    <p class="muted rv-src-h">출처 (우리 말로 요약했고, 원문 표현을 그대로 옮기지 않았어요)</p>
    <ol class="rv-src">${srcs.map(x => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>${x.publisher ? ` · ${esc(x.publisher)}` : ''}${x.date ? ` · ${esc(x.date)}` : ''}</li>`).join('')}</ol>
  </section>`);
  }
  const y = item.youtube;
  if (y && /^[\w-]{11}$/.test(y.id ?? '')) {
    out.push(`<section class="guide-sec">
    <h2 class="sec">${esc(y.title ?? '공식 영상')}</h2>
    <div class="yt"><iframe src="https://www.youtube-nocookie.com/embed/${y.id}" title="${esc(y.title ?? '')}" loading="lazy" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe></div>${y.channel ? `\n    <p class="muted">출처: ${esc(y.channel)} 공식 유튜브</p>` : ''}
  </section>`);
  }
  return out.join('\n');
}

export function renderPage({ item, items, today, history, updatedAt, minSalePrice, related = [] }) {
  const kw = item.keyword;
  const title = `${kw} 가격 비교${updatedAt ? ` (${kstDate(updatedAt)} 기준)` : ''}`;
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

  const guideHtml = renderGuide(item);
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
</head>
<body>
<header class="top">
  <a class="logo" href="/"><picture><source srcset="/assets/logo.webp" type="image/webp"><img src="/assets/logo.png" alt="핫딜 오이데" width="178" height="44" decoding="async" fetchpriority="high"></picture></a>
  <div class="top-act"><button type="button" class="inst-btn" id="installBtn" aria-haspopup="dialog">홈 화면 추가</button><button type="button" class="my-btn" id="myBtn" aria-haspopup="dialog" aria-expanded="false" aria-label="MY 맞춤 설정"><span aria-hidden="true">MY</span></button><a class="tg-ico" href="${TG_URL}" target="_blank" rel="noopener" aria-label="텔레그램 채널"><svg aria-hidden="true" focusable="false" width="36" height="36" viewBox="0 0 240 240"><circle cx="120" cy="120" r="120" fill="#229ED9"/><path fill="#fff" d="M53.8 117.6c35-15.2 58.3-25.3 70-30.2 33.3-13.9 40.2-16.3 44.7-16.4 1 0 3.2.2 4.7 1.4 1.2 1 1.5 2.3 1.7 3.3.2.9.4 3.1.2 4.8-1.8 19-9.6 65.1-13.6 86.4-1.7 9-5 12-8.2 12.3-7 .6-12.3-4.6-19-9-10.6-6.9-16.5-11.2-26.8-18-11.9-7.8-4.2-12.1 2.6-19.1 1.8-1.8 32.5-29.8 33.1-32.3.1-.3.1-1.5-.6-2.1-.7-.6-1.7-.4-2.5-.2-1.1.2-17.9 11.4-50.6 33.5-4.8 3.3-9.1 4.9-13 4.8-4.3-.1-12.5-2.4-18.7-4.4-7.5-2.4-13.5-3.7-13-7.9.3-2.2 3.3-4.4 8.9-6.7z"/></svg></a></div>
</header>
<main class="wrap">
  <section class="hero">
    <h1>${esc(title)}</h1>${ended ? '\n    <p class="ended-banner" role="status">끝난 딜이에요</p>' : ''}
    ${updated ? `<p class="muted">${updated}</p>` : ''}
  </section>
  <section>
    ${body}
  </section>
${guideHtml ? `  ${guideHtml}\n` : ''}${relatedHtml}
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
  const today = kstDate(now);
  const changed = [];
  const noindex = new Set();

  for (const item of items) {
    const rec = state.items[item.slug] ?? { deals: [] };
    const matched = matchDeals(data.deals, item);
    // 기록 최저가는 합치기 전 기록 + 이전 누적값 + 오늘 가격으로 누적한다.
    // mergeHistory가 같은 url을 오늘 가격으로 덮어쓰거나 HISTORY_MAX개로 자르기 전에 계산해야 예전 더 싼 가격이 사라지지 않는다.
    const min = recordMin([...(rec.deals ?? []), ...matched], rec.minSalePrice);
    if (min !== null) rec.minSalePrice = min;
    rec.deals = mergeHistory(rec.deals, matched, seenAt);
    const html = renderPage({ item, items, today: matched, history: rec.deals, updatedAt: data.updatedAt, minSalePrice: rec.minSalePrice,
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
