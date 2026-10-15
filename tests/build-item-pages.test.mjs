import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { withSubId, matchDeals, titleMatches, mergeHistory, buildAll, flushIndexNow, readPending, pageUrl, DISCLOSURE, HISTORY_MAX } from '../scripts/build-item-pages.mjs';
import { sameOriginUrls } from '../scripts/indexnow-submit.mjs';

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
  assert.deepEqual(changed, [pageUrl('팬히터'), pageUrl('스마트TV')]);
  const html = page(root, '팬히터');
  assert.match(html, /<title>팬히터 최저가·핫딜 \| 핫딜 오이데<\/title>/);
  assert.match(html, /<h1>팬히터 오늘 핫딜<\/h1>/);
  assert.match(html, /신일 팬히터 SFH-1/);
  assert.match(html, /<b>19,300원<\/b>/);
  assert.match(html, /<s>30,000원<\/s>/);
  assert.match(html, /-36%/);
  assert.match(html, /href="https:\/\/link\.coupang\.com\/a\/fh1" data-subid-missing="1" target="_blank" rel="sponsored nofollow noopener">쿠팡에서 보기/);
  assert.match(html, /<link rel="canonical" href="https:\/\/hotdeal\.sooinlab\.com\/deal\/%ED%8C%AC%ED%9E%88%ED%84%B0\/">/);
  assert.match(html, /href="\/assets\/style\.css"/);
  assert.match(html, /2026년 10월 15일 07:33 \(KST\)/);
  assert.match(html, /https:\/\/t\.me\/hotdeal_oide[^>]*>✈️ @hotdeal_oide 구독하고 매일 받기/);
  assert.ok(html.includes(`<div class="disclosure" role="note"><strong>광고</strong> ${DISCLOSURE}</div>`));
  assert.ok(html.trimEnd().endsWith(`<p>${DISCLOSURE}</p>\n</footer>\n</body>\n</html>`));
  rmSync(root, { recursive: true });
});

test('상태 (b): 오늘 딜 없고 기록 있음 → 오늘은 딜 없음 + 최근 딜', () => {
  const root = site([deal('fh1', '신일 팬히터')]);
  buildAll({ root, now: D1 });
  setDeals(root, [deal('x', '다른 상품')], '2026-10-16T07:30:00+09:00');
  const { changed } = buildAll({ root, now: D2 });
  assert.ok(changed.includes(pageUrl('팬히터')));
  const html = page(root, '팬히터');
  assert.match(html, /오늘은 딜 없음/);
  assert.match(html, /최근 딜/);
  assert.match(html, /10\/15 확인/);
  assert.match(html, /달라졌을 수 있으니/);
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
  const root = site([]);
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
  const root = site([]);
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
  const root = site([deal('fh1', '신일 팬히터')]);
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
  const root = site([]);
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
  const root = site([deal('fh1', '신일 팬히터')]);
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
