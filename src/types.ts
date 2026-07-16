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
  | "partial_take_profit"
  | "stop_loss"
  | "breakeven_stop"
  | "max_hold_time"
  | "sniper_exit"
  | "unsupported_timeout"
  | "manual";

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
export type QualificationPath = "volume" | "dev_trusted" | "sniper_trusted";

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
  // Tokens/cost-basis currently held. Both shrink proportionally on a
  // partial take-profit sell — see positionManager.ts's takePartialProfit.
  tokenAmount: number;
  solSpent: number;
  // Immutable snapshot of the original total cost basis at buy time, used
  // to compute the overall (cumulative) trade PnL% even after partial
  // exits have shrunk solSpent down to the remainder's cost basis.
  originalSolSpent: number;
  // Cumulative SOL PnL already realized from any partial sell(s) on this
  // position. Added to the final sell's own PnL to get the trade's total.
  realizedPnlSolSoFar: number;
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
  // True once PARTIAL_TAKE_PROFIT_SELL_PCT has been sold at
  // MIN_TAKE_PROFIT_PCT under the extended-hold gate. Moves the remainder's
  // effective stop-loss to breakeven (0%) instead of -STOP_LOSS_PCT.
  hasTakenPartialProfit: boolean;
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
  tunedParams: { minVolumeSol: number; maxDevHoldPct: number };
}

export interface ClosedPosition extends Position {
  closedAt: number;
  exitReason: ExitReason;
  exitPricePerToken: number;
  // Proceeds from THIS sell only (partial or final stage).
  solReceived: number;
  // THIS stage's own PnL, relative to the cost basis it sold against.
  stagePnlSol: number;
  stagePnlPct: number;
  // Cumulative PnL for the trade as a whole as of this log entry — equal to
  // stagePnlSol/stagePnlPct on a first/only exit, but on the FINAL entry of
  // a staged exit this includes the earlier partial sell(s) too, computed
  // against originalSolSpent (the true total investment). This is the
  // number that should be used for "did this trade make money overall."
  pnlSol: number;
  pnlPct: number;
  // True for a partial_take_profit log row (position stayed open after);
  // false/absent on the row that actually closed the position out.
  isPartialExit: boolean;
}
