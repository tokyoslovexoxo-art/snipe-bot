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
  pumpportal/
    socket.ts          PumpPortal websocket client with reconnect
    trade.ts           buy/sell execution (dry-run + live)
  index.ts             entrypoint, wiring, graceful shutdown
```
