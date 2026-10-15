import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../assets/style.css', import.meta.url), 'utf8');
test('TOP 딜 상자가 전체 딜보다 먼저, 제목 두 개', () => {
  const a = html.indexOf('⭐ 오늘의 TOP 딜'), b = html.indexOf('전체 딜</h2>');
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
