const won = n => n.toLocaleString('ko-KR') + '원';
const pct = d => d.originalPrice > d.salePrice ? Math.round((1 - d.salePrice / d.originalPrice) * 100) : 0;
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let all = [], cat = '전체';

function thumb(d) {
  return d.image
    ? `<img src="${esc(d.image)}" alt="${esc(d.title)}" loading="lazy">`
    : `<div class="ph" aria-hidden="true">${d.emoji || '🛒'}</div>`;
}
function card(d) {
  const p = pct(d);
  return `<article class="card">
    <div class="thumb">${thumb(d)}${p ? `<span class="badge">-${p}%</span>` : ''}</div>
    <div class="body">
      <div class="tags"><span class="tag">${esc(d.category)}</span>${d.rocket ? "<span class=\"tag rocket\">로켓</span>" : ""}</div>
      <h3>${esc(d.title)}</h3>
      <div class="price">${p ? `<s>${won(d.originalPrice)}</s>` : ''}<b>${won(d.salePrice)}</b></div>
      <a class="btn" data-id="${esc(d.id)}" href="${esc(d.url)}" target="_blank" rel="sponsored nofollow noopener">쿠팡에서 보기</a>
    </div></article>`;
}
// MY 설정(assets/my.js): 꺼 둔 카테고리는 숨기되, 남는 상품이 없으면 전체를 보여줌
const my = window.HDMY;
let notice = '';
function visible() {
  notice = '';
  if (!my) return all;
  const prefs = my.getPrefs(), off = my.CATS.map(c => c[1]).filter(c => !prefs.cats.includes(c));
  if (!off.length) return all;
  const list = all.filter(d => !off.includes(d.category));
  if (!list.length) { notice = 'MY에서 고른 카테고리에 오늘 상품이 없어 전체 상품을 보여드려요.'; return all; }
  notice = 'MY 설정에 따라 일부 카테고리를 숨겼어요.';
  return list;
}
// 기본 정렬(추천순)에서는 MY 성별·연령 일치 → 자주 누른 카테고리·키워드 순으로 먼저 보여줌
function byRecommend(list) {
  if (!my) return list.sort((a, b) => pct(b) - pct(a));
  const prefs = my.getPrefs(), clicks = my.getClicks(), sc = new Map(list.map(d => [d, my.score(d, prefs, clicks)]));
  return list.sort((a, b) => sc.get(b) - sc.get(a) || pct(b) - pct(a));
}
function renderTop() {
  const base = visible();
  let top = base.filter(d => d.top);
  if (!top.length) top = all.filter(d => d.top);
  document.getElementById('top').innerHTML = byRecommend(top).slice(0, 6).map(card).join('');
}
function render() {
  const q = document.getElementById('q').value.trim().toLowerCase();
  const sort = document.getElementById('sort').value;
  const base = visible();
  const note = document.getElementById('myNote');
  note.textContent = notice; note.hidden = !notice;
  let list = base.filter(d => (cat === '전체' || d.category === cat) && (!q || d.title.toLowerCase().includes(q)));
  if (sort === 'recommend') byRecommend(list);
  else if (sort === 'discount') list.sort((a, b) => pct(b) - pct(a));
  else list.sort(sort === 'price' ? (a, b) => a.salePrice - b.salePrice : (a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  document.getElementById('grid').innerHTML = list.map(card).join('');
  document.getElementById('empty').hidden = list.length > 0;
}
function renderCats() {
  const cats = ['전체', ...new Set(visible().map(d => d.category))];
  if (!cats.includes(cat)) cat = '전체';
  const el = document.getElementById('cats');
  el.innerHTML = cats.map(c => `<button class="chip${c === cat ? ' on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
  el.onclick = e => { const b = e.target.closest('.chip'); if (!b) return; cat = b.dataset.c; renderCats(); render(); };
}
fetch('deals.json', {cache: 'no-store'}).then(r => r.json()).then(data => {
  all = data.deals || [];
  document.getElementById('sampleBanner').hidden = !data.isSample;
  if (data.updatedAt) document.getElementById('updated').textContent =
    '업데이트: ' + new Date(data.updatedAt).toLocaleString('ko-KR', {timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short'}) + ' (KST)';
  renderTop(); renderCats(); render();
}).catch(() => { document.getElementById('empty').hidden = false; document.getElementById('empty').textContent = '상품 데이터를 불러오지 못했어요.'; });
document.getElementById('q').addEventListener('input', render);
document.getElementById('sort').addEventListener('change', render);
document.addEventListener('hd:my-change', () => { if (all.length) { renderTop(); renderCats(); render(); } });
// 예시 링크(#placeholder)는 이동하지 않고 안내만 표시
document.addEventListener('click', e => {
  const a = e.target.closest('a.btn');
  if (!a) return;
  if (a.getAttribute('href').startsWith('#')) { e.preventDefault(); alert('예시 데이터입니다. 실제 쿠팡 파트너스 링크로 바꿔 주세요.'); return; }
  // "쿠팡에서 보기" 클릭: 카테고리·키워드 횟수만 이 브라우저에 기록 (전송 없음)
  const d = all.find(x => String(x.id) === a.dataset.id);
  if (d && my) my.recordClick(d);
});
