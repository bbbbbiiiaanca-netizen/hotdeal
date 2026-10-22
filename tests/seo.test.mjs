import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ORIGIN, pageUrl, NOINDEX_META, sitemapLastmods, buildSitemap } from '../scripts/build-item-pages.mjs';

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
