import * as fs from "fs";
import { ClosedPosition } from "./types";

export interface WindowStats {
  label: string;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  totalPnlSol: number;
  avgPnlSol: number;
  bestTrade: ClosedPosition | null;
  worstTrade: ClosedPosition | null;
  byExitReason: Record<string, number>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Only counts final-exit rows (isPartialExit === false): a staged exit
 * (see positionManager.ts) logs an intermediate partial_take_profit row
 * plus a final row, and the final row's pnlSol/pnlPct already reflect the
 * whole trade's cumulative result. Counting both rows would double-count
 * partial exits.
 */
export function loadClosedTrades(logFile: string): ClosedPosition[] {
  if (!fs.existsSync(logFile)) return [];
  const lines = fs
    .readFileSync(logFile, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  const records: ClosedPosition[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as ClosedPosition);
    } catch {
      // skip malformed/partial lines
    }
  }
  return records.filter((r) => !r.isPartialExit);
}

export function summarize(label: string, trades: ClosedPosition[]): WindowStats {
  const wins = trades.filter((t) => t.pnlSol > 0).length;
  const losses = trades.length - wins;
  const totalPnlSol = trades.reduce((sum, t) => sum + t.pnlSol, 0);

  const byExitReason: Record<string, number> = {};
  for (const t of trades) {
    byExitReason[t.exitReason] = (byExitReason[t.exitReason] ?? 0) + 1;
  }

  let bestTrade: ClosedPosition | null = null;
  let worstTrade: ClosedPosition | null = null;
  for (const t of trades) {
    if (!bestTrade || t.pnlSol > bestTrade.pnlSol) bestTrade = t;
    if (!worstTrade || t.pnlSol < worstTrade.pnlSol) worstTrade = t;
  }

  return {
    label,
    trades: trades.length,
    wins,
    losses,
    winRatePct: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    totalPnlSol,
    avgPnlSol: trades.length > 0 ? totalPnlSol / trades.length : 0,
    bestTrade,
    worstTrade,
    byExitReason,
  };
}

export function summarizeWindows(allTrades: ClosedPosition[]): {
  last24h: WindowStats;
  last7d: WindowStats;
  allTime: WindowStats;
} {
  const now = Date.now();
  const last24h = allTrades.filter((t) => now - t.closedAt <= DAY_MS);
  const last7d = allTrades.filter((t) => now - t.closedAt <= 7 * DAY_MS);

  return {
    last24h: summarize("Last 24 hours", last24h),
    last7d: summarize("Last 7 days", last7d),
    allTime: summarize("All-time", allTrades),
  };
}

export function signed(n: number, decimals = 4): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(decimals)}`;
}
