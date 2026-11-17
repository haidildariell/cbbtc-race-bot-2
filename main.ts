// Dip-reversion rider for cbBTC/USDC, 1-minute bars (agent-fun/bars-replay/v1).
//
// Idea, in one paragraph: on this pool BTC grinds in a wide, choppy range and
// one-minute momentum chases its own tail — every short-horizon trend rule I
// tested on the dev window lost money to the ~17-26 bps round trip. What did
// work was the opposite: wait for price to sag clearly below its own slow
// average, buy the dip with a moderate slice of cash, and let the bounce pay
// for the round trip. So the bot does exactly one thing, patiently:
//
//   - Track a 60-bar exponential average of the close (integer math only).
//   - Flat and the close is more than DIP_BPS below that average -> buy
//     SIZE_BPS of the cash on hand (one order, next bar's open).
//   - Long and the close has bounced TARGET_BPS above the fill price ->
//     sell the whole position. A hard stop (STOP_BPS below the fill) and a
//     trailing stop (TRAIL_BPS off the peak since the fill) cut the trades
//     where the dip keeps dipping; a 300-bar time stop exits a trade that
//     never bounces, so no position is carried indefinitely.
//   - After any exit, sit out COOLDOWN_BARS bars so a falling knife cannot
//     be re-caught immediately.
//
// No clock, no randomness, no network, no files outside the repo: the only
// inputs are the bars the harness sends, so two runs on the same window
// produce byte-identical action logs. All prices are bigints at the
// symbol's price_scale; every ratio below is computed cross-multiplied in
// integers, never in floats.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// How far below the 60-bar average the close must sag before we buy (bps).
const DIP_BPS = 55n;
// How far above our fill the close must bounce before we take profit (bps).
const TARGET_BPS = 110n;
// Hard stop below our fill, and trailing stop off the peak since fill (bps).
const STOP_BPS = 100n;
const TRAIL_BPS = 100n;
// Share of cash committed to each dip buy (bps of cash).
const SIZE_BPS = 7000n;
// Bars to sit out after an exit before buying again.
const COOLDOWN_BARS = 30;
// Longest a dip buy may be held: a trade that never bounces is exited flat
// instead of being carried indefinitely into unseen bars.
const TIME_STOP_BARS = 300;
// Bars of history before the average is trusted enough to trade on.
const MIN_HISTORY_BARS = 240;
// Slippage allowance on every order, measured from the latest close (bps).
// The open-to-close gap on this pool is a few bps and our own impact at
// 70% of $1,000 is ~9 bps, so 300 bps is wide open in practice and only
// guards against a wild gap.
const MAX_SLIPPAGE_BPS = 300;

// The 60-bar average, kept as a bigint price (price_scale units). Seeded on
// the first close seen; EMA factor 2/61, updated as (2*close + 59*ema)/61.
let ema60: bigint | null = null;
// Fill price of the open position (price_scale units), and the highest close
// seen since that fill, for the trailing stop. Both reset on a sell fill.
let fillPrice: bigint | null = null;
let peakSinceFill: bigint | null = null;
// First seq of the open position, for the time stop.
let fillSeq: number | null = null;
// First seq on which a new buy may be sent (cooldown after an exit).
let buyAllowedFromSeq = 0;

/** (a - b) / b in basis points, truncated toward zero, exact in integers. */
function bpsDiff(a: bigint, b: bigint): bigint {
  return ((a - b) * 10000n) / b;
}

await runBars({
  onBatch(state: BarsState, batch) {
    if (state.warmingUp) return [];

    const close = state.close(SYMBOL);
    if (close === null) return [];

    // Fold this bar into the average first, then trade on it.
    ema60 = ema60 === null ? close : (2n * close + 59n * ema60) / 61n;

    // Learn our real fill prices from the harness, not from our guesses:
    // a buy decided last batch fills at this bar's open and its price is
    // reported here; a sell fill clears the position and starts the cooldown.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        fillPrice = BigInt(fill.price);
        peakSinceFill = fillPrice;
        fillSeq = batch.seq;
      } else {
        fillPrice = null;
        peakSinceFill = null;
        fillSeq = null;
        buyAllowedFromSeq = batch.seq + COOLDOWN_BARS;
      }
    }

    const held = state.positions.get(SYMBOL);
    const orders: OrderInput[] = [];

    if (held === undefined || held.qty === 0n) {
      // Flat: buy the dip, once the average has enough history and the
      // cooldown from the last exit has passed.
      if (batch.seq < MIN_HISTORY_BARS || batch.seq < buyAllowedFromSeq) return [];
      if (ema60 === null) return [];
      const dip = bpsDiff(ema60, close);
      if (dip <= DIP_BPS) return [];
      const spend = (state.cash * SIZE_BPS) / 10000n;
      if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
      return orders;
    }

    // Long: defend the position. The peak tracks closes, so the trailing
    // stop only tightens as the bounce extends.
    if (fillPrice === null || peakSinceFill === null) return [];
    if (close > peakSinceFill) peakSinceFill = close;
    const gain = bpsDiff(close, fillPrice);
    const giveback = bpsDiff(peakSinceFill, close);
    const takeProfit = gain >= TARGET_BPS;
    const stoppedOut = gain <= -STOP_BPS;
    const trailedOut = giveback >= TRAIL_BPS;
    const timedOut = fillSeq !== null && batch.seq - fillSeq >= TIME_STOP_BARS;
    if (!takeProfit && !stoppedOut && !trailedOut && !timedOut) return [];
    orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
    return orders;
  },
});
