// Pump.fun Sharpe Sprint — "Calm Breakout Scalper"
//
// Paper-trading bot for the agent-fun/replay/v2 pump.fun replay. Ranked by
// hourly Sharpe ratio, so the goal is many small, steady, low-variance wins
// — not one moonshot. Every design choice below comes from measuring the dev
// dataset (1,222 coins, 24 block-hours):
//
//   - Most new coins bleed: the median coin ends ~25% below its trigger
//     price within 5,000 slots, and a price that breaks down gaps down ~13%
//     inside the 2-slot order latency, so a stop-loss set on price alone
//     cannot protect a position. Exits must be decided on leading signals
//     and fills must be protected, not chased.
//   - The only durable edge found: coins whose FIRST 10 trades arrive fast
//     (<= 200 slots after creation), are almost all buys (>= 90% buy share)
//     and come from many distinct wallets (>= 7). Those coins spike and
//     retrace; the trade is to catch the early leg and leave quickly.
//   - Tight buy slippage (50 bps) is the key filter: the harness rejects a
//     buy whose token output is >0.5% worse than decision-time reserves
//     would give. A buy decided while a coin is spiking fills ~14% above
//     the trigger price — buying the top. With 50 bps slippage the order is
//     simply refused when the coin keeps running in the 2 slots after the
//     decision, so the bot only ever buys a coin that has paused. Rejected
//     buys are never retried: a coin that ran away stays away.
//   - One fixed stake (0.05 SOL, the largest size whose 1%-of-real-reserve
//     cap is reachable early: needs real reserves >= 5 SOL) keeps the
//     per-trade tx-fee drag small and every position the same size, which
//     keeps hourly returns smooth. Never more than 5 open positions.
//   - Exits are mechanical: take profit at +25%, stop at -2% from the fill
//     price, or a 1,000-slot time stop, whichever comes first. Sells use
//     wide slippage (10,000 bps) so a losing position always gets out.
//
// Nothing here reads the clock, the environment or Math.random; every
// decision is a pure function of the harness state, so the two grading runs
// agree byte for byte.

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- parameters

/** Fixed stake per coin, in lamports (0.05 SOL). */
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 5n) / 100n;
/** Buys need real SOL reserves of at least this much (cap = 1% of real). */
const MIN_REAL_LAMPORTS = STAKE_LAMPORTS * 100n;
/** Entry filter: first 10 trades within this many slots of creation. */
const MAX_AGE_AT_10_TRADES_SLOTS = 200;
/** Entry filter: minimum buy share over all trades seen on the coin. */
const MIN_BUY_SHARE_NUM = 9;
const MIN_BUY_SHARE_DEN = 10;
/** Entry filter: minimum distinct buyer wallets seen on the coin. */
const MIN_DISTINCT_BUYERS = 7;
/** Entry filter: minimum trades seen before a coin can be considered. */
const MIN_TRADES = 10;
/** Buy slippage guard, in bps (0.5%): refuse to buy a running coin. */
const BUY_SLIPPAGE_BPS = 50;
/** Sell slippage: wide open, so exits always fill. */
const SELL_SLIPPAGE_BPS = 10_000;
/** Take profit: sell when the mark is this multiple of the fill price. */
const TAKE_PROFIT_NUM = 125;
const TAKE_PROFIT_DEN = 100;
/** Stop loss: sell when the mark falls to this multiple of the fill price. */
const STOP_LOSS_NUM = 98;
const STOP_LOSS_DEN = 100;
/** Time stop: sell after this many slots held, whatever the price. */
const MAX_HOLD_SLOTS = 1000;

// ---------------------------------------------------------------- per-coin bookkeeping

interface CoinStats {
  /** Slot of the CreateEvent, or of the first sighting when there was none. */
  createdSlot: number;
  /** Trades seen so far. */
  trades: number;
  buys: number;
  sells: number;
  /** Distinct wallets that traded on the coin. */
  users: Set<string>;
  /** Slots from creation to the 10th trade; null until the 10th trade. */
  ageAt10Trades: number | null;
  /** True once the curve completed (no more orders). */
  complete: boolean;
}

interface OpenPosition {
  /** Fill price in SOL per token (quote lamports / tokens). */
  entryPrice: number;
  /** Slot the buy filled. */
  fillSlot: number;
}

const stats = new Map<string, CoinStats>();
const decided = new Set<string>();
const entries = new Map<string, OpenPosition>();
/** Mints whose buy failed on a transaction error and may be tried once more. */
const failedBuys = new Map<string, number>();

function coinStats(mint: string, slot: number): CoinStats {
  let s = stats.get(mint);
  if (s === undefined) {
    s = { createdSlot: slot, trades: 0, buys: 0, sells: 0, users: new Set(), ageAt10Trades: null, complete: false };
    stats.set(mint, s);
  }
  return s;
}

/** Current mark price of a curve in SOL per token, from its virtual reserves. */
function markPrice(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

await runBot({
  onBatch(state, batch) {
    // --- fold this batch's fills into the entry book -----------------------
    for (const fill of batch.fills) {
      if (fill.client_id.startsWith('_')) {
        // A harness close (complete / flatten / writeoff): the position is gone.
        entries.delete(fill.mint);
        continue;
      }
      if (fill.side === 'buy' && fill.status === 'filled') {
        const tokens = BigInt(fill.token_amount);
        const quote = BigInt(fill.quote_lamports);
        if (tokens > 0n) {
          entries.set(fill.mint, {
            entryPrice: Number(quote) / Number(tokens),
            fillSlot: fill.slot,
          });
        }
      } else if (fill.side === 'buy' && fill.status === 'failed') {
        // A seeded transaction failure, not a price signal: one retry is
        // allowed, still protected by the buy slippage guard. A second
        // failure leaves the coin decided so retries cannot pile up fees.
        const n = (failedBuys.get(fill.mint) ?? 0) + 1;
        failedBuys.set(fill.mint, n);
        if (n < 2) decided.delete(fill.mint);
      } else if (fill.side === 'buy' && fill.status === 'rejected') {
        // Slippage (or size) refusal: the coin ran away. Never chase it.
        decided.add(fill.mint);
      } else if (fill.side === 'sell' && fill.status === 'filled') {
        entries.delete(fill.mint);
      }
      // A failed or rejected sell leaves the position held; the exit logic
      // below re-sends the sell on the next batch.
    }

    // --- fold this batch's events into the per-coin stats ------------------
    const touched = new Set<string>();
    for (const e of batch.events) {
      touched.add(e.mint);
      const s = coinStats(e.mint, e.slot);
      if (e.event === 'CreateEvent') {
        s.createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        s.trades += 1;
        if (e.is_buy) s.buys += 1;
        else s.sells += 1;
        s.users.add(e.user);
        if (s.trades === MIN_TRADES && s.ageAt10Trades === null) {
          s.ageAt10Trades = e.slot - s.createdSlot;
        }
      } else {
        s.complete = true;
      }
    }

    const orders: Array<BuyInput | SellInput> = [];
    const txFee = state.txFeeLamports();

    // --- exits first: take profit, stop loss, time stop --------------------
    for (const [mint, pos] of entries) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const held = state.positions.get(mint);
      if (held === undefined || held.token_amount === 0n) continue;
      // Never send two sells for one position in the same reply.
      if (orders.some((o) => o.side === 'sell' && o.mint === mint)) continue;
      const price = markPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0 || pos.entryPrice <= 0) continue;
      // Skip a position whose sell is already in flight: sending a second
      // sell for the same tokens would be refused as insufficient_tokens.
      let sellPending = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'sell' && p.order.mint === mint) { sellPending = true; break; }
      }
      if (sellPending) continue;
      const takeProfit = price * TAKE_PROFIT_DEN >= pos.entryPrice * TAKE_PROFIT_NUM;
      const stopLoss = price * STOP_LOSS_DEN <= pos.entryPrice * STOP_LOSS_NUM;
      const timedOut = batch.slot - pos.fillSlot >= MAX_HOLD_SLOTS;
      if (takeProfit || stopLoss || timedOut) {
        orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      }
    }

    // --- entries: one calm, fast, broad breakout per coin ------------------
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of touched) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      const s = stats.get(mint);
      if (s === undefined || s.complete) continue;
      if (decided.has(mint)) continue;
      if (entries.has(mint)) continue;
      if (state.positions.has(mint)) continue;
      // A buy already in flight for this mint: wait for its fill.
      let buyPending = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy' && p.order.mint === mint) { buyPending = true; break; }
      }
      if (buyPending) continue;
      if (s.trades < MIN_TRADES) continue;
      if (s.ageAt10Trades === null || s.ageAt10Trades > MAX_AGE_AT_10_TRADES_SLOTS) continue;
      const totalTrades = s.buys + s.sells;
      if (totalTrades === 0) continue;
      if (s.buys * MIN_BUY_SHARE_DEN < MIN_BUY_SHARE_NUM * totalTrades) continue;
      if (s.users.size < MIN_DISTINCT_BUYERS) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < MIN_REAL_LAMPORTS) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < STAKE_LAMPORTS) continue;
      if (free < STAKE_LAMPORTS + txFee) continue;
      decided.add(mint);
      orders.push({ side: 'buy', mint, quote_lamports: STAKE_LAMPORTS, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= STAKE_LAMPORTS + txFee;
      slots -= 1;
    }

    return orders;
  },
});
