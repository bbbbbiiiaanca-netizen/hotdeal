// 교차광고 카드 클릭 측정 — gtag가 이미 있을 때만 이벤트 1회, 없으면 아무것도 안 함
// - 측정 ID·gtag.js 로드는 여기서 하지 않음
// - 보내는 값은 카드의 data-* 속성 4개뿐 (URL·사용자 값 없음), 링크 이동은 막지 않음
(function () {
  function buildPromoParams(el) {
    return {
      promo_target: el.getAttribute('data-promo-target'),
      promo_position: el.getAttribute('data-promo-position'),
      page_slug: el.getAttribute('data-page-slug'),
      copy_variant: el.getAttribute('data-copy-variant')
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { buildPromoParams };
  if (typeof document === 'undefined') return;
  document.addEventListener('click', function (e) {
    try {
      if (typeof window.gtag !== 'function') return;
      const a = e.target && e.target.closest && e.target.closest('a[data-promo-target]');
      if (!a) return;
      window.gtag('event', 'cross_promo_click', buildPromoParams(a));
    } catch (_) {}
  });
})();
