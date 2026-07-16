import * as fs from "fs";
import { config } from "./config";
import { ClosedPosition } from "./types";

function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  info(msg: string): void {
    console.log(`[${timestamp()}] ${msg}`);
  },
  warn(msg: string): void {
    console.warn(`[${timestamp()}] WARN: ${msg}`);
  },
  error(msg: string): void {
    console.error(`[${timestamp()}] ERROR: ${msg}`);
  },
  trade(closed: ClosedPosition): void {
    const pnlSign = closed.pnlSol >= 0 ? "+" : "";
    this.info(
      `CLOSED ${closed.symbol} (${closed.mint.slice(0, 8)}...) reason=${closed.exitReason} ` +
        `pnl=${pnlSign}${closed.pnlSol.toFixed(4)} SOL (${pnlSign}${closed.pnlPct.toFixed(2)}%)`
    );
    const line = JSON.stringify({ ...closed, loggedAt: timestamp() });
    fs.appendFile(config.logFile, line + "\n", (err) => {
      if (err) this.error(`Failed to write trade log: ${err.message}`);
    });
  },
};
