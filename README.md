# snipe-bot

A pump.fun new-launch snipe bot for Solana. Watches new pump.fun token
launches in real time, buys into ones that clear a minimum volume threshold,
and exits automatically on take-profit, stop-loss, or a max-hold-time safety
net.

**Read the Risks section before using this with real money.**

## How it works

- **Discovery**: connects to [PumpPortal](https://pumpportal.fun)'s public
  websocket (`wss://pumpportal.fun/api/data`) and subscribes to new pump.fun
  token creation events plus per-token trade events.
- **Filter**: a token qualifies for a buy once cumulative SOL bought on its
  bonding curve since creation reaches `MIN_VOLUME_SOL`, within
  `VOLUME_WINDOW_MS` of launch. Tokens where the creator's own initial buy
  is more than `MAX_DEV_HOLD_PCT` of the curve's token supply are skipped
  outright as a basic rug filter.
- **Buy**: spends `BUY_AMOUNT_SOL` SOL per qualifying token, up to
  `MAX_CONCURRENT_POSITIONS` open positions at once.
- **Sell**: closes a position when unrealized PnL hits
  +`TAKE_PROFIT_PCT`%, -`STOP_LOSS_PCT`%, or the position has been held
  longer than `MAX_HOLD_TIME_MS` (a safety net for tokens that go illiquid
  without ever hitting TP/SL).
- **Execution**: live trades are built via PumpPortal's non-custodial
  "local transaction" API — PumpPortal returns an unsigned transaction, this
  bot signs it locally with your keypair and broadcasts it via your own RPC.
  **Your private key never leaves your machine / gets sent to PumpPortal.**
- **Dev reputation** (see below): remembers each token creator's track
  record with the bot across restarts, skipping known-bad creators and
  fast-tracking known-good ones.
- **Adaptive tuning** (see below): nudges the volume/dev-hold entry filters
  based on realized win rate, within bounded limits.
- **Sniper reputation** (see below): remembers OTHER wallets (not creators)
  that buy into tokens the bot is watching, scored on real observed
  round-trip PnL, and fast-tracks a buy when a proven-profitable wallet buys
  into a token you're already tracking.

## Dev reputation & adaptive tuning ("learning" — read this carefully)

Two mechanisms let the bot improve its entry decisions over time as it
accumulates real trade outcomes, persisted in `data/` across restarts:

- **`src/devReputation.ts`**: tracks each token creator wallet's history
  with the bot — tokens launched, tokens bought, wins, losses, total PnL.
  Once a creator has enough resolved trades (`TRUST_MIN_SAMPLES` /
  `BLACKLIST_MIN_SAMPLES`), they're classified:
  - **Blacklisted** (win rate below `BLACKLIST_MAX_WIN_RATE_PCT`): their
    future launches are skipped entirely.
  - **Trusted** (win rate at/above `TRUST_MIN_WIN_RATE_PCT`): their next
    launch is bought immediately at creation, skipping the volume-wait —
    the actual edge of "recognizing a good dev" is reacting faster on a
    source you already trust.
- **`src/adaptiveTuner.ts`**: after every `TUNING_WINDOW_TRADES` closed
  trades, looks at the realized win rate and nudges `MIN_VOLUME_SOL` /
  `MAX_DEV_HOLD_PCT` tighter or looser, clamped to never drift more than
  `TUNING_MAX_ADJUST_PCT` away from your `.env` baselines. It never touches
  `TAKE_PROFIT_PCT` / `STOP_LOSS_PCT` — your exit economics stay exactly
  what you set.

- **`src/sniperReputation.ts` / `src/sniperTracker.ts`**: while the bot is
  watching a mint (from launch through however long discovery or an open
  position keeps it subscribed), it records every OTHER wallet's buys with
  their cost basis. If that same wallet sells before we stop watching, we
  compute their *actual realized PnL* on that round trip — not a proxy — and
  feed it into their reputation. Once a wallet has enough observed round
  trips (`SNIPER_TRUST_MIN_SAMPLES`) at a high enough win rate
  (`SNIPER_TRUST_MIN_WIN_RATE_PCT`), it's trusted, and the bot buys
  immediately whenever that wallet buys into a token it's tracking.
  - **Manual seeding**: set `PRIORITY_SNIPER_WALLETS` (comma-separated) to
    treat specific wallets as trusted immediately, on your own say-so,
    without waiting to earn it. This is "trusted until proven otherwise,"
    not permanent: once the bot has actually observed enough of that
    wallet's own round-trips (`SNIPER_REVOKE_MIN_SAMPLES`) and their real
    performance is bad (at/below `SNIPER_REVOKE_MAX_WIN_RATE_PCT`), the free
    pass is revoked and it falls back to normal (unearned) status.
  - **Sampling limitation, worth understanding**: we only ever see the
    slice of a sniper's activity that happens while we're actively watching
    a given mint. A sniper who holds longer than our watch window, or exits
    after we've stopped watching, is invisible to us for that trade — so
    the sample is biased toward wallets that exit fast, and a wallet's
    real-world track record (e.g. one you've seen quoted elsewhere) can
    differ from what this bot itself observes and scores.

**What this is not**: none of these three are a machine-learning model. All
are plain counters and threshold checks — every decision is visible in the
logs with the exact stat that triggered it, and you can inspect or hand-edit
`data/devs.json` / `data/tuning.json` / `data/snipers.json` directly. This
was a deliberate choice over a black-box model: a bot this selective will
only see a handful of qualifying trades a day, nowhere near enough data for
a real model to find genuine signal instead of noise. Treat these as
slow-moving, bounded safety adjustments — not fast learning, and not a
guarantee that "day 30" is meaningfully better than "day 1."

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

- Leave `DRY_RUN=true` to start (strongly recommended — see Risks).
- For live trading later, set `PRIVATE_KEY` (base58 secret key) and `RPC_URL`
  (use a paid low-latency provider like Helius/QuickNode/Triton — public RPCs
  are too slow to compete for inclusion).
- Tune strategy parameters (buy size, TP/SL, volume filter, position limits,
  slippage, priority fee) as needed.

Run it:

```bash
npm run dev      # ts-node, good for iterating
# or
npm run build && npm start
```

Stop with `Ctrl+C` (shuts down the websocket and exits cleanly).

## Dry-run (paper trading) mode

With `DRY_RUN=true` (the default), the bot runs against the **same live
PumpPortal data** but trades against an in-memory virtual SOL balance
(`DRY_RUN_STARTING_BALANCE_SOL`) instead of your real wallet — no keys, no
RPC, no real funds needed. Every simulated trade is logged to the console and
appended to `trades.jsonl`.

Dry-run is accurate for validating the **strategy logic** — which tokens it
buys, and when it decides to sell — because that logic is identical in both
modes. It is **not** accurate for **execution realism**:

- Fill prices are estimated (last quoted price + a haircut derived from your
  slippage setting), not a real competitive execution against other bots.
- There's no simulated RPC/network latency or transaction-confirmation delay.
  Live, your stop-loss sell can take an extra block or two to land, during
  which a bonding-curve token can move well past -2%.
- Failed/dropped transactions aren't modeled; live ones can fail and need
  retrying.
- A total rug/liquidity-vanishing event still assumes an exit fill exists in
  dry-run; live, you may not be able to sell at any price.

Treat dry-run PnL as an optimistic ceiling on live performance, not a
forecast.

## Risks (read this)

- **Brand-new pump.fun tokens are extremely thin-liquidity and adversarial.**
  Rug pulls, honeypots, and instant single-block dumps are common. The
  `MAX_DEV_HOLD_PCT` filter and volume threshold reduce exposure to the most
  obvious cases but do not make this safe — nothing prevents you from buying
  into a token that goes to zero a second later.
- **A 2% stop-loss is often unenforceable in practice** on a bonding curve —
  by the time your sell transaction lands, price may already be far past
  where you tried to exit. Live losses can exceed your configured
  `STOP_LOSS_PCT`.
- **This bot has not been run against real funds or verified end-to-end
  against PumpPortal's live trade-execution endpoint** (the docs site
  couldn't be reliably fetched while building this — see code comments in
  `src/pumpportal/trade.ts`). Before setting `DRY_RUN=false`, do one small
  manual test trade and confirm it behaves as expected.
- **No strategy here guarantees profit.** Sizing, filters, and exits are
  configurable, but memecoin sniping is a high-variance, adversarial game
  where you're competing against other bots with faster infrastructure.
- Only risk money you can afford to lose entirely, and start with the
  smallest `BUY_AMOUNT_SOL` and `MAX_CONCURRENT_POSITIONS` you're willing to
  test with before scaling up.
- **The "trusted dev" fast-track skips the volume-confirmation wait
  entirely.** A dev can look good on 2 small trades and still rug their 3rd
  token — trust classification is based on very few samples early on. Raise
  `TRUST_MIN_SAMPLES` if you want more evidence required before fast-tracking.
- **The same applies to sniper fast-tracking, more so for
  `PRIORITY_SNIPER_WALLETS`.** A manually-seeded wallet is trusted
  immediately on your say-so alone, with zero trades observed by this bot —
  if the claim behind it is wrong, outdated, or was itself an automated bot
  that gets retuned or stops working, you won't find out until real losses
  accumulate. `MIN_VOLUME_SOL=0.2` also means the bot buys on much thinner
  confirmation than the original 1 SOL default — expect more false positives
  (rugs that briefly look active) in exchange for catching things earlier.

## Project layout

```
src/
  config.ts           env var loading / validation
  types.ts            shared types (events, positions, trade results)
  logger.ts           console + JSONL trade logging
  wallet.ts           keypair + Solana RPC connection (live mode)
  paperWallet.ts       virtual balance ledger (dry-run mode)
  discovery.ts        new-token tracking, volume filter, anti-rug filter
  positionManager.ts  open-position tracking, TP/SL/time-exit logic
  devReputation.ts    per-creator-wallet track record, trust classification
  adaptiveTuner.ts    bounded rule-based filter tuning from realized win rate
  sniperReputation.ts per-sniper-wallet track record, trust classification
  sniperTracker.ts    cost-basis tracking on watched mints, round-trip PnL
  pumpportal/
    socket.ts          PumpPortal websocket client with reconnect
    trade.ts           buy/sell execution (dry-run + live)
  index.ts             entrypoint, wiring, graceful shutdown

data/                  runtime state (gitignored): devs.json, tuning.json, snipers.json
```
