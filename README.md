# Pump.fun Replay Sprint — Momentum Snipe Paper Bot

![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)
![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/funtoons/pump-fun-replay-sprint-bot/rank.svg)
![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/funtoons/pump-fun-replay-sprint-bot/reward.svg)

A paper trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on make.fun. It trades 10 SOL of paper money on a 24-hour replay of recorded pump.fun bonding-curve activity.

## Strategy

Snipe new coins showing strong early buy pressure (buys ≥ 0.10 SOL and ≥ 60% of early volume, price still within 2x of creation), build up to 0.08 SOL per coin in small orders capped at 90 bps of real reserves, and exit via tiered take-profit (+60% half, +150% all), a −25% stop-loss, a 30% trailing exit, and a 1200-slot time cap. See [STRATEGY.md](STRATEGY.md) for the full description.

## Run

Node 22+, no dependencies, no build step:

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol: JSONL on stdin (`hello`, `batch`, `done`), one `{"type":"reply","seq":...,"orders":[...]}` line per batch on stdout. Deterministic and offline — two runs on the same data produce byte-identical action logs.

## Dev-window result

Grade-local on the kit dev window: net PnL **+0.336 SOL** (+3.36%), 36 round-trip coins, 139 fills, max drawdown 2.67%.
