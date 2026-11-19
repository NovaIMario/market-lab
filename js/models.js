// Prediction models and the walk-forward backtest. Runs in Node (the nightly update) and in the
// browser alike. Every model only ever sees data up to the close of the day it predicts from.

import { sma, rsi, rollingStd, logReturns } from './indicators.js';

export const FEATURE_NAMES = [
  '1-day return', '5-day return', '20-day return', '60-day return', '20-day volatility',
  'RSI(14)', 'Distance from 50-day average', 'Distance from 200-day average', 'Volume vs 20-day average',
];

export const TRAIN_WINDOW = 750;   // about three years of trading days
export const REFIT_EVERY = 21;     // retrain monthly
export const WARMUP = 200;         // the longest feature needs 200 days of history
export const COST = 0.0005;        // 5 basis points each time the strategy switches in or out

// Seeded random numbers so every run of the site produces the same numbers.
export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Feature matrix: row i describes the market as of the close of day i.
export function buildFeatures(close, volume) {
  const n = close.length;
  const r = logReturns(close);
  const vol20 = rollingStd(r, 20);
  const rs = rsi(close, 14);
  const s50 = sma(close, 50), s200 = sma(close, 200);
  const hasVolume = volume.some((v) => v > 0);
  const vMean = sma(volume, 20), vStd = rollingStd(volume, 20);
  const X = new Array(n).fill(null);
  for (let i = WARMUP; i < n; i++) {
    const vz = hasVolume && vStd[i] > 0 ? (volume[i] - vMean[i]) / vStd[i] : 0;
    X[i] = [
      r[i],
      Math.log(close[i] / close[i - 5]),
      Math.log(close[i] / close[i - 20]),
      Math.log(close[i] / close[i - 60]),
      vol20[i],
      (rs[i] - 50) / 50,
      close[i] / s50[i] - 1,
      close[i] / s200[i] - 1,
      Math.max(-5, Math.min(5, vz)),
    ];
  }
  return X;
}

function standardiser(rows) {
  const d = rows[0].length;
  const mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const x of rows) for (let j = 0; j < d; j++) mu[j] += x[j];
  for (let j = 0; j < d; j++) mu[j] /= rows.length;
  for (const x of rows) for (let j = 0; j < d; j++) sd[j] += (x[j] - mu[j]) ** 2;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j] / rows.length) || 1;
  return (x) => x.map((v, j) => (v - mu[j]) / sd[j]);
}

// Solve A x = b by Gaussian elimination with partial pivoting (A is small and symmetric positive definite).
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// L2-regularised logistic regression fitted by Newton's method (IRLS). The intercept is not penalised.
export function fitLogistic(Xs, y, lambda = 5, iters = 12) {
  const d = Xs[0].length + 1;
  const w = new Array(d).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(d).fill(0);
    const H = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let i = 0; i < Xs.length; i++) {
      const x = [1, ...Xs[i]];
      let z = 0;
      for (let j = 0; j < d; j++) z += w[j] * x[j];
      const p = 1 / (1 + Math.exp(-z));
      const s = p * (1 - p);
      for (let j = 0; j < d; j++) {
        g[j] += (p - y[i]) * x[j];
        for (let k = j; k < d; k++) H[j][k] += s * x[j] * x[k];
      }
    }
    for (let j = 0; j < d; j++) for (let k = 0; k < j; k++) H[j][k] = H[k][j];
    for (let j = 1; j < d; j++) { g[j] += lambda * w[j]; H[j][j] += lambda; }
    H[0][0] += 1e-9;
    const step = solve(H, g);
    let moved = 0;
    for (let j = 0; j < d; j++) { w[j] -= step[j]; moved = Math.max(moved, Math.abs(step[j])); }
    if (moved < 1e-7) break;
  }
  return (x) => {
    let z = w[0];
    for (let j = 1; j < d; j++) z += w[j] * x[j - 1];
    return 1 / (1 + Math.exp(-z));
  };
}

function knnPredictor(Xs, y, k = 75) {
  return (x) => {
    const dist = Xs.map((r, i) => {
      let s = 0;
      for (let j = 0; j < r.length; j++) s += (r[j] - x[j]) ** 2;
      return [s, y[i]];
    });
    dist.sort((a, b) => a[0] - b[0]);
    let up = 0;
    for (let i = 0; i < k; i++) up += dist[i][1];
    return up / k;
  };
}

// Each model returns the probability that the next close is higher than today's.
// Rule models ignore the training data and return 0 or 1.
export const MODELS = [
  { id: 'always', name: 'Always up', kind: 'Baseline', about: 'Predicts a rise every day. Its strategy is buy and hold.' },
  { id: 'momentum', name: 'Momentum', kind: 'Rule', about: 'Predicts a rise when the last 20 days were up.' },
  { id: 'reversion', name: 'Mean reversion', kind: 'Rule', about: 'Predicts a rise when the last 5 days were down.' },
  { id: 'trend', name: '200-day trend', kind: 'Rule', about: 'Predicts a rise when the price is above its 200-day average.' },
  { id: 'logistic', name: 'Logistic regression', kind: 'Learned', about: 'L2-regularised logistic regression on 9 features, retrained monthly on the last 3 years.' },
  { id: 'knn', name: 'k-nearest neighbours', kind: 'Learned', about: 'Looks up the 75 most similar days of the last 3 years and counts how many were followed by a rise.' },
];

function rulePredict(id, X, i) {
  const x = X[i];
  switch (id) {
    case 'always': return 1;
    case 'momentum': return x[2] > 0 ? 1 : 0;
    case 'reversion': return x[1] < 0 ? 1 : 0;
    case 'trend': return x[7] > 0 ? 1 : 0;
  }
  return null;
}

function fitLearned(id, X, labels, end) {
  // Train on rows [end - TRAIN_WINDOW, end): their labels are known by the close of day `end`.
  const rows = [], y = [];
  for (let j = Math.max(WARMUP, end - TRAIN_WINDOW); j < end; j++) { rows.push(X[j]); y.push(labels[j]); }
  const z = standardiser(rows);
  const Xs = rows.map(z);
  const f = id === 'logistic' ? fitLogistic(Xs, y) : knnPredictor(Xs, y);
  return (x) => f(z(x));
}

// Walk forward through history. At each day i (from the first day with a full training window)
// every model predicts whether close[i+1] > close[i] using only rows up to i.
export function walkForward(close, volume) {
  const n = close.length;
  const X = buildFeatures(close, volume);
  const labels = close.map((c, i) => (i + 1 < n ? (close[i + 1] > c ? 1 : 0) : null));
  const start = WARMUP + TRAIN_WINDOW;
  const probs = Object.fromEntries(MODELS.map((m) => [m.id, []]));
  const fitted = {};
  for (let i = start; i < n; i++) {
    if ((i - start) % REFIT_EVERY === 0) {
      for (const m of MODELS) if (m.kind === 'Learned') fitted[m.id] = fitLearned(m.id, X, labels, i);
    }
    for (const m of MODELS) {
      probs[m.id].push(m.kind === 'Learned' ? fitted[m.id](X[i]) : rulePredict(m.id, X, i));
    }
  }
  // Tomorrow's call uses a fresh fit on the most recent window.
  const today = {};
  for (const m of MODELS) {
    today[m.id] = m.kind === 'Learned'
      ? fitLearned(m.id, X, labels, n - 1)(X[n - 1])
      : rulePredict(m.id, X, n - 1);
  }
  return { start, probs, labels, today };
}

// Two-sided p-value from a standard normal z score.
function normalP(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 2 * p;
}

function wilson(k, n, z = 1.96) {
  const p = k / n, den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [c - h, c + h];
}

// Score the walk-forward predictions: accuracy, a McNemar test against "always up", and a
// long-or-cash strategy that holds the asset only when the model predicts a rise.
export function evaluate(close, dates, wf, periodsPerYear) {
  const { start, probs, labels } = wf;
  const n = close.length;
  const last = n - 2; // the final day has no label yet
  const ret = [];
  for (let i = start; i <= last; i++) ret.push(close[i + 1] / close[i] - 1);
  const T = ret.length;
  const always = probs.always;
  const results = {};
  for (const m of MODELS) {
    const p = probs[m.id];
    let correct = 0, b = 0, c = 0, eq = 1, peak = 1, maxDD = 0, prevPos = 0, switches = 0, invested = 0;
    const equity = [1];
    const daily = [];
    for (let t = 0; t < T; t++) {
      const y = labels[start + t];
      const up = p[t] > 0.5 ? 1 : 0;
      const ok = up === y, aOk = y === 1;
      if (ok) correct++;
      if (ok && !aOk) b++;
      if (!ok && aOk) c++;
      const pos = up;
      let r = pos * ret[t];
      if (pos !== prevPos) { r -= COST; switches++; }
      prevPos = pos;
      invested += pos;
      eq *= 1 + r;
      daily.push(r);
      equity.push(eq);
      peak = Math.max(peak, eq);
      maxDD = Math.min(maxDD, eq / peak - 1);
    }
    const mean = daily.reduce((a, v) => a + v, 0) / T;
    const sd = Math.sqrt(daily.reduce((a, v) => a + (v - mean) ** 2, 0) / (T - 1));
    const years = T / periodsPerYear;
    // McNemar: on days where the model and "always up" disagree, is the model right more often?
    const mcZ = b + c > 0 ? (b - c) / Math.sqrt(b + c) : 0;
    results[m.id] = {
      accuracy: correct / T,
      accuracyCI: wilson(correct, T),
      vsAlwaysP: m.id === 'always' ? null : normalP(mcZ),
      vsAlwaysSign: Math.sign(b - c),
      cagr: eq ** (1 / years) - 1,
      vol: sd * Math.sqrt(periodsPerYear),
      sharpe: sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : 0,
      maxDD,
      exposure: invested / T,
      tradesPerYear: switches / years,
      // Thin the equity curve to about 400 points for the chart.
      equity: thin(equity, 400),
    };
  }
  const step = Math.max(1, Math.ceil((T + 1) / 400));
  const eqDates = [];
  for (let t = 0; t <= T; t += step) eqDates.push(dates[start + t]);
  if ((T % step) !== 0) eqDates.push(dates[start + T]);
  return { from: dates[start], to: dates[last + 1], days: T, upRate: ret.filter((r) => r > 0).length / T, results, eqDates };
}

function thin(arr, target) {
  const step = Math.max(1, Math.ceil(arr.length / target));
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(+arr[i].toFixed(5));
  if ((arr.length - 1) % step !== 0) out.push(+arr[arr.length - 1].toFixed(5));
  return out;
}

// Monte Carlo forecast cone. Resamples the last `lookback` daily log returns in blocks of 5 days
// (which keeps some of the volatility clustering), with the average return removed: the cone
// assumes no drift, so it says how far the price could move, not which way.
function simulateQuantiles(r, horizon, paths, rand, qs) {
  const L = r.length, B = 5;
  const mean = r.reduce((a, v) => a + v, 0) / L;
  const sims = Array.from({ length: horizon }, () => new Float64Array(paths));
  for (let p = 0; p < paths; p++) {
    let s = 0, h = 0;
    while (h < horizon) {
      const k = Math.floor(rand() * (L - B));
      for (let j = 0; j < B && h < horizon; j++, h++) { s += r[k + j] - mean; sims[h][p] = s; }
    }
  }
  return sims.map((col) => {
    const sorted = Array.from(col).sort((a, b) => a - b);
    return qs.map((q) => sorted[Math.min(paths - 1, Math.floor(q * paths))]);
  });
}

export const CONE_QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];

export function forecastCone(close, horizon = 60, lookback = 500, paths = 4000, seed = 7) {
  const r = logReturns(close).slice(-lookback);
  const qs = simulateQuantiles(r, horizon, paths, mulberry32(seed), CONE_QUANTILES);
  const last = close[close.length - 1];
  return qs.map((row) => row.map((v) => +(last * Math.exp(v)).toPrecision(6)));
}

// How often did past cones contain what actually happened? Every 10 days, build a 20-day cone from
// the 500 days before, then check where the price really was 20 days later.
export function coneCalibration(close, horizon = 20, lookback = 500, every = 10) {
  const r = logReturns(close);
  const rand = mulberry32(11);
  let n = 0, in50 = 0, in90 = 0;
  for (let i = lookback; i + horizon < close.length; i += every) {
    const q = simulateQuantiles(r.slice(i - lookback + 1, i + 1), horizon, 1000, rand, CONE_QUANTILES)[horizon - 1];
    const real = Math.log(close[i + horizon] / close[i]);
    n++;
    if (real >= q[1] && real <= q[3]) in50++;
    if (real >= q[0] && real <= q[4]) in90++;
  }
  return { tests: n, in50: in50 / n, in90: in90 / n, horizon };
}
