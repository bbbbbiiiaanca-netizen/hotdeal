import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  isDuplicate, findEntry, sentIds, upsertEntry, snapshotEntry, sendParts, sendMessage, classifyFetchError,
  SendError, UncertainError, sanitize, isValidToken, extractToken, kstDate, sha256,
  readState, writeState, acquireLock, run,
} from '../scripts/post-telegram.mjs';

const TOKEN = '123456789:' + 'A'.repeat(35);
const NOW = new Date('2026-10-12T22:00:00Z'); // KST 2026-10-13 07:00
const DATE = '2026-10-13';

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'hotdeal-post-'));
const deal = (id, extra = {}) => ({
  id, title: `상품 ${id}`, category: '육아', originalPrice: 47100, salePrice: 22250,
  url: `https://link.coupang.com/a/${id}`, ...extra,
});

// deals.json과 상태 파일을 임시 폴더에 만들고 run()을 부르는 도우미
async function setup(deals, slot = 1) {
  const dir = await tmpDir();
  const file = path.join(dir, 'deals.json');
  await fs.writeFile(file, JSON.stringify({ updatedAt: '2026-10-13T07:35:00+09:00', deals }));
  const stateFile = path.join(dir, 'state', 'posted.json');
  const logs = [];
  const go = (fetchImpl, extraArgs = []) =>
    run({
      argv: ['--slot', String(slot), '--file', file, ...extraArgs],
      env: { TELEGRAM_BOT_TOKEN: TOKEN, STATE_FILE: stateFile },
      fetchImpl, now: () => NOW, sleep: async () => {},
      log: (m) => logs.push(m), warn: (m) => logs.push(m),
    });
  return { dir, file, stateFile, logs, go, state: () => readState(stateFile) };
}

// 가짜 텔레그램: 요청 본문을 기록하고 순서대로 응답(함수면 호출)
function fakeFetch(responses) {
  const calls = [];
  let n = 0;
  const impl = async (url, opts) => {
    calls.push({ url, text: JSON.parse(opts.body).text });
    const r = responses[Math.min(n++, responses.length - 1)];
    return typeof r === 'function' ? r() : r;
  };
  return { impl, calls };
}
const okRes = (id) => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: id } }) });
const tgErr = (status, description, parameters) => ({ ok: false, status, json: async () => ({ ok: false, description, ...(parameters && { parameters }) }) });
const badJson = (status = 200) => ({ ok: status < 400, status, json: async () => { throw new SyntaxError('Unexpected token <'); } });
const netErr = (code) => () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code } }); };
const timeoutErr = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };

const entry = (texts) => snapshotEntry(DATE, 1, texts);
const noSleep = { sleep: async () => {} };

test('스냅샷: 조각마다 글·sha256 해시·pending 상태 저장', () => {
  const e = entry(['a', 'b']);
  assert.deepEqual(e, {
    date: DATE, slot: 1,
    parts: [
      { index: 0, text: 'a', hash: sha256('a'), status: 'pending' },
      { index: 1, text: 'b', hash: sha256('b'), status: 'pending' },
    ],
  });
  assert.equal(sha256('a'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
});

test('중복 방지 헬퍼: 날짜 + slot 기준', () => {
  let entries = [];
  assert.equal(isDuplicate(entries, DATE, 1), false);
  const e = entry(['a', 'b']);
  e.parts[0].status = 'sent';
  e.parts[0].message_id = 101;
  entries = upsertEntry(entries, e);
  assert.equal(isDuplicate(entries, DATE, 1), false);
  assert.deepEqual(sentIds(findEntry(entries, DATE, 1)), [101]);
  e.parts[1].status = 'sent';
  e.parts[1].message_id = 102;
  entries = upsertEntry(entries, e);
  assert.equal(entries.length, 1);
  assert.equal(isDuplicate(entries, DATE, 1), true);
  assert.equal(isDuplicate(entries, DATE, 2), false);
  assert.equal(isDuplicate(entries, '2026-10-14', 1), false);
  // 다른 slot은 따로 저장
  entries = upsertEntry(entries, snapshotEntry(DATE, 2, ['c']));
  assert.equal(entries.length, 2);
  // slot 없는 예전(morning/evening) 기록은 무시
  const old = [{ date: DATE, mode: 'morning', message_id: 9 }, { date: DATE, mode: 'evening', parts: 1, message_ids: [1] }];
  assert.equal(findEntry(old, DATE, 1), undefined);
  assert.equal(isDuplicate(old, DATE, 1), false);
  assert.equal(upsertEntry(old, snapshotEntry(DATE, 1, ['a'])).length, 3);
  assert.equal(kstDate(new Date('2026-10-12T15:30:00Z')), '2026-10-13');
});

test('sendMessage: 응답을 실패 종류로 분류', async () => {
  const send = (res) => sendMessage(TOKEN, 'hi', { fetchImpl: async () => (typeof res === 'function' ? res() : res) });
  assert.equal(await send(okRes(5)), 5);
  for (const [res, kind] of [
    [tgErr(429, 'Too Many Requests', { retry_after: 7 }), 'pre-delivery'],
    [tgErr(500, 'Internal Server Error'), 'pre-delivery'],
    [tgErr(502, 'Bad Gateway'), 'pre-delivery'],
    [tgErr(400, 'Bad Request: chat not found'), 'pre-delivery'],
    [netErr('ECONNREFUSED'), 'pre-delivery'],
    [netErr('ENOTFOUND'), 'pre-delivery'],
    [netErr('UND_ERR_CONNECT_TIMEOUT'), 'pre-delivery'],
    [netErr('ECONNRESET'), 'ambiguous'],
    [netErr('UND_ERR_SOCKET'), 'ambiguous'],
    [netErr('UND_ERR_HEADERS_TIMEOUT'), 'ambiguous'],
    [timeoutErr, 'ambiguous'],
    [badJson(200), 'ambiguous'],
    [badJson(502), 'ambiguous'], // 프록시가 준 HTML 502: 텔레그램 응답인지 모름
    [{ ok: true, status: 200, json: async () => ({ ok: true }) }, 'ambiguous'],
  ]) {
    await assert.rejects(send(res), (e) => e instanceof SendError && e.kind === kind, `${kind}`);
  }
  await assert.rejects(send(tgErr(429, 'x', { retry_after: 7 })), (e) => e.retryAfterMs === 7000);
  assert.equal(classifyFetchError(new Error('boom')).kind, 'ambiguous');
});

test('sendParts: 보내기 전에 sending 저장, 성공하면 sent + message_id', async () => {
  const e = entry(['a', 'b']);
  const snaps = [];
  let id = 200;
  const ids = await sendParts(e, {
    send: async (text) => { snaps.push(`send ${text}: ${e.parts.find((p) => p.text === text).status}`); return ++id; },
    persist: async (x) => snaps.push(x.parts.map((p) => p.status).join(',')),
  });
  assert.deepEqual(ids, [201, 202]);
  assert.deepEqual(snaps, ['sending,pending', 'send a: sending', 'sent,pending', 'sent,sending', 'send b: sending', 'sent,sent']);
});

test('sendParts: 안 올라간 게 확실한 실패(429/5xx/4xx/연결 실패)는 한 번만 재시도', async () => {
  for (const err of [new SendError('429', 'pre-delivery'), new SendError('500', 'pre-delivery'), new SendError('ECONNREFUSED', 'pre-delivery')]) {
    const e = entry(['a']);
    let calls = 0;
    const waits = [];
    const ids = await sendParts(e, {
      send: async () => { if (++calls === 1) throw err; return 9; },
      persist: async () => {}, sleep: async (ms) => waits.push(ms),
    });
    assert.deepEqual(ids, [9]);
    assert.equal(calls, 2);
    assert.deepEqual(waits, [3000]);
  }
  // 429 retry_after를 따름
  const waits = [];
  let calls = 0;
  await sendParts(entry(['a']), {
    send: async () => { if (++calls === 1) throw new SendError('429', 'pre-delivery', { retryAfterMs: 7000 }); return 1; },
    persist: async () => {}, sleep: async (ms) => waits.push(ms),
  });
  assert.deepEqual(waits, [7000]);

  // 두 번 다 실패하면 pending으로 되돌리고 멈춤 (다음 실행에서 다시 보내도 안전)
  const e = entry(['a', 'b']);
  calls = 0;
  await assert.rejects(
    sendParts(e, { send: async () => { calls++; throw new SendError('Telegram 500', 'pre-delivery'); }, persist: async () => {}, ...noSleep }),
    (err) => err instanceof SendError,
  );
  assert.equal(calls, 2);
  assert.deepEqual(e.parts.map((p) => p.status), ['pending', 'pending']);
  assert.equal(e.parts[0].error, 'Telegram 500');
});

test('sendParts: 결과가 불확실하면 재시도 없이 uncertain 저장 후 멈춤', async () => {
  for (const err of [new SendError('timeout', 'ambiguous'), new Error('unknown')]) {
    const e = entry(['a', 'b', 'c']);
    const sent = [];
    const persisted = [];
    await assert.rejects(
      sendParts(e, {
        send: async (t) => { sent.push(t); if (t === 'b') throw err; return 1; },
        persist: async (x) => persisted.push(x.parts.map((p) => p.status).join(',')),
        sleep: async () => assert.fail('재시도하면 안 됨'),
      }),
      UncertainError,
    );
    assert.deepEqual(sent, ['a', 'b']); // b는 한 번만, c는 안 보냄
    assert.equal(persisted.at(-1), 'sent,uncertain,pending');
  }
});

test('sendParts: uncertain 조각은 --force-uncertain 없이는 다시 안 보냄', async () => {
  const e = entry(['a', 'b']);
  e.parts[0].status = 'uncertain';
  let calls = 0;
  const send = async () => ++calls;
  await assert.rejects(sendParts(e, { send, persist: async () => {} }), UncertainError);
  assert.equal(calls, 0);
  // 지난 실행이 sending에서 죽었으면 uncertain으로 바꾸고 멈춤
  const crashed = entry(['a']);
  crashed.parts[0].status = 'sending';
  const saved = [];
  await assert.rejects(sendParts(crashed, { send, persist: async (x) => saved.push(x.parts[0].status) }), UncertainError);
  assert.deepEqual(saved, ['uncertain']);
  assert.equal(calls, 0);
  // 강제로 다시 보내기
  const ids = await sendParts(e, { send, persist: async () => {}, forceUncertain: true });
  assert.deepEqual(ids, [1, 2]);
});

test('sendParts: 저장된 글이 해시와 다르면 보내지 않음', async () => {
  const e = entry(['a']);
  e.parts[0].text = 'changed';
  await assert.rejects(sendParts(e, { send: async () => assert.fail('보내면 안 됨'), persist: async () => {} }), /해시/);
});

test('상태 파일은 임시 파일에 쓰고 rename (임시 파일이 남지 않음)', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'state', 'posted.json');
  await writeState(file, [{ a: 1 }]);
  await writeState(file, [{ a: 2 }]);
  assert.deepEqual(await readState(file), [{ a: 2 }]);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['posted.json']);
  // 쓰기에 실패해도 원래 파일은 그대로
  const circular = {};
  circular.self = circular;
  await assert.rejects(writeState(file, [circular]));
  assert.deepEqual(await readState(file), [{ a: 2 }]);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['posted.json']);
});

test('잠금: 동시 실행 막기, 10분 지난 잠금은 풀기, 끝나면 해제', async () => {
  const dir = await tmpDir();
  const lock = path.join(dir, 'state', 'post.lock');
  let t = Date.parse('2026-10-13T00:00:00Z');
  const now = () => t;
  const release = await acquireLock(lock, { now });
  const info = JSON.parse(await fs.readFile(lock, 'utf8'));
  assert.equal(info.pid, process.pid);
  assert.equal(info.timestamp, '2026-10-13T00:00:00.000Z');
  await assert.rejects(acquireLock(lock, { now }), /다른 전송이 실행 중/);
  t += 9 * 60 * 1000;
  await assert.rejects(acquireLock(lock, { now }), /다른 전송이 실행 중/);
  t += 2 * 60 * 1000; // 11분 지남 → 오래된 잠금
  const release2 = await acquireLock(lock, { now });
  await release(); // 남의(새) 잠금은 지우지 않음
  await assert.rejects(acquireLock(lock, { now }), /다른 전송이 실행 중/);
  await release2();
  await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
});

test('run: 첫 실행에 스냅샷 저장, 이어서 보낼 땐 바뀐 deals.json이 아니라 스냅샷을 보냄', async () => {
  // URL을 길게 해서 slot 1(5개)이 여러 조각으로 나뉘게 함
  const deals = Array.from({ length: 5 }, (_, i) => deal(`d${i}`, { url: `https://link.coupang.com/a/d${i}?` + 'u'.repeat(1200) }));
  const s = await setup(deals);
  // 두 번째 조각에서 확실한 실패 2번 → 멈춤
  const first = fakeFetch([okRes(1), tgErr(500, 'Internal'), tgErr(500, 'Internal')]);
  await assert.rejects(s.go(first.impl), /Telegram 500/);
  const [e1] = await s.state();
  assert.ok(e1.parts.length >= 2);
  assert.deepEqual(e1.parts.slice(0, 2).map((p) => p.status), ['sent', 'pending']);
  for (const p of e1.parts) assert.equal(p.hash, sha256(p.text));
  assert.equal(first.calls[0].text, e1.parts[0].text);

  // deals.json이 바뀌어도 스냅샷 그대로 보냄
  await fs.writeFile(s.file, JSON.stringify({ updatedAt: '2026-10-13T07:35:00+09:00', deals: [deal('new')] }));
  const second = fakeFetch(e1.parts.map((_, i) => okRes(100 + i)));
  const result = await s.go(second.impl);
  assert.equal(result.status, 'sent');
  assert.deepEqual(second.calls.map((c) => c.text), e1.parts.slice(1).map((p) => p.text));
  assert.ok(second.calls.every((c) => !c.text.includes('상품 new')));
  const [e2] = await s.state();
  assert.ok(e2.parts.every((p) => p.status === 'sent'));
  assert.deepEqual(result.ids, [1, ...e1.parts.slice(1).map((_, i) => 100 + i)]);

  // 다 보냈으면 다시 안 보냄, 잠금도 풀려 있음
  const third = fakeFetch([okRes(999)]);
  assert.equal((await s.go(third.impl)).status, 'duplicate');
  assert.equal(third.calls.length, 0);
  await assert.rejects(fs.stat(path.join(path.dirname(s.stateFile), 'post.lock')), { code: 'ENOENT' });
});

test('run: 응답 시간 초과는 재전송하지 않고 uncertain, 다음 실행은 --force-uncertain 없으면 거부', async () => {
  const s = await setup([deal('a')]);
  const first = fakeFetch([timeoutErr, okRes(2)]);
  await assert.rejects(s.go(first.impl), (e) => {
    assert.match(e.message, /전송 결과를 알 수 없는 조각/);
    assert.match(e.message, /조각 1\/1 \(sha256 [0-9a-f]{12}…/);
    assert.match(e.message, /--force-uncertain/);
    assert.match(e.message, /@hotdeal_oide/);
    return true;
  });
  assert.equal(first.calls.length, 1); // 재시도 없음
  assert.equal((await s.state())[0].parts[0].status, 'uncertain');

  const second = fakeFetch([okRes(3)]);
  await assert.rejects(s.go(second.impl), /전송 결과를 알 수 없는 조각/);
  assert.equal(second.calls.length, 0);

  const third = fakeFetch([okRes(4)]);
  const r = await s.go(third.impl, ['--force-uncertain']);
  assert.deepEqual(r.ids, [4]);
  assert.equal(third.calls.length, 1);
  assert.ok(s.logs.some((l) => l.includes('--force-uncertain으로 다시 보냅니다')));
  // 잠금은 실패한 실행 뒤에도 풀려 있었음 (그래서 두 번째·세 번째 실행이 가능)
});

test('run: JSON을 못 읽는 응답도 uncertain', async () => {
  const s = await setup([deal('a')]);
  const f = fakeFetch([badJson(200), okRes(2)]);
  await assert.rejects(s.go(f.impl), /전송 결과를 알 수 없는 조각/);
  assert.equal(f.calls.length, 1);
});

test('run: 다른 실행이 잠금을 잡고 있으면 아무것도 안 보냄', async () => {
  const s = await setup([deal('a')]);
  const lock = path.join(path.dirname(s.stateFile), 'post.lock');
  await fs.mkdir(path.dirname(lock), { recursive: true });
  await fs.writeFile(lock, JSON.stringify({ pid: 1, timestamp: NOW.toISOString() }));
  const f = fakeFetch([okRes(1)]);
  await assert.rejects(s.go(f.impl), /다른 전송이 실행 중/);
  assert.equal(f.calls.length, 0);
  assert.ok(await fs.stat(lock)); // 남의 잠금은 그대로
});

test('run: slot마다 따로 보내고, 같은 날 같은 slot은 한 번만', async () => {
  const deals = Array.from({ length: 12 }, (_, i) => deal(`d${i}`, { salePrice: 10000 - i * 100, originalPrice: 10000 }));
  const s1 = await setup(deals, 1);
  const f1 = fakeFetch([okRes(1)]);
  assert.equal((await s1.go(f1.impl)).status, 'sent');
  assert.ok(f1.calls[0].text.startsWith('🔥 10/13 핫딜 오이데~ TOP 5 (1/4)\n'));
  const titles = (t) => t.match(/^\d+\) (.+)$/gm).map((l) => l.replace(/^\d+\) /, ''));
  assert.deepEqual(titles(f1.calls[0].text), ['상품 d11', '상품 d10', '상품 d9', '상품 d8', '상품 d7']);
  // 같은 상태 파일로 slot 2: 다음 5개
  const f2 = fakeFetch([okRes(2)]);
  const r2 = await run({
    argv: ['--slot', '2', '--file', s1.file], env: { TELEGRAM_BOT_TOKEN: TOKEN, STATE_FILE: s1.stateFile },
    fetchImpl: f2.impl, now: () => NOW, log: () => {}, warn: () => {},
  });
  assert.equal(r2.status, 'sent');
  assert.ok(f2.calls[0].text.startsWith('🔥 10/13 핫딜 오이데~ TOP 5 (2/4)\n'));
  assert.deepEqual(titles(f2.calls[0].text), ['상품 d6', '상품 d5', '상품 d4', '상품 d3', '상품 d2']);
  const st = await s1.state();
  assert.deepEqual(st.map((e) => [e.date, e.slot]), [[DATE, 1], [DATE, 2]]);
  // slot 1 다시 → 중복
  const f3 = fakeFetch([okRes(3)]);
  assert.equal((await s1.go(f3.impl)).status, 'duplicate');
  assert.equal(f3.calls.length, 0);
});

test('run: slot 몫이 없으면 아무것도 안 보내고 상태도 안 남김', async () => {
  const s = await setup([deal('a'), deal('b')], 3);
  const f = fakeFetch([okRes(1)]);
  assert.equal((await s.go(f.impl)).status, 'empty');
  assert.equal(f.calls.length, 0);
  assert.ok(s.logs.some((l) => l.includes('slot 3에 올릴 상품이 없습니다')));
  assert.deepEqual(await s.state(), []);
  await assert.rejects(fs.stat(path.join(path.dirname(s.stateFile), 'post.lock')), { code: 'ENOENT' });
  // dry-run도 같음
  const dry = await s.go(f.impl, ['--dry-run']);
  assert.equal(dry.status, 'empty');
  assert.equal(f.calls.length, 0);
});

test('run: 토큰은 에러·로그에 나오지 않음', async () => {
  const s = await setup([deal('a')]);
  const leaky = async (url) => { throw Object.assign(new TypeError(`request to ${url} failed`), { cause: { code: 'ECONNREFUSED' } }); };
  await assert.rejects(s.go(leaky), (e) => !e.message.includes(TOKEN) && !e.message.includes('AAAAAAAAAA'));
  const tokenInDesc = fakeFetch([tgErr(401, `Unauthorized ${TOKEN}`)]);
  await assert.rejects(s.go(tokenInDesc.impl), (e) => !e.message.includes(TOKEN));
  for (const l of s.logs) assert.ok(!l.includes(TOKEN), l);
  assert.ok(s.logs.some((l) => l.includes('[REDACTED]')));
});

test('토큰 검사와 에러 문구 정리', () => {
  assert.ok(isValidToken(TOKEN));
  assert.ok(!isValidToken('123:short'));
  assert.ok(!isValidToken(''));
  assert.ok(!isValidToken(` ${TOKEN} `));
  assert.equal(extractToken(`  ${TOKEN}\n`), TOKEN);
  assert.equal(extractToken(`TELEGRAM_BOT_TOKEN=${TOKEN} # 봇 토큰`), TOKEN);
  assert.equal(extractToken(`"${TOKEN}" 987654321:${'B'.repeat(35)}`), TOKEN);
  assert.equal(extractToken('토큰 없음 123:short'), null);
  assert.equal(extractToken(undefined), null);
  const msg = sanitize(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`, TOKEN);
  assert.ok(!msg.includes(TOKEN));
  assert.ok(!msg.includes('123456789'));
});
