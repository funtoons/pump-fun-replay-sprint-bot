// Pump.fun Replay Sprint — momentum snipe paper bot.
//
// Strategy (designed from the dev window, no hard-coded answers):
//  * Watch every new bonding-curve coin from its CreateEvent.
//  * Snipe only coins whose very first trades show real buy pressure:
//    cumulative buys >= 0.10 SOL, buys >= 60% of early volume, and the
//    price still within 2x of the create price (avoid chasing a top).
//  * Build a position of up to 0.08 SOL per coin in small orders, each
//    capped at 90 bps of the coin's real SOL reserve (harness cap is
//    100 bps), so a round trip always clears the 0.01 SOL bar.
//  * Exit: sell half at +60%, sell the rest at +150%, stop-loss at -25%,
//    trailing exit 30% below the peak, and a hard time exit after
//    1200 slots. At most 5 open positions, never more than 16 orders
//    per batch. Fully deterministic: no clock, no randomness, no I/O
//    besides stdin/stdout, stdlib only.
//
// Protocol: agent-fun/replay/v2. Harness sends JSONL on stdin
// (hello, batch, done); the bot answers every batch with one line:
// {"type":"reply","seq":<seq>,"orders":[...]}.
//   buy  -> {"side":"buy","client_id":...,"mint":...,
//             "quote_lamports":"<u64>","max_slippage_bps":1000}
//   sell -> {"side":"sell","client_id":...,"mint":...,
//             "token_amount":"<u64>","max_slippage_bps":1000}
// All money values are u64 decimal strings; prices are computed as
// virtual quote reserves / virtual token reserves (lamports per token).

import * as readline from "node:readline";

// ---- Tuned constants (from offline sweeps on the dev window) ----
const TARGET_LAMPORTS = 80_000_000; // 0.08 SOL target per coin
const MIN_EARLY_BUYS = 100_000_000; // 0.10 SOL of buys before entry
const MIN_BUY_SHARE = 0.6; // buys must be >= 60% of early volume
const MIN_REAL_SOL = 300_000_000; // 0.30 SOL real reserve to enter
const MAX_ENTRY_MULT = 2.0; // never chase beyond 2x the create price
const ENTRY_WINDOW = 300; // slots after create during which we may enter
const BUILD_WINDOW = 600; // slots after create during which we top up
const MIN_FIRST_BUY = 5_000_000; // 0.005 SOL smallest first order
const MIN_TOPUP = 2_000_000; // 0.002 SOL smallest top-up order
const ORDER_BPS_OF_RESERVE = 90; // 90 bps < harness cap of 100 bps
const MAX_POSITIONS = 5;
const MAX_ORDERS_PER_BATCH = 16;
const TP1 = 0.6; // sell half at +60%
const TP2 = 1.5; // sell all at +150%
const STOP_LOSS = 0.25; // sell all at -25%
const TRAIL_DROP = 0.3; // sell all 30% below the position peak
const MAX_HOLD_SLOTS = 1200; // hard time exit
const COOLDOWN_SLOTS = 2000; // do not re-enter a coin right after exit
const PRUNE_AGE_SLOTS = 3000; // drop state for old, unheld coins
const SLIPPAGE_BPS = 1000;

type CoinState = {
  mint: string;
  createSlot: number;
  p0: number; // price (lamports per token) at create
  buys: number; // cumulative buy volume, lamports
  sells: number; // cumulative sell volume, lamports
  ntrades: number;
  lastPrice: number;
  realSol: number;
  maxPrice: number;
  completed: boolean;
};

type Position = {
  mint: string;
  entryPrice: number; // volume-weighted effective entry price, lamports/token
  peakPrice: number;
  entrySlot: number;
  buyLamports: number; // cumulative quote spent on this position
  tokensBought: number; // cumulative tokens received (for entry price)
  soldHalf: boolean;
};

const coins = new Map<string, CoinState>();
const positions = new Map<string, Position>();
const cooldownUntil = new Map<string, number>();
const pendingSell = new Set<string>(); // mints with a sell order awaiting fill
const pendingBuy = new Map<string, number>(); // mint -> quote lamports in flight

let cashLamports = 10_000_000_000;
let maxPositions = MAX_POSITIONS;
let maxOrdersPerBatch = MAX_ORDERS_PER_BATCH;
let orderSeq = 0;
let batchCount = 0;

function priceOf(virtualQuote: string, virtualToken: string): number {
  const q = Number(virtualQuote);
  const t = Number(virtualToken);
  if (t <= 0) return 0;
  return q / t;
}

function getOrInitCoin(mint: string, slot: number, price: number): CoinState {
  let c = coins.get(mint);
  if (!c) {
    c = {
      mint,
      createSlot: slot,
      p0: price,
      buys: 0,
      sells: 0,
      ntrades: 0,
      lastPrice: price,
      realSol: 0,
      maxPrice: price,
      completed: false,
    };
    coins.set(mint, c);
  }
  return c;
}

function handleBatch(msg: any): any[] {
  const slot: number = msg.slot;
  const orders: any[] = [];
  batchCount++;

  // ---- 1. Reconcile account (authoritative holdings + cash) ----
  const held = new Map<string, string>(); // mint -> token_amount string
  if (msg.account) {
    cashLamports = Number(msg.account.cash_lamports ?? cashLamports);
    for (const p of msg.account.positions ?? []) {
      held.set(p.mint, p.token_amount);
    }
  }
  // Drop local position records for coins the account no longer holds
  // (unless a sell is still pending for them).
  for (const mint of [...positions.keys()]) {
    if (!held.has(mint) && !pendingSell.has(mint)) {
      positions.delete(mint);
    }
  }

  // ---- 2. Apply fills: clear pending flags, update buy totals ----
  for (const f of msg.fills ?? []) {
    if (f.status !== "filled") {
      if (f.side === "sell") pendingSell.delete(f.mint);
      if (f.side === "buy") {
        pendingBuy.delete(f.mint);
        // A rejected first buy leaves a phantom position: drop it so
        // the coin can be entered again (or skipped) cleanly.
        if (!held.has(f.mint)) positions.delete(f.mint);
      }
      continue;
    }
    if (f.side === "sell") {
      pendingSell.delete(f.mint);
      // If nothing is held any more, the position is closed.
      if (!held.has(f.mint)) {
        positions.delete(f.mint);
        cooldownUntil.set(f.mint, slot + COOLDOWN_SLOTS);
      }
    }
    if (f.side === "buy") {
      pendingBuy.delete(f.mint);
      const pos = positions.get(f.mint);
      if (pos) {
        const q = Number(f.quote_lamports ?? 0);
        const t = Number(f.token_amount ?? 0);
        pos.buyLamports += q;
        // Effective entry price from the actual fill (quote paid per
        // token received), volume-weighted across all fills.
        if (t > 0) {
          const prevTokens = pos.tokensBought;
          const prevQuote = pos.entryPrice * prevTokens;
          pos.tokensBought += t;
          pos.entryPrice = (prevQuote + q) / pos.tokensBought;
          if (pos.peakPrice < pos.entryPrice) pos.peakPrice = pos.entryPrice;
        }
      }
    }
  }

  // ---- 3. Process events ----
  const activeMints: string[] = [];
  for (const ev of msg.events ?? []) {
    const mint: string = ev.mint;
    if (ev.event === "CreateEvent") {
      const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
      const c = getOrInitCoin(mint, ev.slot, p);
      c.createSlot = ev.slot;
      c.p0 = p;
      c.lastPrice = p;
      c.maxPrice = p;
      if (!activeMints.includes(mint)) activeMints.push(mint);
    } else if (ev.event === "TradeEvent") {
      const p = priceOf(
        ev.virtual_sol_reserves,
        ev.virtual_token_reserves,
      );
      const c = getOrInitCoin(mint, ev.slot, p);
      c.ntrades++;
      c.lastPrice = p;
      c.realSol = Number(ev.real_sol_reserves ?? 0);
      if (p > c.maxPrice) c.maxPrice = p;
      const amt = Number(ev.sol_amount ?? 0);
      if (ev.is_buy) c.buys += amt;
      else c.sells += amt;
      if (!activeMints.includes(mint)) activeMints.push(mint);
    } else if (ev.event === "CompleteEvent") {
      const c = coins.get(mint);
      if (c) c.completed = true;
      if (!activeMints.includes(mint)) activeMints.push(mint);
    }
  }

  // ---- 4. Apply marks (current reserves for mints in this batch) ----
  for (const mk of msg.marks ?? []) {
    const c = coins.get(mk.mint);
    if (!c) continue;
    const p = priceOf(mk.virtual_quote_reserves, mk.virtual_token_reserves);
    if (p > 0) {
      c.lastPrice = p;
      if (p > c.maxPrice) c.maxPrice = p;
    }
    const rs = Number(mk.real_quote_reserves ?? 0);
    if (rs > 0) c.realSol = rs;
  }

  // ---- 5. Exits for held positions ----
  for (const [mint, pos] of [...positions.entries()]) {
    if (orders.length >= maxOrdersPerBatch) break;
    const tokens = held.get(mint);
    if (!tokens || tokens === "0") continue;
    if (pendingSell.has(mint)) continue;
    const c = coins.get(mint);
    const cur = c ? c.lastPrice : pos.entryPrice;
    if (cur <= 0 || pos.entryPrice <= 0) continue;
    if (cur > pos.peakPrice) pos.peakPrice = cur;
    const ret = cur / pos.entryPrice - 1;
    const age = slot - pos.entrySlot;
    let frac = 0;
    if (c?.completed) frac = 1;
    else if (ret >= TP2 || ret <= -STOP_LOSS) frac = 1;
    else if (age >= MAX_HOLD_SLOTS) frac = 1;
    else if (cur <= pos.peakPrice * (1 - TRAIL_DROP)) frac = 1;
    else if (ret >= TP1 && !pos.soldHalf) {
      frac = 0.5;
      pos.soldHalf = true;
    }
    if (frac <= 0) continue;
    const total = BigInt(tokens);
    const amount =
      frac >= 1 ? total : total / 2n > 0n ? total / 2n : total;
    if (amount <= 0n) continue;
    orderSeq++;
    orders.push({
      side: "sell",
      client_id: `s${slot}-${orderSeq}`,
      mint,
      token_amount: amount.toString(),
      max_slippage_bps: SLIPPAGE_BPS,
    });
    pendingSell.add(mint);
    if (frac >= 1) {
      positions.delete(mint);
      cooldownUntil.set(mint, slot + COOLDOWN_SLOTS);
    }
  }

  // ---- 6. Entries / top-ups for coins active in this batch ----
  const openCount = [...held.keys()].filter((m) => held.get(m) !== "0")
    .length;
  if (openCount < maxPositions) {
    for (const mint of activeMints) {
      if (orders.length >= maxOrdersPerBatch) break;
      if ([...held.keys()].filter((m) => held.get(m) !== "0").length >= maxPositions) break;
      const c = coins.get(mint);
      if (!c) continue;
      const age = slot - c.createSlot;
      const pos = positions.get(mint);
      if (pos) {
        // Top up a building position while the coin is still young.
        if (
          age <= BUILD_WINDOW &&
          pos.buyLamports < TARGET_LAMPORTS &&
          c.lastPrice > 0 &&
          c.lastPrice <= c.p0 * MAX_ENTRY_MULT &&
          !pendingBuy.has(mint)
        ) {
          const room = TARGET_LAMPORTS - pos.buyLamports;
          const cap = Math.floor((c.realSol * ORDER_BPS_OF_RESERVE) / 10000);
          const size = Math.min(room, cap);
          if (size >= MIN_TOPUP && size <= cashLamports) {
            orderSeq++;
            orders.push({
              side: "buy",
              client_id: `b${slot}-${orderSeq}`,
              mint,
              quote_lamports: String(size),
              max_slippage_bps: SLIPPAGE_BPS,
            });
            pendingBuy.set(mint, size);
          }
        }
        continue;
      }
      // Fresh entry: early buy pressure, still near the create price.
      if (age > ENTRY_WINDOW) continue;
      if (c.completed) continue;
      if ((cooldownUntil.get(mint) ?? 0) > slot) continue;
      if (c.ntrades < 1) continue;
      if (c.buys < MIN_EARLY_BUYS) continue;
      const vol = c.buys + c.sells;
      if (vol <= 0 || c.buys / vol < MIN_BUY_SHARE) continue;
      if (c.realSol < MIN_REAL_SOL) continue;
      if (c.p0 <= 0 || c.lastPrice <= 0) continue;
      if (c.lastPrice > c.p0 * MAX_ENTRY_MULT) continue;
      const cap = Math.floor((c.realSol * ORDER_BPS_OF_RESERVE) / 10000);
      const size = Math.min(TARGET_LAMPORTS, cap);
      if (size < MIN_FIRST_BUY) continue;
      if (size > cashLamports) continue;
      orderSeq++;
      orders.push({
        side: "buy",
        client_id: `b${slot}-${orderSeq}`,
        mint,
        quote_lamports: String(size),
        max_slippage_bps: SLIPPAGE_BPS,
      });
      pendingBuy.set(mint, size);
      positions.set(mint, {
        mint,
        entryPrice: c.lastPrice,
        peakPrice: c.lastPrice,
        entrySlot: slot,
        buyLamports: 0,
        tokensBought: 0,
        soldHalf: false,
      });
    }
  }

  // ---- 7. Prune stale coin state (keeps memory bounded) ----
  if (batchCount % 1000 === 0) {
    for (const [mint, c] of [...coins.entries()]) {
      if (
        slot - c.createSlot > PRUNE_AGE_SLOTS &&
        !positions.has(mint) &&
        !held.has(mint)
      ) {
        coins.delete(mint);
        cooldownUntil.delete(mint);
      }
    }
  }

  return orders;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "hello") {
      if (msg.capital?.lamports) {
        cashLamports = Number(msg.capital.lamports);
      }
      if (msg.caps) {
        if (typeof msg.caps.max_open_positions === "number") {
          maxPositions = msg.caps.max_open_positions;
        }
        if (typeof msg.caps.max_orders_per_batch === "number") {
          maxOrdersPerBatch = msg.caps.max_orders_per_batch;
        }
      }
      continue;
    }
    if (msg.type === "batch") {
      const orders = handleBatch(msg);
      process.stdout.write(
        JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n",
      );
      continue;
    }
    if (msg.type === "done") {
      break;
    }
  }
}

main().catch(() => {
  process.exit(1);
});
