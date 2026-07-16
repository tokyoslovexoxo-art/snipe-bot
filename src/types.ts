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

export type ExitReason = "take_profit" | "stop_loss" | "max_hold_time" | "manual";

export interface TradeResult {
  success: boolean;
  txSignature?: string;
  filledSol: number; // SOL spent (buy) or received (sell)
  filledTokens: number; // tokens received (buy) or sold (sell)
  pricePerToken: number; // SOL per token at fill
  error?: string;
}

export interface Position {
  mint: string;
  symbol: string;
  name: string;
  creatorWallet: string;
  entryPricePerToken: number;
  tokenAmount: number;
  solSpent: number;
  openedAt: number;
  currentPricePerToken: number;
  lastUpdatedAt: number;
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

export type TrustLevel = "blacklisted" | "trusted" | "neutral";

export interface ClosedPosition extends Position {
  closedAt: number;
  exitReason: ExitReason;
  exitPricePerToken: number;
  solReceived: number;
  pnlSol: number;
  pnlPct: number;
}
