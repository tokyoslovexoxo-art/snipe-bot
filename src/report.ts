import * as fs from "fs";
import { config } from "./config";
import { ClosedPosition } from "./types";

interface WindowStats {
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

/**
 * Standalone PnL summary over trades.jsonl. Run with `npm run report`
 * (optionally pass a different log file path as the first arg).
 *
 * Only counts final-exit rows (isPartialExit === false): a staged exit
 * (see positionManager.ts) logs an intermediate partial_take_profit row
 * plus a final row, and the final row's pnlSol/pnlPct already reflect the
 * whole trade's cumulative result. Counting both rows would double-count
 * partial exits.
 */
function loadClosedTrades(logFile: string): ClosedPosition[] {
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

function summarize(label: string, trades: ClosedPosition[]): WindowStats {
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

function signed(n: number, decimals = 4): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(decimals)}`;
}

function formatStats(stats: WindowStats): string {
  const lines: string[] = [`\n=== ${stats.label} ===`];

  if (stats.trades === 0) {
    lines.push("No closed trades in this window.");
    return lines.join("\n");
  }

  lines.push(
    `Trades: ${stats.trades} (${stats.wins}W / ${stats.losses}L, ${stats.winRatePct.toFixed(1)}% win rate)`
  );
  lines.push(
    `Total PnL: ${signed(stats.totalPnlSol)} SOL (avg ${signed(stats.avgPnlSol)} SOL/trade)`
  );
  if (stats.bestTrade) {
    lines.push(
      `Best:  ${stats.bestTrade.symbol} ${signed(stats.bestTrade.pnlSol)} SOL (${signed(stats.bestTrade.pnlPct, 1)}%)`
    );
  }
  if (stats.worstTrade) {
    lines.push(
      `Worst: ${stats.worstTrade.symbol} ${signed(stats.worstTrade.pnlSol)} SOL (${signed(stats.worstTrade.pnlPct, 1)}%)`
    );
  }
  const reasonSummary = Object.entries(stats.byExitReason)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ");
  lines.push(`Exit reasons: ${reasonSummary}`);

  return lines.join("\n");
}

function main(): void {
  const logFile = process.argv[2] ?? config.logFile;
  const allTrades = loadClosedTrades(logFile);

  if (allTrades.length === 0) {
    console.log(`No closed trades found in ${logFile}.`);
    return;
  }

  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const last24h = allTrades.filter((t) => now - t.closedAt <= DAY_MS);
  const last7d = allTrades.filter((t) => now - t.closedAt <= 7 * DAY_MS);

  console.log(`PnL report from ${logFile}`);
  console.log(formatStats(summarize("Last 24 hours", last24h)));
  console.log(formatStats(summarize("Last 7 days", last7d)));
  console.log(formatStats(summarize("All-time", allTrades)));
}

main();
