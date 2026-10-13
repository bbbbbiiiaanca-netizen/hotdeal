import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPost, formatParts, pickDeals, rankDeals, dedupeDeals, rankingSnapshot, slotItems, parseArgs, priceLine, kstMonthDay, truncateTitle, discountPct, DISCLOSURE, FOOTER, DEFAULT_FILE, loadData } from '../scripts/make-post.mjs';

const deal = (id, extra = {}) => ({
  id, title: `상품 ${id}`, category: '육아', originalPrice: 47100, salePrice: 22250,
  url: `https://link.coupang.com/a/${id}`, ...extra,
});
const data = (deals) => ({ updatedAt: '2026-10-13T07:35:00+09:00', deals });
// 조각이 하나뿐일 때 그 메시지
const one = (d, opts = { slot: 1 }) => {
  const parts = buildPost(d, opts);
  assert.equal(parts.length, 1);
  return parts[0];
};

test('마지막 줄은 대가성 문구, 바로 위는 전체 목록 링크', () => {
  const lines = one(data([deal('a')])).split('\n');
  assert.equal(lines.at(-1), '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.');
  assert.equal(lines.at(-1), DISCLOSURE);
  assert.equal(lines.at(-2), '전체 목록: https://hotdeal.sooinlab.com/');
  assert.equal(lines.filter((l) => l === DISCLOSURE).length, 1);
});

test('헤더: KST 날짜, slot 몫의 실제 개수, (k/4)', () => {
  const deals = Array.from({ length: 25 }, (_, i) => deal(`d${i}`));
  const first = (d, slot) => buildPost(data(d), { slot })[0].split('\n')[0];
  assert.equal(first(deals, 1), '🔥 10/13 핫딜 오이데~ TOP 5 (1/4)');
  assert.equal(first(deals, 4), '🔥 10/13 핫딜 오이데~ TOP 5 (4/4)');
  assert.equal(first(deals.slice(0, 8), 2), '🔥 10/13 핫딜 오이데~ TOP 3 (2/4)');
  assert.equal(first(deals.slice(0, 2), 1), '🔥 10/13 핫딜 오이데~ TOP 2 (1/4)');
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
  const msg = one(data(deals));
  for (const tag of Object.values(cats)) assert.ok(msg.includes(`\n   ${tag}\n`), tag);
});

test('항목 형식과 푸터', () => {
  const msg = one(data([deal('a')]));
  assert.ok(msg.includes('\n1) 상품 a\n   22,250원 (-53%)\n   https://link.coupang.com/a/a\n   #육아소모품\n'));
  assert.ok(msg.endsWith(`#육아소모품\n\n가격과 재고는 수시로 바뀌어요. 구매 전에 쿠팡에서 확인하세요.\n전체 목록: https://hotdeal.sooinlab.com/\n${DISCLOSURE}`));
});

test('할인율 높은 순, 할인율 없으면 뒤로, 같으면 파일 순서 (top 무시)', () => {
  const deals = [
    deal('none1', { originalPrice: undefined }),
    deal('p10', { salePrice: 9000, originalPrice: 10000 }),
    deal('p53a', { top: true }),
    deal('p90', { salePrice: 1000, originalPrice: 10000 }),
    deal('none2', { originalPrice: 1000, salePrice: 2000 }),
    deal('p53b'),
  ];
  assert.deepEqual(rankDeals(deals).map((d) => d.id), ['p90', 'p53a', 'p53b', 'p10', 'none1', 'none2']);
});

test('상위 20개를 5개씩 slot 1~4로 나눔, 겹치지 않음', () => {
  // d0이 할인율 가장 낮고 d24가 가장 높음
  const deals = Array.from({ length: 25 }, (_, i) => deal(`d${i}`, { salePrice: 10000 - i * 300, originalPrice: 10000 }));
  const ids = (slot, d = deals) => pickDeals(d, slot).map((x) => x.id);
  assert.deepEqual(ids(1), ['d24', 'd23', 'd22', 'd21', 'd20']);
  assert.deepEqual(ids(2), ['d19', 'd18', 'd17', 'd16', 'd15']);
  assert.deepEqual(ids(4), ['d9', 'd8', 'd7', 'd6', 'd5']);
  const all = [1, 2, 3, 4].flatMap((k) => ids(k));
  assert.equal(all.length, 20);
  assert.equal(new Set(all).size, 20);
  // 상품이 모자라면 뒤 slot은 일부만 또는 비어 있음
  assert.deepEqual(ids(2, deals.slice(0, 7)), ['d1', 'd0']);
  assert.deepEqual(ids(3, deals.slice(0, 7)), []);
  for (const bad of [0, 5, 1.5, '1', undefined]) assert.throws(() => pickDeals(deals, bad), /slot/);
});

test('slot 몫이 없으면 빈 배열, 유효한 상품이 아예 없으면 에러', () => {
  assert.deepEqual(buildPost(data([deal('a')]), { slot: 2 }), []);
  assert.throws(() => buildPost(data([]), { slot: 1 }), /상품이 없습니다/);
  // 번호는 slot마다 1부터
  const deals = Array.from({ length: 7 }, (_, i) => deal(`d${i}`));
  assert.ok(one(data(deals), { slot: 2 }).includes('\n1) 상품 d5\n'));
});

test('id나 url이 겹치면 처음 것만 남기고 순위를 매김', () => {
  const deals = [
    deal('a', { salePrice: 9000, originalPrice: 10000 }),
    deal('b'),
    deal('a', { title: 'id 중복', salePrice: 1000, originalPrice: 10000 }),
    deal('c', { url: ' https://link.coupang.com/a/b ', salePrice: 1000, originalPrice: 10000 }),
    deal('d', { url: 'https://link.coupang.com/a/a' }),
    deal('e'),
  ];
  assert.deepEqual(dedupeDeals(deals).map((d) => d.id), ['a', 'b', 'e']);
  assert.deepEqual(rankDeals(deals).map((d) => [d.id, d.title]), [['b', '상품 b'], ['e', '상품 e'], ['a', '상품 a']]);
  // 유효하지 않은 상품은 먼저 빼므로, 같은 id의 뒤쪽 유효한 상품이 남음
  assert.deepEqual(rankDeals([deal('x', { url: '' }), deal('x', { title: '살아남음' })]).map((d) => d.title), ['살아남음']);
  // id가 없어도 url로 중복 제거, 중복이 빠진 만큼 다음 순위가 slot에 들어옴
  const noId = [deal(undefined, { url: 'https://u/1' }), deal(undefined, { url: 'https://u/1' }), deal(undefined, { url: 'https://u/2' })];
  assert.deepEqual(pickDeals(noId, 1).map((d) => d.url), ['https://u/1', 'https://u/2']);
  const many = Array.from({ length: 6 }, (_, i) => deal(`d${i}`));
  assert.deepEqual(pickDeals([many[0], many[0], ...many.slice(1)], 1).map((d) => d.id), ['d0', 'd1', 'd2', 'd3', 'd4']);
});

test('하루 순위 스냅샷은 글에 필요한 필드만, slotItems는 exclude id를 뺌', () => {
  const deals = [deal('a', { image: 'x.png', top: true, priceType: 'coupon' }), deal('b')];
  const snap = rankingSnapshot(deals);
  assert.deepEqual(snap[0], {
    id: 'a', url: 'https://link.coupang.com/a/a', title: '상품 a', category: '육아', originalPrice: 47100, salePrice: 22250, priceType: 'coupon',
  });
  // 스냅샷으로 만든 글 = deals로 만든 글
  assert.deepEqual(buildPost({ updatedAt: data([]).updatedAt }, { slot: 1, ranking: snap }), buildPost(data(deals), { slot: 1 }));
  const ranking = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}` }));
  assert.deepEqual(slotItems(ranking, 2, ['r6', 'r0', 'zz']).map((d) => d.id), ['r5', 'r7', 'r8', 'r9']);
  assert.deepEqual(slotItems(ranking, 3).map((d) => d.id), ['r10', 'r11']);
  assert.throws(() => slotItems(ranking, 0), /slot/);
  assert.throws(() => buildPost({ updatedAt: data([]).updatedAt }, { slot: 1, ranking: [] }), /상품이 없습니다/);
});

test('--slot 인자', () => {
  assert.equal(parseArgs(['--slot', '3']).slot, 3);
  assert.equal(parseArgs(['--slot=4', '--dry-run']).slot, 4);
  for (const argv of [[], ['--slot', '0'], ['--slot', '5'], ['--slot', '1.5'], ['--slot', 'x'], ['--slot=']]) {
    assert.throws(() => parseArgs(argv), /--slot/, argv.join(' '));
  }
  assert.throws(() => parseArgs(['--mode', 'morning']), /알 수 없는 옵션/);
});

test('title/salePrice/url 없는 상품은 건너뜀', () => {
  const deals = [deal('a', { title: '' }), deal('b', { salePrice: undefined }), deal('c', { url: undefined }), deal('d')];
  assert.deepEqual(pickDeals(deals, 1).map((d) => d.id), ['d']);
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
  const parts = buildPost(data([deal('a', { title: 'x'.repeat(50000) })]), { slot: 1 });
  assert.equal(parts.length, 1);
  assert.ok(parts[0].includes(`1) ${'x'.repeat(199)}…\n`));
});

test('헤더와 첫 상품이 한 메시지에 안 들어가면 헤더만 따로 첫 조각', () => {
  // URL이 매우 길어서 상품 하나가 헤더와 같이 못 들어가는 경우
  const longUrl = 'https://link.coupang.com/a/' + 'u'.repeat(3900);
  const parts = buildPost(data([deal('a', { url: longUrl }), deal('b')]), { slot: 1 });
  assert.equal(parts.length, 3);
  assert.equal(parts[0], `🔥 10/13 핫딜 오이데~ TOP 2 (1/4)\n\n${DISCLOSURE}`);
  assert.ok(parts[1].startsWith('1) 상품 a'));
  for (const p of parts) {
    assert.ok(p.length <= 4096);
    assert.equal(p.split('\n').at(-1), DISCLOSURE);
  }
  // 상품 하나만으로 한도를 넘으면 여전히 에러
  assert.throws(() => buildPost(data([deal('a', { url: 'https://x/' + 'u'.repeat(5000) })]), { slot: 1 }), /4096/);
});

test('판매가는 원 단위 양의 정수, 0 이하·숫자 아님은 건너뜀', () => {
  const deals = [deal('a', { salePrice: 0 }), deal('b', { salePrice: -100 }), deal('c', { salePrice: 0.4 }), deal('d', { salePrice: NaN }), deal('e', { salePrice: '1000' }), deal('f', { salePrice: 9999.6 })];
  assert.deepEqual(pickDeals(deals, 1).map((d) => d.id), ['f']);
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
  // 제목은 200자로 잘리므로 URL을 길게 해서 5개가 한 메시지를 넘게 만듦
  const deals = Array.from({ length: 5 }, (_, i) => deal(`d${i}`, { url: `https://link.coupang.com/a/d${i}?` + 'u'.repeat(1200) }));
  const parts = buildPost(data(deals), { slot: 1 });
  assert.ok(parts.length >= 2, `조각 ${parts.length}개`);
  for (const p of parts) {
    assert.ok(p.length <= 4096, `${p.length}자`);
    assert.equal(p.split('\n').at(-1), DISCLOSURE);
    assert.equal(p.split('\n').filter((l) => l === DISCLOSURE).length, 1);
  }
  assert.equal(parts[0].split('\n')[0], '🔥 10/13 핫딜 오이데~ TOP 5 (1/4)');
  assert.ok(parts.slice(1).every((p) => !p.includes('핫딜 오이데~')));
  // 안내 문구와 링크는 마지막 조각에
  assert.ok(parts.at(-1).endsWith(`\n${FOOTER.join('\n')}\n${DISCLOSURE}`));
  assert.ok(parts.slice(0, -1).every((p) => !p.includes(FOOTER[1])));
  // 번호는 1~5가 순서대로 한 번씩, 상품이 조각 사이에서 잘리지 않음
  const nums = parts.flatMap((p) => p.match(/^\d+\) /gm).map((m) => parseInt(m)));
  assert.deepEqual(nums, [1, 2, 3, 4, 5]);
  for (const p of parts) assert.equal(p.match(/^\d+\) /gm).length, p.match(/^   https:/gm).length);
  // dry-run 구분선
  const out = formatParts(parts);
  assert.ok(out.startsWith(`----- part 1/${parts.length} -----\n🔥`));
  assert.ok(out.includes(`\n----- part ${parts.length}/${parts.length} -----\n`));
  assert.equal(formatParts(['하나']), '하나');
});

test('실제 deals.json으로 slot 1~4 (5개씩, 상위 20개 안에서 겹치지 않음)', async () => {
  const real = await loadData(DEFAULT_FILE);
  const ranked = rankDeals(real.deals).length;
  const seen = [];
  for (let slot = 1; slot <= 4; slot++) {
    const parts = buildPost(real, { slot });
    const n = Math.max(0, Math.min(5, ranked - (slot - 1) * 5));
    if (!n) {
      assert.deepEqual(parts, []);
      continue;
    }
    assert.equal(parts[0].split('\n')[0].endsWith(`TOP ${n} (${slot}/4)`), true);
    const urls = parts.join('\n').match(/^   https:\S+/gm);
    assert.equal(urls.length, n);
    seen.push(...urls);
    for (const p of parts) {
      assert.ok(p.length <= 4096);
      assert.equal(p.split('\n').at(-1), DISCLOSURE);
    }
  }
  assert.equal(seen.length, Math.min(20, ranked));
});
