// Shapes are based on PumpPortal's publicly documented websocket/trading API.
// PumpPortal's own docs site was unreachable for a final field-by-field check
// while building this (blocked the fetch), so parsing below is defensive:
// unexpected/missing fields are tolerated rather than crashing the bot. Log
// a few raw messages (see DiscoveryService) and compare against
// https://pumpportal.fun/data-api/real-time before relying on this in LIVE
// mode.

export interface NewTokenEvent {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: string; // "create"
  name: string;
  symbol: string;
  uri: string;
  initialBuy: number; // token amount the creator bought at launch
  solAmount: number; // SOL the creator spent on that initial buy
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
}

export interface TokenTradeEvent {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: "buy" | "sell";
  tokenAmount: number;
  solAmount: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
}

export type ExitReason =
  | "take_profit"
  | "stop_loss"
  | "max_hold_time"
  | "sniper_exit"
  | "unsupported_timeout"
  | "manual"
  // Closed preemptively, based on a priority wallet's own historical
  // average hold time — see config.preemptiveExitFractionPct. Only used in
  // copy-trade-only mode.
  | "preemptive_exit"
  // No longer produced (the staged partial-take-profit mechanism was
  // removed in favor of a single full sell), kept here only so old
  // trades.jsonl entries with these values still type-check if re-read.
  | "partial_take_profit"
  | "breakeven_stop";

export interface TradeResult {
  success: boolean;
  txSignature?: string;
  filledSol: number; // SOL spent (buy) or received (sell)
  filledTokens: number; // tokens received (buy) or sold (sell)
  pricePerToken: number; // SOL per token at fill
  error?: string;
}

export type TrustLevel = "blacklisted" | "trusted" | "neutral";

// Which mechanism qualified this token for a buy — useful on its own as a
// training feature later (fast-tracked buys are a different risk profile
// than volume-confirmed ones).
export type QualificationPath = "volume" | "market_cap" | "dev_trusted" | "sniper_trusted";

/**
 * Snapshot of everything that informed a buy decision, captured at
 * qualification time. Carried through onto Position/ClosedPosition so the
 * full trade log is self-contained — no need to cross-reference devs.json /
 * snipers.json / tuning.json (which only hold current state, not history)
 * to reconstruct "what did the bot know when it bought this."
 */
export interface DecisionContext {
  qualificationPath: QualificationPath;
  devHoldPctAtBuy: number;
  devTrustLevelAtBuy: TrustLevel;
  devWinsAtBuy: number;
  devLossesAtBuy: number;
  devTotalPnlSolAtBuy: number;
  triggeringSniperWallet: string | null;
  sniperWinsAtBuy: number | null;
  sniperLossesAtBuy: number | null;
  volumeAtQualificationSol: number;
  timeToQualifyMs: number;
  tunedMinVolumeSolAtBuy: number;
  tunedMaxDevHoldPctAtBuy: number;
  marketCapSolAtQualification: number;
}

export interface Position extends DecisionContext {
  mint: string;
  symbol: string;
  name: string;
  creatorWallet: string;
  entryPricePerToken: number;
  tokenAmount: number;
  solSpent: number;
  openedAt: number;
  currentPricePerToken: number;
  currentMarketCapSol: number;
  lastUpdatedAt: number;
  // Deterministic 0..1 score (src/confidence.ts) computed at buy time from
  // this trade's DecisionContext — not a learned/black-box value, see README.
  confidenceScore: number;
  // Where confidenceScore places the take-profit target within
  // [MIN_TAKE_PROFIT_PCT, MAX_TAKE_PROFIT_PCT].
  targetTakeProfitPct: number;
  // Sticky: true once any trusted sniper has been observed holding this
  // mint while we hold it. Used to tell "never had sniper backing" (target
  // stands on confidence alone) apart from "had it and lost it" (drop to
  // MIN_TAKE_PROFIT_PCT) — see positionManager.ts.
  sniperSupportSeen: boolean;
  // Set at buy time, only for copy-trades of a PRIORITY_SNIPER_WALLETS
  // wallet with enough observed sell history: the timestamp at which we
  // preemptively close, targeting a bit before that wallet's own average
  // hold time. Null if not applicable / not enough data yet.
  preemptiveExitAtMs: number | null;
}

export interface DevRecord {
  wallet: string;
  tokensLaunched: number;
  tokensBought: number;
  wins: number;
  losses: number;
  totalPnlSol: number;
  lastSeenAt: number;
}

export interface SniperRecord {
  wallet: string;
  roundTrips: number;
  wins: number;
  losses: number;
  totalPnlSol: number;
  lastSeenAt: number;
  // Running averages describing the situations this wallet buys into —
  // only populated for manually-seeded PRIORITY_SNIPER_WALLETS (see
  // SniperTracker). This is the "why does this wallet pick what it picks"
  // analysis: built entirely from observed data, not a model/prediction.
  buyContextSamples: number;
  avgMarketCapUsdAtBuy: number;
  avgDevHoldPctAtBuy: number;
  avgTimeSinceLaunchMsAtBuy: number;
  // Same idea, for this wallet's observed sells — only populated for
  // PRIORITY_SNIPER_WALLETS. Feeds the preemptive-exit timing AND take-
  // profit targets (see config.preemptiveExit* / positionManager.ts).
  sellContextSamples: number;
  avgMarketCapUsdAtSell: number;
  avgTimeSinceLaunchMsAtSell: number;
}

/**
 * Periodic snapshot the main bot process writes to disk (config.statusFile)
 * purely for the dashboard server (a separate process) to read. Carries no
 * trading behavior of its own.
 */
export interface StatusSnapshot {
  updatedAt: number;
  dryRun: boolean;
  paperBalanceSol: number | null;
  openPositions: Position[];
  devSummary: { totalDevs: number; trusted: number; blacklisted: number };
  sniperSummary: { totalSnipers: number; trusted: number };
  tunedParams: {
    minVolumeSol: number;
    maxDevHoldPct: number;
    unsupportedMaxHoldMs: number;
    marketCapRangeUsd: { minUsd: number; maxUsd: number };
  };
}

export interface ClosedPosition extends Position {
  closedAt: number;
  exitReason: ExitReason;
  exitPricePerToken: number;
  solReceived: number;
  pnlSol: number;
  pnlPct: number;
}
