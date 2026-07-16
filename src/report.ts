import { config } from "./config";
import { loadClosedTrades, signed, summarizeWindows, WindowStats } from "./pnlStats";

/**
 * Standalone PnL summary over trades.jsonl. Run with `npm run report`
 * (optionally pass a different log file path as the first arg).
 */
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

  const { last24h, last7d, allTime } = summarizeWindows(allTrades);

  console.log(`PnL report from ${logFile}`);
  console.log(formatStats(last24h));
  console.log(formatStats(last7d));
  console.log(formatStats(allTime));
}

main();
