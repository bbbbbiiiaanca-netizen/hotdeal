// 쿠팡 파트너스 Open API로 deals.json을 갱신하는 스텁 (Node 18+, 외부 패키지 없음)
// 사용법: COUPANG_ACCESS_KEY=... COUPANG_SECRET_KEY=... node scripts/refresh-deals.mjs
// 키는 절대 코드/깃에 넣지 말고 환경변수(또는 GitHub Actions Secrets)로만 넘기세요.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const ACCESS_KEY = process.env.COUPANG_ACCESS_KEY;
const SECRET_KEY = process.env.COUPANG_SECRET_KEY;
const SUB_ID = process.env.COUPANG_SUB_ID || ''; // 파트너스에서 만든 채널 ID (선택)
if (!ACCESS_KEY || !SECRET_KEY) { console.error('COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY 환경변수가 필요합니다.'); process.exit(1); }

const HOST = 'https://api-gateway.coupang.com';
const BASE = '/v2/providers/affiliate_open_api/apis/openapi/v1';

// signed-date: UTC 기준 yyMMddTHHmmssZ (예: 261011T031500Z)
function authHeader(method, path, query) {
  const datetime = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '').slice(2);
  const message = datetime + method + path + query;           // 쿼리는 '?' 없이 붙임
  const signature = crypto.createHmac('sha256', SECRET_KEY).update(message).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`;
}

async function call(method, subPath, params = {}) {
  const path = BASE + subPath;
  const query = new URLSearchParams(params).toString();
  const res = await fetch(HOST + path + (query ? '?' + query : ''), {
    method, headers: { Authorization: authHeader(method, path, query), 'Content-Type': 'application/json;charset=UTF-8' }
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.rCode && json.rCode !== '0')) throw new Error(`${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json.data;
}

// 키워드 → 카테고리 매핑은 원하는 대로 수정하세요.
const KEYWORDS = { '디지털': '무선이어폰', '식품': '생수', '생활': '화장지', '가전': '에어프라이어' };

const deals = [];
// 1) 골드박스(당일 특가) — 응답 필드는 공식 문서에서 다시 확인하세요.
try {
  const gold = await call('GET', '/products/goldbox', SUB_ID ? { subId: SUB_ID } : {});
  for (const p of (gold || []).slice(0, 12)) deals.push(toDeal(p, '오늘의특가', true));
} catch (e) { console.warn('goldbox 실패:', e.message); }

// 2) 키워드 검색 (limit 최대 10). 검색 API는 1시간당 10회 제한 — 초과 시 24시간 정지, 누적 시 계정 제한. 하루 1~2회만 실행하세요.
for (const [category, keyword] of Object.entries(KEYWORDS)) {
  try {
    const data = await call('GET', '/products/search', { keyword, limit: 5, ...(SUB_ID && { subId: SUB_ID }) });
    for (const p of data?.productData || []) deals.push(toDeal(p, category, false));
  } catch (e) { console.warn(`search(${keyword}) 실패:`, e.message); }
}

function toDeal(p, category, top) {
  // 검색 API는 보통 현재가(productPrice)만 줍니다. 정상가가 없으면 할인율 배지는 표시되지 않습니다.
  const sale = Number(p.productPrice) || 0;
  const original = Number(p.originalPrice || p.basePrice) || sale;
  return {
    id: String(p.productId), title: p.productName, category,
    originalPrice: original, salePrice: sale, image: p.productImage, rocket: !!p.isRocket,
    addedAt: new Date().toISOString(), url: p.productUrl, top
  };
}

if (!deals.length) { console.error('가져온 상품이 없어 deals.json을 바꾸지 않습니다.'); process.exit(1); }
const out = { updatedAt: new Date().toISOString(), isSample: false, deals };
await fs.writeFile(new URL('../deals.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`deals.json 갱신 완료: ${deals.length}개`);
