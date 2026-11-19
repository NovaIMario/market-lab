import { PriceChart, LineChart, compact } from './chart.js';
import { MODELS } from './models.js';

const $ = (s) => document.querySelector(s);
const pct = (v, d = 1) => (v == null ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(d)}%`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const MODEL_COLOR = { always: '--ink-2', momentum: '--series-1', reversion: '--series-2', trend: '--series-3', logistic: '--series-4', knn: '--series-5' };
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

let index = null;
let current = null;
let currency = 'USD';

function money(v, cur = currency) {
  if (v == null || !isFinite(v)) return '–';
  const a = Math.abs(v);
  const dp = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 4;
  const num = v.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  if (cur === 'GBp') return `${num}p`;
  const sym = { USD: '$', GBP: '£', EUR: '€' }[cur];
  return sym ? `${v < 0 ? '−' : ''}${sym}${num.replace('-', '')}` : num;
}

function deltaHTML(v, label = '') {
  if (v == null) return '–';
  const up = v >= 0;
  return `<span class="delta ${up ? 'up' : 'down'}"><span aria-hidden="true">${up ? '▲' : '▼'}</span> ${pct(v, 2)}${label}</span>`;
}

// ---------- Theme ----------
$('#theme-toggle').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch (e) {}
  refreshColors();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => refreshColors());

// ---------- Charts ----------
const price = new PriceChart($('#price-chart'), {
  format: (v) => money(v),
  onHover: (i) => showReadout(i),
});
price.onZoom = () => setPressed('#ranges', null);
const fcChart = new LineChart($('#fc-chart'), { format: (v) => money(v), tooltip: $('#fc-tip') });
const eqChart = new LineChart($('#eq-chart'), { format: (v) => `${v.toFixed(2)}×`, logY: true, tooltip: $('#eq-tip') });

function setPressed(group, btn) {
  for (const b of document.querySelectorAll(`${group} button`)) b.setAttribute('aria-pressed', String(b === btn));
}

$('#ranges').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !current) return;
  setPressed('#ranges', b);
  applyRange(b.dataset.range);
});

function applyRange(r) {
  const t = current.prices.t, n = t.length;
  let from;
  if (r === 'max') from = 0;
  else if (r === 'ytd') from = t.findIndex((d) => d.startsWith(t[n - 1].slice(0, 4)));
  else from = n - 1 - Math.round(+r * (current.group === 'Crypto' ? 365 / 252 : 1));
  price.setRange(Math.max(0, from), n - 1);
}

$('#types').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  setPressed('#types', b);
  price.setOptions({ type: b.dataset.type });
});
$('#overlays').addEventListener('change', () => {
  const on = [...document.querySelectorAll('#overlays input:checked')].map((i) => i.value);
  price.setOptions({ overlays: new Set(on) });
});
$('#lower').addEventListener('change', (e) => price.setOptions({ lower: e.target.value }));

function showReadout(i) {
  const p = current.prices;
  if (i == null) i = p.c.length - 1;
  const ch = i > 0 ? p.c[i] / p.c[i - 1] - 1 : null;
  $('#readout').innerHTML =
    `<b>${p.t[i]}</b> Open <b>${money(p.o[i])}</b> High <b>${money(p.h[i])}</b> Low <b>${money(p.l[i])}</b> Close <b>${money(p.c[i])}</b> ` +
    `${deltaHTML(ch)}${p.v[i] ? ` &nbsp;Vol <b>${compact(p.v[i])}</b>` : ''}`;
}

// ---------- Data loading ----------
async function loadIndex() {
  const res = await fetch('data/index.json', { cache: 'no-cache' });
  index = await res.json();
  const sel = $('#ticker');
  const groups = {};
  for (const t of index.tickers) (groups[t.group] ||= []).push(t);
  sel.innerHTML = Object.entries(groups).map(([g, ts]) =>
    `<optgroup label="${esc(g)}">${ts.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} (${esc(t.id)})</option>`).join('')}</optgroup>`).join('');
  sel.addEventListener('change', () => { location.hash = sel.value; });
  $('#updated').textContent = `Data updated ${new Date(index.updated).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`;
  renderMarkets();
}

async function loadTicker(id) {
  if (!index.tickers.some((t) => t.id === id)) id = 'SPY';
  $('#ticker').value = id;
  const res = await fetch(`data/${encodeURIComponent(id)}.json`, { cache: 'no-cache' });
  current = await res.json();
  currency = current.currency;
  document.title = `${current.name} (${current.id}) · Market Lab`;
  renderQuote();
  price.setData(current.prices);
  const pressed = document.querySelector('#ranges [aria-pressed="true"]');
  applyRange(pressed ? pressed.dataset.range : '252');
  if (!pressed) setPressed('#ranges', document.querySelector('#ranges [data-range="252"]'));
  showReadout(null);
  renderPriceTable();
  renderForecast();
  renderBacktest();
}

function renderQuote() {
  const p = current.prices, n = p.c.length;
  $('#q-name').textContent = current.name;
  $('#q-meta').textContent = `${current.id} · ${current.exchange} · ${current.currency === 'GBp' ? 'GBP (pence)' : current.currency}`;
  $('#q-last').textContent = money(p.c[n - 1]);
  $('#q-change').outerHTML = `<span id="q-change">${deltaHTML(p.c[n - 1] / p.c[n - 2] - 1, ' today')}</span>`;
  $('#q-date').textContent = `Close on ${new Date(p.t[n - 1]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function renderPriceTable() {
  const p = current.prices, n = p.c.length;
  const rows = [];
  for (let i = n - 1; i >= Math.max(1, n - 260); i--) {
    rows.push(`<tr><td>${p.t[i]}</td><td>${money(p.o[i])}</td><td>${money(p.h[i])}</td><td>${money(p.l[i])}</td><td>${money(p.c[i])}</td><td>${pct(p.c[i] / p.c[i - 1] - 1, 2)}</td><td>${p.v[i] ? compact(p.v[i]) : '–'}</td></tr>`);
  }
  $('#price-table').innerHTML = '<caption class="sr-only">Daily prices for the last year, newest first</caption><thead><tr><th>Date</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Change</th><th>Volume</th></tr></thead><tbody>' + rows.join('') + '</tbody>';
}

function futureDates(last, k, everyDay) {
  const out = [];
  const d = new Date(last + 'T00:00:00Z');
  while (out.length < k) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (everyDay || (wd !== 0 && wd !== 6)) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function renderForecast() {
  const p = current.prices, n = p.c.length;
  const cone = current.cone, H = cone.length;
  const hist = 120;
  const crypto = current.group === 'Crypto';
  const x = [...p.t.slice(n - hist), ...futureDates(p.t[n - 1], H, crypto)];
  const last = p.c[n - 1];
  const histVals = [...p.c.slice(n - hist), ...new Array(H).fill(null)];
  const pad = new Array(hist - 1).fill(null);
  const q = (k) => [...pad, last, ...cone.map((r) => r[k])];
  fcChart.setData({
    x,
    series: [
      { name: 'Price', color: cssVar('--series-1'), values: histVals },
      { name: 'Median path', color: cssVar('--series-1'), values: q(2), dash: [5, 5], width: 1.5 },
    ],
    bands: [
      { name: '90% range', lo: q(0), hi: q(4), fill: 1 },
      { name: '50% range', lo: q(1), hi: q(3), fill: 2 },
    ],
    marker: hist - 1, markerLabel: 'Today',
  });
  const unit = crypto ? 'days' : 'trading days';
  $('#fc-lede').textContent = `4,000 simulated paths for the next ${H} ${unit}, built from the last two years of ${current.name}'s daily moves. The cone shows how wide the range of outcomes is, not which way the price will go.`;
  const rows = [5, 20, H].map((h) => {
    const r = cone[h - 1];
    const span = (a, b) => `${money(a)} – ${money(b)}<div class="ci">${pct(a / last - 1, 0)} to ${pct(b / last - 1, 0)}</div>`;
    return `<tr><td>${h} ${crypto ? 'days' : 'days'}</td><td>${span(r[1], r[3])}</td><td>${span(r[0], r[4])}</td></tr>`;
  });
  $('#fc-table').innerHTML = `<caption class="sr-only">Forecast ranges</caption><thead><tr><th>Ahead</th><th>50% range</th><th>90% range</th></tr></thead><tbody>${rows.join('')}</tbody>`;
  const c = current.calibration;
  const verdict = (got, want) => Math.abs(got - want) <= 0.05 ? 'about right' : got < want ? 'a little too narrow' : 'a little too wide';
  $('#fc-calib').innerHTML = `<strong>Is the cone honest?</strong> We built a ${c.horizon}-day cone every two weeks over the history (${c.tests} times) and checked where the price really ended up. It landed in the 50% range <strong>${Math.round(c.in50 * 100)}%</strong> of the time and in the 90% range <strong>${Math.round(c.in90 * 100)}%</strong> of the time, so the width is ${verdict(c.in90, 0.9)}.`;
}

function renderBacktest() {
  const bt = current.backtest;
  const R = bt.results;
  $('#bt-lede').innerHTML = `Each model predicts whether the next close will be higher than today's. Tested on ${bt.days.toLocaleString('en-GB')} days from ${bt.from} to ${bt.to}, during which ${current.name} rose on <strong>${(bt.upRate * 100).toFixed(1)}%</strong> of days. So "always up" was right ${(bt.upRate * 100).toFixed(1)}% of the time without looking at anything.`;
  const rows = MODELS.map((m) => {
    const r = R[m.id];
    const pUp = current.today[m.id];
    const call = pUp > 0.5
      ? `<span class="call up"><span aria-hidden="true">▲</span> Up</span>`
      : `<span class="call down"><span aria-hidden="true">▼</span> Down</span>`;
    const conf = m.kind === 'Learned' ? `<div class="ci">${Math.round(pUp * 100)}% chance of a rise</div>` : '';
    let vs = '<span class="ci">baseline</span>';
    if (r.vsAlwaysP != null) {
      const p = r.vsAlwaysP < 0.001 ? '<0.001' : r.vsAlwaysP.toFixed(2);
      if (r.vsAlwaysP < 0.05) vs = r.vsAlwaysSign > 0 ? `Better <span class="sig">p ${p}</span>` : `Worse <span class="sig">p ${p}</span>`;
      else vs = `No real difference<div class="ci">p = ${p}</div>`;
    }
    return `<tr class="${m.id === 'always' ? 'base' : ''}">
      <td><div class="model-name"><span class="key" style="background:var(${MODEL_COLOR[m.id]})"></span>${esc(m.name)}</div><div class="model-about">${esc(m.about)}</div></td>
      <td>${call}${conf}</td>
      <td>${(r.accuracy * 100).toFixed(1)}%<div class="ci">${(r.accuracyCI[0] * 100).toFixed(1)}–${(r.accuracyCI[1] * 100).toFixed(1)}%</div></td>
      <td>${vs}</td>
      <td>${pct(r.cagr)}</td>
      <td>${r.sharpe.toFixed(2)}</td>
      <td>${pct(r.maxDD, 0)}</td>
      <td>${Math.round(r.exposure * 100)}%</td>
    </tr>`;
  });
  $('#bt-table').innerHTML = `<caption class="sr-only">Backtest results for each model</caption><thead><tr>
    <th scope="col">Model</th><th scope="col">Tomorrow</th><th scope="col">Accuracy <span class="ci">(95% CI)</span></th>
    <th scope="col">vs always up</th><th scope="col">Annual return</th><th scope="col">Sharpe</th><th scope="col">Worst fall</th><th scope="col">Time invested</th>
    </tr></thead><tbody>${rows.join('')}</tbody>`;

  eqChart.setData({
    x: bt.eqDates,
    ref: 1,
    series: MODELS.map((m) => ({ name: m.name, color: cssVar(MODEL_COLOR[m.id]), values: R[m.id].equity, width: m.id === 'always' ? 2.5 : 1.75 })),
  });
  $('#eq-legend').innerHTML = MODELS.map((m) =>
    `<label><input type="checkbox" checked value="${esc(m.name)}"><span class="key" style="background:var(${MODEL_COLOR[m.id]})"></span>${esc(m.name)}${m.id === 'always' ? ' (buy and hold)' : ''}</label>`).join('');
  for (const m of MODELS) if (eqChart.hidden.has(m.name)) $(`#eq-legend input[value="${m.name}"]`).checked = false;

  const others = MODELS.filter((m) => m.id !== 'always');
  const better = others.filter((m) => R[m.id].vsAlwaysP < 0.05 && R[m.id].vsAlwaysSign > 0);
  const sharper = others.filter((m) => R[m.id].sharpe > R.always.sharpe);
  const all = index.tickers;
  const totSig = all.reduce((a, t) => a + t.significant, 0);
  const totSharpe = all.reduce((a, t) => a + t.higherSharpe, 0);
  const total = all.length * others.length;
  $('#bt-verdict').innerHTML = `
    <p><strong>For ${esc(current.name)}:</strong> ${better.length ? `${better.map((m) => m.name).join(' and ')} called the direction significantly more often than "always up".` : 'no model called the direction significantly more often than "always up".'}
    ${sharper.length ? `${sharper.length} of ${others.length} had a better return for the risk taken (Sharpe ratio) than buy and hold.` : 'None had a better return for the risk taken (Sharpe ratio) than buy and hold.'}</p>
    <p><strong>Across all ${all.length} markets:</strong> ${totSig} of ${total} model and market pairs were significantly more accurate than "always up". With a 5% test you would expect about ${Math.round(total * 0.025)} by luck alone. ${totSharpe} of ${total} had a better Sharpe ratio than buy and hold, usually because they stayed out of the market during a crash, not because they predicted days better.</p>`;
}

$('#eq-legend').addEventListener('change', (e) => eqChart.toggle(e.target.value, e.target.checked));

function refreshColors() {
  if (!current) return;
  renderForecast();
  renderBacktest();
}

// ---------- All markets ----------
function spark(vals) {
  const w = 110, h = 28;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4)).toFixed(1)}`).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(${up ? '--up' : '--down'})" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

function renderMarkets() {
  const groups = {};
  for (const t of index.tickers) (groups[t.group] ||= []).push(t);
  const body = Object.entries(groups).map(([g, ts]) =>
    `<tr class="group-row"><td colspan="7">${esc(g)}</td></tr>` + ts.map((t) => `
      <tr data-id="${esc(t.id)}">
        <td><button class="link" type="button" data-id="${esc(t.id)}">${esc(t.id)}</button><span class="nm">${esc(t.name)}</span></td>
        <td>${money(t.last, t.currency)}</td>
        <td>${deltaHTML(t.d1)}</td>
        <td>${deltaHTML(t.m1)}</td>
        <td>${deltaHTML(t.y1)}</td>
        <td>${spark(t.spark)}</td>
        <td>${t.logistic > 0.5 ? '<span class="call up"><span aria-hidden="true">▲</span> Up</span>' : '<span class="call down"><span aria-hidden="true">▼</span> Down</span>'} <span class="ci">${Math.round(t.logistic * 100)}% chance</span></td>
      </tr>`).join('')).join('');
  $('#all-table').innerHTML = `<caption class="sr-only">All markets</caption><thead><tr><th>Market</th><th>Last</th><th>1 day</th><th>1 month</th><th>1 year</th><th>Last 90 days</th><th>Logistic model for tomorrow</th></tr></thead><tbody>${body}</tbody>`;
  $('#all-table').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    location.hash = tr.dataset.id;
    $('#main').scrollIntoView({ behavior: 'smooth' });
  });
}

window.addEventListener('hashchange', () => loadTicker(decodeURIComponent(location.hash.slice(1))));

(async () => {
  try {
    await loadIndex();
    await loadTicker(decodeURIComponent(location.hash.slice(1)) || 'SPY');
  } catch (e) {
    console.error(e);
    $('#q-name').textContent = 'Could not load the data';
  }
})();
