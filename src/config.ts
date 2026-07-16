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
  takeProfitPct: num("TAKE_PROFIT_PCT", 20),
  stopLossPct: num("STOP_LOSS_PCT", 2),
  minVolumeSol: num("MIN_VOLUME_SOL", 1),
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
