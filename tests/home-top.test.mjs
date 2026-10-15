import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../assets/style.css', import.meta.url), 'utf8');
test('TOP 딜 상자가 전체 딜보다 먼저, 제목 두 개', () => {
  const a = html.indexOf('⭐ 특가 TOP 딜'), b = html.indexOf('오늘의 핫딜 모음</h2>');
  assert.ok(a > 0 && b > a);
  assert.match(html, /id="topBox" class="top-box"/);
});
test('h1은 로고 하나뿐', () => { assert.equal((html.match(/<h1/g) || []).length, 1); });
test('고지는 하단에 한 번', () => { assert.equal((html.match(/쿠팡 파트너스 활동의 일환/g) || []).length, 1); });
test('1~3등 순위 배지와 금·은·동 색', () => {
  assert.match(js, /rank >= 1 && rank <= 3/);
  assert.match(js, /card\(d, i \+ 1\)/);
  for (const n of [1, 2, 3]) assert.match(css, new RegExp(`\\.rank-${n}\\{`));
});
test('전체 딜 목록에는 순위 배지 없음 (map(card)로 index가 넘어가지 않게)', () => { assert.doesNotMatch(js, /\.map\(card\)/); });
test('제목·설명·og에 핫딜/모음/특가/최저가', () => {
  for (const re of [/<title>([^<]*)</, /name="description" content="([^"]*)"/, /property="og:title" content="([^"]*)"/, /property="og:description" content="([^"]*)"/]) {
    const t = html.match(re)[1];
    for (const k of ['핫딜', '모음', '특가']) assert.ok(t.includes(k), k + ' in ' + t);
  }
  assert.match(html, /<title>[^<]*최저가/);
  assert.match(html, /name="description" content="[^"]*최저가/);
});
test('카드에는 최저가 라벨을 붙이지 않음 (기록 확인 전)', () => { assert.doesNotMatch(js, /최저가/); });
test('전체 딜에서 TOP 상품 제외', () => { assert.match(js, /!topIds\.has\(String\(d\.id\)\)/); });
test('TOP 순위: 할인율 1%p 이내면 비싼 상품 먼저', () => {
  const pct = d => Math.round((1 - d.salePrice / d.originalPrice) * 100);
  const topCmp = eval(js.match(/const topCmp = ([^;]+);/)[1]);
  const a = {originalPrice: 10000, salePrice: 5000}, b = {originalPrice: 40000, salePrice: 20400}, c = {originalPrice: 10000, salePrice: 3000};
  assert.deepEqual([a, b, c].sort(topCmp), [c, b, a]);
});
