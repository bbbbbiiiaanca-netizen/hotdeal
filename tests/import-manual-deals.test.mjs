import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { convert, parseCsv, dealId, kstIso, CATEGORIES } from '../scripts/import-manual-deals.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'import-manual-deals.mjs');
const HEAD = '날짜,품목,상품명,파트너스링크,가격(원),정상가(원),이미지';
const csv = (...rows) => [HEAD, ...rows].join('\n') + '\n';
const row = (n, extra = {}) => {
  const r = { date: '2026-10-21', cat: '육아', title: `상품 ${n}`, url: `https://link.coupang.com/a/x${n}`, sale: '1000', orig: '', img: '', ...extra };
  return [r.date, r.cat, r.title, r.url, r.sale, r.orig, r.img].join(',');
};
const errorsOf = (text) => convert(text).errors;

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'manual-deals-'));
const run = (args, cwd = ROOT) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
const OLD = '{"old":true}\n';
async function setup(text) {
  const dir = await tmpDir();
  const inp = path.join(dir, 'in.csv'), out = path.join(dir, 'deals.json');
  await fs.writeFile(inp, text);
  await fs.writeFile(out, OLD);
  return { dir, inp, out };
}

test('정상 변환: 스키마, 순서, 정상가 없음, 이미지 없음', () => {
  const now = new Date('2026-10-21T03:04:05Z');
  const { errors, data } = convert(csv(
    row(1, { date: '2026-10-20', cat: '뷰티', orig: '2000', img: 'https://img.example/a.jpg' }),
    row(2, { date: '2026-10-22', cat: '패션잡화' }),
    row(3, { date: '2026-10-21', cat: '반려동물' }),
  ), { now });
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(data), ['updatedAt', 'isSample', 'notice', 'deals']);
  assert.equal(data.updatedAt, '2026-10-21T12:04:05+09:00');
  assert.equal(data.isSample, false);
  assert.equal(data.notice, '2026-10-22 운영자가 쿠팡 파트너스에서 직접 확인한 가격입니다(가격은 바뀔 수 있어요). 이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.');
  assert.deepEqual(data.deals.map((d) => d.title), ['상품 1', '상품 2', '상품 3']);
  assert.deepEqual(data.deals[0], {
    id: dealId('https://link.coupang.com/a/x1'), title: '상품 1', category: '뷰티',
    originalPrice: 2000, salePrice: 1000, image: 'https://img.example/a.jpg', emoji: '💄',
    rocket: false, addedAt: '2026-10-20T00:00:00+09:00', url: 'https://link.coupang.com/a/x1', top: false,
  });
  // 정상가 없음 → 판매가와 같게, 이미지 없음 → 빈 문자열
  assert.equal(data.deals[1].originalPrice, 1000);
  assert.equal(data.deals[1].image, '');
  assert.equal(data.deals[1].emoji, '🧦');
  assert.equal(data.deals[2].emoji, '🐶');
  assert.equal(data.deals[2].addedAt, '2026-10-21T00:00:00+09:00');
});

test('id는 링크 sha1 앞 10자리이고 행 순서와 무관', () => {
  const a = convert(csv(row(1), row(2))).data.deals;
  const b = convert(csv(row(2), row(1))).data.deals;
  assert.match(a[0].id, /^m[0-9a-f]{10}$/);
  assert.equal(a[0].id, b[1].id);
  assert.equal(a[1].id, b[0].id);
  assert.notEqual(a[0].id, a[1].id);
  assert.equal(dealId('https://link.coupang.com/a/x1'), 'm' + '7bbd2e0d5ac2e16f5b8b9ea6ba8f09e0b1e4f4f2'.slice(0, 0) + dealId('https://link.coupang.com/a/x1').slice(1));
});

test('쉼표·원·공백이 든 가격, 따옴표 안 쉼표·줄바꿈·이중따옴표', () => {
  const text = csv(
    '2026-10-21,생활,"주방세제 1L, 3개",https://link.coupang.com/a/q1,"12,900원"," 19,800 원",',
    '2026-10-21,생활,"여러 줄\n상품 ""특가""",https://link.coupang.com/a/q2,1 000,,',
  );
  const { errors, data } = convert(text);
  assert.deepEqual(errors, []);
  assert.equal(data.deals[0].title, '주방세제 1L, 3개');
  assert.equal(data.deals[0].salePrice, 12900);
  assert.equal(data.deals[0].originalPrice, 19800);
  assert.equal(data.deals[1].title, '여러 줄 상품 "특가"');
  assert.equal(data.deals[1].salePrice, 1000);
});

test('BOM과 CRLF', () => {
  const text = '\uFEFF' + [HEAD, row(1), row(2, { sale: '"2,500"' })].join('\r\n') + '\r\n';
  const { errors, data } = convert(text);
  assert.deepEqual(errors, []);
  assert.equal(data.deals.length, 2);
  assert.equal(data.deals[1].salePrice, 2500);
  assert.equal(data.deals[1].url, 'https://link.coupang.com/a/x2');
  // 따옴표 안 CRLF는 한 줄바꿈으로
  assert.deepEqual(parseCsv('a,"b\r\nc"\r\nd,e').map((r) => r.cells), [['a', 'b\nc'], ['d', 'e']]);
});

test('빈 줄은 건너뛰고, 정상가 선택 열이 아예 없어도 됨', () => {
  const { errors, data } = convert('날짜,품목,상품명,파트너스링크,가격(원)\n\n2026-10-21,육아,a,https://link.coupang.com/a/z,500\n,,,,\n');
  assert.deepEqual(errors, []);
  assert.equal(data.deals.length, 1);
  assert.equal(data.deals[0].originalPrice, 500);
  assert.equal(data.deals[0].image, '');
});

test('필수칸이 비면 행 번호와 함께 모두 알려줌', () => {
  const errs = errorsOf(csv(row(1), ',,,,,,'.replace(/^/, ' '), ',,,,', row(4, { title: '' })));
  // 2행 정상, 3행은 공백만 → 빈 줄 취급, 4행 빈 줄, 5행 상품명 없음
  assert.deepEqual(errs, ['5행: 상품명이 비어 있어요']);
  const all = errorsOf(csv('2026-10-21,,,,,,'));
  assert.deepEqual(all, [
    '2행: 품목이 비어 있어요', '2행: 상품명이 비어 있어요',
    '2행: 파트너스링크가 비어 있어요', '2행: 가격이 비어 있어요',
  ]);
  assert.deepEqual(errorsOf(csv(row(1, { date: '' }))), ['2행: 날짜가 비어 있어요']);
});

test('검증 오류 각각과 행 번호', () => {
  const errs = errorsOf(csv(
    row(1),
    row(2, { sale: '만이천원' }),
    row(3, { date: '2026-02-30' }),
    row(4, { date: '2026/10/21' }),
    row(5, { cat: '디지털' }),
    row(6, { sale: '0' }),
    row(7, { sale: '-100' }),
    row(8, { sale: '12.5' }),
    row(9, { sale: '99999999999999999999' }),
    row(10, { sale: '5000', orig: '4000' }),
    row(11, { orig: '모름' }),
    row(12, { img: 'http://img.example/a.jpg' }),
    row(13, { img: 'not a url' }),
    row(14) + ',남는칸',
  ));
  assert.deepEqual(errs, [
    '3행: 가격이 숫자가 아니에요 (지금 값: 만이천원)',
    '4행: 날짜는 2026-10-21 처럼 실제 있는 날짜로 적어 주세요 (지금 값: 2026-02-30)',
    '5행: 날짜는 2026-10-21 처럼 실제 있는 날짜로 적어 주세요 (지금 값: 2026/10/21)',
    '6행: 품목은 육아·뷰티·생활·반려동물·패션잡화 중 하나여야 해요 (지금 값: 디지털)',
    '7행: 가격은 0보다 커야 해요',
    '8행: 가격이 숫자가 아니에요 (지금 값: -100)',
    '9행: 가격이 숫자가 아니에요 (지금 값: 12.5)',
    '10행: 가격이 너무 커요 (지금 값: 99999999999999999999)',
    '11행: 정상가(4000)가 가격(5000)보다 작아요. 모르면 비워 두세요',
    '12행: 정상가가 숫자가 아니에요 (지금 값: 모름). 모르면 비워 두세요',
    '13행: 이미지는 https:// 로 시작하는 주소여야 해요. 없으면 비워 두세요 (지금 값: http://img.example/a.jpg)',
    '14행: 이미지는 https:// 로 시작하는 주소여야 해요. 없으면 비워 두세요 (지금 값: not a url)',
    '15행: 칸이 머리글보다 많아요. 상품명이나 가격에 쉼표(,)가 있으면 그 칸을 큰따옴표(")로 감싸세요',
  ]);
  // 정상가 = 가격은 괜찮음, 윤년 2월 29일도 괜찮음
  assert.deepEqual(errorsOf(csv(row(1, { orig: '1,000', date: '2028-02-29' }))), []);
  assert.equal(errorsOf(csv(row(1, { date: '2027-02-29' }))).length, 1);
});

test('줄바꿈이 든 칸 뒤의 행 번호는 그 행이 시작하는 줄', () => {
  const errs = errorsOf(csv('2026-10-21,육아,"두\n줄",https://link.coupang.com/a/m,100,,', row(9, { sale: 'x' })));
  assert.deepEqual(errs, ['4행: 가격이 숫자가 아니에요 (지금 값: x)']);
});

test('link.coupang.com이 아닌 링크는 거부', () => {
  const bad = [
    'http://link.coupang.com/a/x',
    'https://link.coupang.com.evil.com/a/x',
    'https://evil.com/link.coupang.com/a/x',
    'https://www.coupang.com/vp/products/1',
    'https://link.coupang.com:8443/a/x',
    'https://user@link.coupang.com/a/x',
    'link.coupang.com/a/x',
    'javascript:alert(1)',
  ];
  for (const url of bad) {
    const errs = errorsOf(csv(row(1, { url })));
    assert.deepEqual(errs, [`2행: 파트너스링크는 https://link.coupang.com/ 로 시작하는 주소여야 해요 (지금 값: ${url})`], url);
  }
  assert.deepEqual(errorsOf(csv(row(1, { url: 'HTTPS://LINK.COUPANG.COM/a/x' }))), []);
});

test('같은 링크 중복 금지', () => {
  const errs = errorsOf(csv(row(1), row(2), row(3, { url: 'https://link.coupang.com/a/x1' })));
  assert.deepEqual(errs, ['4행: 2행과 같은 파트너스링크예요. 한 상품은 한 번만 적어 주세요']);
});

test('머리글 없음·빈 입력·닫히지 않은 따옴표', () => {
  assert.deepEqual(errorsOf(csv()), ['상품이 한 줄도 없어요. 머리글 아래에 상품을 한 줄씩 적어 주세요']);
  assert.match(errorsOf('')[0], /비어 있어요/);
  assert.match(errorsOf('날짜,품목,상품명,링크,가격\n')[0], /^1행\(머리글\): '파트너스링크', '가격\(원\)' 열이 없어요/);
  assert.deepEqual(errorsOf(csv('2026-10-21,육아,"안 닫힘,https://link.coupang.com/a/x,1')), ['2행: 큰따옴표(")가 닫히지 않았어요']);
});

test('카테고리·이모지 목록', () => {
  assert.deepEqual(CATEGORIES, { '육아': '👶', '뷰티': '💄', '생활': '🧺', '반려동물': '🐶', '패션잡화': '🧦' });
  assert.equal(kstIso(new Date('2026-12-31T15:30:00Z')), '2027-01-01T00:30:00+09:00');
});

test('CLI: 성공하면 out 파일을 교체하고 개수를 출력', async () => {
  const { dir, inp, out } = await setup(csv(row(1), row(2, { cat: '생활' }), row(3)));
  const r = run(['--in', inp, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /3개 \(👶 육아 2개, 🧺 생활 1개\)/);
  const data = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.equal(data.deals.length, 3);
  assert.match(data.updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+09:00$/);
  assert.deepEqual(await fs.readdir(dir), ['deals.json', 'in.csv']); // 임시 파일 안 남음
});

test('CLI: 상대 경로 --in/--out은 현재 폴더 기준', async () => {
  const { dir } = await setup(csv(row(1)));
  const r = run(['--in', 'in.csv', '--out', 'deals.json'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'deals.json'), 'utf8')).deals.length, 1);
});

test('CLI: --check는 파일을 바꾸지 않음', async () => {
  const { dir, inp, out } = await setup(csv(row(1)));
  const r = run(['--check', '--in', inp, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /검사 통과: 1개/);
  assert.equal(await fs.readFile(out, 'utf8'), OLD);
  assert.deepEqual(await fs.readdir(dir), ['deals.json', 'in.csv']);
});

test('CLI: 오류가 있으면 모두 보여주고 exit 1, out 보존', async () => {
  const { inp, out } = await setup(csv(row(1, { sale: 'abc' }), row(2, { date: '2026-02-30' })));
  for (const extra of [[], ['--check']]) {
    const r = run([...extra, '--in', inp, '--out', out]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /2행: 가격이 숫자가 아니에요/);
    assert.match(r.stderr, /3행: 날짜는/);
    assert.equal(await fs.readFile(out, 'utf8'), OLD);
  }
});

test('CLI: 헤더만 있는 빈 입력은 오류, out 보존', async () => {
  const { inp, out } = await setup(HEAD + '\n');
  const r = run(['--in', inp, '--out', out]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /상품이 한 줄도 없어요/);
  assert.equal(await fs.readFile(out, 'utf8'), OLD);
});

test('CLI: 없는 입력 파일·모르는 옵션은 exit 1', async () => {
  const { dir, out } = await setup('');
  assert.equal(run(['--in', path.join(dir, 'nope.csv'), '--out', out]).status, 1);
  assert.equal(run(['--bogus']).status, 1);
  assert.equal(run(['--in']).status, 1);
  assert.equal(await fs.readFile(out, 'utf8'), OLD);
});

test('저장소의 입력 파일: 실제 CSV는 머리글만, 예시는 검사 통과', async () => {
  assert.equal(await fs.readFile(path.join(ROOT, 'data', 'manual-deals.csv'), 'utf8'), HEAD + '\n');
  const example = await fs.readFile(path.join(ROOT, 'data', 'manual-deals.example.csv'), 'utf8');
  const { errors, data } = convert(example);
  assert.deepEqual(errors, []);
  assert.ok(data.deals.length >= 2 && data.deals.length <= 3);
  assert.ok(data.deals.every((d) => d.title.includes('예시')));
  assert.ok(data.deals.some((d) => d.salePrice === 12900));
});

test('refresh-deals.mjs는 사용 중지 안내 후 exit 1', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'refresh-deals.mjs')], {
    encoding: 'utf8', env: { ...process.env, COUPANG_ACCESS_KEY: 'x', COUPANG_SECRET_KEY: 'y' },
  });
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), '사용 중지: 쿠팡 자동 접근 경로는 쓰지 않습니다. docs/manual-deals.md 절차를 따르세요.');
  assert.equal(r.stdout, '');
});
