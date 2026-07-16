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
  minVolumeSol: num("MIN_VOLUME_SOL", 0.2),
  volumeWindowMs: num("VOLUME_WINDOW_MS", 60_000),
  maxConcurrentPositions: num("MAX_CONCURRENT_POSITIONS", 3),
  maxHoldTimeMs: num("MAX_HOLD_TIME_MS", 600_000),
  maxDevHoldPct: num("MAX_DEV_HOLD_PCT", 30),
  slippagePct: num("SLIPPAGE_PCT", 10),
  priorityFeeSol: num("PRIORITY_FEE_SOL", 0.0005),
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
  maxTakeProfitPct: num("MAX_TAKE_PROFIT_PCT", 150),
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

  // ==== Staged (partial) profit-taking ====
  // At MIN_TAKE_PROFIT_PCT, the default behavior is to sell the WHOLE
  // position — take the win rather than risk it giving it back. The bot
  // only holds part of the position for a bigger target if BOTH:
  //   - confidenceScore >= EXTENDED_HOLD_MIN_CONFIDENCE_PCT/100, AND
  //   - the token's current market cap (converted from PumpPortal's
  //     SOL-denominated marketCapSol using SOL_USD_PRICE below) is already
  //     at or above EXTENDED_HOLD_MIN_MARKET_CAP_USD.
  // This is a real-time confirmation check ("has it actually grown into
  // this range already"), not a prediction of where it WILL go — this bot
  // has no ability to forecast future market cap, see README.
  // When the gate passes, PARTIAL_TAKE_PROFIT_SELL_PCT of the position is
  // sold at MIN_TAKE_PROFIT_PCT to lock in a real, banked gain; the
  // remainder's stop-loss moves to breakeven (0%) and its target becomes
  // the same confidence/sniper-support-scaled logic as before, up to
  // MAX_TAKE_PROFIT_PCT.
  extendedHoldMinConfidencePct: num("EXTENDED_HOLD_MIN_CONFIDENCE_PCT", 80),
  extendedHoldMinMarketCapUsd: num("EXTENDED_HOLD_MIN_MARKET_CAP_USD", 10_000),
  partialTakeProfitSellPct: num("PARTIAL_TAKE_PROFIT_SELL_PCT", 50),
  // Manually-set SOL/USD rate used only for the market-cap gate above.
  // NOT a live price feed — SOL is volatile, keep this reasonably current
  // yourself. Set near $76 as of when this was configured (Jul 2026).
  solUsdPrice: num("SOL_USD_PRICE", 76),
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
