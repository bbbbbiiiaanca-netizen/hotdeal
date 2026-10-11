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
      <a class="btn" href="${esc(d.url)}" target="_blank" rel="sponsored nofollow noopener">쿠팡에서 보기</a>
    </div></article>`;
}
function render() {
  const q = document.getElementById('q').value.trim().toLowerCase();
  const sort = document.getElementById('sort').value;
  let list = all.filter(d => (cat === '전체' || d.category === cat) && (!q || d.title.toLowerCase().includes(q)));
  list.sort(sort === 'price' ? (a, b) => a.salePrice - b.salePrice
          : sort === 'new' ? (a, b) => new Date(b.addedAt) - new Date(a.addedAt)
          : (a, b) => pct(b) - pct(a));
  document.getElementById('grid').innerHTML = list.map(card).join('');
  document.getElementById('empty').hidden = list.length > 0;
}
function renderCats() {
  const cats = ['전체', ...new Set(all.map(d => d.category))];
  const el = document.getElementById('cats');
  el.innerHTML = cats.map(c => `<button class="chip${c === cat ? ' on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
  el.onclick = e => { const b = e.target.closest('.chip'); if (!b) return; cat = b.dataset.c; renderCats(); render(); };
}
fetch('deals.json', {cache: 'no-store'}).then(r => r.json()).then(data => {
  all = data.deals || [];
  document.getElementById('sampleBanner').hidden = !data.isSample;
  if (data.updatedAt) document.getElementById('updated').textContent =
    '업데이트: ' + new Date(data.updatedAt).toLocaleString('ko-KR', {timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short'}) + ' (KST)';
  const top = all.filter(d => d.top).sort((a, b) => pct(b) - pct(a)).slice(0, 6);
  document.getElementById('top').innerHTML = top.map(card).join('');
  renderCats(); render();
}).catch(() => { document.getElementById('empty').hidden = false; document.getElementById('empty').textContent = '상품 데이터를 불러오지 못했어요.'; });
document.getElementById('q').addEventListener('input', render);
document.getElementById('sort').addEventListener('change', render);
// 예시 링크(#placeholder)는 이동하지 않고 안내만 표시
document.addEventListener('click', e => {
  const a = e.target.closest('a.btn');
  if (a && a.getAttribute('href').startsWith('#')) { e.preventDefault(); alert('예시 데이터입니다. 실제 쿠팡 파트너스 링크로 바꿔 주세요.'); }
});
