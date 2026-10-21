import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { withSubId, matchDeals, titleMatches, mergeHistory, buildAll, flushIndexNow, readPending, pageUrl, renderPage, isIndexable, NOINDEX_META, DISCLOSURE, HISTORY_MAX, relatedDeals } from '../scripts/build-item-pages.mjs';
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
  assert.match(html, /<title>팬히터 가격 비교 \(2026-10-15 기준\)<\/title>/);
  assert.match(html, /<h1>팬히터 가격 비교 \(2026-10-15 기준\)<\/h1>/);
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

test('제목: title·h1·description·og·twitter 모두 "{품목} 가격 비교 (YYYY-MM-DD 기준)", 날짜는 갱신일(KST)', () => {
  const T = '팬히터 가격 비교 (2026-10-15 기준)';
  const cases = [
    renderPage({ ...R, today: [deal('n', '팬히터 n', { salePrice: 25000 })],
      history: [H('n', 25000, '2026-10-15T07:33:00+09:00'), H('o', 19300, '2026-10-10T07:00:00+09:00')] }),
    renderPage({ ...R, today: [deal('n', '팬히터 n', { salePrice: 19300 })],
      history: [H('n', 19300, '2026-10-13T16:00:00Z'), H('o', 19300, '2026-10-01T07:00:00+09:00')] }),
    renderPage({ ...R, minSalePrice: 15000, today: [deal('n', '팬히터 n', { salePrice: 19300 })], history: [H('n', 19300, '2026-10-14T07:33:00+09:00')] }),
    renderPage({ ...R, today: [], history: [] }),
    renderPage({ ...R, today: [], history: [H('o', 100, '2026-10-10T07:00:00+09:00')] }),
  ];
  for (const html of cases) {
    assert.equal(titleOf(html), T);
    assert.equal(h1Of(html), T);
    assert.equal(descOf(html), `${T} | 오늘의 쿠팡 핫딜·특가 모음, 핫딜 오이데`);
    for (const m of html.matchAll(/<meta (?:property|name)="(?:og|twitter):(?:title|description)" content="([^"]*)">/g)) assert.ok(m[1].startsWith(T), m[0]);
    // 가장 낮은 가격을 주장하는 표현은 어떤 경우에도 없음
    assert.doesNotMatch(html, /최저가|가장 낮은 가격|우리 기록 중|최저/);
  }
  // 갱신일이 KST 기준으로 바뀌는지
  assert.equal(titleOf(renderPage({ ...R, updatedAt: '2026-10-16T16:00:00Z', today: [], history: [] })), '팬히터 가격 비교 (2026-10-17 기준)');
});

test('buildAll: 가격이 바뀌어도 제목은 갱신일 기준만, 누적 최저가 기록은 state에 남는다', () => {
  const root = site([deal('fh1', '팬히터 A', { salePrice: 20000 })], '2026-10-15T07:33:00+09:00');
  buildAll({ root, now: D1 });
  assert.equal(titleOf(page(root, '팬히터')), '팬히터 가격 비교 (2026-10-15 기준)');
  setDeals(root, [deal('fh2', '팬히터 B', { salePrice: 25000 })], '2026-10-16T07:30:00+09:00');
  buildAll({ root, now: D2 });
  assert.equal(titleOf(page(root, '팬히터')), '팬히터 가격 비교 (2026-10-16 기준)');
  setDeals(root, [deal('fh3', '팬히터 C', { salePrice: 18000 })], '2026-10-17T07:30:00+09:00');
  buildAll({ root, now: new Date('2026-10-17T00:00:00Z') });
  assert.equal(titleOf(page(root, '팬히터')), '팬히터 가격 비교 (2026-10-17 기준)');
  assert.doesNotMatch(page(root, '팬히터'), /최저|가장 낮은 가격/);
  assert.equal(readState(root).items['팬히터'].minSalePrice, 18000);
  rmSync(root, { recursive: true });
});

test('누적 최저가 기록 회귀: 예전 state(minSalePrice 없음)에서 같은 URL 가격이 올라도 기록 10,000원 유지, 제목엔 가격 주장 없음', () => {
  const root = site([deal('fh1', '신일 팬히터', { salePrice: 20000 })], '2026-10-16T07:30:00+09:00');
  // 예전 state: minSalePrice 필드 없이 기록만 있음
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state', 'item-history.json'), JSON.stringify({ items: { 팬히터: { deals: [
    { title: '신일 팬히터', url: 'https://link.coupang.com/a/fh1', salePrice: 10000, originalPrice: 30000, image: '', seenAt: '2026-10-10T07:30:00+09:00' },
  ] } } }));
  buildAll({ root, now: D2 });
  assert.equal(titleOf(page(root, '팬히터')), '팬히터 가격 비교 (2026-10-16 기준)');
  assert.doesNotMatch(page(root, '팬히터'), /가장 낮은 가격|최저가/);
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
  assert.ok(ended.includes(`<h1>팬히터 가격 비교 (2026-10-15 기준)</h1>\n    ${BANNER}\n`));
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
  assert.equal(titleOf(html), '팬히터 가격 비교 (2026-10-17 기준)');
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
    assert.match(h1s[0], /^<h1>팬히터 가격 비교 \(\d{4}-\d{2}-\d{2} 기준\)<\/h1>$/);
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
