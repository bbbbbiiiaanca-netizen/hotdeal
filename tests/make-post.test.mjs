import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPost, formatParts, pickDeals, priceLine, kstMonthDay, DISCLOSURE, FOOTER, DEFAULT_FILE, loadData } from '../scripts/make-post.mjs';
import { isDuplicate, findEntry, sentIds, upsertEntry, sendParts, sanitize, isValidToken, extractToken, withRetry, kstDate } from '../scripts/post-telegram.mjs';

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

test('상품 하나가 4096자를 넘으면 에러', () => {
  assert.throws(() => buildPost(data([deal('a', { title: 'x'.repeat(5000) })])), /4096/);
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

test('post-telegram: 중복 방지 헬퍼', () => {
  let entries = [];
  assert.equal(isDuplicate(entries, '2026-10-13', 'morning'), false);
  entries = upsertEntry(entries, '2026-10-13', 'morning', 2, [101]);
  assert.equal(isDuplicate(entries, '2026-10-13', 'morning'), false); // 2개 중 1개만 보냄
  assert.deepEqual(sentIds(findEntry(entries, '2026-10-13', 'morning')), [101]);
  entries = upsertEntry(entries, '2026-10-13', 'morning', 2, [101, 102]);
  assert.deepEqual(entries, [{ date: '2026-10-13', mode: 'morning', parts: 2, message_ids: [101, 102] }]);
  assert.equal(isDuplicate(entries, '2026-10-13', 'morning'), true);
  assert.equal(isDuplicate(entries, '2026-10-13', 'evening'), false);
  assert.equal(isDuplicate(entries, '2026-10-14', 'morning'), false);
  // 예전 형식 기록도 다 보낸 것으로 봄
  const legacy = [{ date: '2026-10-12', mode: 'evening', message_id: 9 }];
  assert.equal(isDuplicate(legacy, '2026-10-12', 'evening'), true);
  assert.deepEqual(sentIds(legacy[0]), [9]);
  assert.equal(kstDate(new Date('2026-10-12T15:30:00Z')), '2026-10-13');
});

test('post-telegram: 조각을 순서대로 보내고, 이미 보낸 조각은 다시 안 보냄', async () => {
  const sent = [];
  const saved = [];
  let id = 200;
  const send = async (text) => { sent.push(text); return ++id; };
  const ids = await sendParts(['a', 'b', 'c'], { alreadySent: [101], send, onSent: (x) => saved.push(x) });
  assert.deepEqual(sent, ['b', 'c']);
  assert.deepEqual(ids, [101, 201, 202]);
  assert.deepEqual(saved, [[101, 201], [101, 201, 202]]);

  // 두 번째 조각이 두 번 다 실패하면 첫 조각까지만 저장되고 에러
  const progress = [];
  let calls = 0;
  const flaky = async (text) => { calls++; if (text === 'b') throw new Error('down'); return 1; };
  await assert.rejects(
    sendParts(['a', 'b', 'c'], { send: flaky, onSent: (x) => progress.push(x), retry: () => ({ sleep: async () => {} }) }),
    /down/,
  );
  assert.equal(calls, 3); // a 1번 + b 2번(재시도 1회), c는 안 보냄
  assert.deepEqual(progress, [[1]]);
});

test('post-telegram: 토큰 검사와 에러 문구 정리', () => {
  const token = '123456789:' + 'A'.repeat(35);
  assert.ok(isValidToken(token));
  assert.ok(!isValidToken('123:short'));
  assert.ok(!isValidToken(''));
  assert.ok(!isValidToken(` ${token} `));
  assert.equal(extractToken(token), token);
  assert.equal(extractToken(`  ${token}\n`), token);
  assert.equal(extractToken(`TELEGRAM_BOT_TOKEN=${token} # 봇 토큰`), token);
  assert.equal(extractToken(`"${token}" 987654321:${'B'.repeat(35)}`), token);
  assert.equal(extractToken('토큰 없음 123:short'), null);
  assert.equal(extractToken(undefined), null);
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
