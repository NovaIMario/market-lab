# Market Lab

**Stock, index and crypto charts, with forecasts that are tested against what actually happened.**

**▶ Live site: https://novaimario.github.io/market-lab/**

Market Lab follows 30 markets: US index ETFs, the FTSE 100, gold, Treasuries, 15 US stocks, 6 UK stocks, Bitcoin and Ether. For each one it shows:

| Section | What it does |
| --- | --- |
| **Price chart** | Candlestick or line chart drawn on a canvas with no chart library. Zoom with the scroll wheel, drag to pan, and use the arrow keys to move the crosshair. Overlays for the 20, 50 and 200-day moving averages and Bollinger bands, and a lower pane showing volume, RSI or MACD. |
| **Forecast cone** | 4,000 Monte Carlo paths for the next 60 trading days, giving 50% and 90% ranges, plus a calibration check of how often past cones actually contained the outcome. |
| **Next-day backtest** | Six models predict whether tomorrow's close will be higher. Each one is walk-forward tested over about 6 years with no lookahead, compared with "always up" using McNemar's test, and traded as a long-or-cash strategy after costs. |
| **All markets** | 1-day, 1-month and 1-year changes, 90-day sparklines, and the logistic model's call for tomorrow. |

## Results

Across all 30 markets:

- **The forecast cones are well calibrated.** On average, the 50% range contained the price 20 days later about 50% of the time, and the 90% range contained it about 89% of the time.
- **No model predicts tomorrow's direction better than "always up".** None of the 150 model and market pairs was significantly more accurate at the 5% level. About 4 would be expected by chance alone.
- 18 of the 150 pairs had a higher Sharpe ratio than buy and hold. Those wins come from sitting in cash during crashes (the 200-day trend rule does this most), not from calling individual days better.

The figures refresh every night, so they will drift a little from the ones above.

## Models

| Model | Rule |
| --- | --- |
| Always up | Baseline: predicts a rise every day (buy and hold) |
| Momentum | Up if the last 20 days were up |
| Mean reversion | Up if the last 5 days were down |
| 200-day trend | Up if the price is above its 200-day moving average |
| Logistic regression | L2-regularised, fitted with Newton's method (IRLS) on 9 standardised features: returns over 1, 5, 20 and 60 days, 20-day volatility, RSI, distance from the 50 and 200-day averages, and volume z-score |
| k-nearest neighbours | Share of the 75 most similar past days (same features) that were followed by a rise |

The learned models retrain every 21 trading days on the previous 750 days. Every prediction for day *t* uses only data up to the close of day *t*. A unit test checks this by changing future prices and confirming that no earlier prediction changes.

## How it works

```
GitHub Actions (nightly) ──► scripts/update.mjs
                               ├─ fetch 10 years of daily OHLCV (Yahoo Finance), adjust for splits and dividends
                               ├─ js/models.js: walk-forward backtest, forecast cone, calibration
                               └─ data/<ticker>.json + data/index.json ──► commit ──► GitHub Pages
Browser ──► index.html + js/app.js ──► js/chart.js (canvas charts) + js/indicators.js
```

The indicator and model code is plain ES modules shared by Node and the browser, so it has no dependencies and no build step.

## Running locally

```bash
node scripts/update.mjs          # download prices and rerun the models (about 2 minutes)
node scripts/update.mjs AAPL     # only one ticker
node --test                      # unit tests
python -m http.server            # then open http://localhost:8000
```

## Disclaimer

This is a statistics project, not financial advice.
