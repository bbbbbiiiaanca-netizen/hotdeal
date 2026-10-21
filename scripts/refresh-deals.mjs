// 사용 중지 (2026-10-21 운영자 결정)
// 이 박스의 IP가 쿠팡에서 차단되었고, goldbox.today 등 외부를 거쳐 쿠팡 데이터를 가져오는 갱신도 중단했습니다.
// 쿠팡에 자동으로 접근하던 예전 코드(Open API 호출)는 지웠습니다. 필요하면 git 기록에서 볼 수 있습니다.
// 이제는 운영자가 파트너스에서 직접 고른 상품을 data/manual-deals.csv에 적고
// scripts/import-manual-deals.mjs로 deals.json을 만듭니다. docs/manual-deals.md 참고.
console.error('사용 중지: 쿠팡 자동 접근 경로는 쓰지 않습니다. docs/manual-deals.md 절차를 따르세요.');
process.exit(1);
