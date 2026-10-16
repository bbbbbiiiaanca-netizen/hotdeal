#!/usr/bin/env node
/**
 * IndexNow 제출 — 라이브 사이트맵의 URL을 Bing·Naver·Yandex 등 IndexNow 검색엔진에 한 번에 알린다.
 * 비밀값 없음: 키는 공개 파일(/<KEY>.txt)로 소유를 증명한다. 구글은 IndexNow를 쓰지 않는다.
 *
 * 사용: node scripts/indexnow-submit.mjs [--dry-run] [URL ...]
 * URL을 주면 그 URL만(이 사이트 것만) 제출하고, 없으면 라이브 사이트맵의 URL 전체를 제출한다.
 * deals.json·페이지 변경이 GitHub Pages에 반영된 뒤 수동 실행(비밀값 없음, 쿠팡 키 불필요).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = process.env.INDEXNOW_HOST ?? "hotdeal.sooinlab.com";
const KEY = "2c3cec7d2a6c8471acdd8066ccf9398c";
const ORIGIN = `https://${HOST}`;

/** 파싱한 URL의 origin이 정확히 origin과 같은 것만 남긴다(문자열 접두사 비교는 https://host.evil.com 등을 통과시킴). */
export function sameOriginUrls(urls, origin = ORIGIN) {
  const want = new URL(origin).origin;
  return urls.filter((u) => {
    try { return new URL(u).origin === want; } catch { return false; }
  });
}

async function main() {
  const dry = process.argv.includes("--dry-run");
  const argUrls = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  const keyRes = await fetch(`${ORIGIN}/${KEY}.txt`);
  const keyBody = keyRes.ok ? (await keyRes.text()).trim() : "";
  if (keyBody !== KEY) {
    console.error(`키 파일이 라이브에 없어 제출을 건너뜀 (status ${keyRes.status})`);
    process.exit(dry ? 0 : 1);
  }

  const xml = argUrls.length ? "" : await (await fetch(`${ORIGIN}/sitemap.xml`)).text();
  const candidates = argUrls.length ? argUrls : [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  const urls = sameOriginUrls(candidates).slice(0, 10000);
  if (urls.length < candidates.length) console.error(`다른 사이트 URL ${candidates.length - urls.length}개 제외`);
  console.log(`${argUrls.length ? "지정" : "sitemap"} URL ${urls.length}개`);
  if (!urls.length || dry) process.exit(0);

  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `${ORIGIN}/${KEY}.txt`, urlList: urls }),
  });
  console.log(`IndexNow 응답 ${res.status}`);
  process.exit(res.status === 200 || res.status === 202 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
