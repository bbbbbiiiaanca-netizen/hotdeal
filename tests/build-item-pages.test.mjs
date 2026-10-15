import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { withSubId, matchDeals, titleMatches, mergeHistory, buildAll, flushIndexNow, readPending, pageUrl, renderPage, isIndexable, NOINDEX_META, DISCLOSURE, HISTORY_MAX } from '../scripts/build-item-pages.mjs';
import { sameOriginUrls } from '../scripts/indexnow-submit.mjs';

/** 쿠팡 파트너스 고지문: 페이지 전체에서 정확히 1번, 푸터 안에 메인과 같은 문단으로 */
function assertDisclosureOnceInFooter(html, msg) {
  assert.equal(html.split(DISCLOSURE).length - 1, 1, msg);
  const footer = html.slice(html.indexOf('<footer class="foot">'), html.indexOf('</footer>'));
  assert.ok(footer.includes(`<p class="disclosure" role="note"><strong>광고</strong> ${DISCLOSURE}</p>`), msg);
}

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://hotdeal.sooinlab.com/</loc><lastmod>2026-10-11</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>
  <url><loc>https://hotdeal.sooinlab.com/about.html</loc><lastmod>2026-10-11</lastmod><changefreq>monthly</changefreq><priority>0.5</priority></url>
  <url><loc>https://hotdeal.sooinlab.com/privacy.html</loc><lastmod>2026-10-11</lastmod><changefreq>yearly</changefreq><priority>0.3</priority></url>
</urlset>
`;
const ITEMS = [
  { slug: '팬히터', keyword: '팬히터', subId: 'deal-fanheater', match: ['팬히터'], category: '가전·디지털', guide: '팬히터 기준' },
  { slug: '스마트TV', keyword: '스마트TV', subId: 'deal-smarttv', match: ['스마트tv', 'qled'], category: '가전·디지털', guide: 'TV 기준' },
];
const deal = (id, title, extra = {}) => ({
  id, title, originalPrice: 30000, salePrice: 19300, image: `https://img.example/${id}.jpg`,
  url: `https://link.coupang.com/a/${id}`, ...extra,
});

function site(deals, updatedAt = '2026-10-15T07:33:00+09:00', items = ITEMS) {
  const root = mkdtempSync(join(tmpdir(), 'item-pages-'));
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data', 'item-pages.json'), JSON.stringify({ items }));
  writeFileSync(join(root, 'sitemap.xml'), SITEMAP);
  setDeals(root, deals, updatedAt);
  return root;
}
const setDeals = (root, deals, updatedAt) => writeFileSync(join(root, 'deals.json'), JSON.stringify({ updatedAt, deals }));
const page = (root, slug) => readFileSync(join(root, 'deal', slug, 'index.html'), 'utf8');
const D1 = new Date('2026-10-15T00:00:00Z');
const D2 = new Date('2026-10-16T00:00:00Z');

test('withSubId: 단축 링크는 그대로', () => {
  assert.equal(withSubId('https://link.coupang.com/a/hQ1AV7h4Jo', 'deal-x'), 'https://link.coupang.com/a/hQ1AV7h4Jo');
});

test('withSubId: lptag가 있는 긴 링크에는 subId를 넣고, 기존 subId는 바꾼다', () => {
  const u = new URL(withSubId('https://link.coupang.com/re/AFFSDP?lptag=AF123&pageKey=9', 'deal-x'));
  assert.equal(u.searchParams.get('subId'), 'deal-x');
  assert.equal(u.searchParams.get('lptag'), 'AF123');
  const v = new URL(withSubId('https://link.coupang.com/re/AFFSDP?lptag=AF123&subid=old', 'deal-x'));
  assert.equal(v.searchParams.get('subid'), 'deal-x');
  assert.equal(v.searchParams.has('subId'), false);
});

test('withSubId: subId가 없거나 지원 안 하는 URL은 그대로', () => {
  assert.equal(withSubId('https://link.coupang.com/re/AFFSDP?lptag=AF1', ''), 'https://link.coupang.com/re/AFFSDP?lptag=AF1');
  assert.equal(withSubId('https://www.coupang.com/vp/products/1', 'x'), 'https://www.coupang.com/vp/products/1');
  assert.equal(withSubId('not a url', 'x'), 'not a url');
});

test('matchDeals: 대소문자 무시, 파트너스 링크만, url 중복 제거', () => {
  const deals = [
    deal('a', '삼성 스마트TV 55형'),
    deal('b', 'LG QLED 65인치'),
    deal('c', '스마트TV 거치대', { url: 'https://www.coupang.com/vp/products/1' }),
    deal('d', '스마트tv 리모컨', { url: '#placeholder' }),
    deal('a', '삼성 스마트TV 55형 (중복)'),
    deal('e', '전기 팬히터'),
  ];
  assert.deepEqual(matchDeals(deals, ITEMS[1]).map(d => d.id), ['a', 'b']);
  assert.deepEqual(matchDeals(deals, ITEMS[0]).map(d => d.id), ['e']);
});

test('mergeHistory: 오늘 딜이 앞, url 중복 제거, 최대 10개', () => {
  const prev = Array.from({ length: 12 }, (_, i) => ({ title: `p${i}`, url: `u${i}`, salePrice: 1, originalPrice: 1, image: '', seenAt: 'old' }));
  const h = mergeHistory(prev, [{ title: 'new', url: 'u3', salePrice: 2 }], 'now');
  assert.equal(h.length, HISTORY_MAX);
  assert.equal(h[0].title, 'new');
  assert.equal(h[0].seenAt, 'now');
  assert.equal(h.filter(d => d.url === 'u3').length, 1);
});

test('상태 (a): 오늘 딜 표시 + 단축 링크는 subId 없이 data-subid-missing', () => {
  const root = site([deal('fh1', '신일 팬히터 SFH-1')]);
  const { changed } = buildAll({ root, now: D1 });
  assert.deepEqual(changed, [pageUrl('팬히터')]);
  const html = page(root, '팬히터');
  // 첫 딜이라 기록 최저가와 같음 → 최저가 문구
  assert.match(html, /<title>팬히터 비교 최저가 \(2026-10-15 기준, 우리 기록\)<\/title>/);
  assert.match(html, /<h1>팬히터 비교 최저가 \(2026-10-15 기준, 우리 기록\)<\/h1>/);
  assert.match(html, /신일 팬히터 SFH-1/);
  assert.match(html, /<b>19,300원<\/b>/);
  assert.match(html, /<s>30,000원<\/s>/);
  assert.match(html, /-36%/);
  assert.match(html, /href="https:\/\/link\.coupang\.com\/a\/fh1" data-subid-missing="1" target="_blank" rel="sponsored nofollow noopener">쿠팡에서 보기/);
  assert.match(html, /<link rel="canonical" href="https:\/\/hotdeal\.sooinlab\.com\/deal\/%ED%8C%AC%ED%9E%88%ED%84%B0\/">/);
  assert.match(html, /href="\/assets\/style\.css"/);
  assert.match(html, /2026년 10월 15일 07:33 \(KST\)/);
  assert.match(html, /https:\/\/t\.me\/hotdeal_oide[^>]*>✈️ @hotdeal_oide 구독하고 매일 받기/);
  assertDisclosureOnceInFooter(html);
  rmSync(root, { recursive: true });
});

test('상태 (b): 오늘 딜 없고 기록 있음 → 끝난 딜 + 최근 딜 기록', () => {
  const root = site([deal('fh1', '신일 팬히터')]);
  buildAll({ root, now: D1 });
  setDeals(root, [deal('x', '다른 상품')], '2026-10-16T07:30:00+09:00');
  const { changed } = buildAll({ root, now: D2 });
  assert.ok(changed.includes(pageUrl('팬히터')));
  const html = page(root, '팬히터');
  assert.match(html, /끝난 딜/);
  assert.match(html, /최근 딜 기록/);
  assert.match(html, /2026-10-15 확인/);
  assert.match(html, /지금 가격이 아닙니다/);
  assert.match(html, /신일 팬히터/);
  const state = JSON.parse(readFileSync(join(root, 'state', 'item-history.json'), 'utf8'));
  assert.equal(state.items['팬히터'].deals.length, 1);
  assert.equal(state.items['팬히터'].lastmod, '2026-10-16');
  rmSync(root, { recursive: true });
});

test('상태 (c): 기록 없음 → 준비 중, 가짜 상품 없음', () => {
  const root = site([deal('x', '관계없는 상품')]);
  buildAll({ root, now: D1 });
  const html = page(root, '스마트TV');
  assert.match(html, /준비 중: 아직 이 품목의 확인된 쿠팡 파트너스 상품이 없어요\. 매일 아침 갱신 때 들어오면 여기에 표시됩니다\./);
  assert.doesNotMatch(html, /class="card"/);
  assert.doesNotMatch(html, /쿠팡에서 보기/);
  rmSync(root, { recursive: true });
});

test('내용이 같으면 다시 쓰지 않고 lastmod도 유지', () => {
  const root = site([deal('fh1', '신일 팬히터')]);
  buildAll({ root, now: D1 });
  const { changed } = buildAll({ root, now: D2 });
  assert.deepEqual(changed, []);
  const sm = readFileSync(join(root, 'sitemap.xml'), 'utf8');
  assert.match(sm, /<loc>https:\/\/hotdeal\.sooinlab\.com\/deal\/%ED%8C%AC%ED%9E%88%ED%84%B0\/<\/loc><lastmod>2026-10-15<\/lastmod>/);
  rmSync(root, { recursive: true });
});

test('사이트맵: 기존 3개 유지 + 품목 페이지 추가', () => {
  const root = site([deal('fh1', '신일 팬히터'), deal('tv1', '삼성 스마트TV')]);
  buildAll({ root, now: D1 });
  buildAll({ root, now: D1 });
  const sm = readFileSync(join(root, 'sitemap.xml'), 'utf8');
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.deepEqual(locs, [
    'https://hotdeal.sooinlab.com/', 'https://hotdeal.sooinlab.com/about.html', 'https://hotdeal.sooinlab.com/privacy.html',
    pageUrl('팬히터'), pageUrl('스마트TV'),
  ]);
  assert.match(sm, /<lastmod>2026-10-11<\/lastmod><changefreq>monthly/);
  rmSync(root, { recursive: true });
});

test('페이지를 지우지 않음: 설정에서 빠진 품목도 파일과 사이트맵 항목 유지', () => {
  const root = site([deal('fh1', '신일 팬히터')]);
  buildAll({ root, now: D1 });
  writeFileSync(join(root, 'data', 'item-pages.json'), JSON.stringify({ items: [ITEMS[1]] }));
  const { changed } = buildAll({ root, now: D2 });
  assert.ok(existsSync(join(root, 'deal', '팬히터', 'index.html')));
  assert.ok(!changed.includes(pageUrl('팬히터')));
  assert.match(readFileSync(join(root, 'sitemap.xml'), 'utf8'), /%ED%8C%AC%ED%9E%88%ED%84%B0/);
  rmSync(root, { recursive: true });
});

const readState = root => JSON.parse(readFileSync(join(root, 'state', 'item-history.json'), 'utf8'));
const sitemapOf = root => readFileSync(join(root, 'sitemap.xml'), 'utf8');

test('titleMatches: 배열은 any, all/any 객체는 중첩 가능, 대소문자 무시', () => {
  const tone = { all: ['톤업', { any: ['선', 'spf'] }] };
  assert.equal(titleMatches('라운드랩 톤업 선크림 50ml', tone), true);
  assert.equal(titleMatches('톤업 크림 SPF50+ PA++++', tone), true);
  assert.equal(titleMatches('톤업 크림 50ml', tone), false);
  assert.equal(titleMatches('무기자차 선크림', tone), false);
  assert.equal(titleMatches('삼성 QLED', ['스마트tv', 'qled']), true);
  assert.equal(titleMatches('아무거나', ['스마트tv']), false);
  assert.equal(titleMatches('a b', { all: ['a'], any: ['x', 'b'] }), true);
  assert.equal(titleMatches('a c', { all: ['a'], any: ['x', 'b'] }), false);
  assert.equal(titleMatches('무엇이든', { all: [] }), false);
  assert.equal(titleMatches('무엇이든', ''), false);
  assert.equal(titleMatches('무엇이든', undefined), false);
});

test('설정의 톤업선크림: 톤업 + (선|spf) 모두 있어야 매칭', () => {
  const { items } = JSON.parse(readFileSync(new URL('../data/item-pages.json', import.meta.url), 'utf8'));
  const item = items.find(i => i.slug === '톤업선크림');
  const deals = [deal('t1', '톤업 선크림'), deal('t2', '톤업 크림 spf50'), deal('t3', '톤업 쿠션'), deal('t4', '선크림')];
  assert.deepEqual(matchDeals(deals, item).map(d => d.id), ['t1', 't2']);
});

test('기록이 없으면 lastmod는 파일 mtime이 아니라 기존 사이트맵 값을 쓴다', () => {
  const root = site([deal('fh1', '신일 팬히터'), deal('tv1', '삼성 스마트TV')]);
  buildAll({ root, now: D1 });
  // 새 체크아웃 흉내: 기록만 없고 페이지·사이트맵은 있음. 사이트맵 lastmod를 과거 날짜로 바꿔 둔다.
  rmSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'sitemap.xml'), sitemapOf(root).replaceAll('<lastmod>2026-10-15</lastmod>', '<lastmod>2026-10-01</lastmod>'));
  const { changed } = buildAll({ root, now: D2 });
  assert.ok(!changed.includes(pageUrl('스마트TV')));
  assert.equal(readState(root).items['스마트TV'].lastmod, '2026-10-01');
  assert.match(sitemapOf(root), new RegExp(`<loc>${pageUrl('스마트TV')}</loc><lastmod>2026-10-01</lastmod>`));
  rmSync(root, { recursive: true });
});

test('기록에 없어도 디스크에 남은 /deal/ 페이지는 사이트맵에 유지(기존 lastmod)', () => {
  const root = site([deal('fh1', '신일 팬히터')]);
  buildAll({ root, now: D1 });
  rmSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'data', 'item-pages.json'), JSON.stringify({ items: [ITEMS[1]] }));
  buildAll({ root, now: D2 });
  assert.match(sitemapOf(root), new RegExp(`<loc>${pageUrl('팬히터')}</loc><lastmod>2026-10-15</lastmod>`));
  // 파일까지 없어진 페이지는 빠진다
  rmSync(join(root, 'deal', '팬히터'), { recursive: true });
  buildAll({ root, now: D2 });
  assert.doesNotMatch(sitemapOf(root), /%ED%8C%AC%ED%9E%88%ED%84%B0/);
  rmSync(root, { recursive: true });
});

test('IndexNow 대기: 바뀐 URL은 쌓이고, 실패·dry-run이면 남고, 성공하면 비워진다', () => {
  const root = site([deal('fh1', '신일 팬히터'), deal('tv1', '삼성 스마트TV')]);
  buildAll({ root, now: D1 });
  const all = [pageUrl('팬히터'), pageUrl('스마트TV')];
  assert.deepEqual(readPending(root), all);
  const calls = [];
  const fake = status => (urls, opts) => { calls.push({ urls, ...opts }); return status; };

  assert.equal(flushIndexNow({ root, submit: fake(1) }), 1);
  assert.deepEqual(readPending(root), all);
  assert.equal(flushIndexNow({ root, dryRun: true, submit: fake(0) }), 0);
  assert.deepEqual(readPending(root), all);

  // 다음 실행에서 새로 바뀐 URL이 더해져도 중복 없이 유지
  setDeals(root, [deal('fh2', '팬히터 신상')], '2026-10-16T07:30:00+09:00');
  buildAll({ root, now: D2 });
  assert.deepEqual(readPending(root), all);

  assert.equal(flushIndexNow({ root, submit: fake(0) }), 0);
  assert.deepEqual(readPending(root), []);
  assert.deepEqual(calls.map(c => c.dryRun), [false, true, false]);
  assert.deepEqual(calls[2].urls, all);

  calls.length = 0;
  assert.equal(flushIndexNow({ root, submit: fake(0) }), 0);
  assert.equal(calls.length, 0);
  rmSync(root, { recursive: true });
});

test('indexnow-submit: URL origin이 정확히 같은 것만 통과', () => {
  const o = 'https://hotdeal.sooinlab.com';
  assert.deepEqual(sameOriginUrls([
    `${o}/deal/a/`,
    `${o}`,
    'https://HOTDEAL.sooinlab.com/x',
    'https://hotdeal.sooinlab.com.evil.com/x',
    'https://hotdeal.sooinlab.com@evil.com/x',
    'https://hotdeal.sooinlab.com:8443/x',
    'http://hotdeal.sooinlab.com/x',
    'not a url',
  ], o), [`${o}/deal/a/`, o, 'https://HOTDEAL.sooinlab.com/x']);
});

test('state 기록 파일은 깃에서 무시되지 않는다', () => {
  const repo = new URL('..', import.meta.url).pathname;
  const ignored = f => { try { execFileSync('git', ['check-ignore', '-q', f], { cwd: repo }); return true; } catch { return false; } };
  assert.equal(ignored('state/item-history.json'), false);
  assert.equal(ignored('state/indexnow-pending.json'), false);
});

const TV = pageUrl('스마트TV');
const FH = pageUrl('팬히터');
const writePendingFile = (root, urls) => { mkdirSync(join(root, 'state'), { recursive: true }); writeFileSync(join(root, 'state', 'indexnow-pending.json'), JSON.stringify({ urls })); };

test('noindex: 준비 중(오늘 딜·기록 모두 없음)일 때만 robots noindex', () => {
  const args = { item: ITEMS[1], items: ITEMS, updatedAt: '2026-10-15T07:33:00+09:00' };
  const h = { title: 't', url: 'https://link.coupang.com/a/h', salePrice: 1, originalPrice: 1, image: '', seenAt: '2026-10-14T07:00:00+09:00' };
  const count = html => html.split(NOINDEX_META).length - 1;
  assert.equal(count(renderPage({ ...args, today: [], history: [] })), 1);
  assert.equal(count(renderPage({ ...args, today: [deal('a', '스마트TV')], history: [h] })), 0);
  assert.equal(count(renderPage({ ...args, today: [], history: [h] })), 0);
  assert.equal(isIndexable({ today: [], history: [] }), false);
  assert.equal(isIndexable({ today: [], history: [h] }), true);
});

test('noindex 페이지는 사이트맵·changed·IndexNow 대기에서 빠진다', () => {
  const root = site([deal('fh1', '신일 팬히터')]);
  const { changed } = buildAll({ root, now: D1 });
  assert.match(page(root, '스마트TV'), /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(page(root, '팬히터'), /name="robots"/);
  assert.deepEqual(changed, [FH]);
  assert.deepEqual(readPending(root), [FH]);
  assert.ok(sitemapOf(root).includes(`<loc>${FH}</loc>`));
  assert.ok(!sitemapOf(root).includes(TV));
  rmSync(root, { recursive: true });
});

test('noindex → 딜 생김: noindex 사라지고 changed·대기·사이트맵에 들어간다', () => {
  const root = site([deal('fh1', '신일 팬히터')]);
  buildAll({ root, now: D1 });
  flushIndexNow({ root, submit: () => 0 });
  setDeals(root, [deal('fh1', '신일 팬히터'), deal('tv1', '삼성 스마트TV')], '2026-10-16T07:30:00+09:00');
  const { changed } = buildAll({ root, now: D2 });
  assert.ok(changed.includes(TV));
  assert.ok(readPending(root).includes(TV));
  assert.doesNotMatch(page(root, '스마트TV'), /name="robots"/);
  assert.match(sitemapOf(root), new RegExp(`<loc>${TV}</loc><lastmod>2026-10-16</lastmod>`));
  rmSync(root, { recursive: true });
});

test('기록만 있고 오늘 딜 없음 → 계속 색인(noindex 없음, 사이트맵 유지)', () => {
  const root = site([deal('fh1', '신일 팬히터'), deal('tv1', '삼성 스마트TV')]);
  buildAll({ root, now: D1 });
  setDeals(root, [], '2026-10-16T07:30:00+09:00');
  const { changed } = buildAll({ root, now: D2 });
  assert.deepEqual(changed, [FH, TV]);
  for (const slug of ['팬히터', '스마트TV']) assert.doesNotMatch(page(root, slug), /name="robots"/);
  assert.ok(sitemapOf(root).includes(`<loc>${TV}</loc>`));
  assert.ok(sitemapOf(root).includes(`<loc>${FH}</loc>`));
  rmSync(root, { recursive: true });
});

test('예전 실행이 남긴 noindex URL은 대기 목록과 기존 사이트맵에서 정리된다', () => {
  const root = site([deal('fh1', '신일 팬히터')]);
  writePendingFile(root, [TV, 'https://hotdeal.sooinlab.com/other/']);
  writeFileSync(join(root, 'sitemap.xml'), SITEMAP.replace('</urlset>', `  <url><loc>${TV}</loc><lastmod>2026-10-14</lastmod></url>\n</urlset>`));
  buildAll({ root, now: D1 });
  assert.deepEqual(readPending(root), ['https://hotdeal.sooinlab.com/other/', FH]);
  assert.ok(!sitemapOf(root).includes(TV));
  rmSync(root, { recursive: true });
});

test('디스크에 남은(설정에서 빠진) noindex 페이지는 사이트맵·대기 목록에 다시 들어가지 않는다', () => {
  const root = site([deal('fh1', '신일 팬히터')]);
  buildAll({ root, now: D1 });
  // 스마트TV(준비 중, noindex)를 설정에서 뺀다. 파일은 디스크에 남는다.
  writeFileSync(join(root, 'data', 'item-pages.json'), JSON.stringify({ items: [ITEMS[0]] }));
  writePendingFile(root, [TV]);
  buildAll({ root, now: D2 });
  assert.ok(existsSync(join(root, 'deal', '스마트TV', 'index.html')));
  assert.ok(!sitemapOf(root).includes(TV));
  assert.ok(!readPending(root).includes(TV));
  // 색인 페이지(팬히터)는 설정에서 빠져도 유지
  writeFileSync(join(root, 'data', 'item-pages.json'), JSON.stringify({ items: [ITEMS[1]] }));
  buildAll({ root, now: D2 });
  assert.ok(sitemapOf(root).includes(`<loc>${FH}</loc>`));
  assert.ok(!sitemapOf(root).includes(TV));
  rmSync(root, { recursive: true });
});

// ── 제목 규칙 · 최저가 · 품절대란 · 끝난 딜 ──
const titleOf = html => html.match(/<title>([^<]*)<\/title>/)[1];
const h1Of = html => html.match(/<h1>([^<]*)<\/h1>/)[1];
const descOf = html => html.match(/<meta name="description" content="([^"]*)">/)[1];
const H = (id, salePrice, seenAt) => ({ title: `팬히터 ${id}`, url: `https://link.coupang.com/a/${id}`, salePrice, originalPrice: 30000, image: '', seenAt });
const R = { item: ITEMS[0], items: ITEMS, updatedAt: '2026-10-15T07:33:00+09:00' };
const TG = 'https://t.me/hotdeal_oide';

test('제목 기본값: title·h1·description 모두 "{품목} 비교" (최저가 아니면 덧붙이지 않음)', () => {
  // 오늘 딜(25,000원)이 기록 최저가(19,300원)보다 비쌈
  const html = renderPage({ ...R, today: [deal('n', '팬히터 n', { salePrice: 25000 })],
    history: [H('n', 25000, '2026-10-15T07:33:00+09:00'), H('o', 19300, '2026-10-10T07:00:00+09:00')] });
  assert.equal(titleOf(html), '팬히터 비교');
  assert.equal(h1Of(html), '팬히터 비교');
  assert.equal(descOf(html), '팬히터 비교');
  assert.doesNotMatch(html, /최저가·핫딜|오늘 핫딜<\/h1>/);
  // 준비 중·끝난 딜도 기본값
  assert.equal(titleOf(renderPage({ ...R, today: [], history: [] })), '팬히터 비교');
  assert.equal(titleOf(renderPage({ ...R, today: [], history: [H('o', 100, '2026-10-10T07:00:00+09:00')] })), '팬히터 비교');
});

test('최저가: 오늘 딜이 기록 최저가 이하일 때만, 날짜는 그 딜의 seenAt(KST)', () => {
  const suffix = ' 최저가 (2026-10-14 기준, 우리 기록)';
  // 기록 최저가와 같은 가격 → 표시(이하). seenAt 2026-10-13T16:00Z = KST 10-14
  const eq = renderPage({ ...R, today: [deal('n', '팬히터 n', { salePrice: 19300 })],
    history: [H('n', 19300, '2026-10-13T16:00:00Z'), H('o', 19300, '2026-10-01T07:00:00+09:00')] });
  assert.equal(titleOf(eq), `팬히터 비교${suffix}`);
  assert.equal(h1Of(eq), `팬히터 비교${suffix}`);
  assert.equal(descOf(eq), `팬히터 비교${suffix}`);
  // 오늘 딜 여러 개면 가장 싼 딜 기준
  const multi = renderPage({ ...R, today: [deal('a', '팬히터 a', { salePrice: 50000 }), deal('b', '팬히터 b', { salePrice: 9000 })],
    history: [H('a', 50000, '2026-10-15T07:33:00+09:00'), H('b', 9000, '2026-10-14T07:33:00+09:00'), H('o', 10000, '2026-10-01T07:00:00+09:00')] });
  assert.equal(titleOf(multi), `팬히터 비교${suffix}`);
  // 1원이라도 비싸면 없음
  const above = renderPage({ ...R, today: [deal('n', '팬히터 n', { salePrice: 19301 })],
    history: [H('n', 19301, '2026-10-14T07:33:00+09:00'), H('o', 19300, '2026-10-01T07:00:00+09:00')] });
  assert.doesNotMatch(above, /최저가/);
  // 기록에서 밀려난 딜의 누적 최저가(minSalePrice)도 반영
  const evicted = renderPage({ ...R, minSalePrice: 15000, today: [deal('n', '팬히터 n', { salePrice: 19300 })],
    history: [H('n', 19300, '2026-10-14T07:33:00+09:00')] });
  assert.doesNotMatch(titleOf(evicted), /최저가/);
});

test('최저가: buildAll — 첫 딜·더 싼 딜이면 표시, 더 비싼 딜이면 없음, 누적 최저가는 state에 남는다', () => {
  const root = site([deal('fh1', '팬히터 A', { salePrice: 20000 })], '2026-10-15T07:33:00+09:00');
  buildAll({ root, now: D1 });
  assert.equal(titleOf(page(root, '팬히터')), '팬히터 비교 최저가 (2026-10-15 기준, 우리 기록)');
  setDeals(root, [deal('fh2', '팬히터 B', { salePrice: 25000 })], '2026-10-16T07:30:00+09:00');
  buildAll({ root, now: D2 });
  assert.equal(titleOf(page(root, '팬히터')), '팬히터 비교');
  setDeals(root, [deal('fh3', '팬히터 C', { salePrice: 18000 })], '2026-10-17T07:30:00+09:00');
  buildAll({ root, now: new Date('2026-10-17T00:00:00Z') });
  assert.equal(titleOf(page(root, '팬히터')), '팬히터 비교 최저가 (2026-10-17 기준, 우리 기록)');
  assert.equal(readState(root).items['팬히터'].minSalePrice, 18000);
  rmSync(root, { recursive: true });
});

test('최저가 회귀: 기록 10,000원 딜이 같은 URL로 20,000원에 다시 나와도 최저가 아님(첫 실행 누적값 없음)', () => {
  const root = site([deal('fh1', '신일 팬히터', { salePrice: 20000 })], '2026-10-16T07:30:00+09:00');
  // 예전 state: minSalePrice 필드 없이 기록만 있음
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state', 'item-history.json'), JSON.stringify({ items: { 팬히터: { deals: [
    { title: '신일 팬히터', url: 'https://link.coupang.com/a/fh1', salePrice: 10000, originalPrice: 30000, image: '', seenAt: '2026-10-10T07:30:00+09:00' },
  ] } } }));
  buildAll({ root, now: D2 });
  assert.equal(titleOf(page(root, '팬히터')), '팬히터 비교');
  assert.doesNotMatch(page(root, '팬히터'), /최저가/);
  const rec = readState(root).items['팬히터'];
  assert.equal(rec.minSalePrice, 10000);
  assert.deepEqual(rec.deals.map(d => d.salePrice), [20000]);
  rmSync(root, { recursive: true });
});

test('품절대란: 재고 필드가 없으면 절대 표시 안 함, soldOut/lowStock === true일 때만', () => {
  const hist = [H('o', 1000, '2026-10-01T07:00:00+09:00')];
  const plain = renderPage({ ...R, today: [deal('a', '팬히터 a', { salePrice: 1, originalPrice: 100000 })], history: hist });
  assert.doesNotMatch(plain, /품절대란/);
  for (const extra of [{ soldOut: 'true' }, { lowStock: 1 }, { soldOut: false, lowStock: null }]) {
    assert.doesNotMatch(renderPage({ ...R, today: [deal('a', '팬히터 a', extra)], history: hist }), /품절대란/);
  }
  assert.match(renderPage({ ...R, today: [deal('a', '팬히터 a', { soldOut: true })], history: hist }), /품절대란/);
  assert.match(renderPage({ ...R, today: [deal('a', '팬히터 a', { lowStock: true })], history: hist }), /품절대란/);
  // 실제 deals.json(재고 필드 없음)으로 만든 페이지에도 없다
  const root = site(JSON.parse(readFileSync(new URL('../deals.json', import.meta.url), 'utf8')).deals);
  buildAll({ root, now: D1 });
  for (const it of ITEMS) assert.doesNotMatch(page(root, it.slug), /품절대란/);
  rmSync(root, { recursive: true });
});

test('끝난 딜: 마지막 딜은 기록으로만, 텔레그램·쿠팡 지금 가격 버튼, 고지문, 최근 딜 목록', () => {
  const history = [
    { ...H('last', 19300, '2026-10-14T07:33:00+09:00'), title: '신일 팬히터 마지막' },
    { ...H('old', 21000, '2026-10-10T07:33:00+09:00'), title: '신일 팬히터 예전' },
  ];
  const html = renderPage({ ...R, today: [], history });
  const ended = html.slice(html.indexOf('<div class="ended-deal">'), html.indexOf('</div>', html.indexOf('<div class="ended-deal">')));
  assert.match(ended, /<p>신일 팬히터 마지막<\/p>/);
  assert.match(ended, /기록 가격 <b>19,300원<\/b> <span class="muted">\(2026-10-14 확인, 지난 기록\)<\/span>/);
  // 텔레그램 버튼이 가격 기록 옆(같은 블록)에
  assert.ok(ended.includes(`<a class="tg-btn" href="${TG}" target="_blank" rel="noopener">✈️ 텔레그램으로 매일 받기</a>`));
  // 쿠팡 링크는 "쿠팡에서 지금 가격 보기" 전용 버튼(.btn-now-price, 카드 구매 버튼 .btn·chip 아님, sponsored)
  const NOW_BTN = '<a class="btn-now-price" href="https://link.coupang.com/a/last" target="_blank" rel="sponsored nofollow noopener">쿠팡에서 지금 가격 보기</a>';
  assert.ok(ended.includes(NOW_BTN));
  assert.doesNotMatch(ended, /class="chip"/);
  // 고지문은 버튼 아래가 아니라 푸터에만
  assert.ok(!ended.includes(DISCLOSURE));
  assert.doesNotMatch(html, /ended-disclosure/);
  // 라이브 구매 버튼·할인 배지·카드 없음
  assert.doesNotMatch(html, /class="btn"/);
  assert.doesNotMatch(html, /쿠팡에서 보기</);
  assert.doesNotMatch(html, /class="card"/);
  assert.doesNotMatch(html, /<s>/);
  // 최근 딜 기록 목록: 링크 없는 텍스트(날짜·가격)
  const list = html.slice(html.indexOf('<ul class="recent-deals">'), html.indexOf('</ul>', html.indexOf('<ul class="recent-deals">')));
  assert.match(list, /2026-10-14<\/span> 신일 팬히터 마지막 · 19,300원 <span class="muted">지난 딜<\/span><\/li>/);
  assert.match(list, /2026-10-10<\/span> 신일 팬히터 예전 · 21,000원 <span class="muted">지난 딜<\/span><\/li>/);
  assert.doesNotMatch(list, /<a /);
  // 딜 URL 앵커는 '쿠팡에서 지금 가격 보기' 버튼 하나뿐(예전 딜 URL로 가는 링크 없음)
  const dealAnchors = [...html.matchAll(/<a [^>]*href="https:\/\/link\.coupang\.com\/[^"]*"[^>]*>[^<]*<\/a>/g)].map(m => m[0]);
  assert.deepEqual(dealAnchors, [NOW_BTN]);
  assert.ok(!html.includes('https://link.coupang.com/a/old'));
  // 색인 유지, 고지문은 푸터에 한 번
  assert.ok(!html.includes(NOINDEX_META));
  assertDisclosureOnceInFooter(html);
});

test('고지문: 오늘 딜·끝난 딜·준비 중 페이지 모두 정확히 1번, 푸터 안에 메인과 같은 마크업', () => {
  const pages = {
    current: renderPage({ ...R, today: [deal('n', '팬히터 n')], history: [H('n', 25000, '2026-10-15T07:33:00+09:00')] }),
    ended: renderPage({ ...R, today: [], history: [H('last', 19300, '2026-10-14T07:33:00+09:00')] }),
    never: renderPage({ ...R, today: [], history: [] }),
  };
  for (const [name, html] of Object.entries(pages)) {
    assertDisclosureOnceInFooter(html, name);
    // 예전 상단 광고 바·끝난 딜 버튼 아래 고지문 없음
    assert.doesNotMatch(html, /<div class="disclosure"/, name);
    assert.doesNotMatch(html, /ended-disclosure/, name);
  }
});

test('헤더·푸터: 메인 index.html과 같은 마크업(경로만 절대경로), 로고는 /로, MY는 my.js만', () => {
  const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const abs = s => s.replace(/(src|srcset|href)="(assets\/|about\.html|privacy\.html)/g, '$1="/$2').replace('class="logo" href="index.html"', 'class="logo" href="/"');
  const block = (s, open, close) => s.slice(s.indexOf(open), s.indexOf(close) + close.length);
  const html = renderPage({ ...R, today: [], history: [] });
  const header = block(html, '<header class="top">', '</header>');
  assert.equal(header, abs(block(index, '<header class="top">', '</header>')));
  assert.equal(block(html, '<footer class="foot">', '</footer>'), abs(block(index, '<footer class="foot">', '</footer>')));
  // 헤더: 로고 그림(→ /), MY 버튼, 텔레그램 아이콘
  assert.ok(header.includes('<a class="logo" href="/"><picture><source srcset="/assets/logo.webp" type="image/webp"><img src="/assets/logo.png" alt="핫딜 오이데"'));
  assert.match(header, /<button type="button" class="my-btn" id="myBtn"/);
  assert.match(header, /<a class="tg-ico" href="https:\/\/t\.me\/hotdeal_oide"[^>]*><svg /);
  assert.doesNotMatch(header, /소개|개인정보처리방침|광고/);
  // MY 모달은 my.js만으로 동작. app.js는 메인 전용 요소(#q·#sort)를 전제하므로 싣지 않음
  assert.ok(html.includes('</footer>\n<script src="/assets/my.js"></script>\n</body>'));
  assert.doesNotMatch(html, /app\.js/);
});

test('끝난 딜 배너: h1 바로 아래 큰 배너 하나, 작은 회색 배지 없음, 오늘 딜·준비 중 페이지엔 없음', () => {
  const BANNER = '<p class="ended-banner" role="status">끝난 딜이에요</p>';
  const ended = renderPage({ ...R, today: [], history: [H('last', 19300, '2026-10-14T07:33:00+09:00')] });
  assert.ok(ended.includes(`<h1>팬히터 비교</h1>\n    ${BANNER}\n`));
  assert.equal(ended.split(BANNER).length - 1, 1);
  assert.doesNotMatch(ended, /class="tag ended"/);
  // 나머지는 그대로: 기록 가격·텔레그램·지금 가격 버튼
  assert.match(ended, /기록 가격 <b>19,300원<\/b>/);
  assert.match(ended, /class="btn-now-price"/);
  const current = renderPage({ ...R, today: [deal('n', '팬히터 n')], history: [H('n', 25000, '2026-10-15T07:33:00+09:00')] });
  const never = renderPage({ ...R, today: [], history: [] });
  for (const html of [current, never]) {
    assert.doesNotMatch(html, /ended-banner/);
    assert.doesNotMatch(html, /끝난 딜/);
  }
  const css = readFileSync(new URL('../assets/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.ended-banner\{[^}]*font-weight:800/);
  assert.doesNotMatch(css, /\.tag\.ended/);
});

test('끝난 딜 페이지: 같은 URL, noindex 없음, 사이트맵 유지, 파일·state 기록 유지', () => {
  const root = site([deal('fh1', '신일 팬히터')]);
  buildAll({ root, now: D1 });
  setDeals(root, [], '2026-10-16T07:30:00+09:00');
  const { changed } = buildAll({ root, now: D2 });
  assert.ok(changed.includes(FH));
  assert.ok(readPending(root).includes(FH));
  const html = page(root, '팬히터');
  assert.match(html, /끝난 딜/);
  assert.ok(!html.includes(NOINDEX_META));
  assert.ok(html.includes(`<link rel="canonical" href="${FH}">`));
  assert.match(sitemapOf(root), new RegExp(`<loc>${FH}</loc><lastmod>2026-10-16</lastmod>`));
  assert.equal(readState(root).items['팬히터'].deals.length, 1);
  // 준비 중(딜 한 번도 없음)은 계속 noindex + 사이트맵 제외
  assert.ok(page(root, '스마트TV').includes(NOINDEX_META));
  assert.ok(!sitemapOf(root).includes(TV));
  rmSync(root, { recursive: true });
});

test('끝난 딜 → 새 딜: 같은 URL에서 다시 오늘 딜로, 끝난 딜 표시 사라짐', () => {
  const root = site([deal('fh1', '신일 팬히터', { salePrice: 19300 })]);
  buildAll({ root, now: D1 });
  setDeals(root, [], '2026-10-16T07:30:00+09:00');
  buildAll({ root, now: D2 });
  assert.match(page(root, '팬히터'), /끝난 딜/);
  setDeals(root, [deal('fh2', '팬히터 신상', { salePrice: 25000 })], '2026-10-17T07:30:00+09:00');
  const { changed } = buildAll({ root, now: new Date('2026-10-17T00:00:00Z') });
  assert.ok(changed.includes(FH));
  const html = page(root, '팬히터');
  assert.doesNotMatch(html, /끝난 딜/);
  assert.match(html, /오늘의 팬히터 핫딜 1개/);
  assert.match(html, /href="https:\/\/link\.coupang\.com\/a\/fh2"[^>]*>쿠팡에서 보기/);
  assert.equal(titleOf(html), '팬히터 비교'); // 25,000원 > 기록 최저가 19,300원
  assert.ok(html.includes(`<link rel="canonical" href="${FH}">`));
  assert.deepEqual(readState(root).items['팬히터'].deals.map(d => d.url), ['https://link.coupang.com/a/fh2', 'https://link.coupang.com/a/fh1']);
  assert.match(sitemapOf(root), new RegExp(`<loc>${FH}</loc><lastmod>2026-10-17</lastmod>`));
  rmSync(root, { recursive: true });
});

test('지우지 않음: 딜이 있었던 품목은 며칠 연속 딜이 없어도 페이지·디렉터리·사이트맵·기록이 남는다', () => {
  const root = site([deal('fh1', '신일 팬히터'), deal('tv1', '삼성 스마트TV')]);
  buildAll({ root, now: D1 });
  for (let day = 16; day <= 30; day++) {
    setDeals(root, [], `2026-10-${day}T07:30:00+09:00`);
    buildAll({ root, now: new Date(`2026-10-${day}T00:00:00Z`) });
  }
  for (const [slug, url] of [['팬히터', FH], ['스마트TV', TV]]) {
    assert.ok(existsSync(join(root, 'deal', slug, 'index.html')));
    assert.match(page(root, slug), /끝난 딜/);
    assert.ok(!page(root, slug).includes(NOINDEX_META));
    assert.ok(sitemapOf(root).includes(`<loc>${url}</loc>`));
    assert.equal(readState(root).items[slug].deals.length, 1);
  }
  // 설정에서 빠져도 파일·사이트맵·기록 유지
  writeFileSync(join(root, 'data', 'item-pages.json'), JSON.stringify({ items: [ITEMS[1]] }));
  buildAll({ root, now: new Date('2026-10-31T00:00:00Z') });
  assert.ok(existsSync(join(root, 'deal', '팬히터', 'index.html')));
  assert.ok(sitemapOf(root).includes(`<loc>${FH}</loc>`));
  assert.equal(readState(root).items['팬히터'].deals.length, 1);
  rmSync(root, { recursive: true });
});

test('style.css: .btn-now-price는 일반 흐름 버튼, 반짝임은 버튼 안에 잘림, reduced-motion이면 애니메이션 끔', () => {
  const css = readFileSync(new URL('../assets/style.css', import.meta.url), 'utf8');
  const rule = css.match(/\.btn-now-price\{([^}]*)\}/)[1];
  assert.match(rule, /min-height:52px/);
  assert.match(rule, /overflow:hidden/);
  assert.match(rule, /position:relative/);
  assert.match(rule, /margin:[^;]*14px/); // 고지문 앞 아래 여백
  assert.doesNotMatch(css, /\.btn-now-price[^{]*\{[^}]*position:(fixed|sticky)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.btn-now-price,\.btn-now-price::after\{animation:none\}/);
});
