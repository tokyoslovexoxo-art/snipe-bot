import { config, assertLiveConfig } from "./config";
import { logger } from "./logger";
import { PumpPortalSocket } from "./pumpportal/socket";
import { Trader } from "./pumpportal/trade";
import { PaperWallet } from "./paperWallet";
import { DiscoveryService, QualifiedSignal } from "./discovery";
import { PositionManager } from "./positionManager";

function printBanner(): void {
  const lines = [
    "==================================================",
    ` Pump.fun snipe bot — mode: ${config.dryRun ? "DRY RUN (paper trading, no real funds)" : "LIVE (real SOL at risk)"}`,
    ` Buy size:        ${config.buyAmountSol} SOL`,
    ` Take profit:     +${config.takeProfitPct}%`,
    ` Stop loss:       -${config.stopLossPct}%`,
    ` Max hold time:   ${config.maxHoldTimeMs / 1000}s (safety net if TP/SL never hit)`,
    ` Min volume:      ${config.minVolumeSol} SOL within ${config.volumeWindowMs / 1000}s of launch`,
    ` Max positions:   ${config.maxConcurrentPositions}`,
    ` Max dev hold:    ${config.maxDevHoldPct}% (anti-rug filter)`,
    "==================================================",
  ];
  for (const line of lines) logger.info(line);

  if (!config.dryRun) {
    logger.warn(
      "LIVE MODE: this bot will spend real SOL automatically. Memecoin bonding-curve " +
        "tokens are extremely volatile and can go to zero; stop-loss is not guaranteed " +
        "to execute at exactly -2% due to slippage and network latency."
    );
  }
}

async function main(): Promise<void> {
  assertLiveConfig();
  printBanner();

  const socket = new PumpPortalSocket();
  const paperWallet = config.dryRun ? new PaperWallet() : null;
  const trader = new Trader(paperWallet);
  const discovery = new DiscoveryService(socket);
  const positionManager = new PositionManager(socket, trader);

  discovery.on("qualified", (signal: QualifiedSignal) => {
    void positionManager.onQualified(signal);
  });

  discovery.start();
  positionManager.start();
  socket.connect();

  if (config.dryRun) {
    const reportInterval = setInterval(() => {
      logger.info(
        `[DRY RUN] Paper balance: ${paperWallet!.solBalance.toFixed(4)} SOL | Open positions: ${positionManager.openCount}`
      );
    }, 30_000);
    reportInterval.unref();
  }

  const shutdown = () => {
    logger.info("Shutting down...");
    discovery.stop();
    positionManager.stop();
    socket.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error(`Fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
