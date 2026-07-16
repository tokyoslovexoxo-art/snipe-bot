import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { config } from "./config";
import { loadClosedTrades, summarizeWindows } from "./pnlStats";
import { StatusSnapshot } from "./types";

const PAGE_PATH = path.join(__dirname, "dashboard.html");
const RECENT_TRADES_LIMIT = 20;

/**
 * Read-only status dashboard, protected by HTTP Basic Auth. Runs as its own
 * process (`npm run dashboard`) — completely separate from the trading bot.
 * It only ever reads data the bot already writes (config.statusFile,
 * config.logFile); it never touches trading logic or state.
 *
 * Security note: HTTP Basic Auth sends credentials base64-encoded, not
 * encrypted — fine over an SSH tunnel or localhost, but don't expose this
 * port directly to the open internet over plain HTTP. See README.
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Still do a comparison of equal length so failure timing doesn't leak
    // the expected credential length.
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function isAuthorized(req: http.IncomingMessage): boolean {
  if (!config.dashboardUsername || !config.dashboardPassword) return false;

  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Basic ")) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
  } catch {
    return false;
  }

  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);

  return (
    timingSafeEqualStrings(user, config.dashboardUsername) &&
    timingSafeEqualStrings(pass, config.dashboardPassword)
  );
}

function readStatus(): StatusSnapshot | null {
  try {
    if (!fs.existsSync(config.statusFile)) return null;
    return JSON.parse(fs.readFileSync(config.statusFile, "utf-8")) as StatusSnapshot;
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  if (!isAuthorized(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="snipe-bot dashboard"',
      "Content-Type": "text/plain",
    });
    res.end("Authentication required.");
    return;
  }

  if (req.url === "/api/status") {
    const status = readStatus();
    const trades = loadClosedTrades(config.logFile);
    const windows = summarizeWindows(trades);
    const recentTrades = trades
      .slice()
      .sort((a, b) => b.closedAt - a.closedAt)
      .slice(0, RECENT_TRADES_LIMIT);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status, windows, recentTrades }));
    return;
  }

  fs.readFile(PAGE_PATH, "utf-8", (err, html) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load dashboard page.");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
});

function main(): void {
  if (!config.dashboardUsername || !config.dashboardPassword) {
    console.error(
      "DASHBOARD_USERNAME and DASHBOARD_PASSWORD must both be set in your .env before starting the dashboard."
    );
    process.exit(1);
  }
  server.listen(config.dashboardPort, () => {
    console.log(
      `Dashboard listening on http://0.0.0.0:${config.dashboardPort} (protected by Basic Auth). ` +
        `See README for why you should reach this over an SSH tunnel rather than opening the port publicly.`
    );
  });
}

main();
