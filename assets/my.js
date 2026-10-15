// MY 설정: 관심 카테고리·성별·연령대와 클릭 기록을 이 브라우저(localStorage)에만 저장합니다. 서버로 보내지 않습니다.
(function () {
  const PREFS_KEY = 'hd_my_prefs', CLICKS_KEY = 'hd_my_clicks';
  // 모달 라벨 → deals.json의 category 값
  const CATS = [['출산·육아', '육아'], ['뷰티', '뷰티'], ['생활·주방', '생활'], ['반려동물', '반려동물'], ['패션잡화', '패션잡화']];
  const GENDERS = [['', '선택 안 함'], ['여성', '여성'], ['남성', '남성']];
  const AGES = [['', '전체'], ['10대', '10대'], ['20대', '20대'], ['30대', '30대'], ['40대', '40대'], ['50대+', '50대+']];

  // localStorage가 막혀 있어도(사파리 사생활 보호 등) 오류 없이 동작
  function store() { try { return window.localStorage || null; } catch (e) { return null; } }
  function read(key) { try { const s = store(); return s ? JSON.parse(s.getItem(key) || 'null') : null; } catch (e) { return null; } }
  function write(key, v) { try { const s = store(); if (s) s.setItem(key, JSON.stringify(v)); return !!s; } catch (e) { return false; } }
  function remove(key) { try { const s = store(); if (!s) return false; s.removeItem(key); return s.getItem(key) === null; } catch (e) { return false; } }

  function getPrefs() {
    const p = read(PREFS_KEY) || {};
    const known = CATS.map(c => c[1]);
    return {
      cats: Array.isArray(p.cats) ? p.cats.filter(c => known.includes(c)) : known.slice(),
      gender: GENDERS.some(g => g[0] === p.gender) ? p.gender : '',
      age: AGES.some(a => a[0] === p.age) ? p.age : '',
    };
  }
  function getClicks() {
    const c = read(CLICKS_KEY) || {};
    return { cats: c.cats && typeof c.cats === 'object' ? c.cats : {}, kw: c.kw && typeof c.kw === 'object' ? c.kw : {} };
  }
  // 상품명에서 단순 키워드 추출: 2글자 이상 한글/영문 단어(용량·수량 같은 숫자 단위 제외)
  function keywords(title) {
    return [...new Set((String(title).match(/[가-힣A-Za-z]{2,}/g) || []).map(w => w.toLowerCase()))]
      .filter(w => !/^(ml|kg|cm|mm|개입|세트|혼합)$/.test(w)).slice(0, 8);
  }
  function recordClick(deal) {
    const c = getClicks();
    if (deal.category) c.cats[deal.category] = (c.cats[deal.category] || 0) + 1;
    keywords(deal.title).forEach(w => { c.kw[w] = (c.kw[w] || 0) + 1; });
    // 키워드는 많이 눌린 200개만 유지
    const kws = Object.entries(c.kw);
    if (kws.length > 200) c.kw = Object.fromEntries(kws.sort((a, b) => b[1] - a[1]).slice(0, 200));
    write(CLICKS_KEY, c);
  }

  // 성별·연령대 추천 규칙 (상품명·카테고리·가격 기준, 해당 없으면 '전체' 취급)
  const MALE = /남성|남자|맨즈|면도|쉐이빙|옴므|homme/i;
  const FEMALE = /여성|여자|우먼|레이디|생리대/;
  const FEMALE_BEAUTY = /톤업|립|쿠션|파운데이션|마스카라|섀도|블러셔|네일|핸즈|핸드크림/;
  function audience(d) {
    const t = String(d.title || ''), gender = [], age = [];
    if (MALE.test(t)) gender.push('남성');
    else if (FEMALE.test(t) || (d.category === '뷰티' && FEMALE_BEAUTY.test(t))) gender.push('여성');
    if (d.category === '육아' || /베이비|유아|신생아|아기/.test(t)) age.push('20대', '30대');
    if (/주니어|키즈|아동/.test(t)) age.push('30대', '40대');
    if (/아크네|여드름|스팟/.test(t)) age.push('10대', '20대');
    if (/등산|관절/.test(t) && d.category !== '반려동물') age.push('40대', '50대+');
    // 1.5만 원 이하 뷰티·패션잡화(유아·아동용 제외)는 10대 용돈 가격대로 봄
    if (d.salePrice > 0 && d.salePrice <= 15000 && (d.category === '뷰티' || d.category === '패션잡화')
        && !age.includes('20대') && !/주니어|키즈|아동/.test(t) && !age.includes('10대')) age.push('10대');
    return { gender, age };
  }
  // 정렬 점수: 성별·연령 일치가 우선, 그다음 자주 누른 카테고리·키워드
  function score(d, prefs, clicks) {
    const a = audience(d);
    let s = 0;
    if (prefs.gender && a.gender.includes(prefs.gender)) s += 100;
    if (prefs.age && a.age.includes(prefs.age)) s += 100;
    s += Math.min(clicks.cats[d.category] || 0, 10) * 3;
    s += Math.min(keywords(d.title).reduce((n, w) => n + (clicks.kw[w] || 0), 0), 10);
    return s;
  }

  window.HDMY = { CATS, getPrefs, getClicks, recordClick, audience, score };

  // ---- 모달 ----
  const btn = document.getElementById('myBtn');
  if (!btn) return;
  const opt = (type, name, value, label, checked) =>
    `<label class="my-opt"><input type="${type}" name="${name}" value="${value}"${checked ? ' checked' : ''}><span>${label}</span></label>`;
  const modal = document.createElement('div');
  modal.className = 'my-modal';
  modal.hidden = true;
  modal.innerHTML = `<div class="my-backdrop" data-close></div>
    <div class="my-dialog" role="dialog" aria-modal="true" aria-labelledby="myTitle" tabindex="-1">
      <button type="button" class="my-x" data-close aria-label="닫기">✕</button>
      <h2 id="myTitle">MY 맞춤 설정</h2>
      <p class="muted">이 기기 브라우저에만 저장되고 서버로 보내지 않아요.</p>
      <form id="myForm">
        <fieldset><legend>관심 카테고리</legend><div class="my-opts" id="myCats"></div></fieldset>
        <fieldset><legend>성별</legend><div class="my-opts" id="myGender"></div></fieldset>
        <fieldset><legend>연령대</legend><div class="my-opts" id="myAge"></div></fieldset>
        <p class="my-status" id="myStatus" role="status"></p>
        <div class="my-actions">
          <button type="button" class="my-reset" id="myReset">추천 기록 초기화</button>
          <button type="submit" class="btn my-save">저장</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(modal);
  const dialog = modal.querySelector('.my-dialog'), form = modal.querySelector('#myForm'), status = modal.querySelector('#myStatus');

  function fill() {
    const p = getPrefs();
    modal.querySelector('#myCats').innerHTML = CATS.map(([l, v]) => opt('checkbox', 'cat', v, l, p.cats.includes(v))).join('');
    modal.querySelector('#myGender').innerHTML = GENDERS.map(([v, l]) => opt('radio', 'gender', v, l, p.gender === v)).join('');
    modal.querySelector('#myAge').innerHTML = AGES.map(([v, l]) => opt('radio', 'age', v, l, p.age === v)).join('');
    status.textContent = store() ? '' : '이 브라우저에서는 저장 공간을 쓸 수 없어 설정이 유지되지 않아요.';
  }
  let lastFocus = null, inerted = [];
  // 모달이 열린 동안 바깥 페이지(헤더·본문·푸터 등)는 inert로 막음 (원래 inert였던 요소는 건드리지 않음)
  function setInert(on) {
    if (on) {
      inerted = [...document.body.children].filter(el => el !== modal && !el.inert);
      inerted.forEach(el => { el.inert = true; });
    } else {
      inerted.forEach(el => { el.inert = false; });
      inerted = [];
    }
  }
  function open() {
    fill();
    lastFocus = document.activeElement;
    setInert(true);
    modal.hidden = false;
    document.body.classList.add('my-lock');
    btn.setAttribute('aria-expanded', 'true');
    (dialog.querySelector('input') || dialog).focus();
  }
  function close() {
    modal.hidden = true;
    setInert(false);
    document.body.classList.remove('my-lock');
    btn.setAttribute('aria-expanded', 'false');
    (lastFocus && lastFocus !== document.body && lastFocus.focus ? lastFocus : btn).focus();
  }
  const changed = () => document.dispatchEvent(new CustomEvent('hd:my-change'));

  btn.addEventListener('click', open);
  modal.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
  modal.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    // 포커스가 모달 밖으로 나가지 않도록 처음↔끝 순환
    const f = [...dialog.querySelectorAll('button, input')].filter(el => !el.disabled && el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(form);
    const ok = write(PREFS_KEY, { cats: fd.getAll('cat'), gender: fd.get('gender') || '', age: fd.get('age') || '' });
    if (!ok) { status.textContent = '이 브라우저에서는 저장할 수 없어요.'; return; }
    changed();
    close();
  });
  modal.querySelector('#myReset').addEventListener('click', () => {
    if (!remove(CLICKS_KEY)) { status.textContent = '이 브라우저에서는 추천 기록을 지울 수 없어요.'; return; }
    status.textContent = '추천 기록을 지웠어요.';
    changed();
  });
  // 품목 페이지의 '쿠팡에서 지금 가격 보기'(data-track) 클릭도 메인 카드와 같은 recordClick·같은 저장소에 기록
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[data-track]');
    if (a) recordClick({ category: a.dataset.cat, title: a.dataset.title || '' });
  });
})();
