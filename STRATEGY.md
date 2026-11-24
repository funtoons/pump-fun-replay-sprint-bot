# Strategy — Momentum Snipe Paper Bot (pump.fun replay)

## What it trades

New pump.fun bonding-curve coins (SOL quote, non-mayhem, no cashback),
traded on a replay of recorded chain events. Paper money only: 10 SOL
starting capital, at most 5 open positions.

## Entry — snipe early buy pressure

A coin becomes a candidate in its first 300 slots after its
`CreateEvent` when all of these hold:

- cumulative buy volume since creation is at least 0.10 SOL;
- buys are at least 60% of early volume (buyers dominate, not sellers);
- real SOL reserves are at least 0.30 SOL (the coin has real flow);
- the price is still within 2x of the create price (never chase a top).

When a candidate qualifies, the bot buys up to a 0.08 SOL target per
coin, in small orders, each capped at 90 bps of the coin's real SOL
reserve (the harness cap is 100 bps). It keeps topping up while the
coin is younger than 600 slots and the price stays within 2x of the
create price. A first order is at least 0.005 SOL; top-ups at least
0.002 SOL. A coin that was just exited is not re-entered for
2000 slots.

## Exit — tiered take-profit, tight stop, time cap

- Sell half the position at +60% over the effective entry price.
- Sell everything at +150%.
- Stop-loss: sell everything at -25%.
- Trailing exit: sell everything 30% below the position's peak price.
- Time exit: sell everything after 1200 slots (~8 minutes).
- If a coin completes its bonding curve, sell everything immediately.

The effective entry price is the volume-weighted price actually paid
(quote lamports per token received, from the harness fills), not the
price seen when the order was placed, so the 2-slot execution latency
is accounted for.

## Why this shape

On the dev window, most new coins pump briefly and then fade back to
their starting price, so buying a coin only because it already rose a
lot means buying the top. Buying very early — while buy flow is strong
but the price has not yet run away — and exiting on tiered targets
captures the early run-up while the stop-loss, trailing exit and time
cap cut the many coins that fade. Offline sweeps over the dev window
showed this shape stays positive across neighbouring parameter choices
(target 0.03–0.12 SOL, take-profit 40–100%, stop-loss 15–40%), rather
than depending on one tuned value.

## Costs and limits respected

- Protocol fee ~95 bps + creator fee ~30 bps + 5000 lamports base +
  100000 lamports priority per transaction are priced into every
  decision (small orders are avoided because the flat fees eat them).
- At most 16 orders per batch; order ids are deterministic
  (`b<slot>-<n>` / `s<slot>-<n>`), so two runs on the same data
  produce byte-identical action logs.
- No shorts, no leverage, no network, no clock, no randomness:
  the bot reads only its stdin and writes only its replies.

## Dev-window result (kit grade-local, process driver)

- Net PnL: +336,196,998 lamports (+0.336 SOL, +3.36%)
- Round trips: 36 coins, 139 fills, max drawdown 2.67%
- Action log sha256 identical across two runs (deterministic)
