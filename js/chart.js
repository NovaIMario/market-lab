// Canvas charts with no dependencies: an interactive price chart (candles or line, overlays, a
// lower indicator pane, zoom, pan and crosshair) and a general line chart with bands and tooltips.

import { sma, bollinger, rsi, macd } from './indicators.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

function niceTicks(min, max, count = 5) {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

function logTicks(min, max) {
  const out = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= min && v <= max) out.push(v);
    }
  }
  return out.length >= 2 ? out : niceTicks(min, max, 4);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Pick date labels at month or year boundaries so that they are at least `minGap` pixels apart.
function dateTicks(dates, from, to, xOf, minGap = 70) {
  const span = to - from;
  const unit = span > 1000 ? 'year' : span > 200 ? 'quarter' : span > 40 ? 'month' : 'day';
  const ticks = [];
  let lastX = -Infinity;
  for (let i = Math.max(from, 1); i <= to; i++) {
    const d = dates[i], p = dates[i - 1];
    if (!d || !p) continue;
    let label = null;
    const y = d.slice(0, 4), m = +d.slice(5, 7);
    if (unit === 'year' && y !== p.slice(0, 4)) label = y;
    else if (unit === 'quarter' && d.slice(5, 7) !== p.slice(5, 7) && (m - 1) % 3 === 0) label = m === 1 ? y : MONTHS[m - 1];
    else if (unit === 'month' && d.slice(5, 7) !== p.slice(5, 7)) label = m === 1 ? y : MONTHS[m - 1];
    else if (unit === 'day' && (i - from) % Math.max(1, Math.round(span / 6)) === 0) label = `${+d.slice(8)} ${MONTHS[m - 1]}`;
    if (label == null) continue;
    const x = xOf(i);
    if (x - lastX < minGap) continue;
    ticks.push({ i, x, label });
    lastX = x;
  }
  return ticks;
}

class CanvasBase {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    host.append(this.canvas);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    // Repaint when the theme changes.
    const repaint = () => this.draw();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaint);
    new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  resize() {
    const r = this.host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.W = Math.max(200, r.width);
    this.H = Math.max(150, r.height);
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    this.canvas.style.width = `${this.W}px`;
    this.canvas.style.height = `${this.H}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }
  line(pts, color, width = 2, dash = null) {
    const g = this.ctx;
    g.save();
    g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'round'; g.lineCap = 'round';
    if (dash) g.setLineDash(dash);
    g.beginPath();
    let pen = false;
    for (const p of pts) {
      if (p == null) { pen = false; continue; }
      if (pen) g.lineTo(p[0], p[1]); else { g.moveTo(p[0], p[1]); pen = true; }
    }
    g.stroke();
    g.restore();
  }
}

export class PriceChart extends CanvasBase {
  constructor(host, { onHover, format } = {}) {
    super(host);
    this.onHover = onHover || (() => {});
    this.format = format || ((v) => v.toFixed(2));
    this.opts = { type: 'candles', overlays: new Set(['sma50']), lower: 'volume' };
    this.hover = null;
    this.mouseY = null;
    this.bindEvents();
  }

  setData(p) {
    this.p = p;
    const c = p.c;
    this.ind = {
      sma20: sma(c, 20), sma50: sma(c, 50), sma200: sma(c, 200),
      boll: bollinger(c, 20, 2), rsi: rsi(c, 14), macd: macd(c),
    };
    this.from = Math.max(0, c.length - 252);
    this.to = c.length - 1;
    this.hover = null;
    this.draw();
  }

  setRange(from, to) {
    const n = this.p.c.length;
    this.from = Math.max(0, Math.min(from, n - 5));
    this.to = Math.min(n - 1, Math.max(to, this.from + 4));
    this.draw();
  }

  setOptions(o) { Object.assign(this.opts, o); this.draw(); }

  layout() {
    const axisW = 64, bottom = 22, top = 8, gap = 10;
    const plotW = this.W - axisW - 4;
    const avail = this.H - bottom - top;
    const lowH = this.opts.lower === 'none' ? 0 : Math.round(avail * 0.24);
    const mainH = avail - lowH - (lowH ? gap : 0);
    return { left: 4, plotW, axisW, top, mainH, lowTop: top + mainH + gap, lowH, bottom };
  }

  xOf(i, L = this.layout()) {
    const n = this.to - this.from + 1;
    return L.left + ((i - this.from + 0.5) * L.plotW) / n;
  }

  indexAt(x, L = this.layout()) {
    const n = this.to - this.from + 1;
    return Math.round(this.from + ((x - L.left) * n) / L.plotW - 0.5);
  }

  draw() {
    if (!this.p || !this.W) return;
    const g = this.ctx, L = this.layout();
    const { o, h, l, c, v, t } = this.p;
    const col = {
      up: css('--up'), down: css('--down'), grid: css('--grid'), axis: css('--axis'), muted: css('--muted'),
      ink: css('--ink'), ink2: css('--ink-2'), line: css('--series-1'), surface: css('--surface'),
      s20: css('--series-2'), s50: css('--series-3'), s200: css('--series-7'), band: css('--band'),
    };
    g.clearRect(0, 0, this.W, this.H);
    g.font = FONT;
    const from = this.from, to = this.to;
    const n = to - from + 1;
    const barW = L.plotW / n;
    const candles = this.opts.type === 'candles' && barW >= 2.2;

    // Vertical range of the price pane.
    let lo = Infinity, hi = -Infinity;
    const take = (arr) => { for (let i = from; i <= to; i++) if (arr[i] != null) { lo = Math.min(lo, arr[i]); hi = Math.max(hi, arr[i]); } };
    if (candles) { take(l); take(h); } else take(c);
    const ov = this.opts.overlays;
    for (const k of ['sma20', 'sma50', 'sma200']) if (ov.has(k)) take(this.ind[k]);
    if (ov.has('boll')) { take(this.ind.boll.upper); take(this.ind.boll.lower); }
    const pad = (hi - lo) * 0.06 || hi * 0.01;
    lo -= pad; hi += pad;
    const yOf = (val) => L.top + ((hi - val) / (hi - lo)) * L.mainH;
    this.yScale = { lo, hi, yOf };

    // Grid and price axis.
    g.textBaseline = 'middle'; g.textAlign = 'left';
    for (const tv of niceTicks(lo, hi, Math.max(3, Math.round(L.mainH / 55)))) {
      const y = Math.round(yOf(tv)) + 0.5;
      g.fillStyle = col.grid; g.fillRect(L.left, y, L.plotW, 1);
      g.fillStyle = col.muted; g.fillText(this.format(tv), L.left + L.plotW + 8, y);
    }
    const ticks = dateTicks(t, from, to, (i) => this.xOf(i, L));
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (const tk of ticks) {
      g.fillStyle = col.grid; g.fillRect(Math.round(tk.x), L.top, 1, L.mainH);
      if (L.lowH) g.fillRect(Math.round(tk.x), L.lowTop, 1, L.lowH);
      g.fillStyle = col.muted; g.fillText(tk.label, tk.x, this.H - L.bottom + 6);
    }
    g.fillStyle = col.axis;
    g.fillRect(L.left, L.top + L.mainH, L.plotW, 1);

    g.save();
    g.beginPath(); g.rect(L.left, L.top, L.plotW, L.mainH); g.clip();

    // Bollinger band behind everything else.
    if (ov.has('boll')) {
      const { upper, lower, mid } = this.ind.boll;
      g.fillStyle = col.band; g.beginPath();
      let started = false;
      for (let i = from; i <= to; i++) if (upper[i] != null) { const x = this.xOf(i, L); started ? g.lineTo(x, yOf(upper[i])) : (g.moveTo(x, yOf(upper[i])), started = true); }
      for (let i = to; i >= from; i--) if (lower[i] != null) g.lineTo(this.xOf(i, L), yOf(lower[i]));
      g.fill();
      this.line(this.series(mid, yOf, L), col.muted, 1, [4, 4]);
    }

    if (candles) {
      const bw = Math.max(1, Math.min(barW * 0.7, barW - 2));
      for (let i = from; i <= to; i++) {
        const x = this.xOf(i, L);
        const up = c[i] >= o[i];
        g.fillStyle = up ? col.up : col.down;
        g.fillRect(Math.round(x) - 0.5, yOf(h[i]), 1, Math.max(1, yOf(l[i]) - yOf(h[i])));
        const yTop = yOf(Math.max(o[i], c[i])), yBot = yOf(Math.min(o[i], c[i]));
        g.fillRect(x - bw / 2, yTop, bw, Math.max(1, yBot - yTop));
      }
    } else {
      const pts = this.series(c, yOf, L);
      const grad = g.createLinearGradient(0, L.top, 0, L.top + L.mainH);
      grad.addColorStop(0, col.line + '33'); grad.addColorStop(1, col.line + '00');
      g.fillStyle = grad; g.beginPath();
      pts.forEach((pt, k) => (k ? g.lineTo(...pt) : g.moveTo(...pt)));
      g.lineTo(pts[pts.length - 1][0], L.top + L.mainH); g.lineTo(pts[0][0], L.top + L.mainH); g.fill();
      this.line(pts, col.line, 2);
    }
    if (ov.has('sma20')) this.line(this.series(this.ind.sma20, yOf, L), col.s20, 1.5);
    if (ov.has('sma50')) this.line(this.series(this.ind.sma50, yOf, L), col.s50, 1.5);
    if (ov.has('sma200')) this.line(this.series(this.ind.sma200, yOf, L), col.s200, 1.5);
    g.restore();

    // Last price marker on the axis.
    const lastY = yOf(c[c.length - 1]);
    if (to === c.length - 1 && lastY > L.top && lastY < L.top + L.mainH) {
      const up = c[c.length - 1] >= c[c.length - 2];
      g.fillStyle = up ? col.up : col.down;
      g.fillRect(L.left + L.plotW + 2, lastY - 9, L.axisW - 2, 18);
      g.fillStyle = '#fff'; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(this.format(c[c.length - 1]), L.left + L.plotW + 6, lastY);
    }

    if (L.lowH) this.drawLower(L, col);
    this.drawCrosshair(L, col);
  }

  series(arr, yOf, L) {
    const out = [];
    for (let i = this.from; i <= this.to; i++) out.push(arr[i] == null ? null : [this.xOf(i, L), yOf(arr[i])]);
    return out;
  }

  drawLower(L, col) {
    const g = this.ctx, { from, to } = this;
    const { o, c, v } = this.p;
    const top = L.lowTop, H = L.lowH;
    g.fillStyle = col.axis; g.fillRect(L.left, top + H, L.plotW, 1);
    g.fillStyle = col.muted; g.textAlign = 'left'; g.textBaseline = 'top';
    const label = (s) => { g.fillStyle = col.muted; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText(s, L.left + 4, top + 2); };
    g.save(); g.beginPath(); g.rect(L.left, top, L.plotW + L.axisW, H + 1); g.clip();
    const barW = L.plotW / (to - from + 1);
    const bw = Math.max(1, barW * 0.7);
    if (this.opts.lower === 'volume') {
      let max = 0;
      for (let i = from; i <= to; i++) max = Math.max(max, v[i]);
      if (max === 0) { label('No volume data for this index'); g.restore(); return; }
      for (let i = from; i <= to; i++) {
        const hh = (v[i] / max) * (H - 4);
        g.fillStyle = (c[i] >= o[i] ? col.up : col.down) + '99';
        g.fillRect(this.xOf(i, L) - bw / 2, top + H - hh, bw, hh);
      }
      g.textAlign = 'left'; g.textBaseline = 'top'; g.fillStyle = col.muted;
      g.fillText(compact(max), L.left + L.plotW + 8, top);
      label('Volume');
    } else if (this.opts.lower === 'rsi') {
      const yOf = (val) => top + ((100 - val) / 100) * H;
      for (const lv of [30, 70]) {
        g.fillStyle = col.grid; g.fillRect(L.left, Math.round(yOf(lv)) + 0.5, L.plotW, 1);
        g.fillStyle = col.muted; g.textBaseline = 'middle'; g.fillText(String(lv), L.left + L.plotW + 8, yOf(lv));
      }
      this.line(this.series(this.ind.rsi, yOf, L), col.s200, 1.5);
      label('RSI (14)');
    } else if (this.opts.lower === 'macd') {
      const m = this.ind.macd;
      let a = 0;
      for (let i = from; i <= to; i++) for (const s of [m.line, m.signal]) if (s[i] != null) a = Math.max(a, Math.abs(s[i]));
      a = a || 1;
      const yOf = (val) => top + H / 2 - (val / a) * (H / 2 - 3);
      g.fillStyle = col.grid; g.fillRect(L.left, Math.round(yOf(0)) + 0.5, L.plotW, 1);
      for (let i = from; i <= to; i++) {
        const hv = m.hist[i];
        if (hv == null) continue;
        g.fillStyle = (hv >= 0 ? col.up : col.down) + '88';
        const y0 = yOf(0), y1 = yOf(hv);
        g.fillRect(this.xOf(i, L) - bw / 2, Math.min(y0, y1), bw, Math.abs(y1 - y0));
      }
      this.line(this.series(m.line, yOf, L), col.line, 1.5);
      this.line(this.series(m.signal, yOf, L), col.s20, 1.5);
      label('MACD (12, 26, 9)');
    }
    g.restore();
  }

  drawCrosshair(L, col) {
    const i = this.hover;
    if (i == null) return;
    const g = this.ctx;
    const x = Math.round(this.xOf(i, L)) + 0.5;
    g.fillStyle = col.ink2;
    g.globalAlpha = 0.5;
    g.fillRect(x, L.top, 1, L.mainH);
    if (L.lowH) g.fillRect(x, L.lowTop, 1, L.lowH);
    if (this.mouseY != null && this.mouseY > L.top && this.mouseY < L.top + L.mainH) {
      g.fillRect(L.left, Math.round(this.mouseY) + 0.5, L.plotW, 1);
      g.globalAlpha = 1;
      const { lo, hi } = this.yScale;
      const val = hi - ((this.mouseY - L.top) / L.mainH) * (hi - lo);
      g.fillStyle = col.ink; g.fillRect(L.left + L.plotW + 2, this.mouseY - 9, L.axisW - 2, 18);
      g.fillStyle = col.surface; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(this.format(val), L.left + L.plotW + 6, this.mouseY);
    }
    g.globalAlpha = 1;
    // Date label on the time axis.
    const label = this.p.t[i];
    g.font = FONT;
    const w = g.measureText(label).width + 12;
    const bx = Math.min(Math.max(L.left, x - w / 2), L.left + L.plotW - w);
    g.fillStyle = col.ink; g.fillRect(bx, this.H - L.bottom + 2, w, 18);
    g.fillStyle = col.surface; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, bx + w / 2, this.H - L.bottom + 11);
  }

  bindEvents() {
    const cv = this.canvas;
    cv.style.touchAction = 'pan-y';
    let drag = null;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const setHover = (x, y) => {
      if (!this.p) return;
      const L = this.layout();
      const i = Math.max(this.from, Math.min(this.to, this.indexAt(x, L)));
      this.mouseY = y;
      if (i !== this.hover) { this.hover = i; this.onHover(i); }
      this.draw();
    };
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      drag = { x: pos(e)[0], from: this.from, to: this.to };
    });
    cv.addEventListener('pointermove', (e) => {
      const [x, y] = pos(e);
      if (drag) {
        const L = this.layout();
        const per = L.plotW / (drag.to - drag.from + 1);
        const shift = Math.round((drag.x - x) / per);
        const n = this.p.c.length, span = drag.to - drag.from;
        let f = drag.from + shift;
        f = Math.max(0, Math.min(n - 1 - span, f));
        this.from = f; this.to = f + span;
      }
      setHover(x, y);
    });
    const end = () => { drag = null; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { if (!drag) { this.hover = null; this.mouseY = null; this.onHover(null); this.draw(); } });
    cv.addEventListener('wheel', (e) => {
      if (!this.p) return;
      e.preventDefault();
      const L = this.layout();
      const [x] = pos(e);
      const anchor = Math.max(this.from, Math.min(this.to, this.indexAt(x, L)));
      const span = this.to - this.from;
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const ns = Math.max(10, Math.min(this.p.c.length - 1, Math.round(span * factor)));
      const frac = (anchor - this.from) / (span || 1);
      let f = Math.round(anchor - frac * ns);
      f = Math.max(0, Math.min(this.p.c.length - 1 - ns, f));
      this.from = f; this.to = f + ns;
      this.onZoom?.();
      setHover(...pos(e));
    }, { passive: false });
    // Keyboard: left/right move the crosshair, +/- zoom.
    cv.tabIndex = 0;
    cv.addEventListener('keydown', (e) => {
      if (!this.p) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const d = e.key === 'ArrowLeft' ? -1 : 1;
        const i = Math.max(this.from, Math.min(this.to, (this.hover ?? this.to) + d));
        this.hover = i; this.mouseY = null; this.onHover(i); this.draw(); e.preventDefault();
      } else if (e.key === '+' || e.key === '-') {
        const span = this.to - this.from;
        const ns = Math.max(10, Math.min(this.p.c.length - 1, Math.round(span * (e.key === '+' ? 0.8 : 1.25))));
        this.setRange(this.to - ns, this.to); this.onZoom?.();
      }
    });
  }
}

export function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(1) + 'T';
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}

// A general line chart: x is an array of date strings; series are value arrays aligned with it
// (null for gaps); bands are filled ranges between two arrays. Hover shows a tooltip.
export class LineChart extends CanvasBase {
  constructor(host, { format, logY = false, tooltip } = {}) {
    super(host);
    this.format = format || ((v) => v.toFixed(2));
    this.logY = logY;
    this.tip = tooltip;
    this.hover = null;
    this.hidden = new Set();
    const cv = this.canvas;
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      this.pointer(e.clientX - r.left);
    });
    cv.addEventListener('pointerleave', () => { this.hover = null; this.draw(); if (this.tip) this.tip.hidden = true; });
    cv.tabIndex = 0;
    cv.addEventListener('keydown', (e) => {
      if (!this.d || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      const n = this.d.x.length;
      this.hover = Math.max(0, Math.min(n - 1, (this.hover ?? n - 1) + (e.key === 'ArrowLeft' ? -1 : 1)));
      this.draw(); this.showTip(); e.preventDefault();
    });
    cv.addEventListener('blur', () => { this.hover = null; this.draw(); if (this.tip) this.tip.hidden = true; });
  }

  setData(d) { this.d = d; this.hover = null; this.draw(); }
  toggle(name, on) { on ? this.hidden.delete(name) : this.hidden.add(name); this.draw(); }

  layout() {
    return { left: 4, top: 10, plotW: this.W - 64 - 4, plotH: this.H - 10 - 24 };
  }

  pointer(x) {
    if (!this.d) return;
    const L = this.layout();
    const n = this.d.x.length;
    this.hover = Math.max(0, Math.min(n - 1, Math.round(((x - L.left) / L.plotW) * (n - 1))));
    this.draw();
    this.showTip();
  }

  showTip() {
    if (!this.tip || this.hover == null) return;
    const i = this.hover, d = this.d, L = this.layout();
    const rows = [];
    for (const b of d.bands || []) if (b.lo[i] != null) rows.push([null, b.name, `${this.format(b.lo[i])} – ${this.format(b.hi[i])}`]);
    for (const s of d.series) if (!this.hidden.has(s.name) && s.values[i] != null) rows.push([s.color, s.name, this.format(s.values[i])]);
    rows.sort((a, b) => 0);
    this.tip.innerHTML = `<div class="tip-date">${d.x[i]}</div>` + rows.map(([c, n, v]) =>
      `<div class="tip-row">${c ? `<span class="swatch" style="background:${c}"></span>` : '<span class="swatch band"></span>'}<span>${n}</span><b>${v}</b></div>`).join('');
    this.tip.hidden = false;
    const x = L.left + (i / (d.x.length - 1)) * L.plotW;
    const tw = this.tip.offsetWidth;
    this.tip.style.left = `${x + 14 + tw > this.W ? x - tw - 14 : x + 14}px`;
    this.tip.style.top = '12px';
  }

  draw() {
    const d = this.d;
    if (!d || !this.W) return;
    const g = this.ctx, L = this.layout();
    const col = { grid: css('--grid'), axis: css('--axis'), muted: css('--muted'), ink2: css('--ink-2'), band: css('--band'), band2: css('--band-2') };
    g.clearRect(0, 0, this.W, this.H);
    g.font = FONT;
    const n = d.x.length;
    const vis = d.series.filter((s) => !this.hidden.has(s.name));
    let lo = Infinity, hi = -Infinity;
    for (const arr of [...vis.map((s) => s.values), ...(d.bands || []).flatMap((b) => [b.lo, b.hi])]) {
      for (const v of arr) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
    if (!isFinite(lo)) return;
    const log = this.logY && lo > 0;
    const f = log ? Math.log : (v) => v;
    let a = f(lo), b = f(hi);
    const pad = (b - a) * 0.06 || 1;
    a -= pad; b += pad;
    const xOf = (i) => L.left + (i / (n - 1)) * L.plotW;
    const yOf = (v) => L.top + ((b - f(v)) / (b - a)) * L.plotH;

    g.textBaseline = 'middle'; g.textAlign = 'left';
    const ticks = log ? logTicks(Math.exp(a), Math.exp(b)) : niceTicks(a, b, 5);
    for (const tv of ticks) {
      const y = Math.round(yOf(tv)) + 0.5;
      g.fillStyle = col.grid; g.fillRect(L.left, y, L.plotW, 1);
      g.fillStyle = col.muted; g.fillText(this.format(tv), L.left + L.plotW + 8, y);
    }
    if (d.ref != null) {
      g.fillStyle = col.axis; g.fillRect(L.left, Math.round(yOf(d.ref)) + 0.5, L.plotW, 1);
    }
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (const tk of dateTicks(d.x, 0, n - 1, xOf, 80)) { g.fillStyle = col.muted; g.fillText(tk.label, tk.x, L.top + L.plotH + 8); }
    g.fillStyle = col.axis; g.fillRect(L.left, L.top + L.plotH, L.plotW, 1);
    if (d.marker != null) {
      const x = Math.round(xOf(d.marker)) + 0.5;
      this.line([[x, L.top], [x, L.top + L.plotH]], col.muted, 1, [3, 3]);
      g.fillStyle = col.muted; g.textAlign = 'left'; g.textBaseline = 'top';
      g.fillText(d.markerLabel || '', x + 4, L.top);
    }
    for (const band of d.bands || []) {
      g.fillStyle = band.fill === 2 ? col.band2 : col.band;
      g.beginPath();
      let first = true;
      for (let i = 0; i < n; i++) if (band.hi[i] != null) { first ? g.moveTo(xOf(i), yOf(band.hi[i])) : g.lineTo(xOf(i), yOf(band.hi[i])); first = false; }
      for (let i = n - 1; i >= 0; i--) if (band.lo[i] != null) g.lineTo(xOf(i), yOf(band.lo[i]));
      g.fill();
    }
    for (const s of vis) {
      this.line(s.values.map((v, i) => (v == null ? null : [xOf(i), yOf(v)])), s.color, s.width || 2, s.dash);
    }
    if (this.hover != null) {
      const x = Math.round(xOf(this.hover)) + 0.5;
      g.globalAlpha = 0.5; g.fillStyle = col.ink2; g.fillRect(x, L.top, 1, L.plotH); g.globalAlpha = 1;
      for (const s of vis) {
        const v = s.values[this.hover];
        if (v == null) continue;
        g.beginPath(); g.arc(x, yOf(v), 4, 0, Math.PI * 2);
        g.fillStyle = s.color; g.fill();
        g.lineWidth = 2; g.strokeStyle = css('--surface'); g.stroke();
      }
    }
  }
}
