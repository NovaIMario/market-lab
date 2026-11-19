// Nightly update: download ten years of daily prices for every ticker, run the walk-forward
// backtest and the forecast cone, and write one JSON file per ticker plus an index for the watchlist.
//
//   node scripts/update.mjs            all tickers
//   node scripts/update.mjs AAPL MSFT  just these

import { mkdir, writeFile } from 'node:fs/promises';
import { walkForward, evaluate, forecastCone, coneCalibration, MODELS } from '../js/models.js';
import { TICKERS } from '../js/tickers.js';

const DATA = new URL('../data/', import.meta.url);
const UA = 'Mozilla/5.0 (compatible; market-lab/1.0; +https://github.com/NovaIMario/market-lab)';

const sig = (x, d = 6) => (x == null ? null : +x.toPrecision(d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHistory(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1d&events=div%2Csplit`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const r = json.chart.result[0];
      const q = r.indicators.quote[0];
      const adj = r.indicators.adjclose?.[0]?.adjclose ?? q.close;
      const off = r.meta.gmtoffset ?? 0;
      const rows = [];
      for (let i = 0; i < r.timestamp.length; i++) {
        const c = q.close[i], a = adj[i];
        if (c == null || a == null || q.open[i] == null || !(c > 0)) continue;
        // Back-adjust open, high and low by the same factor as the close, so splits and dividends
        // don't show up as price gaps.
        const f = a / c;
        const date = new Date((r.timestamp[i] + off) * 1000).toISOString().slice(0, 10);
        if (rows.length && rows[rows.length - 1][0] === date) rows.pop(); // today's live bar can repeat
        rows.push([date, q.open[i] * f, q.high[i] * f, q.low[i] * f, a, q.volume[i] ?? 0]);
      }
      return { meta: r.meta, rows };
    } catch (e) {
      if (attempt >= 3) throw new Error(`${symbol}: ${e.message}`);
      await sleep(2000 * attempt);
    }
  }
}

async function main() {
  await mkdir(DATA, { recursive: true });
  const only = process.argv.slice(2);
  const list = only.length ? TICKERS.filter((t) => only.includes(t.id)) : TICKERS;
  const index = [];
  const failures = [];
  for (const t of list) {
    const started = Date.now();
    let hist;
    try { hist = await fetchHistory(t.symbol); } catch (e) { failures.push(e.message); console.error(e.message); continue; }
    const rows = hist.rows;
    const dates = rows.map((r) => r[0]);
    const close = rows.map((r) => r[4]);
    const volume = rows.map((r) => r[5]);
    const ppy = t.group === 'Crypto' ? 365 : 252;

    const wf = walkForward(close, volume);
    const backtest = evaluate(close, dates, wf, ppy);
    const today = Object.fromEntries(MODELS.map((m) => [m.id, +wf.today[m.id].toFixed(4)]));
    const cone = forecastCone(close);
    const calibration = coneCalibration(close);

    const out = {
      id: t.id, symbol: t.symbol, name: t.name, group: t.group,
      currency: t.symbol.startsWith('^') ? 'points' : hist.meta.currency, exchange: hist.meta.fullExchangeName ?? hist.meta.exchangeName,
      updated: new Date().toISOString(),
      prices: {
        t: dates,
        o: rows.map((r) => sig(r[1])), h: rows.map((r) => sig(r[2])),
        l: rows.map((r) => sig(r[3])), c: rows.map((r) => sig(r[4])),
        v: volume.map((v) => Math.round(v)),
      },
      backtest, today, cone, calibration,
    };
    await writeFile(new URL(`${t.id}.json`, DATA), JSON.stringify(out));

    const n = close.length, last = close[n - 1];
    const back = (k) => (n > k ? last / close[n - 1 - k] - 1 : null);
    const yearAgo = dates[n - 1].replace(/^\d{4}/, (y) => String(+y - 1));
    const iYear = dates.findIndex((d) => d >= yearAgo);
    index.push({
      id: t.id, name: t.name, group: t.group, currency: out.currency,
      last: sig(last), date: dates[n - 1],
      d1: sig(back(1), 4), m1: sig(back(t.group === 'Crypto' ? 30 : 21), 4),
      y1: iYear > 0 ? sig(last / close[iYear] - 1, 4) : null,
      spark: close.slice(-90).map((c) => sig(c, 5)),
      logistic: today.logistic,
      // For the site-wide summary: how many of the five non-baseline models beat buy and hold here.
      significant: MODELS.filter((m) => m.id !== 'always' && backtest.results[m.id].vsAlwaysP < 0.05 && backtest.results[m.id].vsAlwaysSign > 0).length,
      higherSharpe: MODELS.filter((m) => m.id !== 'always' && backtest.results[m.id].sharpe > backtest.results.always.sharpe).length,
      in50: calibration.in50, in90: calibration.in90,
    });
    console.log(`${t.id.padEnd(8)} ${n} days  ${Date.now() - started} ms`);
    await sleep(300);
  }
  if (!only.length) {
    if (index.length < TICKERS.length * 0.8) throw new Error(`Only ${index.length} of ${TICKERS.length} tickers downloaded:\n${failures.join('\n')}`);
    await writeFile(new URL('index.json', DATA), JSON.stringify({ updated: new Date().toISOString(), tickers: index }));
  }
  if (failures.length) console.warn(`Failed: ${failures.join('; ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
