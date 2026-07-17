import * as dotenv from "dotenv";

dotenv.config();

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number for ${name}: "${raw}"`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.trim().toLowerCase() === "true";
}

export const config = {
  dryRun: bool("DRY_RUN", true),

  privateKey: process.env.PRIVATE_KEY ?? "",
  rpcUrl: process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",

  dryRunStartingBalanceSol: num("DRY_RUN_STARTING_BALANCE_SOL", 10),

  buyAmountSol: num("BUY_AMOUNT_SOL", 1),
  // Static take-profit, only used when DYNAMIC_TAKE_PROFIT_ENABLED=false.
  takeProfitPct: num("TAKE_PROFIT_PCT", 20),
  stopLossPct: num("STOP_LOSS_PCT", 10),

  // ==== Entry gate ====
  // How a token qualifies for a buy:
  //   "market_cap" - qualifies the instant its market cap is within
  //                  [ENTRY_MIN_MARKET_CAP_USD, ENTRY_MAX_MARKET_CAP_USD] -
  //                  no volume wait at all (checked from the creation event
  //                  onward, so this can fire within the first second).
  //   "volume"     - the original behavior: wait for MIN_VOLUME_SOL of
  //                  cumulative bonding-curve buys within VOLUME_WINDOW_MS.
  //   "both"       - require both conditions at once.
  entryFilterMode: (process.env.ENTRY_FILTER_MODE ?? "market_cap") as "market_cap" | "volume" | "both",
  // USD range for "market_cap"/"both" modes. Converted from PumpPortal's
  // SOL-denominated marketCapSol using SOL_USD_PRICE below.
  entryMinMarketCapUsd: num("ENTRY_MIN_MARKET_CAP_USD", 2_500),
  entryMaxMarketCapUsd: num("ENTRY_MAX_MARKET_CAP_USD", 4_000),
  // Used by "volume"/"both" modes.
  minVolumeSol: num("MIN_VOLUME_SOL", 0.2),
  // How long we watch a token for either condition (volume threshold and/or
  // market-cap range, depending on ENTRY_FILTER_MODE) before giving up on it.
  volumeWindowMs: num("VOLUME_WINDOW_MS", 60_000),
  maxConcurrentPositions: num("MAX_CONCURRENT_POSITIONS", 3),
  maxHoldTimeMs: num("MAX_HOLD_TIME_MS", 600_000),
  maxDevHoldPct: num("MAX_DEV_HOLD_PCT", 30),
  slippagePct: num("SLIPPAGE_PCT", 10),
  priorityFeeSol: num("PRIORITY_FEE_SOL", 0.0005),
  // Used instead of PRIORITY_FEE_SOL, live mode only, specifically for buys
  // triggered by a PRIORITY_SNIPER_WALLETS wallet (qualificationPath ===
  // "sniper_trusted"). This is NOT front-running — PumpPortal's feed only
  // reports trades that already landed on-chain, so there is no pending
  // transaction of theirs to beat. It's a fast-follow: a higher fee just
  // gets our own copy-trade buy included/confirmed sooner than it otherwise
  // would be, on the theory that other bots are racing to copy the same
  // wallet the moment its buy is visible.
  priorityWalletFollowFeeSol: num("PRIORITY_WALLET_FOLLOW_FEE_SOL", 0.002),
  pool: process.env.POOL ?? "pump",

  logFile: process.env.LOG_FILE ?? "trades.jsonl",

  // ==== Dev reputation tracking ====
  devTrackingEnabled: bool("DEV_TRACKING_ENABLED", true),
  devStoreFile: process.env.DEV_STORE_FILE ?? "data/devs.json",
  // A dev needs at least this many resolved (bought) trades before we'll
  // classify them as trusted or blacklisted at all.
  trustMinSamples: num("TRUST_MIN_SAMPLES", 2),
  trustMinWinRatePct: num("TRUST_MIN_WIN_RATE_PCT", 60),
  blacklistMinSamples: num("BLACKLIST_MIN_SAMPLES", 2),
  blacklistMaxWinRatePct: num("BLACKLIST_MAX_WIN_RATE_PCT", 25),

  // ==== Adaptive filter tuning ====
  adaptiveTuningEnabled: bool("ADAPTIVE_TUNING_ENABLED", true),
  tuningStoreFile: process.env.TUNING_STORE_FILE ?? "data/tuning.json",
  // Re-evaluate filters after this many closed trades.
  tuningWindowTrades: num("TUNING_WINDOW_TRADES", 20),
  // Tuned minVolumeSol/maxDevHoldPct can never drift more than this percent
  // away from your .env baseline values, in either direction.
  tuningMaxAdjustPct: num("TUNING_MAX_ADJUST_PCT", 40),

  // ==== Sniper (other buyer wallet) reputation tracking ====
  // Watches other wallets buying/selling on tokens we're already watching,
  // and scores them on REALIZED round-trip PnL for the portion of that we
  // actually observe (see README for the partial-sample caveat).
  sniperTrackingEnabled: bool("SNIPER_TRACKING_ENABLED", true),
  sniperStoreFile: process.env.SNIPER_STORE_FILE ?? "data/snipers.json",
  // "Really profitable all the time" is a high bar by design — require more
  // samples and a higher win rate than the dev-trust thresholds.
  sniperTrustMinSamples: num("SNIPER_TRUST_MIN_SAMPLES", 3),
  sniperTrustMinWinRatePct: num("SNIPER_TRUST_MIN_WIN_RATE_PCT", 80),
  // Wallets manually seeded as trusted immediately (comma-separated), e.g.
  // one you've observed being consistently profitable elsewhere. Trusted
  // "until proven otherwise": once we've actually observed enough of their
  // round-trips ourselves, if their real performance is bad they lose this
  // free pass (see sniperRevoke* below) — it is not a permanent override.
  prioritySniperWallets: (process.env.PRIORITY_SNIPER_WALLETS ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter((w) => w.length > 0),
  sniperRevokeMinSamples: num("SNIPER_REVOKE_MIN_SAMPLES", 3),
  sniperRevokeMaxWinRatePct: num("SNIPER_REVOKE_MAX_WIN_RATE_PCT", 40),

  // ==== Copy-trade-only mode ====
  // When true, the bot buys ONLY when a PRIORITY_SNIPER_WALLETS wallet buys
  // — the market_cap/volume/dev_trusted entry paths, and earned-trust
  // (non-priority) sniper fast-tracking, are all disabled. Pure copy-trading
  // of the specific wallet(s) you've told the bot to trust, matching their
  // own quick-in/quick-out style instead of the bot judging launches itself.
  copyTradeOnlyMode: bool("COPY_TRADE_ONLY_MODE", true),
  // How long (ms) a new token is kept watched, waiting for a priority
  // wallet's buy, before giving up on it. Only used in copy-trade-only mode.
  copyTradeWatchWindowMs: num("COPY_TRADE_WATCH_WINDOW_MS", 300_000),
  // Once a priority wallet has enough observed buy+sell pairs
  // (PREEMPTIVE_EXIT_MIN_SAMPLES), a position copying that wallet targets:
  //  - a take-profit target equal to that wallet's own observed average
  //    multiple (avg sell mcap / avg buy mcap), clamped to
  //    [MIN_TAKE_PROFIT_PCT, MAX_TAKE_PROFIT_PCT] — instead of the generic
  //    confidence-based target, since real data on THIS wallet's own typical
  //    result is more specific than a general confidence score.
  //  - closing at this fraction of that wallet's own average hold time
  //    (time from launch to their sell) — e.g. 85 means "aim to be out
  //    slightly before they typically are," based on real observed pattern.
  // This is NOT knowledge of any pending sell of theirs (impossible — see
  // README, PumpPortal only reports confirmed trades); it's a bet on their
  // own historical behavior, which can be wrong on any single trade. The
  // existing sniper_exit logic (follow them out the instant we see them
  // actually sell) still applies as a reactive backstop alongside this.
  preemptiveExitFractionPct: num("PREEMPTIVE_EXIT_FRACTION_PCT", 85),
  preemptiveExitMinSamples: num("PREEMPTIVE_EXIT_MIN_SAMPLES", 3),

  // ==== Dynamic take-profit ====
  // Instead of a flat TAKE_PROFIT_PCT, place the target somewhere in
  // [MIN_TAKE_PROFIT_PCT, MAX_TAKE_PROFIT_PCT] based on a deterministic
  // confidence score (src/confidence.ts) computed from the buy's dev/sniper
  // trust signals — and while a trusted sniper is still holding the same
  // token, keep aiming for that higher target; once none are left holding,
  // drop the bar back down to MIN_TAKE_PROFIT_PCT so a win gets taken rather
  // than risking it round-trip back down. See README for the tradeoffs.
  dynamicTakeProfitEnabled: bool("DYNAMIC_TAKE_PROFIT_ENABLED", true),
  minTakeProfitPct: num("MIN_TAKE_PROFIT_PCT", 50),
  // 50-100% matches "sell for 1.5x-2x" (tightened from an earlier 150% max
  // now that copy-trade-only mode's quick-flip strategy is the default).
  maxTakeProfitPct: num("MAX_TAKE_PROFIT_PCT", 100),
  // If a trusted sniper who was holding this token fully exits, follow them
  // out immediately regardless of current PnL (only applies while
  // dynamicTakeProfitEnabled).
  sniperExitEnabled: bool("SNIPER_EXIT_ENABLED", true),
  // Shorter hold cap that applies once/if no trusted sniper is currently
  // holding the token (never had one, or they've since left) — separate
  // from and always <= MAX_HOLD_TIME_MS, so an unsupported position doesn't
  // sit around waiting for the full hold window while chasing a big target
  // with no corroborating signal left.
  unsupportedMaxHoldMs: num("UNSUPPORTED_MAX_HOLD_MS", 180_000),

  // Manually-set SOL/USD rate used for the market-cap entry gate above. NOT
  // a live price feed — SOL is volatile, keep this reasonably current
  // yourself. Set near $76 as of when this was configured (Jul 2026).
  solUsdPrice: num("SOL_USD_PRICE", 76),

  // ==== Status snapshot (for the dashboard) ====
  // The main bot process writes a small snapshot of its live state here
  // periodically; the dashboard server (a separate process) reads it. Not
  // used for anything trading-related.
  statusFile: process.env.STATUS_FILE ?? "data/status.json",

  // ==== Web dashboard ====
  // A read-only status page, protected by HTTP Basic Auth. Runs as its own
  // process (`npm run dashboard`), separate from the bot. Set real
  // credentials in your own .env — do not commit them.
  dashboardPort: num("DASHBOARD_PORT", 3000),
  dashboardUsername: process.env.DASHBOARD_USERNAME ?? "",
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? "",
};

export function assertLiveConfig(): void {
  if (config.dryRun) return;
  const missing: string[] = [];
  if (!config.privateKey) missing.push("PRIVATE_KEY");
  if (!config.rpcUrl) missing.push("RPC_URL");
  if (missing.length > 0) {
    throw new Error(
      `DRY_RUN=false but missing required env vars for live trading: ${missing.join(", ")}`
    );
  }
}
