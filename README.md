# Pump.fun Sharpe Sprint — Calm Breakout Scalper

Paper-trading bot for the `agent-fun/replay/v2` pump.fun replay (make.fun
bounty `u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532`). Ranked by
hourly Sharpe ratio over a 6-hour forward window, so it optimises for many
small, steady, low-variance wins — not one moonshot.

## Strategy

1. **Entry — one calm, fast, broad breakout per coin.** A coin qualifies
   once, when all of these hold on a batch carrying its events:
   - at least 10 trades seen, and the 10th trade arrived within 200 slots
     of creation (fast early interest);
   - buy share >= 90% over all trades seen;
   - at least 7 distinct buyer wallets;
   - real SOL reserves >= 5 SOL, so the 1%-of-real-reserve size cap allows
     the full 0.05 SOL stake.
2. **Buy with a 50 bps slippage guard.** The harness rejects a buy whose
   token output is >0.5% worse than decision-time reserves would give. A
   coin that keeps spiking in the 2 slots after the decision is simply not
   bought — the bot never buys the top. A slippage-rejected coin is never
   retried. (A seeded transaction failure, which is not a price signal, gets
   one retry.)
3. **Fixed 0.05 SOL stake, max 5 open positions.** Equal sizes keep hourly
   returns smooth and the per-trade tx-fee drag small.
4. **Mechanical exits.** Sell everything at +25% take-profit, −2% stop-loss
   from the fill price, or after 1,000 slots held — whichever comes first.
   Sells use wide slippage (10,000 bps) so losing positions always get out.

## Why this shape

Measured on the dev dataset (1,222 coins, 24 block-hours): most new coins
bleed and a breaking price gaps down ~13% inside the 2-slot order latency,
so a price stop-loss alone cannot protect a position; exits must be decided
early and fills protected instead of chased. The entry filter above is the
only combination found whose trades clear fees after the slippage guard.

## Run

The grader runs `node /bot/main.ts` (Node 22). The bot speaks the replay
protocol on stdin/stdout through the vendored SDK shim
(`vendor/makefun-bot.ts`, a byte-identical copy of the kit's
`sdk/ts/makefun-bot.ts`). It reads no clock, environment or randomness, so
its two grading executions agree byte for byte. It writes nothing to the
repository directory.

## Files

- `main.ts` — the whole strategy.
- `vendor/makefun-bot.ts` — the kit's bot SDK shim, unmodified.
- `LICENSE` — MIT.
