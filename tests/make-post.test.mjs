import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPost, pickDeals, priceLine, kstMonthDay, DISCLOSURE, DEFAULT_FILE, loadData } from '../scripts/make-post.mjs';
import { isDuplicate, addEntry, sanitize, isValidToken, withRetry, kstDate } from '../scripts/post-telegram.mjs';

const deal = (id, extra = {}) => ({
  id, title: `상품 ${id}`, category: '육아', originalPrice: 47100, salePrice: 22250,
  url: `https://link.coupang.com/a/${id}`, top: false, ...extra,
});
const data = (deals) => ({ updatedAt: '2026-10-13T07:35:00+09:00', deals });

test('첫 줄은 대가성 문구, 다음 줄은 빈 줄', () => {
  const lines = buildPost(data([deal('a')]), { mode: 'morning' }).split('\n');
  assert.equal(lines[0], '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.');
  assert.equal(lines[0], DISCLOSURE);
  assert.equal(lines[1], '');
});

test('헤더: morning/evening, KST 날짜, 실제 개수', () => {
  const deals = Array.from({ length: 8 }, (_, i) => deal(`d${i}`));
  assert.equal(buildPost(data(deals), { mode: 'morning' }).split('\n')[2], '🔥 10/13 오늘의 핫딜 오이데~ TOP 5');
  assert.equal(buildPost(data(deals), { mode: 'evening' }).split('\n')[2], '🌙 10/13 아직 할인 중인 핫딜 오이데~ 3');
  assert.equal(buildPost(data(deals.slice(0, 2)), { mode: 'morning' }).split('\n')[2], '🔥 10/13 오늘의 핫딜 오이데~ TOP 2');
  // UTC 2026-01-04T16:00Z = KST 1/5 01:00, 0 채움 없음
  assert.equal(kstMonthDay('2026-01-04T16:00:00Z'), '1/5');
});

test('가격은 쉼표 + 원, 할인율 표시', () => {
  assert.equal(priceLine(deal('a')), '22,250원 (-53%)');
  assert.equal(priceLine(deal('a', { originalPrice: undefined, salePrice: 1234567 })), '1,234,567원');
});

test('정상가가 없거나 판매가 이하이면 할인율 생략', () => {
  assert.equal(priceLine(deal('a', { originalPrice: undefined })), '22,250원');
  assert.equal(priceLine(deal('a', { originalPrice: 22250 })), '22,250원');
  assert.ok(!buildPost(data([deal('a', { originalPrice: undefined })])).includes('%'));
});

test('쿠폰가/와우가 라벨은 해당 필드가 있을 때만', () => {
  assert.equal(priceLine(deal('a', { priceType: 'coupon' })), '22,250원 (-53%, 쿠폰가)');
  assert.equal(priceLine(deal('a', { priceType: 'wow' })), '22,250원 (-53%, 와우가)');
  assert.equal(priceLine(deal('a', { coupon: true })), '22,250원 (-53%, 쿠폰가)');
  assert.equal(priceLine(deal('a', { wow: true, originalPrice: undefined })), '22,250원 (와우가)');
  assert.equal(priceLine(deal('a')), '22,250원 (-53%)');
});

test('카테고리 해시태그 매핑', () => {
  const cats = { 육아: '#육아소모품', 뷰티: '#뷰티', 생활: '#생활주방', 반려동물: '#반려동물', 패션잡화: '#패션잡화' };
  const deals = Object.keys(cats).map((c, i) => deal(`c${i}`, { category: c }));
  const msg = buildPost(data(deals), { mode: 'morning' });
  for (const tag of Object.values(cats)) assert.ok(msg.includes(`\n   ${tag}\n`), tag);
});

test('항목 형식과 푸터', () => {
  const msg = buildPost(data([deal('a')]));
  assert.ok(msg.includes('\n1) 상품 a\n   22,250원 (-53%)\n   https://link.coupang.com/a/a\n   #육아소모품\n'));
  assert.ok(msg.endsWith('가격과 재고는 수시로 바뀌어요. 구매 전에 쿠팡에서 확인하세요.\n전체 목록: https://hotdeal.sooinlab.com/'));
});

test('morning은 top 먼저, evening은 그 다음 3개 (부족하면 첫 3개)', () => {
  const deals = Array.from({ length: 10 }, (_, i) => deal(`d${i}`, { top: i === 4 || i === 7 }));
  assert.deepEqual(pickDeals(deals, 'morning').map((d) => d.id), ['d4', 'd7', 'd0', 'd1', 'd2']);
  assert.deepEqual(pickDeals(deals, 'evening').map((d) => d.id), ['d3', 'd5', 'd6']);
  assert.deepEqual(pickDeals(deals.slice(0, 6), 'evening').map((d) => d.id), ['d0', 'd1', 'd2']);
});

test('title/salePrice/url 없는 상품은 건너뜀', () => {
  const deals = [deal('a', { title: '' }), deal('b', { salePrice: undefined }), deal('c', { url: undefined }), deal('d')];
  assert.deepEqual(pickDeals(deals, 'morning').map((d) => d.id), ['d']);
  assert.throws(() => buildPost(data([deal('x', { url: '' })])));
});

test('4096자 한도를 넘으면 에러', () => {
  assert.throws(() => buildPost(data([deal('a', { title: 'x'.repeat(5000) })])), /4096/);
});

test('실제 deals.json으로 morning 5개, evening 3개', async () => {
  const real = await loadData(DEFAULT_FILE);
  const m = buildPost(real, { mode: 'morning' });
  const e = buildPost(real, { mode: 'evening' });
  assert.equal(m.match(/^\d\) /gm).length, 5);
  assert.equal(e.match(/^\d\) /gm).length, 3);
  assert.ok(m.length <= 4096 && e.length <= 4096);
});

test('post-telegram: 중복 방지 헬퍼', () => {
  let entries = [];
  assert.equal(isDuplicate(entries, '2026-10-13', 'morning'), false);
  entries = addEntry(entries, '2026-10-13', 'morning', 101);
  assert.deepEqual(entries, [{ date: '2026-10-13', mode: 'morning', message_id: 101 }]);
  assert.equal(isDuplicate(entries, '2026-10-13', 'morning'), true);
  assert.equal(isDuplicate(entries, '2026-10-13', 'evening'), false);
  assert.equal(isDuplicate(entries, '2026-10-14', 'morning'), false);
  assert.equal(kstDate(new Date('2026-10-12T15:30:00Z')), '2026-10-13');
});

test('post-telegram: 토큰 검사와 에러 문구 정리', () => {
  const token = '123456789:' + 'A'.repeat(35);
  assert.ok(isValidToken(token));
  assert.ok(!isValidToken('123:short'));
  assert.ok(!isValidToken(''));
  const msg = sanitize(`request to https://api.telegram.org/bot${token}/sendMessage failed`, token);
  assert.ok(!msg.includes(token));
  assert.ok(!msg.includes('AAAAAAAAAA'));
  assert.ok(!msg.includes('123456789'));
});

test('post-telegram: 실패 시 한 번만 재시도', async () => {
  let calls = 0;
  const waits = [];
  const ok = await withRetry(async () => { if (++calls === 1) throw new Error('x'); return 7; }, { sleep: async (ms) => waits.push(ms) });
  assert.equal(ok, 7);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [3000]);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new Error('y'); }, { sleep: async () => {} }), /y/);
  assert.equal(calls, 2);
});
