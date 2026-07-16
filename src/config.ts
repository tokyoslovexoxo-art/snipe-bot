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
