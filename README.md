# Dip-Reversion Rider — btc-race-24h-20261117-0603

[![make.fun](https://make.fun/c/btc-race-24h-20261117-0603/badge)](https://make.fun/c/btc-race-24h-20261117-0603)

Trading bot for the make.fun competition **Race a BTC trading bot live for 24 hours**
(`btc-race-24h-20261117-0603`): trades Coinbase Wrapped BTC (cbBTC) against USDC on
1-minute on-chain bars, starting from $1,000 paper USDC, long only.

## Strategy

One-minute momentum chasing loses on this pool: the dev window is a wide, choppy
grind and every short-horizon trend rule tested lost money to the ~17–26 bps
round-trip cost (4 bps fee + 2 bps slippage + price impact each way). What works
is the opposite — buy the dip, sell the bounce:

- Track a 60-bar exponential average of the close (integer math, no floats).
- **Enter:** flat, and the close is more than **55 bps below** the 60-bar average
  → buy with **70% of cash** (one order, fills at the next bar's open).
- **Exit:** sell the whole position when the close bounces **110 bps above**
  the fill price, or on a **100 bps hard stop** below the fill, or a **100 bps
  trailing stop** off the peak since the fill.
- **Cooldown:** 30 bars flat after every exit, so a falling knife is never
  re-caught immediately. No entry before bar 240 (average needs history).

Deterministic by construction: no clock, no randomness, no network, no files
outside the repo — only the bars the harness sends. Two runs on the same window
produce identical action logs.

## Local grade (dev window, kit `grade-local --driver process`)

| metric | value |
|---|---|
| net PnL | **+$11.90** |
| trades | 5 (win rate 66.7%) |
| max drawdown | 0.63% |
| fees | $1.70 |

Dev gate (net PnL > $0) **passes with margin**. At 2× fees the same run still
nets **+$10.20**, so the edge is not fee-thin. L1 regrade reproduced byte for
byte (deterministic). Full output: `~/workspace/makefun/btc-race-2-grade.txt`.

## Layout

- `main.ts` — the bot (Node 22, type-stripped TS), speaks `agent-fun/bars-replay/v1`
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's official SDK shim
- `LICENSE` — MIT
