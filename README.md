# 오늘의 핫딜 — 쿠팡 파트너스 핫딜 큐레이션 (샘플)

서버 없는 정적 사이트(HTML/CSS/JS)입니다. 상품 데이터는 모두 `deals.json`에 들어 있고, 나중에 쿠팡 파트너스 Open API로 자동 갱신할 수 있습니다.

> ⚠️ 지금 `deals.json`의 상품은 전부 **예시 데이터**입니다(가격·할인율이 실제가 아니고, 링크는 `#placeholder`). 공개하기 전에 반드시 실제 파트너스 링크로 바꾸세요.

## 파일 구성
```
index.html        메인 (TOP 딜, 카테고리 필터, 정렬, 검색)
about.html        사이트 소개 (애드센스 심사용)
privacy.html      개인정보처리방침 (애드센스 심사용)
deals.json        상품 데이터
assets/style.css  디자인 (모바일 우선)
assets/app.js     목록 렌더링, 필터, 정렬, 검색
scripts/refresh-deals.mjs  쿠팡 API로 deals.json을 갱신하는 스크립트(스텁)
scripts/make-post.mjs      텔레그램 포스트 글 생성
scripts/post-telegram.mjs  텔레그램 채널에 전송 (중복 방지)
tests/            node:test 테스트
screens/          스크린샷
```

로컬에서 미리 보기: `cd hotdeal && python3 -m http.server 8080` → http://localhost:8080
(`file://`로 바로 열면 deals.json을 못 불러옵니다.)

## deals.json 형식
```json
{ "updatedAt": "ISO 시간", "isSample": false,
  "deals": [{ "id": "...", "title": "...", "category": "디지털",
              "originalPrice": 129000, "salePrice": 79000,
              "image": "https://...", "emoji": "🎧", "rocket": true,
              "addedAt": "ISO 시간", "url": "https://link.coupang.com/...", "top": true }] }
```
- `isSample: true`이면 화면 위에 "예시 데이터" 안내가 뜹니다.
- `top: true`인 상품이 "오늘의 TOP 딜"에 나옵니다.
- 할인율은 `originalPrice`와 `salePrice`로 자동 계산됩니다. 정상가를 모르면 두 값을 같게 넣으세요(배지가 안 뜸). **할인율을 지어내지 마세요.**

## 1. 무료로 배포하기
**Cloudflare Pages (추천)**
1. 이 폴더를 GitHub 저장소에 올립니다.
2. Cloudflare 대시보드 → Workers & Pages → Create → Pages → GitHub 저장소 연결.
3. Framework는 None, Build command는 비워 두고, Output directory는 `/`로 둡니다.
4. 배포가 끝나면 `xxx.pages.dev` 주소가 생깁니다. 도메인(연 1~2만 원대)을 연결하면 애드센스 심사에 유리합니다.

**GitHub Pages**
저장소 → Settings → Pages → Branch `main` / root → Save. 주소는 `아이디.github.io/저장소명`입니다.

## 2. 쿠팡 파트너스 가입과 API 키 받기
1. https://partners.coupang.com 에서 가입하고 활동 채널(이 사이트 URL)을 등록합니다.
2. **최종 승인**: 파트너스 링크로 생긴 누적 구매금액이 15만 원을 넘으면 채널 심사가 진행되고, 최종 승인이 나야 수수료를 정산받을 수 있습니다. (2026년 기준으로 여러 가이드가 같은 내용을 안내함. 공식 도움말에서 다시 확인하세요.)
3. 링크는 승인 전에도 파트너스 웹의 "링크 생성"으로 직접 만들 수 있습니다. 처음에는 손으로 링크를 만들어 `deals.json`에 넣으면 됩니다.
4. Open API 키(Access Key / Secret Key)는 파트너스 대시보드의 Open API 메뉴에서 발급합니다. 보통 최종 승인 뒤에 발급됩니다.

## 3. API로 deals.json 자동 갱신
```bash
COUPANG_ACCESS_KEY=xxx COUPANG_SECRET_KEY=yyy COUPANG_SUB_ID=mychannel \
  node scripts/refresh-deals.mjs
```
- 인증 방식: `Authorization: CEA algorithm=HmacSHA256, access-key=…, signed-date=…, signature=…`
  - `signed-date` = UTC 기준 `yyMMddTHHmmssZ`
  - `signature` = HMAC-SHA256(secretKey, signed-date + METHOD + path + querystring) 결과의 hex 값
- 엔드포인트: `https://api-gateway.coupang.com/v2/providers/affiliate_open_api/apis/openapi/v1/products/search`(키워드 검색, limit 최대 10), `/products/goldbox`(골드박스)
  - 오래된 예제 중에는 `/v1` 없이 `/openapi/products/search` 경로를 쓰는 것도 있습니다. 실행이 안 되면 공식 문서(파트너스 → Open API 도움말)에서 경로와 응답 필드를 확인하세요.
- **호출 제한 (반드시 지키기)**: 검색 API는 1시간당 10회, 전체 API는 1분당 100회입니다. 넘으면 24시간 정지되고, 경고가 쌓이면 파트너스 이용 자체가 제한될 수 있습니다. 스크립트는 하루 1~2회만 돌리세요.
- 검색 API는 현재가(`productPrice`)만 주고 정상가는 주지 않는 경우가 많습니다. 정상가가 없으면 할인 배지가 숨겨집니다.
- 자동화: GitHub Actions에 하루 1회 cron 작업을 만들고 키는 Repository Secrets에 넣은 뒤, 갱신된 deals.json을 커밋하면 Cloudflare Pages가 자동으로 다시 배포합니다. **키를 코드나 저장소에 절대 넣지 마세요.**

## 3-1. 텔레그램 채널 자동 포스팅
`deals.json`으로 @hotdeal_oide 채널에 올릴 글(일반 텍스트)을 만들고 보냅니다.
```bash
node scripts/make-post.mjs --mode morning            # 아침: TOP 딜 우선 최대 5개
node scripts/make-post.mjs --mode evening --file deals.json   # 저녁: 아침 다음 3개
node scripts/post-telegram.mjs --mode morning --dry-run       # 메시지만 출력 (토큰·네트워크 없음)
TELEGRAM_BOT_TOKEN=... node scripts/post-telegram.mjs --mode morning
```
- 글 첫 줄에는 항상 대가성 문구가 들어갑니다. 링크 미리보기는 끕니다.
- 같은 날(KST) 같은 mode는 한 번만 올립니다. 기록은 `state/posted.json`(깃 제외, `STATE_FILE`로 경로 변경 가능)에 남습니다.
- 전송이 실패하면 3초 뒤 한 번 더 시도합니다. 토큰은 출력·로그에 남기지 않습니다.
- 테스트: `node --test tests/`

## 4. 대가성 문구 (법적 의무)
공정위 「추천·보증 등에 관한 표시·광고 심사지침」(2024.12.1 개정 시행)에 따라 경제적 이해관계를 **게시물의 제목이나 첫 부분**에, 본문과 구분되게(글자 크기·색을 다르게) 표시해야 합니다. "받을 수 있습니다" 같은 조건부 표현은 안 됩니다.
이 사이트는 모든 페이지 맨 위에 `이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.`를 눈에 띄게 넣었습니다. **SNS, 커뮤니티, 오픈채팅에 링크를 올릴 때도 글마다 같은 문구를 맨 앞에 붙이세요.**

## 5. 방문자 모으기
- **핫딜 커뮤니티 (뽐뿌, 클리앙 알뜰구매, 루리웹, 펨코 핫딜 등)**: 대부분 **제휴(파트너스) 링크와 자기 사이트 홍보를 금지**하고, 걸리면 바로 영구 차단됩니다. 링크를 올리지 말고 각 게시판 규칙을 먼저 읽으세요. 휴대폰 성지 커뮤니티 등도 마찬가지입니다.
- **카카오톡 오픈채팅 "핫딜방" / 텔레그램 채널**: 직접 방을 열고 매일 같은 시간에 3~5개씩 올리는 방식이 가장 현실적입니다. 글마다 대가성 문구를 붙이세요. 남의 방에 링크를 뿌리면 강퇴되고 신고당합니다.
- **검색(SEO)**: "오늘 생수 최저가", "에어프라이어 할인"처럼 상품별 소개 페이지를 쌓으면 천천히 검색 유입이 생깁니다. 몇 달 걸립니다.
- **쇼츠·릴스**: "오늘의 특가 3개" 형식의 짧은 영상에 프로필 링크를 거는 방식입니다. 영상 안과 설명란 모두에 대가성 문구를 넣으세요.

## 6. 현실적인 기대치
수익은 **방문자 수 × 클릭률 × 구매 전환 × 수수료율**로 정해지고, 처음 몇 주는 거의 0원인 경우가 흔합니다. 수수료율과 정산 조건은 쿠팡 파트너스 공지에서 직접 확인하세요. 가격이 실제와 다르면 신뢰를 잃으니, 매일 갱신하고 "구매 전 쿠팡에서 가격 확인" 안내를 유지하세요.
