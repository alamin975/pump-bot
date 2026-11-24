# pump-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/alamin975/pump-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/alamin975/pump-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the Pump.fun Replay Sprint on [make.fun](https://make.fun/?ref=yttjg0tr&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122): it trades 10 SOL of paper money on a 24-hour pump.fun replay.

## Strategy

Consolidation breakout with a volume burst. A curve must first trade sideways in a tight range (400 slots, range within 10%) while its real SOL reserve grows at least 10% — quiet accumulation. It is bought only when the price breaks above that range high on a burst of buy volume (≥1 SOL in 30 slots, ≥4 distinct buyers, burst buys at least 2× the prior 30 slots) with no single whale dominating. One confirmation add of the same size follows if the price holds 5% above the first buy 60+ slots later.

Exits: +50% take-profit, −18% stop, 25% trailing stop once up 20%, failed-breakout exit (price back below the range high), flow-fade exit, creator-sell exit, 600-slot staleness exit, and a 1500-slot time limit. A position that doubles is ridden — the time limit and fade exit stop applying and only the trailing stop takes it out.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout (see `vendor/makefun-bot.ts`, a byte-identical copy of the kit's SDK shim). Grade it locally with the kit's CLI:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=yttjg0tr&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)</sub>
