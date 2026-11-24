# High-Tide Scalper — Pump.fun Paper Sprint (paper bot)

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/badboy0771/pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/badboy0771/pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A trading bot for the make.fun bounty
[Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b): it trades 10 SOL
of paper money on a replay of pump.fun bonding-curve activity.
Nothing is traded for real; the house replay scorer runs this bot over
chain data recorded after entries close and ranks entries by net PnL.

## Strategy

NOT a launch rider: this bot never buys a fresh launch and never rides
anything to completion. It waits for a coin that already ran up at least
+70% from its create price, then buys only the moment the price prints a
fresh high while buy flow is still accelerating into it (the newer half
of the last 120 slots bought at least as much net as the older half).
One fixed 0.01 SOL buy per coin, then it scalps the next leg:
take-profit +4%, hard stop -10%, exit if the creator sells or the coin
goes stale. Winners are banked at the first continuation leg; losers are
cut small and fast.

See [STRATEGY.md](STRATEGY.md) for the full method, the dead ends tested
(kit pilot momentum/reversion/sniper, dip-buying, threshold-chasing, a
trailing stop), the parameter sweep on the kit's dev window, and the
guardrail margins.

## Local verification (dev window, `grade-local --driver process`)

- Net PnL **-0.0110 SOL** (90% interval -0.0277…+0.0051 SOL), 100 fills
  over 50 coins, 50 round trips, win rate 54.0%, max drawdown 0.20%,
  guardrails met (50 round trips ≥ 0.01 SOL), two runs byte-identical
  (deterministic). Fees: 0.0125 SOL curve + 0.0106 SOL tx; at 2x fees
  -0.0340 SOL. Top 3 coins made 26% of the gains; without them -0.02 SOL.
- Offline backtest (same fill model, full dev window): mean -0.013 SOL
  across failed-transaction draws, worst -0.017, drawdown ≤ 0.3%.
- Honest note: no parameter cell swept on this window is net positive.
  This entry is the least-bad flat region of the grid (-0.011…-0.014 SOL
  across the neighbouring cells), with bounded downside and a 54% win
  rate. The final window is fresh data; see STRATEGY.md for the full
  evidence.

## Run

The grader runs `node main.ts` (Node 22+). The bot is deterministic:
no clock, no randomness, no I/O — the two grading executions produce
byte-identical action logs.

## License

MIT — see [LICENSE](LICENSE).
