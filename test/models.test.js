import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, bollinger } from '../js/indicators.js';
import { walkForward, evaluate, forecastCone, fitLogistic, mulberry32, WARMUP, TRAIN_WINDOW } from '../js/models.js';

function randomWalk(n, seed = 1) {
  const r = mulberry32(seed);
  const c = [100];
  for (let i = 1; i < n; i++) c.push(c[i - 1] * Math.exp((r() - 0.5) * 0.04));
  return c;
}

test('sma and ema', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.equal(e[2], 2);
  assert.equal(e[3], 3);
});

test('rsi stays within 0..100 and is 100 for a rising series', () => {
  const up = Array.from({ length: 30 }, (_, i) => i + 1);
  assert.equal(rsi(up, 14).at(-1), 100);
  for (const v of rsi(randomWalk(500), 14)) if (v != null) assert.ok(v >= 0 && v <= 100);
});

test('bollinger bands surround the average', () => {
  const b = bollinger(randomWalk(100), 20, 2);
  for (let i = 19; i < 100; i++) assert.ok(b.lower[i] <= b.mid[i] && b.mid[i] <= b.upper[i]);
});

test('logistic regression learns a separable rule', () => {
  const r = mulberry32(3);
  const X = [], y = [];
  for (let i = 0; i < 400; i++) { const a = r() * 2 - 1, b = r() * 2 - 1; X.push([a, b]); y.push(a + b > 0 ? 1 : 0); }
  const f = fitLogistic(X, y, 0.01);
  assert.ok(f([0.8, 0.8]) > 0.9);
  assert.ok(f([-0.8, -0.8]) < 0.1);
});

test('walk-forward has no lookahead: changing the future does not change past predictions', () => {
  const close = randomWalk(1300, 5);
  const vol = close.map(() => 1000);
  const a = walkForward(close, vol);
  const cut = 1100;
  const altered = close.slice(0, cut + 1).concat(randomWalk(199, 99).map((v) => v * 3));
  const b = walkForward(altered, vol);
  const upto = cut - (WARMUP + TRAIN_WINDOW); // predictions made at or before day `cut`
  for (const id of Object.keys(a.probs)) {
    assert.deepEqual(b.probs[id].slice(0, upto + 1), a.probs[id].slice(0, upto + 1), id);
  }
});

test('on a random walk, no model is significantly better than always up', () => {
  const close = randomWalk(1800, 8);
  const dates = close.map((_, i) => new Date(Date.UTC(2015, 0, 1 + i)).toISOString().slice(0, 10));
  const res = evaluate(close, dates, walkForward(close, close.map(() => 1)), 252);
  for (const [id, r] of Object.entries(res.results)) {
    if (id === 'always') continue;
    assert.ok(!(r.vsAlwaysP < 0.01 && r.vsAlwaysSign > 0), `${id} looked significant`);
  }
});

test('forecast cone quantiles are ordered and start near the last price', () => {
  const close = randomWalk(800, 2);
  const cone = forecastCone(close, 30);
  for (const q of cone) for (let k = 1; k < q.length; k++) assert.ok(q[k] >= q[k - 1]);
  const last = close.at(-1);
  assert.ok(Math.abs(cone[0][2] / last - 1) < 0.02);
});
