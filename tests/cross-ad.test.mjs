import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('cross ad: one card above footer, every link sponsored nofollow + UTM', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/class="cross-ad"/g) || []).length, 1);
  assert.ok(html.indexOf('class="cross-ad"') < html.indexOf('<footer'));
  const card = html.slice(html.indexOf('class="cross-ad"'), html.indexOf('</aside>'));
  const links = [...card.matchAll(/<a href="([^"]+)"[^>]*rel="([^"]+)"/g)];
  assert.equal(links.length, 3);
  for (const [, href, rel] of links) {
    assert.match(rel, /sponsored/); assert.match(rel, /nofollow/);
    const u = new URL(href.replace(/&amp;/g, '&'));
    assert.equal(u.searchParams.get('utm_source'), 'hotdeal');
    assert.equal(u.searchParams.get('utm_medium'), 'house_banner');
    assert.equal(u.searchParams.get('utm_campaign'), 'cross_ad');
  }
  const js = readFileSync(new URL('../assets/cross-ad.js', import.meta.url), 'utf8');
  assert.match(js, /utm_content=reunion_premium/);
});
