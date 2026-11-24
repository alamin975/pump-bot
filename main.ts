// Breakout bot for agent-fun/replay/v2 (pump.fun bonding curves).
//
// Idea: a curve that has consolidated in a tight range while real SOL kept
// growing (quiet accumulation), then breaks above the range high on a burst
// of buy volume, tends to run further than a curve that merely spiked.
// This is NOT a momentum-pyramid bot and NOT a launch sniper and NOT a
// dip-buyer: entries need a 400-slot consolidation range first, a breakout
// above that range, and a volume burst with breadth. No adds: a
// confirmation add bought the top too often. Exits are a take-profit, a
// stop, a trailing stop, a failed-breakout exit, a flow-fade exit, a
// creator-sell exit, and a time limit. A position
// that doubles is ridden: the time limit and fade exit stop applying and
// only the trailing stop (or completion / flatten) takes it out.
//
// The hello message sets the capital, caps and fees; every batch carries
// the slot's events and the orders decided on that slot fill two slots
// later. Deterministic by construction: no clock, no randomness, iteration
// only over insertion-ordered maps fed by the batch stream.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const FEE_BPS = 125n; // curve fees: protocol 95 bps + creator 30 bps.

// --- tuned parameters (chosen on the dev window, flat region preferred) ---
const RANGE_WIN = 400; // slots of consolidation range
const RANGE_MAX_W = 0.15; // range (high-low)/mid must be at most 15%
const RANGE_MIN_TRADES = 10; // trades inside the range window
const RANGE_MIN_RQ_GROWTH = 0.05; // real SOL must grow >= 5% over the range
const BURST_WIN = 30; // slots of the volume-burst window
const BURST_MIN_BUY_SOL = 0.25; // buy SOL inside the burst window
const BURST_MIN_BUYERS = 3; // distinct buyers inside the burst window
const BURST_ACCEL = 1.5; // burst buy SOL vs the 30 slots before it
const BREADTH_WIN = 100; // slots for the anti-whale breadth check
const MAX_BUYER_SHARE = 0.5; // largest single buyer share of buy SOL
const MIN_AGE = 60; // slots since CreateEvent before an entry is allowed
const MIN_RQ_SOL = 1; // real SOL bounds at entry
const MAX_RQ_SOL = 200;
const FIRST_BUY_SOL = 0.1; // first tranche
const ADD_BUY_SOL = 0; // no confirmation add: adds bought the top too often
const MAX_POSITION_SOL = 0.1;
const ADD_AFTER_SLOTS = 60; // add only this long after the first buy
const ADD_MIN_UP = 0.05; // add only if price is 5% above the first buy's price
const BUY_SLIP_BPS = 1000;
const SELL_SLIP_BPS = 10_000;
const TAKE_PROFIT = 0.5; // exit at value >= cost * 1.5
const STOP_LOSS = 0.15; // exit at value <= cost * 0.85
const TRAIL_ARM = 0.2; // trailing stop arms at value >= cost * 1.2
const TRAIL = 0.25; // exit on a 25% fall from the peak value
const MAX_HOLD = 900; // slots
const COOLDOWN = 200; // slots after an exit before the same coin may be bought
const FADE_WIN = 60; // slots for the flow-fade exit
const FADE_MIN_NET_SOL = -0.2; // exit when net flow over FADE_WIN is below this
const STALE_SLOTS = 600; // exit when no trade has hit the coin for this long
const MAX_EXPOSURE_SOL = 4; // most SOL at cost across all positions at once
const MAX_ENTRIES_PER_BATCH = 2;

interface Tick {
  slot: number;
  price: number;
  buy: boolean;
  sol: number;
  user: Pubkey;
  rq: number; // real SOL reserve after this trade
}

interface Coin {
  mint: Pubkey;
  created: number | null;
  creator: Pubkey | null;
  ticks: Tick[];
  entries: number;
  lastExit: number;
  devSold: boolean;
  lastTradeSlot: number;
}

interface Held {
  openedSlot: number;
  peakValue: number; // best close value seen (SOL)
  invested: number; // SOL sent in buys for this position
  entryPrice: number;
  breakoutLevel: number; // range high the price broke above
  lastAddSlot: number;
  added: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + 9999n) / 10000n;
}

/** Net SOL (buys minus sells) over ticks with slot > `fromSlot`. */
function netFlow(ticks: Tick[], fromSlot: number): number {
  let net = 0;
  for (let i = ticks.length - 1; i >= 0; i--) {
    const t = ticks[i]!;
    if (t.slot <= fromSlot) break;
    net += t.buy ? t.sol : -t.sol;
  }
  return net;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();

function coinOf(mint: Pubkey): Coin {
  let c = coins.get(mint);
  if (c === undefined) {
    c = { mint, created: null, creator: null, ticks: [], entries: 0, lastExit: -1e12, devSold: false, lastTradeSlot: 0 };
    coins.set(mint, c);
  }
  return c;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;
    const traded = new Set<Pubkey>();

    // Fold this batch's events into the per-coin tapes.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const c = coinOf(e.mint);
        c.created = e.slot;
        c.creator = e.creator;
        c.lastTradeSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const c = coinOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        c.ticks.push({ slot: e.slot, price, buy: e.is_buy, sol, user: e.user, rq: Number(e.real_quote_reserves) / LAMPORTS });
        c.lastTradeSlot = e.slot;
        if (!e.is_buy && c.creator !== null && e.user === c.creator) c.devSold = true;
        traded.add(e.mint);
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) c.lastExit = now;
      }
    }
    // Prune tapes to the range window plus a little slack.
    for (const mint of traded) {
      const c = coins.get(mint)!;
      let cut = 0;
      while (cut < c.ticks.length && c.ticks[cut]!.slot <= now - (RANGE_WIN + 50)) cut++;
      if (cut > 0) c.ticks.splice(0, cut);
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

    // --- exits first ---
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          coinOf(mint).lastExit = now;
        }
        continue;
      }
      if (curve === undefined || curve.complete) continue;
      const mk = marks.get(mint);
      const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
      const value = Number(sellValue(pos.token_amount, vq, vt)) / LAMPORTS - tx;
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peakValue) h.peakValue = value;
      const price = Number(vq) / Number(vt);
      const riding = value >= cost * 2;
      const c = coinOf(mint);
      let exit = false;
      if (value >= cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && value <= cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + TRAIL_ARM) && value <= h.peakValue * (1 - TRAIL)) exit = true;
      if (!exit && !riding && price < h.breakoutLevel) exit = true; // failed breakout
      if (!exit && !riding && c.devSold) exit = true; // creator sold
      if (!exit && !riding && now - h.openedSlot > MAX_HOLD) exit = true;
      if (!exit && !riding && now - c.lastTradeSlot >= STALE_SLOTS) exit = true;
      if (!exit && !riding && netFlow(c.ticks, now - FADE_WIN) < FADE_MIN_NET_SOL) exit = true;
      if (!exit) continue;
      if (pendingByMint.has(mint)) {
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
      }
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
    }

    // --- entries and the single confirmation add ---
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let exposure = 0;
    for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
    let entriesThisBatch = 0;

    for (const mint of traded) {
      if (orders.length >= cap || entriesThisBatch >= MAX_ENTRIES_PER_BATCH) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint)) continue;
      const c = coins.get(mint)!;
      const h = held.get(mint);
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;

      if (h !== undefined) {
        // Single confirmation add: price held 5% above the first buy, 60+ slots on.
        if (h.added || !state.positions.has(mint)) continue;
        if (now - h.openedSlot < ADD_AFTER_SLOTS) continue;
        if (price < h.entryPrice * (1 + ADD_MIN_UP)) continue;
        if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) continue;
        if (netFlow(c.ticks, now - BURST_WIN) <= 0) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, ADD_BUY_SOL, MAX_POSITION_SOL - h.invested, MAX_EXPOSURE_SOL - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < 0.01) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
        free -= amount + tx;
        exposure += amount;
        h.invested += amount;
        h.added = true;
        h.lastAddSlot = now;
        continue;
      }

      // First buy: consolidation range, then a breakout on a volume burst.
      if (slotsLeft <= 0 || c.entries >= 2 || now - c.lastExit < COOLDOWN) continue;
      if (c.created === null || now - c.created < MIN_AGE) continue;
      if (c.devSold) continue;
      if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) continue;
      const from = now - RANGE_WIN;
      const burstFrom = now - BURST_WIN;
      let rangeHigh = 0;
      let rangeLow = Number.POSITIVE_INFINITY;
      let rangeTrades = 0;
      let rqFirst = -1; // real SOL at the first trade inside the range window
      let burstBuy = 0;
      let prevBuy = 0;
      const burstBuyers = new Set<Pubkey>();
      const buyByUser = new Map<Pubkey, number>();
      let buyTotal = 0;
      for (const t of c.ticks) {
        if (t.slot <= from) continue;
        if (t.slot <= burstFrom) {
          // Range part: everything older than the burst window.
          if (t.price > rangeHigh) rangeHigh = t.price;
          if (t.price < rangeLow) rangeLow = t.price;
          rangeTrades++;
          if (rqFirst < 0) rqFirst = t.rq;
        } else {
          if (t.buy) {
            burstBuy += t.sol;
            burstBuyers.add(t.user);
          }
        }
        if (t.slot > now - 2 * BURST_WIN && t.slot <= burstFrom && t.buy) prevBuy += t.sol;
        if (t.slot > now - BREADTH_WIN && t.buy) {
          buyTotal += t.sol;
          buyByUser.set(t.user, (buyByUser.get(t.user) ?? 0) + t.sol);
        }
      }
      if (rangeTrades < RANGE_MIN_TRADES || rangeHigh <= 0 || rangeLow === Number.POSITIVE_INFINITY) continue;
      const mid = (rangeHigh + rangeLow) / 2;
      if ((rangeHigh - rangeLow) / mid > RANGE_MAX_W) continue; // never consolidated
      if (price < rangeHigh * 1.01) continue; // no breakout above the range
      // The burst must also be a price rise, not just volume: price now at
      // least 3% above the last trade 30+ slots ago.
      let oldPrice = -1;
      for (let i = c.ticks.length - 1; i >= 0; i--) {
        const t = c.ticks[i]!;
        if (t.slot <= burstFrom) {
          oldPrice = t.price;
          break;
        }
      }
      if (oldPrice <= 0 || price < oldPrice * 1.03) continue;
      if (burstBuy < BURST_MIN_BUY_SOL) continue;
      if (burstBuyers.size < BURST_MIN_BUYERS) continue;
      if (prevBuy > 0 && burstBuy < BURST_ACCEL * prevBuy) continue; // no acceleration
      if (rqFirst > 0 && rqSol < rqFirst * (1 + RANGE_MIN_RQ_GROWTH)) continue; // no accumulation
      let top = 0;
      for (const v of buyByUser.values()) if (v > top) top = v;
      if (buyTotal > 0 && top > MAX_BUYER_SHARE * buyTotal) continue; // one whale dominates
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
      let amount = Math.min(capSol, FIRST_BUY_SOL, MAX_EXPOSURE_SOL - exposure);
      if (amount > free - tx) amount = free - tx;
      if (amount < 0.01) continue;
      orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + tx;
      exposure += amount;
      held.set(mint, { openedSlot: now, peakValue: 0, invested: amount, entryPrice: price, breakoutLevel: rangeHigh, lastAddSlot: 0, added: false });
      c.entries++;
      slotsLeft--;
      entriesThisBatch++;
    }
    return orders;
  },
});
