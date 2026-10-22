import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ORIGIN, pageUrl, NOINDEX_META, sitemapLastmods, buildSitemap, coreLastmods, renderPage, lowestNow } from '../scripts/build-item-pages.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = rel => readFileSync(join(ROOT, rel), 'utf8');
const home = read('index.html');
const sitemap = read('sitemap.xml');
const lastmods = sitemapLastmods(sitemap);
const slugs = readdirSync(join(ROOT, 'deal'), { withFileTypes: true })
  .filter(e => e.isDirectory() && existsSync(join(ROOT, 'deal', e.name, 'index.html')))
  .map(e => e.name);

/** 사이트 URL → 저장소 안 파일 경로 (/ 로 끝나면 index.html) */
const fileOf = url => {
  const p = decodeURIComponent(new URL(url).pathname);
  return join(ROOT, p.endsWith('/') ? p + 'index.html' : p);
};
const canonicalOf = html => html.match(/<link rel="canonical" href="([^"]*)">/)?.[1];

const PAGES = [
  ['index.html', `${ORIGIN}/`],
  ['about.html', `${ORIGIN}/about.html`],
  ['privacy.html', `${ORIGIN}/privacy.html`],
  ...slugs.map(s => [`deal/${s}/index.html`, pageUrl(s)]),
];

test('홈의 /deal/ 링크는 모두 실제 품목 페이지로', () => {
  const hrefs = [...home.matchAll(/href="(\/deal\/[^"]*)"/g)].map(m => m[1]);
  assert.ok(hrefs.length > 0);
  for (const h of hrefs) {
    const slug = decodeURIComponent(h).match(/^\/deal\/([^/]+)\/$/)?.[1];
    assert.ok(slug, h);
    assert.ok(existsSync(join(ROOT, 'deal', slug, 'index.html')), h);
  }
});

test('모든 페이지 canonical = 자기 URL (사이트맵과 같은 인코딩)', () => {
  for (const [file, url] of PAGES) {
    const html = read(file);
    assert.equal((html.match(/rel="canonical"/g) ?? []).length, 1, file);
    assert.equal(canonicalOf(html), url, file);
  }
});

test('사이트맵 loc는 모두 실제 파일이고 lastmod(YYYY-MM-DD)가 있음', () => {
  assert.ok(lastmods.size > 0);
  for (const [loc, lastmod] of lastmods) {
    assert.ok(loc.startsWith(ORIGIN + '/'), loc);
    assert.ok(existsSync(fileOf(loc)), loc);
    assert.match(lastmod, /^\d{4}-\d{2}-\d{2}$/, loc);
  }
  for (const u of [`${ORIGIN}/`, `${ORIGIN}/about.html`, `${ORIGIN}/privacy.html`]) assert.ok(lastmods.has(u), u);
});

test('딜 있는(noindex 아닌) 품목 페이지는 사이트맵에 빠짐없이, noindex는 제외', () => {
  for (const s of slugs) {
    const noindex = read(`deal/${s}/index.html`).includes(NOINDEX_META);
    assert.equal(lastmods.has(pageUrl(s)), !noindex, s);
  }
});

test('홈 title·description·og·twitter 6곳에 최저가 없음', () => {
  const res = [
    /<title>([^<]*)</,
    /name="description" content="([^"]*)"/,
    /property="og:title" content="([^"]*)"/,
    /property="og:description" content="([^"]*)"/,
    /name="twitter:title" content="([^"]*)"/,
    /name="twitter:description" content="([^"]*)"/,
  ];
  for (const re of res) {
    const t = home.match(re)?.[1];
    assert.ok(t, String(re));
    assert.ok(!t.includes('최저가'), t);
  }
});

test('buildSitemap: 빠진 홈·about·privacy를 다시 넣고 빈 lastmod는 오늘로', () => {
  const xml = `<urlset><url><loc>${ORIGIN}/about.html</loc><lastmod></lastmod></url></urlset>`;
  const m = sitemapLastmods(buildSitemap(xml, [{ loc: pageUrl('팬히터'), lastmod: '' }], '2026-10-22'));
  assert.deepEqual([...m], [
    [`${ORIGIN}/`, '2026-10-22'], [`${ORIGIN}/about.html`, '2026-10-22'], [`${ORIGIN}/privacy.html`, '2026-10-22'],
    [pageUrl('팬히터'), '2026-10-22'],
  ]);
});

test('coreLastmods: 첫 실행은 기존 사이트맵 날짜, 없으면 오늘', () => {
  const r = coreLastmods(undefined, { 'index.html': 'h1', 'about.html': 'h2' }, { 'index.html': '2026-10-01' }, '2026-10-22');
  assert.deepEqual(r, { 'index.html': { hash: 'h1', lastmod: '2026-10-01' }, 'about.html': { hash: 'h2', lastmod: '2026-10-22' } });
});

test('coreLastmods: 해시가 같으면 저장된 날짜 → 사이트맵 날짜 → 오늘', () => {
  const prev = { 'index.html': { hash: 'h1', lastmod: '2026-10-05' }, 'about.html': { hash: 'h2' }, 'privacy.html': { hash: 'h3' } };
  const r = coreLastmods(prev, { 'index.html': 'h1', 'about.html': 'h2', 'privacy.html': 'h3' }, { 'index.html': '2026-10-01', 'about.html': '2026-10-02' }, '2026-10-22');
  assert.deepEqual(r, {
    'index.html': { hash: 'h1', lastmod: '2026-10-05' },
    'about.html': { hash: 'h2', lastmod: '2026-10-02' },
    'privacy.html': { hash: 'h3', lastmod: '2026-10-22' },
  });
});

test('coreLastmods: 해시가 바뀌면 오늘', () => {
  const r = coreLastmods({ 'index.html': { hash: 'old', lastmod: '2026-10-05' } }, { 'index.html': 'new' }, { 'index.html': '2026-10-01' }, '2026-10-22');
  assert.deepEqual(r, { 'index.html': { hash: 'new', lastmod: '2026-10-22' } });
});

test('coreLastmods: 입력을 바꾸지 않는다', () => {
  const prev = { 'index.html': { hash: 'old', lastmod: '2026-10-05' } };
  const hashes = { 'index.html': 'new', 'about.html': 'h2' };
  const existing = { 'index.html': '2026-10-01' };
  const snap = JSON.stringify([prev, hashes, existing]);
  const r = coreLastmods(prev, hashes, existing, '2026-10-22');
  assert.equal(JSON.stringify([prev, hashes, existing]), snap);
  assert.notEqual(r['index.html'], prev['index.html']);
});

test('buildSitemap: 고정 페이지 lastmod 덮어쓰기(기존·새로 넣은 항목 모두, 다른 필드 유지)', () => {
  const xml = `<urlset><url><loc>${ORIGIN}/</loc><lastmod>2026-10-01</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`
    + `<url><loc>${ORIGIN}/extra.html</loc><lastmod>2026-09-01</lastmod></url></urlset>`;
  const deal = [{ loc: pageUrl('팬히터'), lastmod: '2026-10-20' }];
  const override = new Map([[`${ORIGIN}/`, '2026-10-15'], [`${ORIGIN}/privacy.html`, '2026-10-10']]);
  const out = buildSitemap(xml, deal, '2026-10-22', override);
  assert.deepEqual([...sitemapLastmods(out)], [
    [`${ORIGIN}/`, '2026-10-15'], [`${ORIGIN}/about.html`, '2026-10-22'], [`${ORIGIN}/privacy.html`, '2026-10-10'],
    [`${ORIGIN}/extra.html`, '2026-09-01'], [pageUrl('팬히터'), '2026-10-20'],
  ]);
  assert.ok(out.includes(`<url><loc>${ORIGIN}/</loc><lastmod>2026-10-15</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`));
  assert.ok(out.includes(`<url><loc>${ORIGIN}/privacy.html</loc><lastmod>2026-10-10</lastmod><changefreq>yearly</changefreq><priority>0.3</priority></url>`));
  // 4번째 인자가 없으면 기존 동작 그대로
  assert.equal(sitemapLastmods(buildSitemap(xml, deal, '2026-10-22')).get(`${ORIGIN}/`), '2026-10-01');
});

test('품목 페이지: 기록 하한가 이하 딜이면 "기록된 가격" 문구, "최저가"는 없음', () => {
  const item = { slug: '팬히터', keyword: '팬히터', category: '가전·디지털', match: ['팬히터'] };
  const d = { title: '신일 팬히터', salePrice: 19300, originalPrice: 30000, image: '', url: 'https://link.coupang.com/a/fh1', seenAt: '2026-10-13T16:00:00Z' };
  const args = { item, items: [item], today: [d], history: [d], updatedAt: '2026-10-13T16:00:00Z', minSalePrice: 19300 };
  assert.ok(lowestNow(args)); // 문구가 붙는 조건
  const html = renderPage(args);
  assert.ok(html.includes('<title>팬히터 비교 기록된 가격 (2026-10-14 기준)</title>'));
  assert.ok(html.includes('기록된 가격'));
  assert.ok(!html.includes('최저가'));
});
