// 홈 화면에 추가 안내 — 붉은실(SAJU src/components/platform/InstallAppButton.tsx)과 같은 동작
// - 안드로이드 Chrome/삼성인터넷: beforeinstallprompt를 잡아 '지금 바로 설치하기'
// - 아이폰 Safari: 공유 → 홈 화면에 추가 수동 안내
// - 이미 홈 화면 앱(standalone)으로 열렸으면 버튼을 숨김
(function () {
  const btn = document.getElementById('installBtn');
  if (!btn) return;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) { btn.hidden = true; return; }
  const ua = navigator.userAgent || '';
  const plat = /iPad|iPhone|iPod/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : 'other';
  let deferred = null, installed = false;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; });
  addEventListener('appinstalled', () => { installed = true; deferred = null; });
  const sec = (title, me, steps, note) => `<div class="i-sec${me ? ' me' : ''}"><p class="i-st">${title}${me ? '<span class="i-me">내 기기</span>' : ''}</p><ol>${steps.map(s => `<li>${s}</li>`).join('')}</ol>${note ? `<p class="i-note">💡 ${note}</p>` : ''}</div>`;
  function open() {
    const m = document.createElement('div');
    m.className = 'my-modal'; m.id = 'installModal';
    m.innerHTML = `<div class="my-backdrop" data-x></div><div class="my-dialog i-dialog" role="dialog" aria-modal="true" aria-label="핫딜 오이데 홈 화면에 추가 안내" tabindex="-1">
      <button type="button" class="my-x" data-x aria-label="닫기">✕</button>
      <h2>홈 화면에 앱처럼 추가하기</h2>
      <p class="i-sub">추가해 두면 아이콘을 눌러 <b>앱처럼 바로 실행</b>돼요.</p>
      ${installed ? '<p class="i-ok">설치가 완료됐어요. 홈 화면 아이콘을 확인해 주세요.</p>' : ''}
      ${deferred && !installed ? '<button type="button" class="i-now">지금 바로 설치하기</button>' : ''}
      ${sec('📱 아이폰(iPhone)', plat === 'ios', ['Safari 하단의 <b>공유 버튼(⬆️)</b>을 눌러요', '<b>홈 화면에 추가</b>를 선택해요', '우측 상단 <b>추가</b>를 눌러요'], '아이폰은 Safari 브라우저에서 열어야 추가할 수 있어요.')}
      ${sec('🤖 갤럭시·안드로이드', plat === 'android', ['Chrome 또는 삼성 인터넷 우측 상단 <b>⋮</b>를 눌러요', '<b>홈 화면에 추가</b> (또는 앱 설치)를 선택해요', '<b>추가</b>를 눌러요'])}
      <button type="button" class="my-reset i-close" data-x>닫기</button></div>`;
    const close = () => { m.remove(); document.body.classList.remove('my-lock'); removeEventListener('keydown', key); btn.focus(); };
    const key = e => { if (e.key === 'Escape') close(); };
    m.addEventListener('click', async e => {
      if (e.target.closest('[data-x]')) return close();
      if (e.target.closest('.i-now') && deferred) {
        await deferred.prompt(); const c = await deferred.userChoice; deferred = null;
        if (c.outcome === 'accepted') { installed = true; close(); }
      }
    });
    addEventListener('keydown', key);
    document.body.appendChild(m); document.body.classList.add('my-lock');
    m.querySelector('.my-dialog').focus();
  }
  btn.addEventListener('click', open);
})();
