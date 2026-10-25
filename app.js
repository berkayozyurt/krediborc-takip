/* Borç Takip — tüm veriler yalnızca bu cihazın tarayıcısında (localStorage) tutulur. */
'use strict';

const KEY = 'borctakip_v1';
const $ = (s, el = document) => el.querySelector(s);
const MONTHS = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
const MSHORT = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];

const blank = () => ({
  loans: [], income: 0, fixed: [], tx: [],
  plan: { extra: null, strategy: 'avalanche' },
  pinHash: null,
});

let S = load();
let tab = 'ozet';
let budgetMonth = ymOf(todayISO());

/* ---------- storage ---------- */
function load() {
  try { const d = JSON.parse(localStorage.getItem(KEY)); return d ? { ...blank(), ...d } : blank(); }
  catch { return blank(); }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} }
const uid = () => Math.random().toString(36).slice(2, 10);

/* ---------- helpers ---------- */
function tl(n, dec = 2) {
  return (Number(n) || 0).toLocaleString('tr-TR', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + ' ₺';
}
const tl0 = n => tl(n, 0);
function num(v) {
  if (typeof v === 'number') return v;
  v = String(v || '').trim().replace(/\s|₺|TL/gi, '');
  if (v.includes(',')) v = v.replace(/\./g, '').replace(',', '.');
  return parseFloat(v) || 0;
}
function todayISO() { const d = new Date(); return iso(d); }
function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function parse(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addMonths(s, k) {
  const d = parse(s), day = d.getDate();
  const t = new Date(d.getFullYear(), d.getMonth() + k, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(day, last));
  return iso(t);
}
function ymOf(s) { return s.slice(0, 7); }
function ymLabel(ym) { const [y, m] = ym.split('-').map(Number); return MONTHS[m - 1] + ' ' + y; }
function ymShift(ym, k) { return ymOf(addMonths(ym + '-01', k)); }
function fmtDate(s) { const d = parse(s); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }
function daysUntil(s) { return Math.round((parse(s) - parse(todayISO())) / 864e5); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const loanName = l => (l.name || 'Kredi') + (l.bank ? ' · ' + l.bank : '');

/* ---------- loan math ---------- */
const active = () => S.loans.filter(l => l.remaining > 0 && l.debt > 0.5);
const totalDebt = () => active().reduce((a, l) => a + l.debt, 0);
const monthlyPay = () => active().reduce((a, l) => a + l.payment, 0);

function schedule(l) {
  const out = [];
  for (let k = 0; k < l.remaining; k++) {
    const isLast = k === l.remaining - 1;
    const amt = isLast ? Math.max(l.debt - l.payment * (l.remaining - 1), 0) || l.payment : l.payment;
    out.push({ date: addMonths(l.next, k), amount: amt, loan: l });
  }
  return out;
}
const allPayments = () => active().flatMap(schedule).sort((a, b) => a.date.localeCompare(b.date));
const lastDate = l => addMonths(l.next, l.remaining - 1);

function principal(l) {
  if (l.payoff > 0) return l.payoff;
  const r = (l.rate || 0) / 100, n = l.remaining, p = l.payment;
  return r > 0 ? p * (1 - Math.pow(1 + r, -n)) / r : p * n;
}

/* Planlı ödeme simülasyonu: her ay toplam bütçe = tüm taksitler + ekstra.
   Biten kredinin taksiti, sıradaki hedef krediye aktarılır (kartopu etkisi). */
function simulate(extra, strategy) {
  const L = active().map(l => ({ id: l.id, name: loanName(l), bal: principal(l), r: (l.rate || 0) / 100, pay: l.payment, done: null }));
  if (!L.length) return null;
  const budget = L.reduce((a, l) => a + l.pay, 0) + Math.max(extra, 0);
  const order = [...L].sort(strategy === 'snowball' ? (a, b) => a.bal - b.bal : (a, b) => b.r - a.r || a.bal - b.bal);
  let month = 0, paid = 0;
  const startYM = ymShift(ymOf(todayISO()), 1);
  while (L.some(l => l.bal > 0.01) && month < 600) {
    month++;
    let pool = budget;
    for (const l of L) if (l.bal > 0.01) l.bal *= 1 + l.r;
    for (const l of L) if (l.bal > 0.01) { const p = Math.min(l.pay, l.bal); l.bal -= p; pool -= p; paid += p; }
    for (const l of order) {
      if (pool <= 0.01) break;
      if (l.bal > 0.01) { const p = Math.min(pool, l.bal); l.bal -= p; pool -= p; paid += p; }
    }
    for (const l of L) if (l.bal <= 0.01 && !l.done) l.done = ymShift(startYM, month - 1);
  }
  return { months: month, paid, end: ymShift(startYM, month - 1), order: order.map(o => L.find(x => x.id === o.id)), budget };
}

/* ---------- budget ---------- */
function monthTx(ym) { return S.tx.filter(t => ymOf(t.date) === ym); }
function budgetFor(ym) {
  const tx = monthTx(ym);
  const extraIncome = tx.filter(t => t.type === 'gelir').reduce((a, t) => a + t.amount, 0);
  const spend = tx.filter(t => t.type === 'gider').reduce((a, t) => a + t.amount, 0);
  const fixed = S.fixed.reduce((a, f) => a + f.amount, 0);
  const income = S.income + extraIncome;
  const loans = monthlyPay();
  return { income, base: S.income, extraIncome, fixed, spend, loans, left: income - fixed - spend - loans };
}
function avgSpend() {
  const cur = ymOf(todayISO());
  const months = [ymShift(cur, -1), ymShift(cur, -2), ymShift(cur, -3)].filter(ym => monthTx(ym).length);
  if (!months.length) return budgetFor(cur).spend;
  return months.reduce((a, ym) => a + budgetFor(ym).spend, 0) / months.length;
}
function suggestedExtra() {
  const fixed = S.fixed.reduce((a, f) => a + f.amount, 0);
  return Math.max(0, Math.floor((S.income - fixed - avgSpend() - monthlyPay()) / 100) * 100);
}

/* ---------- öneriler ---------- */
function tips() {
  const out = [];
  const A = active();
  if (!A.length) return [{ k: 'good', i: '🎉', t: 'Aktif kredin yok. Harika!' }];
  const pay = monthlyPay();
  const b = budgetFor(ymOf(todayISO()));

  if (!S.income) out.push({ k: 'info', i: '✍️', t: 'Bütçe sekmesinden aylık gelirini gir; borç/gelir dengen ve planın ona göre hesaplansın.' });
  else {
    const ratio = pay / S.income * 100;
    if (ratio >= 50) out.push({ k: 'bad', i: '⚠️', t: `Gelirinin %${ratio.toFixed(0)}'i taksitlere gidiyor. Bu çok yüksek bir oran; yeni borç almak bu dengeyi daha da bozar.` });
    else if (ratio >= 35) out.push({ k: 'warn', i: '⚖️', t: `Gelirinin %${ratio.toFixed(0)}'i taksitlere gidiyor. Ekstra ödeme için harcamaları kısmak gerekebilir.` });
    else out.push({ k: 'good', i: '✅', t: `Taksitlerin gelirinin %${ratio.toFixed(0)}'i. Kalan parayla ekstra ödeme yaparak borcu hızlandırabilirsin.` });
    if (b.left < 0) out.push({ k: 'bad', i: '🔻', t: `Bu ay ${tl0(-b.left)} açık görünüyor. Taksit günü hesapta para yoksa ek hesap (Ekpara/KMH) devreye girer; onun faizi genelde kredilerinden de yüksektir.` });
    else if (b.left > 0) out.push({ k: 'good', i: '💡', t: `Bu ay ${tl0(b.left)} artıyor. Bunu en pahalı krediye ara ödeme olarak yatırırsan faizden tasarruf edersin.` });
  }

  const hot = [...A].sort((a, c) => (c.rate || 0) - (a.rate || 0))[0];
  if (hot && hot.rate) out.push({ k: 'warn', i: '🎯', t: `En pahalı kredin: ${esc(loanName(hot))} (aylık %${hot.rate.toLocaleString('tr-TR')}${hot.rateEst ? ', tahmini' : ''}). Fazla parayı önce buna yatır.` });

  const closable = A.filter(l => l.payoff > 0 && l.debt - l.payoff > 1).sort((a, c) => (c.debt - c.payoff) - (a.debt - a.payoff));
  closable.slice(0, 2).forEach(l => out.push({ k: 'info', i: '🔓', t: `${esc(loanName(l))}: bugün kapatırsan ${tl0(l.payoff)} ödersin, vadede ${tl0(l.debt)} ödeyeceksin. Fark ${tl0(l.debt - l.payoff)}.` }));

  const small = [...A].sort((a, c) => a.debt - c.debt)[0];
  if (A.length >= 4 && small) out.push({ k: 'info', i: '❄️', t: `${A.length} ayrı kredin var. Takip zorlaşıyorsa en küçüğünü (${esc(loanName(small))}, ${tl0(small.debt)}) kapatıp kredi sayısını azaltmak da motive eder.` });

  const soon = allPayments().filter(p => { const d = daysUntil(p.date); return d >= 0 && d <= 7; });
  if (soon.length) out.push({ k: 'warn', i: '⏰', t: `Önümüzdeki 7 günde ${soon.length} taksit var, toplam ${tl0(soon.reduce((a, p) => a + p.amount, 0))}. Hesapta hazır olsun.` });

  const cats = {};
  monthTx(ymOf(todayISO())).filter(t => t.type === 'gider').forEach(t => cats[t.cat || 'Diğer'] = (cats[t.cat || 'Diğer'] || 0) + t.amount);
  const topCat = Object.entries(cats).sort((a, c) => c[1] - a[1])[0];
  if (topCat) out.push({ k: 'info', i: '🧾', t: `Bu ay en çok harcama: ${esc(topCat[0])} (${tl0(topCat[1])}).` });

  out.push({ k: 'info', i: '🚫', t: 'Borçlar bitene kadar yeni kredi, kart taksiti ve "borcu borçla kapatma"dan uzak dur. Erken kapamada kalan faiz düşülür; kapama tutarını bankandan öğrenebilirsin.' });
  return out;
}

/* ---------- render ---------- */
const TITLES = { ozet: 'Özet', krediler: 'Krediler', takvim: 'Ödeme Takvimi', butce: 'Bütçe', plan: 'Kapatma Planı' };
function render() {
  $('#title').textContent = TITLES[tab];
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const el = $('#app');
  if (!S.loans.length && tab !== 'butce') { el.innerHTML = emptyView(); return; }
  el.innerHTML = ({ ozet: viewOzet, krediler: viewKrediler, takvim: viewTakvim, butce: viewButce, plan: viewPlan })[tab]();
}

function emptyView() {
  return `<div class="card empty"><div style="font-size:40px">📂</div><h3>Henüz veri yok</h3>
  <p>Hazır veri dosyanı (verilerim.json) yükle ya da kredilerini tek tek ekle.</p>
  <div class="actions" style="justify-content:center">
    <button class="btn primary" data-act="import">Dosyadan yükle</button>
    <button class="btn" data-act="addLoan">Kredi ekle</button></div></div>`;
}

function viewOzet() {
  const A = active(), debt = totalDebt(), pay = monthlyPay();
  const ends = A.map(lastDate).sort(); const end = ends[ends.length - 1];
  const next = allPayments().find(p => daysUntil(p.date) >= 0);
  const borrowed = A.reduce((a, l) => a + (l.amount || 0), 0);
  const ratio = S.income ? pay / S.income * 100 : null;
  const b = budgetFor(ymOf(todayISO()));
  return `
  <div class="card hero">
    <div class="label">Toplam kalan borç</div>
    <div class="big">${tl(debt)}</div>
    <div class="small" style="color:#a9b6cc;margin-top:4px">${A.length} kredi · çekilen ${tl0(borrowed)} · faiz farkı ≈ ${tl0(debt - borrowed)}</div>
  </div>
  <div class="grid2">
    <div class="card"><div class="label">Aylık taksit</div><div class="mid">${tl0(pay)}</div></div>
    <div class="card"><div class="label">Son taksit</div><div class="mid">${end ? MSHORT[parse(end).getMonth()] + ' ' + parse(end).getFullYear() : '-'}</div></div>
  </div>
  ${next ? `<div class="card" style="margin-top:12px"><div class="label">Sıradaki ödeme</div>
    <div class="row"><div><strong>${fmtDate(next.date)}</strong><div class="small muted">${esc(loanName(next.loan))} · ${daysUntil(next.date) === 0 ? 'bugün' : daysUntil(next.date) + ' gün sonra'}</div></div><div class="v mid">${tl0(next.amount)}</div></div></div>` : ''}
  <div class="card">
    <div class="label">Bu ayın dengesi</div>
    ${S.income ? `
      <div class="row"><span>Gelir</span><span class="v pos">${tl0(b.income)}</span></div>
      <div class="row"><span>Sabit gider + harcama</span><span class="v">−${tl0(b.fixed + b.spend)}</span></div>
      <div class="row"><span>Taksitler</span><span class="v">−${tl0(b.loans)}</span></div>
      <div class="row"><strong>Kalan</strong><strong class="v ${b.left < 0 ? 'neg' : 'pos'}">${tl0(b.left)}</strong></div>
      <div class="bar ${ratio >= 50 ? 'red' : ratio >= 35 ? 'amber' : ''}"><div style="width:${Math.min(ratio, 100)}%"></div></div>
      <div class="small muted" style="margin-top:6px">Taksit / gelir: %${ratio.toFixed(0)}</div>`
      : `<p class="muted small" style="margin:6px 0 10px">Gelirini girince denge burada görünür.</p><button class="btn primary sm" data-go="butce">Gelir gir</button>`}
  </div>
  <div class="section-title">Öneriler</div>
  ${tips().map(t => `<div class="tip ${t.k}"><span class="i">${t.i}</span><span>${t.t}</span></div>`).join('')}
  <p class="small muted" style="margin-top:12px">Faiz oranı "tahmini" olanlar ekran görüntüsündeki rakamlardan hesaplandı. Kesin oranı banka uygulamasından görüp Krediler sekmesinden düzeltebilirsin. Bu uygulama bilgi amaçlıdır, finansal danışmanlık değildir.</p>`;
}

function viewKrediler() {
  const maxRate = Math.max(...active().map(l => l.rate || 0));
  const list = [...S.loans].sort((a, b) => (b.remaining > 0) - (a.remaining > 0) || a.next.localeCompare(b.next));
  return `<button class="btn primary wide" data-act="addLoan" style="margin-bottom:12px">+ Kredi ekle</button>` +
    list.map(l => {
      const done = !(l.remaining > 0 && l.debt > 0.5);
      return `<div class="card" style="${done ? 'opacity:.55' : ''}">
      <div class="loan-head"><div><h3>${esc(l.name || 'Kredi')}</h3><div class="small muted">${esc(l.bank || '')}${l.amount ? ' · ' + tl0(l.amount) + ' çekildi' : ''}</div></div>
      ${done ? '<span class="chip">Bitti ✓</span>' : l.rate && l.rate === maxRate ? '<span class="chip hot">En pahalı</span>' : ''}</div>
      <div class="row"><span class="muted">Kalan borç</span><span class="v">${tl(l.debt)}</span></div>
      <div class="row"><span class="muted">Aylık taksit</span><span class="v">${tl(l.payment)}${l.paymentEst ? ' <span class="chip">≈</span>' : ''}</span></div>
      <div class="row"><span class="muted">Kalan taksit</span><span class="v">${l.remaining}</span></div>
      ${done ? '' : `<div class="row"><span class="muted">Sonraki taksit</span><span class="v">${fmtDate(l.next)}</span></div>
      <div class="row"><span class="muted">Son taksit</span><span class="v">${fmtDate(lastDate(l))}</span></div>`}
      <div class="row"><span class="muted">Aylık faiz</span><span class="v">${l.rate ? '%' + l.rate.toLocaleString('tr-TR') : '-'}${l.rateEst ? ' <span class="chip">tahmini</span>' : ''}</span></div>
      ${l.payoff > 0 ? `<div class="row"><span class="muted">Kapama tutarı</span><span class="v pos">${tl(l.payoff)}</span></div>` : ''}
      <div class="actions">
        ${done ? '' : `<button class="btn primary sm" data-act="paid" data-id="${l.id}">Taksit ödendi</button>
        <button class="btn sm" data-act="partial" data-id="${l.id}">Ara ödeme</button>`}
        <button class="btn sm" data-act="editLoan" data-id="${l.id}">Düzenle</button>
        <button class="btn sm danger" data-act="delLoan" data-id="${l.id}">Sil</button>
      </div></div>`;
    }).join('');
}

function viewTakvim() {
  const pays = allPayments();
  const byMonth = {};
  pays.forEach(p => (byMonth[ymOf(p.date)] ||= []).push(p));
  const months = Object.keys(byMonth).sort();
  const totals = months.map(m => byMonth[m].reduce((a, p) => a + p.amount, 0));
  const max = Math.max(...totals, 1);
  const shown = months.slice(0, 6);
  return `
  <div class="card"><div class="label">Aylara göre taksit yükü</div>
    <div class="chart">${totals.map((t, i) => `<div title="${ymLabel(months[i])}: ${tl0(t)}" style="height:${t / max * 100}%"></div>`).join('')}</div>
    <div class="chart-labels"><span>${months[0] ? ymLabel(months[0]) : ''}</span><span>${months.length ? ymLabel(months[months.length - 1]) : ''}</span></div>
  </div>` +
  shown.map(m => `<div class="card">
    <div class="loan-head"><h3>${ymLabel(m)}</h3><strong>${tl0(byMonth[m].reduce((a, p) => a + p.amount, 0))}</strong></div>
    ${byMonth[m].map(p => { const d = parse(p.date), du = daysUntil(p.date);
      return `<div class="pay ${du >= 0 && du <= 7 ? 'soon' : ''}"><div class="day">${d.getDate()}<small>${MSHORT[d.getMonth()]}</small></div>
      <div class="who"><div>${esc(p.loan.name || 'Kredi')}</div><div class="small muted">${esc(p.loan.bank || '')}</div></div>
      <div class="amt">${tl0(p.amount)}</div></div>`; }).join('')}
  </div>`).join('') +
  (months.length > 6 ? `<div class="card">${months.slice(6).map((m, i) => `<div class="row"><span>${ymLabel(m)}</span><span class="v">${tl0(totals[i + 6])}</span></div>`).join('')}</div>` : '');
}

function viewButce() {
  const b = budgetFor(budgetMonth);
  const tx = monthTx(budgetMonth).sort((a, c) => c.date.localeCompare(a.date));
  return `
  <div class="card">
    <label>Aylık net gelirim (maaş vb.)
      <div class="inline"><input id="incomeIn" inputmode="decimal" value="${S.income ? S.income.toLocaleString('tr-TR') : ''}" placeholder="0"><button class="btn primary" data-act="saveIncome" style="flex:0 0 auto">Kaydet</button></div>
    </label>
    <div class="small muted">Düzenli olmayan gelirleri (satış, ek iş) aşağıdan "Gelir" olarak ekleyebilirsin.</div>
  </div>

  <div class="card">
    <div class="loan-head"><h3>Sabit giderler <span class="small muted">(her ay)</span></h3><button class="btn sm" data-act="addFixed">+ Ekle</button></div>
    ${S.fixed.length ? S.fixed.map(f => `<div class="tx"><span>${esc(f.name)}</span><span><strong>${tl0(f.amount)}</strong> <button class="del" data-act="delFixed" data-id="${f.id}">×</button></span></div>`).join('')
      : '<p class="small muted">Kira, faturalar, ulaşım, telefon gibi.</p>'}
  </div>

  <div class="month-nav"><button class="btn sm" data-act="mPrev">‹</button><strong>${ymLabel(budgetMonth)}</strong><button class="btn sm" data-act="mNext">›</button></div>

  <div class="card">
    <div class="row"><span>Gelir</span><span class="v pos">${tl0(b.income)}</span></div>
    <div class="row"><span>Sabit giderler</span><span class="v">−${tl0(b.fixed)}</span></div>
    <div class="row"><span>Harcamalar</span><span class="v">−${tl0(b.spend)}</span></div>
    <div class="row"><span>Kredi taksitleri</span><span class="v">−${tl0(b.loans)}</span></div>
    <div class="row"><strong>Kalan</strong><strong class="v ${b.left < 0 ? 'neg' : 'pos'}">${tl0(b.left)}</strong></div>
  </div>

  <div class="card">
    <div class="loan-head"><h3>Hareketler</h3><button class="btn primary sm" data-act="addTx">+ Gelir / Harcama</button></div>
    ${tx.length ? tx.map(t => `<div class="tx"><div><div>${esc(t.desc || t.cat)}</div><div class="small muted">${fmtDate(t.date)} · ${esc(t.cat || '')}</div></div>
      <span><strong class="${t.type === 'gelir' ? 'pos' : ''}">${t.type === 'gelir' ? '+' : '−'}${tl0(t.amount)}</strong> <button class="del" data-act="delTx" data-id="${t.id}">×</button></span></div>`).join('')
      : '<p class="small muted">Bu ay için kayıt yok.</p>'}
  </div>`;
}

function viewPlan() {
  const sug = suggestedExtra();
  const extra = S.plan.extra ?? sug;
  const strat = S.plan.strategy;
  const base = { total: totalDebt(), end: active().map(lastDate).sort().pop() };
  const sim = simulate(extra, strat);
  if (!sim) return '<div class="card">Aktif kredi yok.</div>';
  const save = base.total - sim.paid;
  const closable = active().filter(l => l.payoff > 0);
  return salaryCard() + `
  <div class="card">
    <label>Her ay taksitlere ek olarak ödeyebileceğim tutar
      <div class="inline"><input id="extraIn" inputmode="decimal" value="${extra.toLocaleString('tr-TR')}"><button class="btn primary" data-act="saveExtra" style="flex:0 0 auto">Hesapla</button></div>
    </label>
    <div class="small muted">${S.income ? `Bütçene göre önerilen: <strong>${tl0(sug)}</strong>` : 'Bütçe sekmesine gelirini girersen öneri hesaplanır.'}</div>
  </div>

  <div class="seg">
    <button class="${strat === 'avalanche' ? 'on' : ''}" data-act="strat" data-v="avalanche">En pahalıdan başla</button>
    <button class="${strat === 'snowball' ? 'on' : ''}" data-act="strat" data-v="snowball">En küçükten başla</button>
  </div>
  <p class="small muted" style="margin:-4px 4px 12px">${strat === 'avalanche' ? 'Faizi en yüksek krediye yüklen: en çok parayı bu yöntem kurtarır.' : 'En küçük borcu önce bitir: kredi sayısı hızla azalır, motivasyon artar.'}</p>

  <div class="grid2">
    <div class="card"><div class="label">Plansız bitiş</div><div class="mid">${base.end ? MSHORT[parse(base.end).getMonth()] + ' ' + parse(base.end).getFullYear() : '-'}</div><div class="small muted">${tl0(base.total)}</div></div>
    <div class="card" style="border-color:var(--accent)"><div class="label">Planla bitiş</div><div class="mid pos">${ymLabel(sim.end)}</div><div class="small muted">≈ ${tl0(sim.paid)}</div></div>
  </div>
  <div class="tip ${save > 0 ? 'good' : 'info'}" style="margin-top:12px"><span class="i">💰</span><span>${save > 0
    ? `Bu planla yaklaşık <strong>${tl0(save)}</strong> daha az ödersin ve borçların <strong>${sim.months} ayda</strong> biter.`
    : `Her ay toplam <strong>${tl0(sim.budget)}</strong> ödemeye devam edersen borçların ${sim.months} ayda biter.`} Biten kredinin taksitini bırakma; aynı tutarı sıradakine aktar.</span></div>

  <div class="section-title">Kapatma sırası</div>
  <div class="card">${sim.order.map((l, i) => `<div class="row"><span><strong>${i + 1}.</strong> ${esc(l.name)}<div class="small muted">aylık %${(l.r * 100).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}</div></span><span class="v">${l.done ? ymLabel(l.done) : '-'}</span></div>`).join('')}</div>

  ${closable.length ? `<div class="section-title">Erken kapama fırsatı</div><div class="card">${closable.map(l => `<div class="row"><span>${esc(loanName(l))}<div class="small muted">Bugün kapat: ${tl0(l.payoff)}</div></span><span class="v pos">−${tl0(l.debt - l.payoff)}</span></div>`).join('')}
    <p class="small muted" style="margin-top:8px">Kapama tutarları her gün değişir; Krediler'den güncel tutarı girebilirsin.</p></div>` : ''}
  <p class="small muted" style="margin-top:8px">Hesap, girdiğin faiz oranlarıyla yapılan bir tahmindir.</p>`;
}

/* ---------- maaşla kapatma ---------- */
function salarySim(monthly) {
  const extra = monthly - monthlyPay();
  if (extra < 0) return null;
  return simulate(extra, S.plan.strategy);
}
function salaryResult(pct) {
  const inc = S.income, fixed = S.fixed.reduce((a, f) => a + f.amount, 0);
  const toDebt = inc * pct / 100, live = inc - toDebt;
  const sim = salarySim(toDebt);
  if (!sim) return `<div class="tip bad"><span class="i">⚠️</span><span>${tl0(toDebt)} taksitleri (${tl0(monthlyPay())}) bile karşılamıyor. Yüzdeyi artır.</span></div>`;
  const save = totalDebt() - sim.paid;
  return `
    <div class="row"><span>Borca giden / ay</span><span class="v">${tl0(toDebt)}</span></div>
    <div class="row"><span>Geçinmek için kalan / ay</span><span class="v ${live < fixed ? 'neg' : ''}">${tl0(live)}</span></div>
    <div class="row"><strong>Borçlar biter</strong><strong class="v pos">${ymLabel(sim.end)} · ${sim.months} ay</strong></div>
    <div class="row"><span>Toplam ödenen</span><span class="v">≈ ${tl0(sim.paid)}</span></div>
    <div class="row"><span>Faiz tasarrufu</span><span class="v pos">≈ ${tl0(Math.max(save, 0))}</span></div>
    ${live < fixed ? `<div class="tip bad" style="margin-top:8px"><span class="i">⚠️</span><span>Kalan para sabit giderlerini (${tl0(fixed)}) karşılamıyor. Bu senaryo ancak başka bir gelir varsa mümkün.</span></div>` : ''}`;
}
function salaryCard() {
  if (!S.income) return `<div class="card"><h3>Maaşla kapatma</h3><p class="small muted" style="margin-bottom:10px">Maaşının tamamını ya da bir kısmını borca ayırırsan ne zaman biteceğini görmek için önce gelirini gir.</p><button class="btn primary sm" data-go="butce">Gelir gir</button></div>`;
  const minPct = Math.min(100, Math.ceil(monthlyPay() / S.income * 100 / 5) * 5);
  const pct = Math.max(minPct, Math.min(100, S.plan.salaryPct ?? 100));
  const fixed = S.fixed.reduce((a, f) => a + f.amount, 0);
  const rows = [
    ['Maaşın tamamı', S.income],
    ...(fixed ? [['Maaş − sabit giderler', S.income - fixed]] : []),
    ['Sadece taksitler', null],
  ].map(([n, m]) => {
    if (m === null) { const e = active().map(lastDate).sort().pop(); return `<div class="row"><span>${n}</span><span class="v">${e ? MONTHS[parse(e).getMonth()] + ' ' + parse(e).getFullYear() : '-'}</span></div>`; }
    const s = salarySim(m);
    return `<div class="row"><span>${n}<div class="small muted">${tl0(m)} / ay</div></span><span class="v">${s ? ymLabel(s.end) + '<div class="small muted">' + s.months + ' ay</div>' : 'yetmiyor'}</span></div>`;
  }).join('');
  return `<div class="card">
    <h3>Maaşla kapatma</h3>
    <label style="margin-bottom:4px">Maaşımın <strong id="pctV" style="color:var(--ink)">%${pct}</strong>'ini borca ayırırsam
      <input type="range" id="pctIn" min="${minPct}" max="100" step="5" value="${pct}">
    </label>
    <div id="salOut">${salaryResult(pct)}</div>
  </div>
  <div class="card"><div class="label" style="margin-bottom:4px">Senaryolar</div>${rows}</div>`;
}
document.addEventListener('input', e => {
  if (e.target.id !== 'pctIn') return;
  const p = +e.target.value;
  S.plan.salaryPct = p; save();
  $('#pctV').textContent = '%' + p;
  $('#salOut').innerHTML = salaryResult(p);
});

/* ---------- forms ---------- */
function openSheet(html) { $('#sheet').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeSheet() { $('#modal').classList.add('hidden'); }

function loanForm(l = {}) {
  openSheet(`<h2>${l.id ? 'Krediyi düzenle' : 'Yeni kredi'}</h2>
  <form id="loanF">
    <div class="inline"><label>Ad<input name="name" value="${esc(l.name || 'İhtiyaç Kredisi')}"></label><label>Banka<input name="bank" value="${esc(l.bank || '')}"></label></div>
    <div class="inline"><label>Çekilen tutar<input name="amount" inputmode="decimal" value="${l.amount ? l.amount.toLocaleString('tr-TR') : ''}"></label><label>Kalan borç<input name="debt" inputmode="decimal" required value="${l.debt ? l.debt.toLocaleString('tr-TR') : ''}"></label></div>
    <div class="inline"><label>Kalan taksit<input name="remaining" inputmode="numeric" required value="${l.remaining || ''}"></label><label>Aylık taksit<input name="payment" inputmode="decimal" placeholder="boşsa hesaplanır" value="${l.payment ? l.payment.toLocaleString('tr-TR') : ''}"></label></div>
    <div class="inline"><label>Sonraki taksit<input name="next" type="date" required value="${l.next || todayISO()}"></label><label>Aylık faiz %<input name="rate" inputmode="decimal" value="${l.rate ? l.rate.toLocaleString('tr-TR') : ''}"></label></div>
    <label>Bugünkü kapama tutarı (varsa)<input name="payoff" inputmode="decimal" value="${l.payoff ? l.payoff.toLocaleString('tr-TR') : ''}"></label>
    <div class="actions"><button type="button" class="btn" data-act="close">Vazgeç</button><button class="btn primary" style="flex:1">Kaydet</button></div>
  </form>`);
  $('#loanF').onsubmit = e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const o = l.id ? S.loans.find(x => x.id === l.id) : { id: uid() };
    const rate = num(f.rate), payment = num(f.payment), remaining = parseInt(f.remaining) || 0, debt = num(f.debt);
    Object.assign(o, {
      name: f.name.trim(), bank: f.bank.trim(), amount: num(f.amount), debt, remaining, next: f.next,
      payment: payment || (remaining ? +(debt / remaining).toFixed(2) : 0),
      paymentEst: !payment || (o.paymentEst && payment === o.payment),
      rateEst: o.rateEst && rate === o.rate, rate, payoff: num(f.payoff),
    });
    if (!l.id) S.loans.push(o);
    save(); closeSheet(); render();
  };
}

function txForm() {
  openSheet(`<h2>Gelir / Harcama ekle</h2>
  <form id="txF">
    <div class="seg" id="txType"><button type="button" class="on" data-v="gider">Harcama</button><button type="button" data-v="gelir">Gelir</button></div>
    <label>Tutar<input name="amount" inputmode="decimal" required autofocus></label>
    <label>Kategori<select name="cat">${['Market','Yemek','Ulaşım','Fatura','Giyim','Sağlık','Eğlence','İş','Kart ödemesi','Diğer','Satış','Ek gelir'].map(c => `<option>${c}</option>`).join('')}</select></label>
    <label>Açıklama<input name="desc" placeholder="isteğe bağlı"></label>
    <label>Tarih<input name="date" type="date" value="${budgetMonth === ymOf(todayISO()) ? todayISO() : budgetMonth + '-01'}"></label>
    <div class="actions"><button type="button" class="btn" data-act="close">Vazgeç</button><button class="btn primary" style="flex:1">Ekle</button></div>
  </form>`);
  let type = 'gider';
  $('#txType').onclick = e => { const b = e.target.closest('button'); if (!b) return; type = b.dataset.v; [...$('#txType').children].forEach(x => x.classList.toggle('on', x === b)); };
  $('#txF').onsubmit = e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const amount = num(f.amount); if (!amount) return;
    S.tx.push({ id: uid(), type, amount, cat: f.cat, desc: f.desc.trim(), date: f.date || todayISO() });
    save(); closeSheet(); render();
  };
}

function fixedForm() {
  openSheet(`<h2>Sabit gider ekle</h2><form id="fxF">
    <label>Ad<input name="name" placeholder="Kira, elektrik, internet..." required></label>
    <label>Aylık tutar<input name="amount" inputmode="decimal" required></label>
    <div class="actions"><button type="button" class="btn" data-act="close">Vazgeç</button><button class="btn primary" style="flex:1">Ekle</button></div></form>`);
  $('#fxF').onsubmit = e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    S.fixed.push({ id: uid(), name: f.name.trim(), amount: num(f.amount) }); save(); closeSheet(); render();
  };
}

function partialForm(l) {
  openSheet(`<h2>Ara ödeme · ${esc(l.name)}</h2><form id="ptF">
    <p class="small muted" style="margin-bottom:12px">Bankaya ara ödeme yaptıktan sonra, banka uygulamasındaki yeni kalan borç ve taksit bilgilerini gir.</p>
    <label>Yeni kalan borç<input name="debt" inputmode="decimal" required value="${l.debt.toLocaleString('tr-TR')}"></label>
    <div class="inline"><label>Kalan taksit<input name="remaining" inputmode="numeric" value="${l.remaining}"></label><label>Aylık taksit<input name="payment" inputmode="decimal" value="${l.payment.toLocaleString('tr-TR')}"></label></div>
    <div class="actions"><button type="button" class="btn" data-act="close">Vazgeç</button><button class="btn primary" style="flex:1">Güncelle</button></div></form>`);
  $('#ptF').onsubmit = e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    Object.assign(l, { debt: num(f.debt), remaining: parseInt(f.remaining) || 0, payment: num(f.payment), payoff: 0 });
    save(); closeSheet(); render();
  };
}

function settings() {
  openSheet(`<h2>Ayarlar</h2>
    <div class="card"><h3>PIN kilidi</h3>
      <p class="small muted" style="margin-bottom:10px">${S.pinHash ? 'PIN açık. Uygulama her açılışta PIN ister.' : 'Uygulamayı açarken PIN sorulsun.'}</p>
      <div class="inline"><input id="newPin" type="password" inputmode="numeric" maxlength="8" placeholder="Yeni PIN (4-8 rakam)"><button class="btn primary" data-act="setPin" style="flex:0 0 auto">Kaydet</button></div>
      ${S.pinHash ? '<button class="btn sm danger" data-act="clearPin" style="margin-top:10px">PIN\'i kaldır</button>' : ''}
    </div>
    <div class="card"><h3>Yedek</h3>
      <p class="small muted" style="margin-bottom:10px">Veriler sadece bu telefonun tarayıcısında. Tarayıcı verisini silersen gider; ara ara yedek al.</p>
      <div class="actions"><button class="btn" data-act="export">Yedeği indir</button><button class="btn" data-act="import">Yedekten yükle</button></div>
    </div>
    <button class="btn danger wide" data-act="reset">Tüm verileri sil</button>
    <button class="btn wide" data-act="close" style="margin-top:8px">Kapat</button>`);
}

async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('borctakip:' + s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const go = e.target.closest('[data-go]');
  if (go) { tab = go.dataset.go; render(); scrollTo(0, 0); return; }
  const t = e.target.closest('.tabs button');
  if (t) { tab = t.dataset.tab; render(); scrollTo(0, 0); return; }
  if (e.target.id === 'modal') return closeSheet();
  if (e.target.closest('#settingsBtn')) return settings();
  const a = e.target.closest('[data-act]'); if (!a) return;
  const id = a.dataset.id, L = id && S.loans.find(x => x.id === id);
  switch (a.dataset.act) {
    case 'close': closeSheet(); break;
    case 'addLoan': loanForm(); break;
    case 'editLoan': loanForm(L); break;
    case 'delLoan': if (confirm('Bu kredi silinsin mi?')) { S.loans = S.loans.filter(x => x.id !== id); save(); render(); } break;
    case 'paid':
      if (confirm(`${fmtDate(L.next)} tarihli ${tl0(L.payment)} taksit ödendi olarak işaretlensin mi?`)) {
        L.debt = Math.max(+(L.debt - L.payment).toFixed(2), 0); L.remaining--; L.next = addMonths(L.next, 1); L.payoff = 0;
        if (L.remaining <= 0) L.debt = 0;
        save(); render();
      } break;
    case 'partial': partialForm(L); break;
    case 'saveIncome': S.income = num($('#incomeIn').value); save(); render(); break;
    case 'addFixed': fixedForm(); break;
    case 'delFixed': S.fixed = S.fixed.filter(x => x.id !== id); save(); render(); break;
    case 'addTx': txForm(); break;
    case 'delTx': S.tx = S.tx.filter(x => x.id !== id); save(); render(); break;
    case 'mPrev': budgetMonth = ymShift(budgetMonth, -1); render(); break;
    case 'mNext': budgetMonth = ymShift(budgetMonth, 1); render(); break;
    case 'saveExtra': S.plan.extra = num($('#extraIn').value); save(); render(); break;
    case 'strat': S.plan.strategy = a.dataset.v; save(); render(); break;
    case 'setPin': {
      const p = $('#newPin').value.trim();
      if (!/^\d{4,8}$/.test(p)) return alert('PIN 4-8 rakam olmalı.');
      S.pinHash = await sha(p); save(); sessionStorage.setItem('bt_unlocked', '1'); settings(); break;
    }
    case 'clearPin': S.pinHash = null; save(); settings(); break;
    case 'export': {
      const blob = new Blob([JSON.stringify({ ...S, pinHash: null }, null, 2)], { type: 'application/json' });
      const u = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = u; link.download = 'borc-takip-yedek-' + todayISO() + '.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(u), 1000); break;
    }
    case 'import': $('#fileInput').click(); break;
    case 'reset': if (confirm('Tüm krediler, gelir ve harcamalar silinsin mi? Bu geri alınamaz.')) { S = blank(); save(); closeSheet(); render(); } break;
  }
});

$('#fileInput').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (!Array.isArray(d.loans)) throw 0;
    if (S.loans.length && !confirm('Mevcut verilerin yerine yedektekiler yüklensin mi?')) return;
    const pin = S.pinHash;
    S = { ...blank(), ...d, pinHash: pin };
    S.loans.forEach(l => l.id ||= uid());
    save(); closeSheet(); tab = 'ozet'; render();
  } catch { alert('Dosya okunamadı. Doğru JSON dosyasını seçtiğinden emin ol.'); }
  e.target.value = '';
});

/* ---------- lock ---------- */
async function unlock() {
  const ok = (await sha($('#pinInput').value.trim())) === S.pinHash;
  if (ok) { sessionStorage.setItem('bt_unlocked', '1'); $('#lock').classList.add('hidden'); render(); }
  else { $('#pinErr').textContent = 'PIN yanlış'; $('#pinInput').value = ''; }
}
$('#pinBtn').onclick = unlock;
$('#pinInput').onkeydown = e => { if (e.key === 'Enter') unlock(); };

if (S.pinHash && !sessionStorage.getItem('bt_unlocked')) { $('#lock').classList.remove('hidden'); setTimeout(() => $('#pinInput').focus(), 100); }
else render();
