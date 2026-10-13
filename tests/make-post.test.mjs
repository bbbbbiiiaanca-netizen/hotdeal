import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPost, formatParts, pickDeals, priceLine, kstMonthDay, truncateTitle, discountPct, DISCLOSURE, FOOTER, DEFAULT_FILE, loadData } from '../scripts/make-post.mjs';

const deal = (id, extra = {}) => ({
  id, title: `상품 ${id}`, category: '육아', originalPrice: 47100, salePrice: 22250,
  url: `https://link.coupang.com/a/${id}`, top: false, ...extra,
});
const data = (deals) => ({ updatedAt: '2026-10-13T07:35:00+09:00', deals });
// 조각이 하나뿐일 때 그 메시지
const one = (...args) => {
  const parts = buildPost(...args);
  assert.equal(parts.length, 1);
  return parts[0];
};

test('마지막 줄은 대가성 문구, 바로 위는 전체 목록 링크', () => {
  const lines = one(data([deal('a')]), { mode: 'morning' }).split('\n');
  assert.equal(lines.at(-1), '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.');
  assert.equal(lines.at(-1), DISCLOSURE);
  assert.equal(lines.at(-2), '전체 목록: https://hotdeal.sooinlab.com/');
  assert.equal(lines.filter((l) => l === DISCLOSURE).length, 1);
});

test('헤더: morning/evening, KST 날짜, 실제 개수 (morning 최대 20)', () => {
  const deals = Array.from({ length: 25 }, (_, i) => deal(`d${i}`));
  const first = (d, mode) => buildPost(data(d), { mode })[0].split('\n')[0];
  assert.equal(first(deals, 'morning'), '🔥 10/13 오늘의 핫딜 오이데~ TOP 20');
  assert.equal(first(deals.slice(0, 8), 'morning'), '🔥 10/13 오늘의 핫딜 오이데~ TOP 8');
  assert.equal(first(deals.slice(0, 2), 'morning'), '🔥 10/13 오늘의 핫딜 오이데~ TOP 2');
  assert.equal(first(deals, 'evening'), '🌙 10/13 아직 할인 중인 핫딜 오이데~ 3');
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
  assert.ok(!one(data([deal('a', { originalPrice: undefined })])).includes('%'));
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
  const msg = one(data(deals), { mode: 'morning' });
  for (const tag of Object.values(cats)) assert.ok(msg.includes(`\n   ${tag}\n`), tag);
});

test('항목 형식과 푸터', () => {
  const msg = one(data([deal('a')]));
  assert.ok(msg.includes('\n1) 상품 a\n   22,250원 (-53%)\n   https://link.coupang.com/a/a\n   #육아소모품\n'));
  assert.ok(msg.endsWith(`#육아소모품\n\n가격과 재고는 수시로 바뀌어요. 구매 전에 쿠팡에서 확인하세요.\n전체 목록: https://hotdeal.sooinlab.com/\n${DISCLOSURE}`));
});

test('morning은 top 먼저 최대 20개, evening은 그 다음 3개 (부족하면 첫 3개)', () => {
  const deals = Array.from({ length: 25 }, (_, i) => deal(`d${i}`, { top: i === 4 || i === 7 }));
  const morning = pickDeals(deals, 'morning').map((d) => d.id);
  assert.equal(morning.length, 20);
  assert.deepEqual(morning.slice(0, 5), ['d4', 'd7', 'd0', 'd1', 'd2']);
  assert.equal(morning.at(-1), 'd19');
  assert.deepEqual(pickDeals(deals, 'evening').map((d) => d.id), ['d20', 'd21', 'd22']);
  assert.deepEqual(pickDeals(deals.slice(0, 10), 'morning').map((d) => d.id), ['d4', 'd7', 'd0', 'd1', 'd2', 'd3', 'd5', 'd6', 'd8', 'd9']);
  assert.deepEqual(pickDeals(deals.slice(0, 10), 'evening').map((d) => d.id), ['d0', 'd1', 'd2']);
});

test('title/salePrice/url 없는 상품은 건너뜀', () => {
  const deals = [deal('a', { title: '' }), deal('b', { salePrice: undefined }), deal('c', { url: undefined }), deal('d')];
  assert.deepEqual(pickDeals(deals, 'morning').map((d) => d.id), ['d']);
  assert.throws(() => buildPost(data([deal('x', { url: '' })])));
});

test('긴 제목은 200자로 자르고 … 붙임 (서로게이트 쌍 안 쪼갬)', () => {
  assert.equal(truncateTitle('짧은 제목'), '짧은 제목');
  assert.equal(truncateTitle('x'.repeat(200)), 'x'.repeat(200));
  const cut = truncateTitle('x'.repeat(5000));
  assert.equal(Array.from(cut).length, 200);
  assert.ok(cut.endsWith('…'));
  // 이모지(서로게이트 쌍)가 경계에 걸려도 깨진 글자가 남지 않음
  const emoji = truncateTitle('😀'.repeat(300));
  assert.equal(emoji, '😀'.repeat(199) + '…');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(truncateTitle('a' + '😀'.repeat(300))));
  // 제목이 아무리 길어도 한 메시지에 들어감
  const parts = buildPost(data([deal('a', { title: 'x'.repeat(50000) })]));
  assert.equal(parts.length, 1);
  assert.ok(parts[0].includes(`1) ${'x'.repeat(199)}…\n`));
});

test('헤더와 첫 상품이 한 메시지에 안 들어가면 헤더만 따로 첫 조각', () => {
  // URL이 매우 길어서 상품 하나가 헤더와 같이 못 들어가는 경우
  const longUrl = 'https://link.coupang.com/a/' + 'u'.repeat(3900);
  const parts = buildPost(data([deal('a', { url: longUrl }), deal('b')]));
  assert.equal(parts.length, 3);
  assert.equal(parts[0], `🔥 10/13 오늘의 핫딜 오이데~ TOP 2\n\n${DISCLOSURE}`);
  assert.ok(parts[1].startsWith('1) 상품 a'));
  for (const p of parts) {
    assert.ok(p.length <= 4096);
    assert.equal(p.split('\n').at(-1), DISCLOSURE);
  }
  // 상품 하나만으로 한도를 넘으면 여전히 에러
  assert.throws(() => buildPost(data([deal('a', { url: 'https://x/' + 'u'.repeat(5000) })])), /4096/);
});

test('판매가는 원 단위 양의 정수, 0 이하·숫자 아님은 건너뜀', () => {
  const deals = [deal('a', { salePrice: 0 }), deal('b', { salePrice: -100 }), deal('c', { salePrice: 0.4 }), deal('d', { salePrice: NaN }), deal('e', { salePrice: '1000' }), deal('f', { salePrice: 9999.6 })];
  assert.deepEqual(pickDeals(deals, 'morning').map((d) => d.id), ['f']);
  assert.equal(priceLine(deal('f', { salePrice: 9999.6, originalPrice: undefined })), '10,000원');
  assert.ok(one(data(deals)).includes('   10,000원 (-79%)\n'));
});

test('할인율은 0<pct<100이고 정상가 > 판매가일 때만', () => {
  assert.equal(discountPct(22250, 47100), 53);
  assert.equal(discountPct(1, 100000), 99); // 99.999% → 100으로 반올림되지 않게 99
  assert.equal(discountPct(9990, 10000), null); // 0.1% → 0%면 생략
  assert.equal(discountPct(100, 100), null);
  assert.equal(discountPct(200, 100), null);
  assert.equal(discountPct(100, NaN), null);
  assert.equal(discountPct(100, -5), null);
  assert.equal(discountPct(0, 100), null);
  // 판매가 반올림 뒤 정상가와 같아지면 생략
  assert.equal(discountPct(99.6, 100), null);
  assert.equal(priceLine(deal('a', { salePrice: 1, originalPrice: 1e9 })), '1원 (-99%)');
  assert.equal(priceLine(deal('a', { salePrice: 9990, originalPrice: 10000 })), '9,990원');
});

test('4096자를 넘으면 상품 단위로 나누고, 모든 조각의 마지막 줄은 대가성 문구', () => {
  const deals = Array.from({ length: 20 }, (_, i) => deal(`d${i}`, { title: `긴 상품 이름 ${i} `.repeat(30) }));
  const parts = buildPost(data(deals), { mode: 'morning' });
  assert.ok(parts.length >= 2, `조각 ${parts.length}개`);
  for (const p of parts) {
    assert.ok(p.length <= 4096, `${p.length}자`);
    assert.equal(p.split('\n').at(-1), DISCLOSURE);
    assert.equal(p.split('\n').filter((l) => l === DISCLOSURE).length, 1);
  }
  assert.equal(parts[0].split('\n')[0], '🔥 10/13 오늘의 핫딜 오이데~ TOP 20');
  assert.ok(parts.slice(1).every((p) => !p.includes('오늘의 핫딜 오이데~')));
  // 안내 문구와 링크는 마지막 조각에
  assert.ok(parts.at(-1).endsWith(`\n${FOOTER.join('\n')}\n${DISCLOSURE}`));
  assert.ok(parts.slice(0, -1).every((p) => !p.includes(FOOTER[1])));
  // 번호는 1~20이 순서대로 한 번씩, 상품이 조각 사이에서 잘리지 않음
  const nums = parts.flatMap((p) => p.match(/^\d+\) /gm).map((m) => parseInt(m)));
  assert.deepEqual(nums, Array.from({ length: 20 }, (_, i) => i + 1));
  for (const p of parts) assert.equal(p.match(/^\d+\) /gm).length, p.match(/^   https:/gm).length);
  // dry-run 구분선
  const out = formatParts(parts);
  assert.ok(out.startsWith(`----- part 1/${parts.length} -----\n🔥`));
  assert.ok(out.includes(`\n----- part ${parts.length}/${parts.length} -----\n`));
  assert.equal(formatParts(['하나']), '하나');
});

test('실제 deals.json으로 morning 전체(최대 20), evening 3개', async () => {
  const real = await loadData(DEFAULT_FILE);
  const valid = pickDeals(real.deals, 'morning').length;
  const m = buildPost(real, { mode: 'morning' });
  const e = buildPost(real, { mode: 'evening' });
  assert.equal(m.join('\n').match(/^\d+\) /gm).length, Math.min(20, valid));
  assert.equal(m[0].split('\n')[0].endsWith(`TOP ${Math.min(20, valid)}`), true);
  assert.equal(e.join('\n').match(/^\d+\) /gm).length, 3);
  for (const p of [...m, ...e]) {
    assert.ok(p.length <= 4096);
    assert.equal(p.split('\n').at(-1), DISCLOSURE);
  }
});
