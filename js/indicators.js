// Technical indicators. Pure functions over arrays of numbers; every output is aligned with its
// input and holds null where the indicator is not defined yet (not enough history).

export function sma(x, n) {
  const out = new Array(x.length).fill(null);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i];
    if (i >= n) sum -= x[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(x, n) {
  const out = new Array(x.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < x.length; i++) {
    if (x[i] == null) continue;
    if (prev == null) {
      // Seed with the simple average of the first n defined values.
      if (i >= n - 1 && x[i - n + 1] != null) {
        let s = 0;
        for (let j = i - n + 1; j <= i; j++) s += x[j];
        prev = s / n;
        out[i] = prev;
      }
      continue;
    }
    prev = x[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rollingStd(x, n) {
  const out = new Array(x.length).fill(null);
  let s = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i]; s2 += x[i] * x[i];
    if (i >= n) { s -= x[i - n]; s2 -= x[i - n] * x[i - n]; }
    if (i >= n - 1) out[i] = Math.sqrt(Math.max(0, (s2 - (s * s) / n) / (n - 1)));
  }
  return out;
}

export function bollinger(close, n = 20, k = 2) {
  const mid = sma(close, n);
  const sd = rollingStd(close, n);
  return {
    mid,
    upper: mid.map((m, i) => (m == null ? null : m + k * sd[i])),
    lower: mid.map((m, i) => (m == null ? null : m - k * sd[i])),
  };
}

// Wilder's RSI.
export function rsi(close, n = 14) {
  const out = new Array(close.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= n) {
      gain += g; loss += l;
      if (i === n) { gain /= n; loss /= n; out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

export function macd(close, fast = 12, slow = 26, signal = 9) {
  const f = ema(close, fast), s = ema(close, slow);
  const line = close.map((_, i) => (f[i] == null || s[i] == null ? null : f[i] - s[i]));
  const sig = ema(line, signal);
  const hist = line.map((v, i) => (v == null || sig[i] == null ? null : v - sig[i]));
  return { line, signal: sig, hist };
}

export function logReturns(close) {
  const out = new Array(close.length).fill(0);
  for (let i = 1; i < close.length; i++) out[i] = Math.log(close[i] / close[i - 1]);
  return out;
}
