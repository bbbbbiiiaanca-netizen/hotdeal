import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { withSubId, matchDeals, titleMatches, mergeHistory, buildAll, flushIndexNow, readPending, pageUrl, renderPage, isIndexable, NOINDEX_META, DISCLOSURE, HISTORY_MAX, relatedDeals, mergeDaily, dailyFromDeals, priceStats, isRecordLow, priceGraph, productRef } from '../scripts/build-item-pages.mjs';
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
  // 첫 딜이라 이전 기록이 없음 → 최저가 아님, 기본 제목
  assert.match(html, /<title>팬히터 가격 비교<\/title>/);
  assert.match(html, /<h1>팬히터 가격 비교<\/h1>/);
  assert.match(html, /신일 팬히터 SFH-1/);
  assert.match(html, /<b>19,300원<\/b>/);
  assert.match(html, /<s>30,000원<\/s>/);
  assert.match(html, /-36%/);
  assert.match(html, /href="https:\/\/link\.coupang\.com\/a\/fh1" data-subid-missing="1" target="_blank" rel="sponsored nofollow noopener">쿠팡에서 지금 가격 보기</);
  assert.match(html, /<link rel="canonical" href="https:\/\/hotdeal\.sooinlab\.com\/deal\/%ED%8C%AC%ED%9E%88%ED%84%B0\/">/);
  assert.match(html, /href="\/assets\/style\.css"/);
  assert.match(html, /2026년 10월 15일 07:33 \(KST\)/);
  assertNoBodyTelegram(html);
  assertDisclosureOnceInFooter(html);
  rmSync(root, { recursive: true });
});

test('상태 (b): 오늘 딜 없고 기록 있음 → 끝난 딜(최근 딜 기록 칸 없음)', () => {
  const root = site([deal('fh1', '신일 팬히터')]);
  buildAll({ root, now: D1 });
  setDeals(root, [deal('x', '다른 상품')], '2026-10-16T07:30:00+09:00');
  const { changed } = buildAll({ root, now: D2 });
  assert.ok(changed.includes(pageUrl('팬히터')));
  const html = page(root, '팬히터');
  assert.match(html, /끝난 딜/);
  assert.doesNotMatch(html, /최근 딜 기록|recent-deals/);
  assertNoBodyTelegram(html);
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
  assert.doesNotMatch(html, /쿠팡에서 (지금 가격 )?보기/);
  assert.doesNotMatch(html, /data-track/);
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
const REQ_LINE = '<p class="req"><a href="https://t.me/hotdealoide_bot?start=request" target="_blank" rel="noopener">원하는 품목 신청</a></p>';
function assertNoBodyTelegram(html) {
  // 푸터의 아주 작은 '원하는 품목 신청'(봇 링크)은 메인과 같은 공통 푸터라 제외
  const body = html.slice(html.indexOf('</header>')).replace(REQ_LINE, '');
  assert.doesNotMatch(body, /t\.me|tg-btn|hotdeal_oide|텔레그램|Telegram/);
  assert.equal(html.split('https://t.me/hotdeal_oide').length - 1, 1);
}

const ogOf = html => html.match(/<meta property="og:title" content="([^"]*)">/)[1];
const DL = (...pairs) => pairs.map(([date, minPrice]) => ({ date, minPrice }));

test('mergeDaily: 날짜순, 같은 날은 더 낮은 값으로만 갱신, 날짜 중복 없음, 0·음수·잘못된 값 제외, 입력 불변', () => {
  let d = mergeDaily([], '2026-10-15', 20000);
  d = mergeDaily(d, '2026-10-15', 25000); // 같은 날 더 비싼 값 → 그대로
  assert.deepEqual(d, DL(['2026-10-15', 20000]));
  d = mergeDaily(d, '2026-10-15', 18000); // 같은 날 더 싼 값 → 갱신
  assert.deepEqual(d, DL(['2026-10-15', 18000]));
  d = mergeDaily(d, '2026-10-13', 30000);
  for (const p of [0, -5, NaN, Infinity, '100', null, undefined]) d = mergeDaily(d, '2026-10-14', p);
  d = mergeDaily(d, '2026/10/14', 100);
  assert.deepEqual(d, DL(['2026-10-13', 30000], ['2026-10-15', 18000]));
  // 기존 기록의 중복·잘못된 항목도 정리, 입력은 바꾸지 않음
  const prev = [...DL(['2026-10-16', 5], ['2026-10-01', 9], ['2026-10-16', 3], ['2026-10-02', 0]), null, { date: 'x', minPrice: 1 }];
  const copy = structuredClone(prev);
  assert.deepEqual(mergeDaily(prev), DL(['2026-10-01', 9], ['2026-10-16', 3]));
  assert.deepEqual(prev, copy);
  assert.deepEqual(mergeDaily(undefined), []);
});

test('productRef: 쿠팡 상품 URL이면 productId, 단축 링크·그 밖은 url, 빈 값은 없음', () => {
  assert.deepEqual(productRef('https://www.coupang.com/vp/products/7335597976?itemId=1'), { productId: '7335597976' });
  assert.deepEqual(productRef('https://link.coupang.com/a/abc'), { url: 'https://link.coupang.com/a/abc' });
  assert.deepEqual(productRef('https://evil.example/vp/products/1'), { url: 'https://evil.example/vp/products/1' });
  assert.deepEqual(productRef('https://www.coupang.com/vp/products/12x'), { url: 'https://www.coupang.com/vp/products/12x' });
  assert.deepEqual(productRef(undefined), {});
});

test('mergeDaily: 같은 날 더 싼 가격이면 상품명·productId/url도 교체, 같거나 비싸면 기존 항목 유지', () => {
  const A = { title: '팬히터 A', url: 'https://link.coupang.com/a/A' };
  const B = { title: '팬히터 B', url: 'https://www.coupang.com/vp/products/222' };
  const C = { title: '팬히터 C', url: 'https://link.coupang.com/a/C' };
  let d = mergeDaily([], '2026-10-15', 20000, A);
  assert.deepEqual(d, [{ date: '2026-10-15', minPrice: 20000, title: '팬히터 A', url: 'https://link.coupang.com/a/A' }]);
  d = mergeDaily(d, '2026-10-15', 19000, B); // 더 쌈 → B로 교체(url에서 productId)
  assert.deepEqual(d, [{ date: '2026-10-15', minPrice: 19000, title: '팬히터 B', productId: '222' }]);
  d = mergeDaily(d, '2026-10-15', 19000, C); // 같음 → 유지
  d = mergeDaily(d, '2026-10-15', 25000, C); // 비쌈 → 유지
  assert.deepEqual(d, [{ date: '2026-10-15', minPrice: 19000, title: '팬히터 B', productId: '222' }]);
  // 기존 항목의 상품 정보는 다시 합쳐도 보존
  assert.deepEqual(mergeDaily(d), d);
});

test('dailyFromDeals: seenAt(KST 날짜)+salePrice가 둘 다 유효한 딜만, 추정 없음, 딜의 title·url도 옮긴다', () => {
  assert.deepEqual(dailyFromDeals([
    H('a', 20000, '2026-10-14T16:00:00Z'), // KST 10-15
    H('b', 19000, '2026-10-15T07:00:00+09:00'), // 같은 KST 날 → 더 낮은 값(상품명·url도 b로)
    H('c', 1000, undefined),
    H('d', 1000, 'not a date'),
    H('e', 0, '2026-10-10T07:00:00+09:00'),
    H('f', 30000, '2026-10-09T07:00:00+09:00'),
  ]), [
    { date: '2026-10-09', minPrice: 30000, title: '팬히터 f', url: 'https://link.coupang.com/a/f' },
    { date: '2026-10-15', minPrice: 19000, title: '팬히터 b', url: 'https://link.coupang.com/a/b' },
  ]);
  assert.deepEqual(dailyFromDeals(undefined), []);
});

test('priceStats: 최고·평균(반올림)·최저·기간·일수, 기록 없으면 null', () => {
  assert.equal(priceStats([]), null);
  assert.deepEqual(priceStats(DL(['2026-10-15', 100], ['2026-10-13', 300], ['2026-10-14', 201])),
    { days: 3, start: '2026-10-13', end: '2026-10-15', min: 100, max: 300, avg: 200 });
});

test('isRecordLow: 오늘 이전 서로 다른 날짜 2일 이상 + 이전 모든 일별 최저가보다 엄격히 낮을 때만', () => {
  const two = DL(['2026-10-13', 20000], ['2026-10-14', 19000]);
  assert.deepEqual(isRecordLow(two, '2026-10-15', 15200), { prev: 19000, price: 15200, pct: 20 });
  // 동률·더 비싼 값은 아님
  assert.equal(isRecordLow(two, '2026-10-15', 19000), null);
  assert.equal(isRecordLow(two, '2026-10-15', 19500), null);
  // 오늘 이전 기록 1일뿐이면 아님, 같은 날짜 중복은 1일로 셈
  assert.equal(isRecordLow(DL(['2026-10-14', 19000]), '2026-10-15', 1000), null);
  assert.equal(isRecordLow(DL(['2026-10-14', 19000], ['2026-10-14', 18000]), '2026-10-15', 1000), null);
  // 오늘 기록(같은 날짜)·이후 날짜는 '이전'으로 세지 않음
  assert.equal(isRecordLow(DL(['2026-10-14', 19000], ['2026-10-15', 15000]), '2026-10-15', 15000), null);
  assert.equal(isRecordLow(DL(['2026-10-14', 19000], ['2026-10-16', 18000]), '2026-10-15', 1000), null);
  // 오늘 기록이 이미 합쳐져 있어도 판정은 그대로(같은 날 재실행)
  assert.ok(isRecordLow([...two, ...DL(['2026-10-15', 15200])], '2026-10-15', 15200));
  assert.equal(isRecordLow(two, '2026-10-15', 0), null);
});

test('isRecordLow: 오늘 앞서 더 싼 값이 기록됐으면 지금 가격은 최저가 아님(오늘 일별 최저와 같을 때만)', () => {
  const daily = DL(['2026-10-13', 100], ['2026-10-14', 100], ['2026-10-15', 50]);
  assert.equal(isRecordLow(daily, '2026-10-15', 80, 50), null);
  assert.equal(isRecordLow(daily, '2026-10-15', 80), null); // todayMin 생략 시 daily의 오늘 최저(50) 사용
  assert.deepEqual(isRecordLow(daily, '2026-10-15', 50, 50), { prev: 100, price: 50, pct: 50 });
  const page = renderPage({ ...R, today: [deal('n', '팬히터 n', { salePrice: 80 })], history: [], daily });
  assert.equal(titleOf(page), '팬히터 가격 비교');
  assert.doesNotMatch(page, /class="pg-low"/);
});

const twOf = html => html.match(/<meta name="twitter:title" content="([^"]*)">/)[1];

test('제목 고정: 판정과 무관하게 항상 "{품목} 가격 비교", 화면·메타 어디에도 "최저가" 없음, 판정 충족 시만 기간 배너', () => {
  const today = [deal('n', '팬히터 n', { salePrice: 15200 }), deal('m', '팬히터 m', { salePrice: 30000 })];
  const prior = DL(['2026-10-13', 20000], ['2026-10-14', 19000]);
  const low = renderPage({ ...R, today, history: [], daily: mergeDaily(prior, '2026-10-15', 15200, today[0]) });
  for (const get of [titleOf, h1Of, ogOf, twOf]) assert.equal(get(low), '팬히터 가격 비교');
  assert.equal(descOf(low), '팬히터 가격 비교 | 오늘의 쿠팡 핫딜·특가 모음, 핫딜 오이데');
  assert.ok(low.includes('<h1>팬히터 가격 비교</h1>\n    <p class="pg-low">🔥 우리 기록(2026-10-13 ~ 2026-10-15, 3일) 중 가장 낮은 가격 · 19,000원 → 15,200원 (▼20%)</p>'));
  assert.ok(!low.includes('최저가'));
  const cases = {
    above: renderPage({ ...R, today: [deal('n', '팬히터 n', { salePrice: 25000 })], history: [], daily: mergeDaily(prior, '2026-10-15', 25000) }),
    tie: renderPage({ ...R, today: [deal('n', '팬히터 n', { salePrice: 19000 })], history: [], daily: mergeDaily(prior, '2026-10-15', 19000) }),
    oneDay: renderPage({ ...R, today: [deal('n', '팬히터 n', { salePrice: 100 })], history: [], daily: DL(['2026-10-14', 19000], ['2026-10-15', 100]) }),
    ended: renderPage({ ...R, today: [], history: [H('o', 100, '2026-10-10T07:00:00+09:00')], daily: prior }),
    never: renderPage({ ...R, today: [], history: [] }),
  };
  for (const [name, html] of Object.entries(cases)) {
    for (const get of [titleOf, h1Of, ogOf, twOf]) assert.equal(get(html), '팬히터 가격 비교', name);
    assert.equal(descOf(html), '팬히터 가격 비교 | 오늘의 쿠팡 핫딜·특가 모음, 핫딜 오이데', name);
    assert.doesNotMatch(html, /class="pg-low"|우리 기록|가장 낮은 가격 ·|오늘 핫딜<\/h1>/, name);
    assert.ok(!html.includes('최저가'), name);
  }
});

test('가격 그래프: 2일 이상이면 SVG 선·점 + 최고·평균·최저 + 기록 기준, 빈 날은 선을 끊는다(보간 없음)', () => {
  const html = renderPage({ ...R, today: [], history: [H('o', 1, '2026-10-10T07:00:00+09:00')],
    daily: DL(['2026-10-13', 55140], ['2026-10-14', 60000], ['2026-10-16', 58000]) });
  const sec = html.slice(html.indexOf('<section class="pg"'), html.indexOf('</section>', html.indexOf('<section class="pg"')));
  assert.match(sec, /<svg class="pg-svg" viewBox="0 0 600 180" role="img" aria-label="[^"]+">/);
  assert.match(html, /\.pg-svg\{display:block;width:100%;height:auto\}/);
  assert.match(html, /\.pg\{[^}]*background:#fff/);
  // 기록한 날만 점(빈 15일엔 점 없음)
  assert.equal((sec.match(/<circle /g) ?? []).length, 3);
  // 13→14만 이어지고 14→16(빈 날 15일)은 끊김: 선분 1개
  assert.equal((sec.match(/<path d="([^"]*)"/)[1].match(/M/g) ?? []).length, 1);
  assert.match(sec, /<dt>최고<\/dt><dd>60,000원<\/dd>/);
  assert.match(sec, /<dt>평균<\/dt><dd>57,713원<\/dd>/);
  assert.match(sec, /<dt>최저<\/dt><dd>55,140원<\/dd>/);
  assert.ok(sec.includes('기록 기간: 2026-10-13 ~ 2026-10-16, 3일 (날마다 확인한 가장 낮은 가격)'));
  assert.doesNotMatch(sec, /NaN|undefined/);
});

test('가격 그래프: 기록 1일이면 점 하나 + 부족 안내, 0일이면 기록 없음 안내(SVG 없음)', () => {
  const page1 = renderPage({ ...R, today: [deal('n', '팬히터 n', { salePrice: 55140 })], history: [], daily: DL(['2026-10-15', 55140]) });
  const one = page1.slice(page1.indexOf('<section class="pg"'), page1.indexOf('</section>', page1.indexOf('<section class="pg"')));
  assert.match(one, /<svg class="pg-svg" viewBox="0 0 600 60"/);
  assert.equal((one.match(/<circle /g) ?? []).length, 1); // 헤더 텔레그램 아이콘의 circle은 제외(그래프 섹션만)
  assert.doesNotMatch(one, /class="pg-line"/);
  assert.ok(one.includes('기록 기간: 2026-10-15 ~ 2026-10-15, 1일 · 추이를 판단하기엔 기록이 부족해요'));
  assert.doesNotMatch(one, /기록 기준:|<dt>평균/);
  const none = renderPage({ ...R, today: [], history: [] });
  assert.ok(none.includes('아직 가격 기록이 없어요'));
  assert.doesNotMatch(none, /<svg class="pg-svg"|class="pg-dot"/);
  assert.equal(priceGraph([]), priceGraph(DL(['2026-10-15', 0])));
});

test('가격 그래프: 점마다 날짜·가격·상품명 툴팁, 그래프 아래 기록 상세(최신순, 링크 없는 텍스트, 이스케이프)', () => {
  const daily = [
    { date: '2026-10-13', minPrice: 21000, title: '팬히터 <b>"A"</b> & 1', url: 'https://link.coupang.com/re/AFFSDP?lptag=AF1' },
    { date: '2026-10-14', minPrice: 19000, title: '팬히터 B', productId: '222' },
    { date: '2026-10-15', minPrice: 20000 }, // 예전 기록(상품명 없음)
  ];
  const html = renderPage({ ...R, today: [], history: [H('o', 1, '2026-10-10T07:00:00+09:00')], daily });
  const sec = html.slice(html.indexOf('<section class="pg"'), html.indexOf('</section>', html.indexOf('<section class="pg"')));
  const tips = [...sec.matchAll(/<circle [^>]*><title>([^<]*)<\/title><\/circle>/g)].map(m => m[1]);
  assert.deepEqual(tips, ['2026-10-13 21,000원 · 팬히터 &lt;b&gt;&quot;A&quot;&lt;/b&gt; &amp; 1', '2026-10-14 19,000원 · 팬히터 B', '2026-10-15 20,000원']);
  const detail = sec.slice(sec.indexOf('<div class="pg-detail">'));
  assert.ok(sec.indexOf('<svg') < sec.indexOf('<div class="pg-detail">'));
  assert.match(detail, /<h3 class="pg-h3">기록 상세<\/h3>/);
  const rows = [...detail.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => m[1]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0], '<span class="pg-date">2026-10-15</span> <b>20,000원</b> <span class="pg-name"><span class="muted">상품명 기록 없음</span></span>');
  assert.equal(rows[1], '<span class="pg-date">2026-10-14</span> <b>19,000원</b> <span class="pg-name">팬히터 B</span>');
  // 상품명은 링크 없이 이스케이프된 텍스트만
  assert.equal(rows[2], '<span class="pg-date">2026-10-13</span> <b>21,000원</b> <span class="pg-name">팬히터 &lt;b&gt;&quot;A&quot;&lt;/b&gt; &amp; 1</span>');
  assert.ok(!html.includes('<b>"A"</b>'));
  assert.ok(!html.includes('최저가'));
});

test('기록 상세: <a> 태그 없음, 기록 url·productId는 저장 데이터에 남고 페이지 기록 상세에는 안 나옴', () => {
  const URL_A = 'https://link.coupang.com/re/AFFSDP?lptag=AF1&pageKey=777';
  let daily = mergeDaily([], '2026-10-13', 21000, { title: '팬히터 A', url: URL_A });
  daily = mergeDaily(daily, '2026-10-14', 19000, { title: '팬히터 B', url: 'https://www.coupang.com/vp/products/222?itemId=9' });
  const before = structuredClone(daily);
  const html = renderPage({ ...R, today: [], history: [H('o', 1, '2026-10-10T07:00:00+09:00')], daily });
  const sec = html.slice(html.indexOf('<section class="pg"'), html.indexOf('</section>', html.indexOf('<section class="pg"')));
  const detail = sec.slice(sec.indexOf('<div class="pg-detail">'));
  // (a) 기록 상세 영역에 <a 태그가 하나도 없음
  assert.ok(detail.includes('팬히터 A') && detail.includes('팬히터 B'));
  assert.doesNotMatch(detail, /<a[\s>]/i);
  // (b) 렌더 후에도 저장 데이터에는 url·productId가 그대로
  assert.deepEqual(daily, before);
  assert.equal(daily[0].url, URL_A);
  assert.equal(daily[1].productId, '222');
  // (c) 기록 url(이스케이프 형태 포함)·상품 페이지 링크가 기록 상세에 나타나지 않음
  for (const s of [URL_A, URL_A.replace(/&/g, '&amp;'), 'link.coupang.com', 'coupang.com/vp/products']) assert.ok(!detail.includes(s), s);
});

test('buildAll: 기록 url·productId는 item-history.json에 저장되고, 페이지 기록 상세에는 링크로 나오지 않음', () => {
  const root = site([deal('fh1', '팬히터 A', { salePrice: 20000 })], '2026-10-15T07:33:00+09:00');
  buildAll({ root, now: D1 });
  const rec = readState(root).items['팬히터'].daily;
  assert.equal(rec.length, 1);
  assert.equal(rec[0].url, 'https://link.coupang.com/a/fh1');
  const html = page(root, '팬히터');
  const detail = html.slice(html.indexOf('<div class="pg-detail">'), html.indexOf('</section>', html.indexOf('<div class="pg-detail">')));
  assert.ok(detail.includes('<span class="pg-name">팬히터 A</span>'));
  assert.doesNotMatch(detail, /<a[\s>]/i);
  assert.ok(!detail.includes('https://link.coupang.com/a/fh1'));
  assert.ok(html.includes('https://link.coupang.com/a/fh1')); // 쿠팡에서 지금 가격 보기 버튼은 그대로
  rmSync(root, { recursive: true });
});

test('buildAll: 일별 기록 누적·같은 날 재실행 min(상품명·url 함께)·1회 이관, 기간 배너는 이전 2일 이상부터', () => {
  const root = site([deal('fh1', '팬히터 A', { salePrice: 20000 })], '2026-10-15T07:33:00+09:00');
  // 예전 state(daily 없음): 이관 가능한 10-13 기록 하나 + seenAt 없는 기록 + 예전 누적 최저가 필드
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state', 'item-history.json'), JSON.stringify({ items: { 팬히터: { minSalePrice: 5000, deals: [
    H('old', 21000, '2026-10-13T07:30:00+09:00'), { ...H('x', 5000), seenAt: undefined },
  ] } } }));
  buildAll({ root, now: D1 });
  const E = (date, minPrice, id, title) => ({ date, minPrice, title, url: `https://link.coupang.com/a/${id}` });
  assert.deepEqual(readState(root).items['팬히터'].daily, [E('2026-10-13', 21000, 'old', '팬히터 old'), E('2026-10-15', 20000, 'fh1', '팬히터 A')]);
  assert.equal(readState(root).items['팬히터'].minSalePrice, undefined); // 날짜 없는 예전 값은 옮기지 않고 지움
  assert.equal(titleOf(page(root, '팬히터')), '팬히터 가격 비교'); // 이전 기록 1일뿐
  // 같은 날 재실행: 더 싼 딜 → min 갱신, 더 비싼 딜 → 유지, 날짜 중복 없음
  setDeals(root, [deal('fh2', '팬히터 B', { salePrice: 19500 })], '2026-10-15T12:00:00+09:00');
  buildAll({ root, now: D1 });
  setDeals(root, [deal('fh3', '팬히터 C', { salePrice: 26000 })], '2026-10-15T18:00:00+09:00');
  buildAll({ root, now: D1 });
  assert.deepEqual(readState(root).items['팬히터'].daily, [E('2026-10-13', 21000, 'old', '팬히터 old'), E('2026-10-15', 19500, 'fh2', '팬히터 B')]);
  // 다음 날: 이전 2일(21,000·19,500)과 같은 값은 배너 없음, 더 싸면 배너(제목은 늘 고정)
  setDeals(root, [deal('fh4', '팬히터 D', { salePrice: 19500 })], '2026-10-16T07:30:00+09:00');
  buildAll({ root, now: D2 });
  assert.doesNotMatch(page(root, '팬히터'), /class="pg-low"/);
  setDeals(root, [deal('fh5', '팬히터 E', { salePrice: 15600 })], '2026-10-17T07:30:00+09:00');
  buildAll({ root, now: new Date('2026-10-17T00:00:00Z') });
  let html = page(root, '팬히터');
  assert.equal(titleOf(html), '팬히터 가격 비교');
  assert.ok(html.includes('🔥 우리 기록(2026-10-13 ~ 2026-10-17, 4일) 중 가장 낮은 가격 · 19,500원 → 15,600원 (▼20%)'));
  assert.ok(html.includes('기록 기간: 2026-10-13 ~ 2026-10-17, 4일 (날마다 확인한 가장 낮은 가격)'));
  assert.ok(!html.includes('최저가'));
  // 같은 날 재실행해도 판정 유지(오늘 기록은 비교 대상 아님)
  setDeals(root, [deal('fh5', '팬히터 E', { salePrice: 15600 })], '2026-10-17T12:00:00+09:00');
  buildAll({ root, now: new Date('2026-10-17T03:00:00Z') });
  assert.ok(page(root, '팬히터').includes('class="pg-low">🔥 우리 기록(2026-10-13 ~ 2026-10-17, 4일)'));
  // 딜 없는 날은 기록하지 않음(0 채움 없음), 끝난 딜 페이지는 배너 없음
  setDeals(root, [], '2026-10-18T07:30:00+09:00');
  buildAll({ root, now: new Date('2026-10-18T00:00:00Z') });
  assert.equal(readState(root).items['팬히터'].daily.length, 4);
  assert.equal(titleOf(page(root, '팬히터')), '팬히터 가격 비교');
  assert.doesNotMatch(page(root, '팬히터'), /class="pg-low"/);
  // 이관은 1회: daily가 생긴 뒤엔 다시 만들지 않음(스마트TV는 기록 0일로 고정)
  assert.deepEqual(readState(root).items['스마트TV'].daily, []);
  // 기간 제한 없음: 딜 기록(HISTORY_MAX개)과 달리 일별 기록은 계속 쌓인다
  for (let day = 19; day <= 31; day++) {
    setDeals(root, [deal(`z${day}`, `팬히터 ${day}`, { salePrice: 30000 })], `2026-10-${day}T07:30:00+09:00`);
    buildAll({ root, now: new Date(`2026-10-${day}T00:00:00Z`) });
  }
  const rec = readState(root).items['팬히터'];
  assert.equal(rec.daily.length, 17);
  assert.equal(rec.deals.length, HISTORY_MAX);
  html = page(root, '팬히터');
  assert.ok(html.includes('기록 기간: 2026-10-13 ~ 2026-10-31, 17일 (날마다 확인한 가장 낮은 가격)'));
  assertDisclosureOnceInFooter(html);
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

test('끝난 딜: 마지막 딜은 기록으로만, 쿠팡 지금 가격 버튼, 고지문, 본문 텔레그램·최근 딜 목록 없음', () => {
  const history = [
    { ...H('last', 19300, '2026-10-14T07:33:00+09:00'), title: '신일 팬히터 마지막' },
    { ...H('old', 21000, '2026-10-10T07:33:00+09:00'), title: '신일 팬히터 예전' },
  ];
  const html = renderPage({ ...R, today: [], history });
  const ended = html.slice(html.indexOf('<div class="ended-deal">'), html.indexOf('</div>', html.indexOf('<div class="ended-deal">')));
  assert.match(ended, /<p>신일 팬히터 마지막<\/p>/);
  assert.match(ended, /기록 가격 <b>19,300원<\/b> <span class="muted">\(2026-10-14 확인, 지난 기록\)<\/span>/);
  // 본문 텔레그램 버튼 없음(헤더 종이비행기만)
  assert.doesNotMatch(ended, /tg-btn|t\.me/);
  assertNoBodyTelegram(html);
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
  // 최근 딜 기록 칸 없음(위 카드와 중복)
  assert.doesNotMatch(html, /최근 딜 기록|recent-deals|신일 팬히터 예전/);
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
  const abs = s => s.replace(/(src|srcset|href)="(assets\/|about\.html|privacy\.html)/g, '$1="/$2').replace('class="logo" href="index.html"', 'class="logo" href="/"').replace(/<h1 class="logo-h1">(.*?)<\/h1>/, '$1'); // 품목 페이지는 상품명이 h1이라 로고는 h1 밖 일반 링크
  const block = (s, open, close) => s.slice(s.indexOf(open), s.indexOf(close) + close.length);
  const html = renderPage({ ...R, today: [], history: [] });
  const header = block(html, '<header class="top">', '</header>');
  assert.equal(header, abs(block(index, '<header class="top">', '</header>')));
  // 푸터: 메인과 같되 텔레그램 버튼 줄만 뺌
  const noTg = s => s.replace(/  <p><a class="tg-btn"[^\n]*<\/a><\/p>\n/, '');
  assert.equal(block(html, '<footer class="foot">', '</footer>'), noTg(abs(block(index, '<footer class="foot">', '</footer>'))));
  // 헤더: 로고 그림(→ /), MY 버튼, 텔레그램 아이콘
  assert.ok(header.includes('<a class="logo" href="/"><picture><source srcset="/assets/logo.webp" type="image/webp"><img src="/assets/logo.png" alt="핫딜 오이데"'));
  assert.match(header, /<button type="button" class="my-btn" id="myBtn"/);
  assert.match(header, /<a class="tg-ico" href="https:\/\/t\.me\/hotdeal_oide"[^>]*><svg /);
  assert.doesNotMatch(header, /소개|개인정보처리방침|광고/);
  // MY 모달은 my.js만으로 동작. app.js는 메인 전용 요소(#q·#sort)를 전제하므로 싣지 않음
  assert.ok(html.includes('</footer>\n<script src="/assets/my.js"></script>\n<script src="/assets/install.js"></script>\n</body>'));
  // 홈 화면 추가: 메인과 같은 버튼 + manifest
  assert.match(header, /<button type="button" class="inst-btn" id="installBtn"/);
  assert.ok(html.includes('<link rel="manifest" href="/manifest.json">'));
  assert.ok(html.includes(REQ_LINE));
  assert.doesNotMatch(html, /app\.js/);
});

test('끝난 딜 배너: h1 바로 아래 큰 배너 하나, 작은 회색 배지 없음, 오늘 딜·준비 중 페이지엔 없음', () => {
  const BANNER = '<p class="ended-banner" role="status">끝난 딜이에요</p>';
  const ended = renderPage({ ...R, today: [], history: [H('last', 19300, '2026-10-14T07:33:00+09:00')] });
  assert.ok(ended.includes(`<h1>팬히터 가격 비교</h1>\n    ${BANNER}\n`));
  assert.equal(ended.split(BANNER).length - 1, 1);
  assert.doesNotMatch(ended, /class="tag ended"/);
  // 나머지는 그대로: 기록 가격·지금 가격 버튼
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
  assert.match(html, /href="https:\/\/link\.coupang\.com\/a\/fh2"[^>]*>쿠팡에서 지금 가격 보기</);
  assert.equal(titleOf(html), '팬히터 가격 비교'); // 이전 기록 2일(10-15·10-16 중 딜 있던 날은 10-15뿐) 미만
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

test('h1: 품목 페이지마다 h1은 "{품목} 비교" 하나뿐, 로고는 h1 밖의 일반 링크', () => {
  const pages = [
    renderPage({ ...R, today: [deal('n', '팬히터 n')], history: [H('n', 25000, '2026-10-15T07:33:00+09:00')] }),
    renderPage({ ...R, today: [], history: [H('last', 19300, '2026-10-14T07:33:00+09:00')] }),
    renderPage({ ...R, today: [], history: [] }),
  ];
  for (const html of pages) {
    const h1s = [...html.matchAll(/<h1[\s>][\s\S]*?<\/h1>/g)].map(m => m[0]);
    assert.equal(h1s.length, 1);
    assert.match(h1s[0], /^<h1>팬히터 (가격 비교|최저가)<\/h1>$/);
    assert.doesNotMatch(html, /logo-h1/);
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    assert.doesNotMatch(header, /<h1/);
    assert.match(header, /<a class="logo" href="\/">/);
  }
});

test('살아 있는 딜: 카드마다 큰 "쿠팡에서 지금 가격 보기" 버튼, 클릭 기록용 data-id·data-cat', () => {
  const root = site([deal('fh1', '신일 팬히터 SFH-1')]);
  buildAll({ root, now: D1 });
  const html = page(root, '팬히터');
  assert.match(html, /<a class="btn-now-price" data-track="1" data-id="fh1" data-cat="[^"]+" data-title="신일 팬히터 SFH-1" href="https:\/\/link\.coupang\.com\/a\/fh1"/);
  assert.doesNotMatch(html, /class="btn"/);
  assert.equal(html.match(/<h1>/g).length, 1);
  assert.equal((html.replace(REQ_LINE, '').match(/t\.me\//g) || []).length, 1);
  rmSync(root, { recursive: true });
});

test('my.js: data-track 클릭을 메인 카드와 같은 recordClick으로 기록', () => {
  const js = readFileSync(new URL('../assets/my.js', import.meta.url), 'utf8');
  assert.match(js, /closest\('a\[data-track\]'\)/);
  assert.match(js, /recordClick\(\{ category: a\.dataset\.cat/);
});

test('비슷한 핫딜: 같은 카테고리 실제 딜 최대 4개, 품목 페이지 있으면 그 페이지로, 없으면 파트너스 링크', () => {
  const cat = '가전·디지털';
  const deals = [
    deal('f1', '팬히터 A', { category: cat }),
    deal('t1', '스마트TV B', { category: cat }),
    deal('x1', '전기포트 C', { category: cat }),
    deal('x2', '드라이기 D', { category: cat }),
    deal('x3', '청소기 E', { category: cat }),
    deal('x4', '토스터 F', { category: cat }),
    deal('o1', '선크림', { category: '뷰티' }),
  ];
  const item = ITEMS[0];
  const today = matchDeals(deals, item);
  const rel = relatedDeals({ deals, item, items: ITEMS, today });
  assert.equal(rel.length, 4);
  assert.ok(rel.every(r => r.deal.category === cat && !r.deal.title.includes('팬히터')));
  assert.equal(rel[0].page, '/deal/' + encodeURIComponent('스마트TV') + '/');
  assert.equal(rel[1].page, null);
  const html = renderPage({ ...R, today, history: [], related: rel });
  assert.match(html, /<h2 class="sec">비슷한 핫딜<\/h2>/);
  assert.equal((html.match(/class="rel-card"/g) ?? []).length, 4);
  assert.ok(html.includes(`href="${rel[0].page}"`));
  assert.match(html, /href="https:\/\/link\.coupang\.com\/a\/x1" data-track="1"[^>]*rel="sponsored nofollow noopener"/);
  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.doesNotMatch(html, /고르는 방법|고르는 기준|품목별 핫딜|class="chip"|전체 핫딜/);
});

test('비슷한 핫딜: 같은 카테고리 딜이 없으면 섹션을 생략하고, 끝난 딜 페이지도 설명·칩이 없다', () => {
  const item = ITEMS[0];
  assert.deepEqual(relatedDeals({ deals: [deal('o1', '선크림', { category: '뷰티' })], item, items: ITEMS, today: [] }), []);
  const h = { ...deal('a', '팬히터 a'), seenAt: '2026-10-14T07:00:00+09:00' };
  for (const html of [renderPage({ ...R, today: [], history: [h] }), renderPage({ ...R, today: [], history: [] })]) {
    assert.doesNotMatch(html, /비슷한 핫딜|고르는 방법|고르는 기준|품목별 핫딜|class="chip"/);
  }
});
