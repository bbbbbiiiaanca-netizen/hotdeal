// 하우스 교차 광고: 붉은실 칸을 재회 프리미엄 / 월하도령 중 하나로 랜덤 표시(기본 HTML은 월하도령).
(function () {
  var li = document.getElementById('xad-bulgeunsil');
  if (!li || Math.random() >= 0.5) return;
  var a = li.querySelector('a');
  a.href = 'https://bulgeunsil.sooinlab.com/reunion-premium?utm_source=hotdeal&utm_medium=house_banner&utm_campaign=cross_ad&utm_content=reunion_premium';
  a.textContent = '우리, 다시 만날 수 있을까 · 붉은실 재회 프리미엄 감정서';
})();
