#!/usr/bin/env node
/**
 * IndexNow 제출 — 라이브 사이트맵의 URL을 Bing·Naver·Yandex 등 IndexNow 검색엔진에 한 번에 알린다.
 * 비밀값 없음: 키는 공개 파일(/<KEY>.txt)로 소유를 증명한다. 구글은 IndexNow를 쓰지 않는다.
 *
 * 사용: node scripts/indexnow-submit.mjs [--dry-run]
 * deals.json·페이지 변경이 GitHub Pages에 반영된 뒤 수동 실행(비밀값 없음, 쿠팡 키 불필요).
 */
const HOST = process.env.INDEXNOW_HOST ?? "hotdeal.sooinlab.com";
const KEY = "2c3cec7d2a6c8471acdd8066ccf9398c";
const ORIGIN = `https://${HOST}`;
const dry = process.argv.includes("--dry-run");

const keyRes = await fetch(`${ORIGIN}/${KEY}.txt`);
const keyBody = keyRes.ok ? (await keyRes.text()).trim() : "";
if (keyBody !== KEY) {
  console.error(`키 파일이 라이브에 없어 제출을 건너뜀 (status ${keyRes.status})`);
  process.exit(dry ? 0 : 1);
}

const xml = await (await fetch(`${ORIGIN}/sitemap.xml`)).text();
const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)]
  .map((m) => m[1])
  .filter((u) => u.startsWith(ORIGIN))
  .slice(0, 10000);
console.log(`sitemap URL ${urls.length}개`);
if (!urls.length || dry) process.exit(0);

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `${ORIGIN}/${KEY}.txt`, urlList: urls }),
});
console.log(`IndexNow 응답 ${res.status}`);
process.exit(res.status === 200 || res.status === 202 ? 0 : 1);
