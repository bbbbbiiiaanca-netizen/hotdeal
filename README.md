# 핫딜 오이데 — 쿠팡 파트너스 핫딜 큐레이션 (샘플)

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
assets/og.png     SNS 공유 이미지 1200x630 (brand/og.py로 생성)
scripts/refresh-deals.mjs  (사용 중지) 예전 쿠팡 API 자동 갱신 스크립트
scripts/import-manual-deals.mjs  data/manual-deals.csv → deals.json 검사·변환
data/manual-deals.csv      운영자가 직접 고른 상품 입력 파일 (예시: data/manual-deals.example.csv)
scripts/make-post.mjs      텔레그램 포스트 글 생성
scripts/post-telegram.mjs  텔레그램 채널에 전송 (중복 방지)
scripts/build-item-pages.mjs  품목별 페이지(deal/<품목>/) + sitemap.xml 생성
data/item-pages.json       품목 페이지 설정 (slug·keyword·subId·match·category·guide)
deal/<품목>/index.html     생성된 품목 페이지 (직접 고치지 말 것)
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
   - 지금은 이 방법만 씁니다. 직접 만든 링크를 `data/manual-deals.csv`에 적고 스크립트로 `deals.json`을 만드는 절차: [docs/manual-deals.md](docs/manual-deals.md)
4. Open API 키(Access Key / Secret Key)는 파트너스 대시보드의 Open API 메뉴에서 발급합니다. 보통 최종 승인 뒤에 발급됩니다.

## 3. API로 deals.json 자동 갱신 (사용 중지)
> **사용 중지 (2026-10-21 운영자 결정)**: 이 박스의 IP가 쿠팡에서 차단되어, goldbox.today 등 외부를 거쳐 갱신하던 방식도 중단했습니다. `scripts/refresh-deals.mjs`는 실행하면 안내만 출력하고 종료(exit 1)합니다.
> 이제는 운영자가 파트너스에서 직접 고른 상품을 CSV에 적어 `deals.json`을 만듭니다: [docs/manual-deals.md](docs/manual-deals.md)
> 아래 내용은 기록용으로 남겨 둡니다.

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
node scripts/make-post.mjs --slot 1                     # 1번째 묶음(할인율 1~5위) 글 출력
node scripts/make-post.mjs --slot 3 --file deals.json
node scripts/post-telegram.mjs --slot 2 --dry-run        # 메시지만 출력 (토큰·네트워크 없음)
TELEGRAM_BOT_TOKEN=... node scripts/post-telegram.mjs --slot 1
```
- 하루 4번(KST 09·13·17·21시) 올립니다. 시간마다 `--slot 1`~`--slot 4`로 실행하세요(스케줄은 cron 등에서 직접 설정).
- 유효한 상품(title·salePrice·url 있음)을 **할인율 높은 순**으로 정렬하고(할인율이 없는 상품은 맨 뒤, 같으면 `deals.json` 순서), 상위 20개를 5개씩 나눕니다. 같은 `id`나 같은 `url`이 여러 번 있으면 처음 것만 씁니다. slot k = k번째 묶음(순위 5(k-1)+1 ~ 5k위)이라 하루 안에서 같은 상품이 두 번 나오지 않습니다. `top` 필드는 쓰지 않습니다.
- 헤더는 `🔥 M/D 핫딜 오이데~ TOP N (k/4)`입니다(N = 그 slot의 실제 개수, 번호는 slot마다 1부터).
- 상품이 모자라 그 slot 몫이 없으면 아무것도 보내지 않고 안내만 출력한 뒤 정상 종료(exit 0)합니다. 유효한 상품이 아예 없으면 에러(exit 1)입니다.
- 링크 미리보기는 끕니다.
- 텔레그램 한도(4096자)를 넘으면 상품 단위로 여러 메시지로 나눠 차례로 보냅니다. 헤더는 첫 메시지, 안내 문구·전체 목록 링크는 마지막 메시지에 들어가고, **모든 메시지의 마지막 줄은 대가성 문구**입니다. `--dry-run`에서는 메시지가 여러 개일 때만 `----- part i/n -----` 줄로 구분해 보여줍니다.
- 상품 제목은 최대 200자(넘으면 `…`)로 자릅니다. 헤더와 첫 상품이 한 메시지에 안 들어가면 헤더만 따로 첫 메시지로 보냅니다. 판매가는 원 단위 양의 정수로 반올림하고 0원 이하인 상품은 뺍니다. 할인율은 정상가가 판매가보다 클 때만, 1~99%일 때만 표시합니다.
- 같은 날(KST) 같은 slot은 한 번만 올립니다. 기록은 `state/posted.json`(깃 제외, `STATE_FILE`로 경로 변경 가능)에 남습니다. 처음 실행할 때 모든 메시지의 글과 sha256 해시를 스냅샷으로 저장하고, 다시 돌리면 `deals.json`이 바뀌었어도 스냅샷에서 아직 안 보낸 메시지만 보냅니다. 상태 파일은 임시 파일에 쓴 뒤 rename해서 저장합니다.
- 하루 순위 스냅샷: 그날(KST) 처음 실행되는 slot(몇 번이든)이 상위 20개 순위(글에 필요한 필드만)를 상태 파일에 그 날짜로 저장합니다. 같은 날 나머지 slot은 `deals.json`이 바뀌었어도 이 순위로 만들고, 다른 slot에 이미 넣은 상품 id는 뺍니다. `--dry-run`도 저장된 순위가 있으면 그걸로 보여 줍니다(상태 파일은 안 바꿈).
- 동시 실행 방지: 실행 중에는 `state/post.lock`(pid·시각)을 잡고, 끝나면 풉니다. 10분이 넘은 잠금은 죽은 실행이 남긴 것으로 보고 풉니다.
- 재시도 규칙: 메시지를 보내기 직전에 상태를 `sending`으로 저장합니다. 메시지가 **안 올라간 게 확실한** 실패(연결 자체가 안 됨, 텔레그램이 `ok:false`로 거절한 429·5xx·4xx)만 3초 뒤(429면 `retry_after`만큼) 한 번 더 시도합니다. 응답 시간 초과, 연결 끊김, 응답을 못 읽음처럼 **올라갔는지 알 수 없는** 실패는 다시 보내지 않고 `uncertain`으로 저장한 뒤 멈춥니다.
- `uncertain`이 남아 있으면 다음 실행은 보내지 않고 안내를 출력합니다. 채널에서 직접 확인한 뒤, 올라갔으면 상태 파일에서 그 조각의 `status`를 `"sent"`로 바꾸고, 안 올라갔으면 `--force-uncertain`을 붙여 다시 실행하세요.
- 토큰은 출력·로그에 남기지 않습니다.
- 테스트: `node --test tests/`

## 3-2. 품목별 핫딜 페이지 (deal/<품목>/)
`deals.json`을 갱신한 **바로 뒤에** 실행합니다.
```bash
node scripts/build-item-pages.mjs --indexnow     # 페이지·사이트맵 생성 + 제출 대기 URL(바뀐 페이지)을 IndexNow 제출
node scripts/build-item-pages.mjs                # 생성만 (제출 안 함)
node scripts/build-item-pages.mjs --indexnow --dry-run   # 제출 직전까지만 확인
```
- `data/item-pages.json`의 품목마다 `deal/<slug>/index.html`을 만듭니다(주소는 `/deal/<퍼센트 인코딩된 slug>/`). 페이지는 지우지 않습니다. 설정에서 품목을 빼도 파일과 사이트맵 항목은 남습니다.
- 딜 고르기: 제목이 `match` 규칙에 맞고(대소문자 무시. 배열은 하나라도, `{"all": [...]}`는 모두, `{"any": [...]}`는 하나라도, 중첩 가능 — 예: `{"all": ["톤업", {"any": ["선", "spf"]}]}`) 링크가 `https://link.coupang.com/`으로 시작하는 딜만 씁니다. 예시·가짜 상품은 절대 넣지 않습니다.
- 화면: 오늘 딜이 있으면 그 딜 / 오늘은 없고 예전 기록이 있으면 "오늘은 딜 없음" + 최근 딜(확인 날짜, 가격이 바뀌었을 수 있다는 안내) / 기록이 아예 없으면 "준비 중" 안내.
- subId: 단축 링크(`link.coupang.com/a/...`)는 subId를 붙일 수 없어 그대로 두고 버튼에 `data-subid-missing="1"`을 표시합니다. `lptag`·`subId` 파라미터가 있는 긴 파트너스 링크만 품목의 `subId`를 넣습니다.
- 기록: `state/item-history.json`에 품목별 최근 딜 10개(url 기준 중복 제거)와 페이지 마지막 변경일을 남깁니다. 이 파일은 깃에 커밋합니다(새로 체크아웃해도 기록·lastmod 유지). 기록이 없으면 `lastmod`는 기존 사이트맵 항목 값을 이어 씁니다.
- 내용이 바뀐 파일만 다시 쓰고, 바뀐 페이지 URL 목록을 JSON으로 출력합니다. `sitemap.xml`은 기존 3개 항목을 그대로 두고 품목 페이지(설정에서 빠졌어도 `deal/`에 파일이 남아 있는 페이지 포함)를 붙이며, `lastmod`는 그 페이지 내용이 마지막으로 바뀐 날(KST)입니다.
- 페이지에 갱신 시각이 들어가서 `deals.json`의 `updatedAt`이 바뀌면 모든 품목 페이지가 바뀐 것으로 잡힙니다(하루 1번 갱신이면 하루 1번 제출).
- 바뀐 URL은 `state/indexnow-pending.json`(커밋 대상)에 쌓입니다. `--indexnow`는 이 대기 URL을 `scripts/indexnow-submit.mjs <URL...>`로 넘기고(그 스크립트는 URL을 주면 사이트맵 대신 이 사이트 origin의 URL만 제출), `--dry-run`이 아닌 제출이 성공했을 때만 대기 목록을 비웁니다. 실패하면 다음 실행에서 다시 제출합니다. 검색엔진이 새 페이지를 바로 가져갈 수 있으니, 가능하면 커밋·배포가 끝난 뒤에 제출하는 순서가 안전합니다.

## 4. 대가성 문구 (법적 의무)
공정위 「추천·보증 등에 관한 표시·광고 심사지침」(2024.12.1 개정 시행)에 따라 경제적 이해관계를 **게시물의 제목이나 첫 부분**에, 본문과 구분되게(글자 크기·색을 다르게) 표시해야 합니다. "받을 수 있습니다" 같은 조건부 표현은 안 됩니다.
이 사이트는 모든 페이지 맨 위에 `이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.`를 눈에 띄게 넣었습니다.
**텔레그램 채널 포스트는 운영자 결정에 따라 모든 메시지의 마지막 줄에 같은 문구를 넣습니다**(메시지가 여러 개로 나뉘어도 메시지마다 마지막 줄). 위 지침이 권하는 "첫 부분" 배치와 다르다는 점을 알고 정한 것이며, 배치를 바꾸려면 `scripts/make-post.mjs`와 테스트를 함께 고쳐야 합니다.

## 5. 방문자 모으기
- **핫딜 커뮤니티 (뽐뿌, 클리앙 알뜰구매, 루리웹, 펨코 핫딜 등)**: 대부분 **제휴(파트너스) 링크와 자기 사이트 홍보를 금지**하고, 걸리면 바로 영구 차단됩니다. 링크를 올리지 말고 각 게시판 규칙을 먼저 읽으세요. 휴대폰 성지 커뮤니티 등도 마찬가지입니다.
- **카카오톡 오픈채팅 "핫딜방" / 텔레그램 채널**: 직접 방을 열고 매일 같은 시간에 3~5개씩 올리는 방식이 가장 현실적입니다. 글마다 대가성 문구를 붙이세요. 남의 방에 링크를 뿌리면 강퇴되고 신고당합니다.
- **검색(SEO)**: "오늘 생수 최저가", "에어프라이어 할인"처럼 상품별 소개 페이지를 쌓으면 천천히 검색 유입이 생깁니다. 몇 달 걸립니다.
- **쇼츠·릴스**: "오늘의 특가 3개" 형식의 짧은 영상에 프로필 링크를 거는 방식입니다. 영상 안과 설명란 모두에 대가성 문구를 넣으세요.

## 6. 현실적인 기대치
수익은 **방문자 수 × 클릭률 × 구매 전환 × 수수료율**로 정해지고, 처음 몇 주는 거의 0원인 경우가 흔합니다. 수수료율과 정산 조건은 쿠팡 파트너스 공지에서 직접 확인하세요. 가격이 실제와 다르면 신뢰를 잃으니, 매일 갱신하고 "구매 전 쿠팡에서 가격 확인" 안내를 유지하세요.
