// High-Tide Scalper — a pump.fun replay bot (agent-fun/replay/v2).
//
// Idea: do NOT chase fresh launches and do NOT ride anything to
// completion. Most new coins spike, then hand most of the move back while
// the crowd that chased the top sells out. This bot waits for a coin that
// already proved itself — it ran up hard from its create price — and buys
// only the moment it prints a fresh high while buy flow is still
// accelerating into it. Then it scalps the next leg and gets out: bank a
// small, fast gain or cut a small, fast loss. Nothing is held hoping for
// a bonding-curve completion.
//
// Entry (decided once per coin, age 30..10,000 slots):
//   - the coin ran up at least +70% from its create price to its peak;
//   - the price is printing a new high right now (at or above the peak);
//   - buy flow is accelerating: over the last 120 slots, net bought SOL
//     is >= 0 from at least 1 distinct recent buyer, and the newer half
//     of the window bought at least as much net as the older half;
//   - the creator has never sold; the curve holds 0.3..30 SOL of real SOL.
// Exit (checked every batch while holding):
//   - take-profit at +4% over cost (v2; swept, see STRATEGY.md);
//   - hard stop at -10% under cost;
//   - the creator sells while we hold;
//   - no trade for 600 slots (the move never came);
//   - 2,000-slot hold cap;
//   - (v3, off by default) a trailing stop: once the position is up
//     trailArmBps over cost, exit on a trailBps pullback from its peak
//     value. TESTED AND REJECTED in this session: TP +8% with arm +2% /
//     trail -3% measured -0.023 SOL mean vs -0.013 for the fixed +4% TP,
//     so the trailing stop stays off (trailArmBps 0) and the code is kept
//     only as a documented dead end. See STRATEGY.md.
// One 0.01 SOL buy per coin (the guardrail minimum round trip), at most
// 5 open positions (harness cap), every order within 1% of real reserve.
//
// Deterministic by construction: no clock, no randomness, no I/O — only
// insertion-ordered maps fed by the batch stream, so the grader's two
// executions produce byte-identical action logs.

import { BPS, type Batch, type Bot, type BotState, type OrderInput, type Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAgeSlots: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAgeSlots: number;
  /** Lamports to aim for per coin (each order is still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the transaction fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSolLamports: number;
  maxRealSolLamports: number;
  /** Peak price must be at least this far above the create price (bps). */
  minPeakRunupBps: number;
  /** Price must exceed the peak by at least this much (bps). 0 = a print at the high is enough. */
  breakoutBps: number;
  /** Recent-flow window (slots) and what it must show. */
  flowWindowSlots: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  /** Newer-half net flow must be at least this share (bps) of the older half's. */
  accelMinBps: number;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  takeProfitBps: number;
  /** Exit when the position is worth this much under its cost (bps). */
  stopLossBps: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the creator sells while held. */
  exitOnCreatorSell: boolean;
  /** Creator sold before entry: skip the coin. */
  skipCreatorSold: boolean;
  /** Trailing stop: once the position's value reaches cost * (1 + trailArmBps),
   *  exit if it falls trailBps below its own peak value. 0 = off. */
  trailArmBps: number;
  trailBps: number;
}

/** Shipped settings — picked by sweeping the kit's dev window (see
 *  STRATEGY.md). v1 shipped TP +3% and measured -0.0136 SOL mean over
 *  5 failed-tx draws in this session's own code. v2 raises TP to +4%:
 *  the sweep's flat best region (TP +3%/+4% both ≈ -0.014 SOL mean over
 *  4 draws at +70% run-up, 0.01 SOL stake); +4% banks slightly more per
 *  winner at the same 49-51 coin count, and the region is flat, so the
 *  choice is not a spike fit.
 *  Lab (full dev window, mean over failed-tx draws): about -0.014 SOL,
 *  49-51 coins, ~58% win rate, max drawdown ~0.4%. Honest note: no cell
 *  swept on this window is net positive; this is the least-bad flat
 *  region of the grid, and the final window is fresh chain data. */
export const DEFAULT_PARAMS: Params = {
  minAgeSlots: 30,
  maxAgeSlots: 10000,
  stakeLamports: 10_000_000,
  minBuyLamports: 5_000_000,
  minRealSolLamports: 300_000_000,
  maxRealSolLamports: 30_000_000_000,
  minPeakRunupBps: 7000,
  breakoutBps: 0,
  flowWindowSlots: 120,
  minFlowLamports: 0,
  minRecentBuyers: 1,
  accelMinBps: 10000,
  buySlippageBps: 10_000,
  takeProfitBps: 400,
  stopLossBps: 1000,
  maxHoldSlots: 2000,
  staleSlots: 600,
  exitOnCreatorSell: true,
  skipCreatorSold: true,
  trailArmBps: 0,
  trailBps: 0,
};

/** Curve fee on a sale: protocol 95 bps + creator 30 bps. */
const CURVE_FEE_BPS = 125n;

/** One trade's contribution to the recent-flow window. */
interface FlowTick {
  slot: number;
  netSol: bigint;
  buyer: Pubkey | null;
}

/** Everything remembered about one coin. */
interface Tape {
  mint: Pubkey;
  bornSlot: number;
  creator: Pubkey;
  /** Price (vq/vt) at creation, as a float ratio. */
  openPrice: number;
  /** Highest price seen since creation. */
  highPrice: number;
  /** Creator sold at any point. */
  creatorDumped: boolean;
  lastTradeSlot: number;
  flow: FlowTick[];
  /** Never consider this coin again (decided, exited, or completed). */
  closed: boolean;
}

/** A position we hold. */
interface Position {
  openedSlot: number;
  exiting: boolean;
  /** Best liquidation value seen since entry (for the trailing stop). */
  peakValue: bigint;
}

/** Price from virtual reserves, as a float ratio (enough precision for bps thresholds). */
function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

/** What selling `tokens` against reserves (vq, vt) pays after the curve fee. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const quote = (tokens * vq) / (vt + tokens);
  return quote - (quote * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Bot {
  const P = params;
  const tapes = new Map<Pubkey, Tape>();
  const open = new Map<Pubkey, Position>();
  const exiting = new Set<Pubkey>();

  /** Fold one batch of chain events into the per-coin tapes. */
  function observe(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!tapes.has(e.mint)) {
          const openPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          tapes.set(e.mint, {
            mint: e.mint,
            bornSlot: e.slot,
            creator: e.creator,
            openPrice,
            highPrice: openPrice,
            creatorDumped: false,
            lastTradeSlot: e.slot,
            flow: [],
            closed: false,
          });
        }
        continue;
      }
      if (e.event !== 'TradeEvent') continue;
      const tape = tapes.get(e.mint);
      if (tape === undefined) continue;
      const sol = BigInt(e.sol_amount);
      const isCreator = e.user === tape.creator;
      tape.lastTradeSlot = e.slot;
      const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      if (price > tape.highPrice) tape.highPrice = price;
      if (e.is_buy) {
        tape.flow.push({ slot: e.slot, netSol: sol, buyer: isCreator ? null : e.user });
      } else {
        if (isCreator) tape.creatorDumped = true;
        tape.flow.push({ slot: e.slot, netSol: -sol, buyer: null });
      }
      // Prune flow ticks older than the window (plus a small margin).
      while (tape.flow.length > 0 && tape.flow[0]!.slot < e.slot - P.flowWindowSlots - 50) tape.flow.shift();
    }
  }

  /** Net bought SOL and distinct recent buyers inside the flow window,
   *  split into an older and a newer half for the acceleration check. */
  function flowNow(tape: Tape, now: number): { net: bigint; buyers: number; olderNet: bigint; newerNet: bigint } {
    let net = 0n;
    let olderNet = 0n;
    let newerNet = 0n;
    const buyers = new Set<Pubkey>();
    const mid = now - P.flowWindowSlots / 2;
    for (const tick of tape.flow) {
      if (tick.slot < now - P.flowWindowSlots) continue;
      net += tick.netSol;
      if (tick.slot < mid) olderNet += tick.netSol;
      else newerNet += tick.netSol;
      if (tick.buyer !== null) buyers.add(tick.buyer);
    }
    return { net, buyers: buyers.size, olderNet, newerNet };
  }

  /** Does this coin show a buyable high-tide setup at slot `now`? */
  function setupReady(
    tape: Tape,
    now: number,
    curve: { real_quote_reserves: string; virtual_quote_reserves: string; virtual_token_reserves: string } | undefined,
  ): boolean {
    if (tape.closed || curve === undefined) return false;
    const age = now - tape.bornSlot;
    if (age < P.minAgeSlots || age > P.maxAgeSlots) return false;
    if (P.skipCreatorSold && tape.creatorDumped) return false;
    const realSol = BigInt(curve.real_quote_reserves);
    if (realSol < BigInt(P.minRealSolLamports) || realSol > BigInt(P.maxRealSolLamports)) return false;
    if (tape.openPrice <= 0 || tape.highPrice <= 0) return false;
    // It must have run up first: peak vs create price, in bps.
    const runupBps = Math.floor((tape.highPrice / tape.openPrice - 1) * 10_000);
    if (runupBps < P.minPeakRunupBps) return false;
    const price = priceOf(BigInt(curve.virtual_quote_reserves), BigInt(curve.virtual_token_reserves));
    if (price <= 0) return false;
    // New high: price at or above the peak by at least breakoutBps.
    const aboveHighBps = Math.floor((price / tape.highPrice - 1) * 10_000);
    if (aboveHighBps < P.breakoutBps) return false;
    // Buying must be coming back / accelerating: net flow and fresh buyers.
    const flow = flowNow(tape, now);
    if (flow.net < BigInt(P.minFlowLamports)) return false;
    if (flow.buyers < P.minRecentBuyers) return false;
    if (P.accelMinBps > 0) {
      // Newer half must have bought at least accelMinBps of the older half's net.
      if (flow.olderNet <= 0n) return false;
      if (flow.newerNet * 10_000n < flow.olderNet * BigInt(P.accelMinBps)) return false;
    }
    return true;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      observe(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txFee = state.txFeeLamports();
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));

      // 1. Clean up holds whose position is gone, and clear finished sells.
      for (const [mint, pos] of open) {
        const held = state.positions.get(mint);
        if (held === undefined) {
          let inFlight = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint) inFlight = true;
          }
          if (!inFlight) {
            open.delete(mint);
            exiting.delete(mint);
            const tape = tapes.get(mint);
            if (tape !== undefined) tape.closed = true;
          }
        }
      }

      // 2. Exits first: take-profit, stop-loss, creator sell, stale, hold cap.
      for (const [mint, pos] of open) {
        if (orders.length >= cap) break;
        if (pos.exiting || exiting.has(mint)) continue;
        const held = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (held === undefined || curve === undefined || curve.complete) continue;
        const mark = marks.get(mint);
        const vq = mark !== undefined ? BigInt(mark.virtual_quote_reserves) : BigInt(curve.virtual_quote_reserves);
        const vt = mark !== undefined ? BigInt(mark.virtual_token_reserves) : BigInt(curve.virtual_token_reserves);
        const tokens = BigInt(held.token_amount);
        const cost = BigInt(held.cost_lamports);
        let value = sellValue(tokens, vq, vt);
        value = value > txFee ? value - txFee : 0n;
        const tape = tapes.get(mint);
        const creatorDumped = tape !== undefined && tape.creatorDumped;
        if (value > pos.peakValue) pos.peakValue = value;
        let exit = false;
        if (value >= (cost * BigInt(10_000 + P.takeProfitBps)) / 10_000n) exit = true;
        if (!exit && value <= (cost * BigInt(10_000 - P.stopLossBps)) / 10_000n) exit = true;
        // Trailing stop: armed once the position is up trailArmBps over
        // cost, it exits on a trailBps pullback from the peak value, so a
        // winner that runs past the take-profit is not handed all back.
        if (
          !exit && P.trailArmBps > 0 && P.trailBps > 0 &&
          pos.peakValue >= (cost * BigInt(10_000 + P.trailArmBps)) / 10_000n &&
          value <= (pos.peakValue * BigInt(10_000 - P.trailBps)) / 10_000n
        ) exit = true;
        if (!exit && P.exitOnCreatorSell && creatorDumped) exit = true;
        if (!exit && tape !== undefined && batch.slot - tape.lastTradeSlot > P.staleSlots) exit = true;
        if (!exit && batch.slot - pos.openedSlot > P.maxHoldSlots) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: 10_000 });
        pos.exiting = true;
        exiting.add(mint);
      }

      // 3. Entries: one high-tide buy per qualifying coin.
      let free = state.freeCashLamports();
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const [mint, tape] of tapes) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        if (open.has(mint)) continue;
        let inFlight = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint) inFlight = true;
        }
        if (inFlight) continue;
        const curve = state.curves.get(mint);
        if (!setupReady(tape, batch.slot, curve)) continue;
        const capLamports = state.maxBuyLamports(mint);
        let amount = BigInt(P.stakeLamports);
        if (amount > capLamports) amount = capLamports;
        if (amount < BigInt(P.minBuyLamports)) continue;
        // Keep enough cash to pay for this buy and its eventual sell.
        if (free < amount + txFee * 2n) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + txFee;
        slotsLeft -= 1;
        open.set(mint, { openedSlot: batch.slot, exiting: false, peakValue: 0n });
        tape.closed = true;
      }
      return orders;
    },
  };
}
