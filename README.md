# snipe-bot

A pump.fun new-launch snipe bot for Solana. By default (`COPY_TRADE_ONLY_MODE=true`)
it buys ONLY the coins that specific wallet(s) you've told it to track buy —
pure copy-trading, matching their own quick-in/quick-out style — and tries
to exit at or before their own typical hold time and price target, learned
from what they've actually done. With copy-trade-only mode off, it instead
judges launches itself (by market cap, volume, or trust fast-track — see
below). Either way, every exit is a single full sell, on a take-profit,
stop-loss, or hold-time safety net.

**Read the Risks section before using this with real money.**

## How it works

- **Discovery**: connects to [PumpPortal](https://pumpportal.fun)'s public
  websocket (`wss://pumpportal.fun/api/data`) and subscribes to new pump.fun
  token creation events plus per-token trade events.
- **Filter**: with `COPY_TRADE_ONLY_MODE=true` (the default), the ONLY thing
  that qualifies a buy is a `PRIORITY_SNIPER_WALLETS` wallet buying that
  token — `ENTRY_FILTER_MODE`, dev-trust fast-tracking, and earned-trust
  (non-priority) sniper fast-tracking are all disabled, and a priority
  wallet's buy overrides the anti-rug filter (`MAX_DEV_HOLD_PCT`/dev
  blacklist) too. See "Copy-trade-only mode" below.
  With `COPY_TRADE_ONLY_MODE=false`, `ENTRY_FILTER_MODE` decides instead:
  - `market_cap`: the token's market cap is within
    `[ENTRY_MIN_MARKET_CAP_USD, ENTRY_MAX_MARKET_CAP_USD]` — checked from the
    moment it's created, so this can fire within the first second, no
    volume wait at all.
  - `volume`: cumulative SOL bought on the bonding curve since creation
    reaches `MIN_VOLUME_SOL` within `VOLUME_WINDOW_MS`.
  - `both`: require both conditions at once.
  In this mode, tokens where the creator's own initial buy is more than
  `MAX_DEV_HOLD_PCT` of the curve's token supply are blocked from normal
  qualification as a basic rug filter — except a `PRIORITY_SNIPER_WALLETS`
  buy, which still overrides it (see Sniper reputation below).
- **Buy**: spends `BUY_AMOUNT_SOL` SOL per qualifying token, up to
  `MAX_CONCURRENT_POSITIONS` open positions at once.
- **Sell**: closes the *entire* position, in one sell, when unrealized PnL
  hits its take-profit target (dynamic `MIN_TAKE_PROFIT_PCT`–
  `MAX_TAKE_PROFIT_PCT`, or a flat `TAKE_PROFIT_PCT` if dynamic mode is off —
  see below), -`STOP_LOSS_PCT`%, the position has been held longer than
  `MAX_HOLD_TIME_MS` (absolute safety net), `UNSUPPORTED_MAX_HOLD_MS` with no
  trusted sniper currently holding, a trusted sniper backing the trade fully
  exits, or (copy-trade-only mode) a learned preemptive-exit deadline is
  reached — see below. There is no partial/staged exit — every close is a
  full sell.
- **Execution**: live trades are built via PumpPortal's non-custodial
  "local transaction" API — PumpPortal returns an unsigned transaction, this
  bot signs it locally with your keypair and broadcasts it via your own RPC.
  **Your private key never leaves your machine / gets sent to PumpPortal.**
- **Dev reputation** (see below): remembers each token creator's track
  record with the bot across restarts, skipping known-bad creators and
  fast-tracking known-good ones.
- **Adaptive tuning** (see below): nudges the volume/dev-hold/market-cap
  entry filters based on realized win rate and observed priority-wallet
  behavior, within bounded limits.
- **Sniper reputation** (see below): remembers OTHER wallets (not creators)
  that buy into tokens the bot is watching, scored on real observed
  round-trip PnL, and fast-tracks a buy when a proven-profitable wallet buys
  into a token you're already tracking. Manually-seeded priority wallets get
  extra treatment: an anti-rug-filter override, buy-context analysis, and
  (live mode) a dedicated priority fee for the copy-trade buy.

## Copy-trade-only mode

`COPY_TRADE_ONLY_MODE=true` (the default) turns the bot into a pure
copy-trader of the wallet(s) in `PRIORITY_SNIPER_WALLETS`: it buys ONLY
when one of them buys, full stop. Every other qualification path
(`market_cap`/`volume`/`dev_trusted`, and earned-trust fast-tracking for
any *other* sniper wallet) is disabled — the point is to match this
specific wallet's fast in-and-out style on high-volume launches, not to
have the bot make its own judgment calls alongside it. Set
`COPY_TRADE_ONLY_MODE=false` to go back to the bot judging launches itself.

**How the bot decides *when* to sell, beyond copying the wallet's own exit:**

Once a priority wallet has enough observed buy+sell pairs
(`PREEMPTIVE_EXIT_MIN_SAMPLES`, default 3), the bot builds two learned
targets straight from that wallet's own history (`data/snipers.json`):

- **Take-profit target** = that wallet's own average realized multiple
  (avg market cap at their sell ÷ avg market cap at their buy), clamped to
  `[MIN_TAKE_PROFIT_PCT, MAX_TAKE_PROFIT_PCT]` — instead of the generic
  confidence score. If they've historically sold around 1.8x, the bot
  targets ~1.8x too, not a guess.
- **Preemptive-exit deadline** = `PREEMPTIVE_EXIT_FRACTION_PCT` (default
  85%) of that wallet's own average hold time (time from launch to their
  sell). If they typically sell 20 seconds after launch, the bot targets
  closing at ~17 seconds — aiming to be out slightly before they usually
  are, based on their own pattern.

**Be clear about what this is not**: the bot cannot know a specific pending
sell of theirs before it happens — PumpPortal's data feed only reports
trades that already confirmed on-chain, so there is no "beat their exact
transaction" mechanism here, same as the honest limit on the buy side (see
Sniper reputation below). The preemptive deadline is a bet on their
*historical average*, which can be wrong on any single trade — a wallet
having a good streak with a 20-second average hold can absolutely still
hold one particular coin for 5 minutes, and the bot would exit "early"
relative to that one trade.

As a backstop alongside the preemptive timer, the existing reactive
`sniper_exit` logic still applies: the instant the bot actually sees the
tracked wallet fully exit a coin, it follows immediately regardless of
current PnL. Whichever of the two triggers first — the learned preemptive
deadline, or the wallet's real observed sell — closes the position.
Live-mode sells on these positions also use `PRIORITY_WALLET_FOLLOW_FEE_SOL`
(see below) so whichever exit path fires, it confirms fast.

With no observed sell history yet for a wallet, positions copying it fall
back to the normal confidence-scaled take-profit and the reactive
`sniper_exit`/hold-time safety nets described below — the learned targets
only kick in once there's real data to learn from.

## Dynamic take-profit and hold-time caps

By default (`DYNAMIC_TAKE_PROFIT_ENABLED=true`) every exit is a single full
sell of the whole position — there is no staged/partial exit anymore. What
varies is *where* the take-profit target sits, and *when* the position
closes early regardless of PnL.

**Confidence** (`src/confidence.ts`): a deterministic score, computed once
at buy time from this trade's `DecisionContext` — how it qualified
(dev/sniper fast-track, market-cap-range entry, or plain volume
confirmation) and the win rates of the creator and triggering sniper, if
known. This places a `targetTakeProfitPct` for the position somewhere in
`[MIN_TAKE_PROFIT_PCT, MAX_TAKE_PROFIT_PCT]` (default 50%-100%, i.e.
1.5x-2x). Like the dev/adaptive-tuning mechanisms above, this is a fixed,
logged formula over known signals — not a learned model. In copy-trade-only
mode, this confidence-based target is only a fallback for wallets without
enough sell history yet — see "Copy-trade-only mode" above for the
wallet's-own-observed-multiple target used once there's real data.

**Sniper support**: if a trusted sniper is confirmed holding the same
token, the bot keeps aiming for the higher end of the confidence-scaled
target. The moment a trusted sniper who was holding fully exits, the bar
drops to `MIN_TAKE_PROFIT_PCT` immediately (`sniper_exit` in the trade log)
— regardless of current PnL — rather than risk being the one left holding
after they've moved on. Once a position has ever had confirmed sniper
backing, it's held to this stricter standard for the rest of its life even
if that backing later disappears; a position that *never* had any sniper
backing at all is judged on confidence alone and isn't subject to this drop.

**"Don't hold too long" safeguards:**

- `MAX_HOLD_TIME_MS` — the absolute backstop (unconditional): force-exit no
  matter what once a position has been open this long.
- `UNSUPPORTED_MAX_HOLD_MS` — a shorter cap that applies **only to positions
  that had confirmed trusted-sniper backing and then lost it**. A position
  that never had any sniper signal at all (the `volume`/`market_cap`/
  `dev_trusted` paths) isn't held to this shorter clock — it runs to
  `MAX_HOLD_TIME_MS` like normal. (Earlier versions applied this cap to
  *any* position lacking a trusted holder, including ones that never had
  one — since sniper trust takes real observed round-trips to earn, almost
  nothing qualifies early on, so in practice every position was getting
  force-sold at 3 minutes regardless of qualification path, before ever
  getting a real shot at the take-profit target. Fixed after live dry-run
  data showed 18/18 trades exiting this way at a suspiciously uniform ~-5%
  — enough rapid 3-minute cycles like that can fully drain the paper
  balance on its own.)

Set `DYNAMIC_TAKE_PROFIT_ENABLED=false` to go back to the original flat
`TAKE_PROFIT_PCT` / `STOP_LOSS_PCT` behavior.

**Worth understanding**: aiming for up to 100% instead of 20% means a
position stays exposed to the token for longer, waiting for a bigger move —
more time for a rug, a liquidity dry-up, or a reversal to happen before the
single exit lands. The hold-time caps above (and, in copy-trade-only mode,
the preemptive-exit timer) are the counterweight to that.

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
  It also watches for one exit reason dominating a window (currently:
  `unsupported_timeout` making up half or more of recent trades) — a sign
  something structural is cutting positions short rather than normal
  variance — and raises `UNSUPPORTED_MAX_HOLD_MS` (same bounded clamp) in
  response. This is the bot's one form of genuine "reflect on why it lost
  and self-correct": bounded, logged, and limited to nudging existing
  numbers — it can't rewrite its own logic. The actual logic bug behind the
  first real-world case of this (see the take-profit section above) still
  needed a real code fix; the tuner can compensate for degree, not for a
  wrong comparison.
  Separately, it also nudges the *center* of the
  `[ENTRY_MIN_MARKET_CAP_USD, ENTRY_MAX_MARKET_CAP_USD]` entry range toward
  what a `PRIORITY_SNIPER_WALLETS` wallet actually buys at, once that wallet
  has at least 3 observed buys — see "buy-context analysis" below. Same
  bounded clamp as everything else here.

- **`src/sniperReputation.ts` / `src/sniperTracker.ts`**: while the bot is
  watching a mint (from launch through however long discovery or an open
  position keeps it subscribed), it records every OTHER wallet's buys with
  their cost basis. If that same wallet sells before we stop watching, we
  compute their *actual realized PnL* on that round trip — not a proxy — and
  feed it into their reputation. Once a wallet has enough observed round
  trips (`SNIPER_TRUST_MIN_SAMPLES`) at a high enough win rate
  (`SNIPER_TRUST_MIN_WIN_RATE_PCT`), it's trusted, and the bot buys
  immediately whenever that wallet buys into a token it's tracking.
  - **Manual seeding, multiple wallets supported**: set
    `PRIORITY_SNIPER_WALLETS` (comma-separated — add more wallets any time
    by appending to the list) to treat specific wallets as trusted
    immediately, on your own say-so, without waiting to earn it. Every
    wallet in the list is tracked, copy-traded, and learned from
    independently and identically — each gets its own buy/sell-context
    averages and its own preemptive-exit target. This is "trusted until
    proven otherwise," not permanent: once the bot has actually observed
    enough of a wallet's own round-trips (`SNIPER_REVOKE_MIN_SAMPLES`) and
    its real performance is bad (at/below `SNIPER_REVOKE_MAX_WIN_RATE_PCT`),
    its free pass is revoked and it falls back to normal (unearned) status
    — in `COPY_TRADE_ONLY_MODE`, a revoked wallet simply stops triggering
    buys, same as if it were never in the list.
  - **Anti-rug-filter override**: unlike an earned-trust sniper, a
    `PRIORITY_SNIPER_WALLETS` buy makes the bot copy the same buy even on a
    token that was otherwise blocked by `MAX_DEV_HOLD_PCT` or dev
    blacklisting. This is intentional — you asked for the bot to follow this
    specific wallet's entries even when they'd normally be filtered out —
    but it does mean these copy-trades carry more rug risk than the bot's
    normal buys, by design.
  - **Buy-context analysis**: every observed buy from a
    `PRIORITY_SNIPER_WALLETS` wallet also has its situation recorded as a
    running average — market cap at the time, the launching dev's hold %,
    and time since launch (`avgMarketCapUsdAtBuy`, `avgDevHoldPctAtBuy`,
    `avgTimeSinceLaunchMsAtBuy` in `data/snipers.json`). This is the "figure
    out why this wallet picks what it picks" mechanism: purely descriptive
    of what's actually been observed, not a guess — and it's what feeds the
    adaptive tuner's market-cap-range nudging above.
  - **Sell-context analysis**: symmetrically, every observed sell from a
    `PRIORITY_SNIPER_WALLETS` wallet records market cap and time-since-launch
    at that moment (`avgMarketCapUsdAtSell`, `avgTimeSinceLaunchMsAtSell`).
    This is what "copy-trade-only mode" above uses to build the preemptive-
    exit timing and the wallet's-own-multiple take-profit target — the
    "when does this wallet get out, and at what price" half of the analysis.
  - **Live-mode follow fee, buy AND sell**: when a buy is triggered by
    copying a `PRIORITY_SNIPER_WALLETS` wallet, live-mode trades use
    `PRIORITY_WALLET_FOLLOW_FEE_SOL` instead of `PRIORITY_FEE_SOL` — and the
    same higher fee applies to the eventual sell on that position too,
    whichever exit reason ends up triggering it. To be clear about what
    this is and isn't: PumpPortal's data feed only reports trades that have
    already landed on-chain, so there is no way for this bot to see or beat
    a *pending* transaction of theirs — this is **not** front-running. It's
    a fast-follow: a higher fee just helps our own trade confirm sooner once
    we've seen theirs (or once our own preemptive timer fires), on the
    assumption other bots/traders are racing to copy the same wallet.
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
- Tune strategy parameters (buy size, TP/SL, entry filter mode/market-cap
  range/volume threshold, position limits, slippage, priority fee) as needed.

Run it:

```bash
npm run dev      # ts-node, good for iterating
# or
npm run build && npm start
```

Stop with `Ctrl+C` (shuts down the websocket and exits cleanly).

Check performance any time with:

```bash
npm run report            # reads trades.jsonl
npm run report other.jsonl # or a specific log file
```

Prints win rate, total/average realized PnL, best/worst trade, and exit
reason breakdown over the last 24 hours, last 7 days, and all-time. Every
closed trade is a single row — there's no partial/staged exit to fold
together (see the trade log section below).

## Web dashboard

A read-only status page you view in a browser, as an alternative to reading
terminal output. It's a **separate process** from the bot — it only ever
reads the files the bot already writes (`data/status.json`, `trades.jsonl`)
and never touches trading logic or state.

Set real credentials in your `.env` first (the `.env.example` placeholders
are `changeme` — **do not leave them as-is, and never commit real
credentials into `.env.example`**, only your own untracked `.env`):

```
DASHBOARD_USERNAME=your-username
DASHBOARD_PASSWORD=your-password
DASHBOARD_PORT=3000
```

Run it (while the bot is also running, so there's data to show):

```bash
npm run dashboard
```

Open `http://<server-ip>:3000` in a browser — it'll prompt for the
username/password you set, using your browser's built-in login prompt
(HTTP Basic Auth), then show open positions, recent trades, and PnL
summaries, auto-refreshing every 10 seconds.

**Security note — read before exposing this on a public server:** HTTP
Basic Auth sends your credentials base64-encoded, which is easily
decodable, not encrypted. That's fine over `localhost` or through an SSH
tunnel, but if you open `DASHBOARD_PORT` directly to the public internet
over plain HTTP, anyone who intercepts the traffic (e.g. on the same
network, or a malicious router in the path) can read the credentials in
plain text. The safe way to reach it on a remote server (like Oracle
Cloud) is an SSH tunnel instead of opening the firewall port:

```bash
ssh -i /path/to/your-key -L 3000:localhost:3000 ubuntu@<server-ip>
```

Then open `http://localhost:3000` on **your own machine** — the tunnel
carries the connection securely over SSH, and you never need to expose the
port publicly at all.

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
  which a bonding-curve token can move well past your configured
  `STOP_LOSS_PCT`.
- Failed/dropped transactions aren't modeled; live ones can fail and need
  retrying.
- A total rug/liquidity-vanishing event still assumes an exit fill exists in
  dry-run; live, you may not be able to sell at any price.

Treat dry-run PnL as an optimistic ceiling on live performance, not a
forecast.

## Trade log / future training data

Every closed trade appended to `trades.jsonl` includes a full
`DecisionContext` snapshot, not just the outcome — captured at the moment
the token qualified for a buy:

- `qualificationPath` — `"market_cap"` / `"volume"` / `"dev_trusted"` /
  `"sniper_trusted"`
- `devHoldPctAtBuy`, `devTrustLevelAtBuy`, `devWinsAtBuy`, `devLossesAtBuy`,
  `devTotalPnlSolAtBuy` — the creator's track record as of that trade
- `triggeringSniperWallet`, `sniperWinsAtBuy`, `sniperLossesAtBuy` — set if
  a sniper signal is what triggered the buy
- `volumeAtQualificationSol`, `timeToQualifyMs` — how much volume had
  accumulated and how long it took
- `marketCapSolAtQualification` — the token's market cap (in SOL) at the
  moment it qualified
- `tunedMinVolumeSolAtBuy`, `tunedMaxDevHoldPctAtBuy` — the live tuned
  filter values in effect at that moment (these drift over time, so the
  current `data/tuning.json` alone can't tell you what they were on any
  earlier trade)

This is deliberate: `data/devs.json`, `data/tuning.json`, and
`data/snipers.json` only hold *current* aggregate state, so without this the
trade log would be reduced to bare PnL numbers with no situational context.
With it, every row in `trades.jsonl` is a self-contained (features, outcome)
example — which is what you'd actually need if you ever fit a real model on
accumulated history later (see the dev/adaptive-tuning section above for why
that's a "much later, after real data has piled up" thing, not a now thing).

## Risks (read this)

- **Brand-new pump.fun tokens are extremely thin-liquidity and adversarial.**
  Rug pulls, honeypots, and instant single-block dumps are common. With
  `COPY_TRADE_ONLY_MODE=true` (the default), the `MAX_DEV_HOLD_PCT` filter
  doesn't apply to these buys at all (see the anti-rug-override bullet
  below) — you're relying entirely on the tracked wallet's own judgment.
  With copy-trade-only mode off, `MAX_DEV_HOLD_PCT`/`ENTRY_FILTER_MODE`
  reduce exposure to the most obvious cases but still don't make this safe
  — nothing prevents buying into a token that goes to zero a second later.
- **A stop-loss is often unenforceable in practice** on a bonding curve — by
  the time your sell transaction lands, price may already be far past where
  you tried to exit. Live losses can exceed your configured `STOP_LOSS_PCT`
  (default 10%, raised from an earlier 2% default — still not a hard
  ceiling on realized loss).
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
- **`PRIORITY_SNIPER_WALLETS` buys bypass the anti-rug filter entirely.**
  This is by design (you asked for the bot to copy this wallet's entries
  even on tokens that would otherwise be blocked), but it means these
  specific copy-trades have strictly more rug exposure than every other buy
  this bot makes — including tokens with a near-100% dev-held supply. If the
  wallet's judgment is wrong on a given token, this override doesn't catch
  it. Remove the wallet from `PRIORITY_SNIPER_WALLETS` if you want to stop
  this override without disabling sniper tracking entirely.
- **The preemptive-exit deadline is a bet on a wallet's historical average,
  not a guarantee about any single trade.** A wallet that typically sells
  20 seconds after launch can still hold one particular coin for 5 minutes;
  the bot would still try to exit around the ~17-second mark on that trade,
  which may be well before the wallet's own real exit and could mean
  leaving profit on the table (or, worse, exiting into a dip the wallet
  itself was patient enough to ride through). The reactive `sniper_exit`
  (follow their real sell the instant it's observed) still fires
  independently, but only once their actual sell happens — it does not
  correct a preemptive exit that already happened first.
- **The buy-context-driven tuner nudge and the follow-fee both act on
  *observed* behavior, not intent.** If the tracked wallet's actual strategy
  changes, or it's briefly noisy/manipulated, the tuner will still nudge the
  entry range toward whatever it's observed buying, and the follow-fee still
  applies to every copy-trade regardless of outcome quality.

## Project layout

```
src/
  config.ts           env var loading / validation
  types.ts            shared types (events, positions, trade results)
  logger.ts           console + JSONL trade logging
  pnlStats.ts         shared PnL summary logic (used by report.ts + dashboard)
  report.ts           standalone PnL summary over trades.jsonl (npm run report)
  dashboardServer.ts  read-only web dashboard, HTTP Basic Auth (npm run dashboard)
  dashboard.html      dashboard page markup/styles/client-side JS
  wallet.ts           keypair + Solana RPC connection (live mode)
  paperWallet.ts       virtual balance ledger (dry-run mode)
  discovery.ts        new-token tracking, volume filter, anti-rug filter
  positionManager.ts  open-position tracking, TP/SL/time-exit logic
  devReputation.ts    per-creator-wallet track record, trust classification
  adaptiveTuner.ts    bounded rule-based filter tuning from realized win rate
  sniperReputation.ts per-sniper-wallet track record, trust classification
  sniperTracker.ts    cost-basis tracking on watched mints, round-trip PnL
  confidence.ts       deterministic take-profit-target scoring formula
  pumpportal/
    socket.ts          PumpPortal websocket client with reconnect
    trade.ts           buy/sell execution (dry-run + live)
  index.ts             entrypoint, wiring, graceful shutdown

data/                  runtime state (gitignored): devs.json, tuning.json, snipers.json, status.json
```
