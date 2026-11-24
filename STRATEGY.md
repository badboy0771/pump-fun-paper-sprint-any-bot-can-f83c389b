# STRATEGY.md — High-Tide Scalper (momentum breakout scalp)

## Method

NOT a launch rider: this bot never buys a fresh launch. The competing
"Launch Rider" style — buy every new launch that passes a rug filter and
ride it to completion — is deliberately not used here. Instead the bot
waits for proof, then scalps the continuation:

1. **Entry (once per coin).** Age 30–10,000 slots; peak ≥ +70% over the
   create price; price printing a new high (at or above the peak); net
   buy flow ≥ 0 over the last 120 slots from ≥ 1 distinct recent buyer,
   with the newer half's net flow ≥ the older half's (buying is
   accelerating, not fading); creator has not sold; curve holds 0.3–30
   SOL of real reserves.
2. **Exit (checked every batch).** Take-profit +4%, hard stop -10%,
   exit when the creator sells while held, exit if no trade for 600
   slots, 2,000-slot hold cap. Winners are banked at the first
   continuation leg; losers are cut small and fast. Nothing is ridden to
   completion.
3. **Guardrails.** At most 5 open positions, every order within 1% of
   the coin's real reserve, every round trip 0.01 SOL (the guardrail
   minimum), drawdown far under the 50% cap.

## What the data says (and why scalping is hard here)

The dev window holds 1,222 sampled coins; only 35 complete (2.9%), but
every completer pays ~+1,370% from its create price while non-completers
end flat (median 0%). Completion is the whole game — and the median
completer crosses every real-SOL threshold in the same slot it completes,
so no strategy that waits for confirmation can catch one through the
2-slot execution latency. That is why the entries below behave the way
they do.

## Dev-window evidence (kit's local engine, full 128,058-event window)

All sweep numbers are means over 4 failed-transaction draws on the FULL
dev window (lab/tools/sim.ts reads all three dataset parts; an earlier
builder's first sim read only part-00000 and its numbers were wrong —
the fix is kept). Best cell of each family:

| family | best mean net PnL | fills | coins | wins | max DD |
| --- | --- | --- | --- | --- | --- |
| **breakout scalp (shipped)** | **-0.014 SOL** | 98 | 49 | 27/50 | 0.003 |
| volume-surge sniper (kit pilot) | -0.47 SOL | ~700 | ~350 | 47/350 | 0.05 |
| momentum (kit pilot) | -9.4 SOL | ~430 | ~50 | 5/80 | 0.95 |
| mean reversion (kit pilot) | unstable: -3.7 / +0.87 / ~0 across fail draws | — | — | — | — |
| dip-buying (pullback from peak) | -0.175 SOL | 135 | 70 | 43/160 | 0.027 |
| threshold-chaser (buy at real SOL ≥ 5–30, hold) | -1.033 SOL | 143 | 74 | 49/211 | 0.178 |

The kit pilots were run as shipped on this window with the lab runner:
momentum is catastrophic (its probe/guardrail buying fires constantly),
reversion's result flips sign between failed-transaction draws, and the
sniper bleeds a little on almost every coin. None of them is a usable
base on this window.

## How the shipped cell was found

Refining the breakout scalp, step by step (each step is the best cell
of its grid, 4-draw means):

- 0.05 SOL stake, TP +10% / SL -15%, run-up +100%: **-0.109 SOL**
  (the previous builder's least-bad cell).
- 0.02 SOL stake, TP +5% / SL -10%, run-up +50%: **-0.037 SOL** —
  smaller stakes and tighter take-profits help a lot.
- 0.01 SOL stake, TP +3% / SL -10%, run-up +50%: **-0.023 SOL**.
- 0.01 SOL stake, TP +3–4% / SL -10%, run-up +70%: **-0.014 SOL** —
  the plateau. The neighbouring cells (TP +3%/+4%, run-up +70%/+100%,
  min age 10/30 slots) all land at -0.014…-0.015 SOL, so this is a flat
  region, not a spike fit. 0.01 SOL is the guardrail minimum stake; it
  cannot go lower.
- Checks on the shipped cell: dropping the acceleration filter
  (accelMinBps 0) worsens it to **-0.040 SOL** — the filter earns its
  keep. Shortening the stale/hold caps (200/500 slots) changes nothing:
  exits are dominated by TP/SL.
- Trailing stop, tested and rejected in this session: TP +8% with a
  trailing stop arming at +2% and trailing -3% measured **-0.023 SOL**
  mean vs -0.013 for the fixed +4% TP, so the trailing code stays in
  strategy.ts disabled (trailArmBps 0) as a documented dead end.

## Shipped cell detail (this session's own code, 5 failed-tx draws)

TP +4%, SL -10%, 0.01 SOL stake, +70% run-up, accel filter on:

| draw | net PnL | fills | coins | trips | wins | max DD |
| --- | --- | --- | --- | --- | --- | --- |
| 11 | -0.011 | 100 | 50 | 50 | 27 | 0.002 |
| 22 | -0.010 | 98 | 49 | 49 | 27 | 0.002 |
| 33 | -0.017 | 99 | 50 | 50 | 26 | 0.003 |
| 44 | -0.017 | 99 | 50 | 50 | 27 | 0.003 |
| none | -0.010 | 102 | 51 | 51 | 28 | 0.002 |

Mean **-0.013 SOL**, 0 rejected orders. Top 3 coins contribute about
+0.006 SOL; without them the mean is about -0.019 SOL.

Real grader (`grade-local --driver process`, two runs byte-identical):
net PnL **-0.0110 SOL** (90% interval -0.0277…+0.0051), 100 fills over
50 coins, 50 round trips, win rate 54.0%, max drawdown 0.0020,
guardrails MET (50 round trips ≥ 0.01 SOL, drawdown ok). Fees: 0.0125
SOL curve + 0.0106 SOL tx; at 2x fees -0.0340 SOL. Top 3 coins made 26%
of the gains; without them -0.02 SOL.
result_sha256 f3e86e34c65e92ce8b13a2dadec78790628d553ea028a707e2f32770673763e5
(action_log_sha256 6fa3cbdfe5e9bfb08ab43b6b7b345d0fc20d2eb30c2dd94a0121b49352aa7062).

## Revisions in this session

- v1: breakout scalp as written, TP +3% — measured -0.0136 SOL mean
  over 5 draws in this session's own code.
- v2: TP +3% → +4% (sweep's flat best region) — measured -0.0130 SOL
  mean over 5 draws.
- v3: trailing stop added (arm +2% / trail -3%) and tested with TP
  +8%: -0.023 SOL mean — rejected, stays off by default.

## What the dev window cannot prove

The final window is fresh chain data recorded after entries close, so
dev PnL is only a weak signal — and here it is negative for every
variant tested, including the shipped one. What transfers is the shape:
bounded downside (max drawdown 0.2% on dev, worst draw -0.017 SOL),
guardrail margins (50 coins vs 20 required, drawdown 0.002 vs 0.50
cap), a better-than-coin-flip win rate (54%), and upside exposure if
the final window's coins continue further than the dev window's. If the
final window behaves like the dev window, the bot loses roughly 0.01
SOL of paper money and wins nothing. It is a lottery ticket, reported
as such.
