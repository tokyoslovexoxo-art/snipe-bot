import { config, assertLiveConfig } from "./config";
import { logger } from "./logger";
import { PumpPortalSocket } from "./pumpportal/socket";
import { Trader } from "./pumpportal/trade";
import { PaperWallet } from "./paperWallet";
import { DiscoveryService, QualifiedSignal } from "./discovery";
import { PositionManager } from "./positionManager";
import { DevReputationStore } from "./devReputation";
import { AdaptiveTuner } from "./adaptiveTuner";
import { SniperReputationStore } from "./sniperReputation";
import { SniperTracker } from "./sniperTracker";

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
    ` Dev tracking:    ${config.devTrackingEnabled ? "on" : "off"} (remembers devs across restarts)`,
    ` Adaptive tuning: ${config.adaptiveTuningEnabled ? "on" : "off"} (bounded, rule-based filter nudging)`,
    ` Sniper tracking: ${config.sniperTrackingEnabled ? "on" : "off"}${config.prioritySniperWallets.length > 0 ? ` (${config.prioritySniperWallets.length} priority wallet(s) seeded)` : ""}`,
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
  const devReputation = new DevReputationStore();
  const tuner = new AdaptiveTuner();
  const sniperReputation = new SniperReputationStore();
  const sniperTracker = new SniperTracker(socket, sniperReputation);
  const discovery = new DiscoveryService(socket, devReputation, tuner, sniperTracker);
  const positionManager = new PositionManager(socket, trader, devReputation, tuner, sniperTracker);

  discovery.on("qualified", (signal: QualifiedSignal) => {
    void positionManager.onQualified(signal);
  });

  discovery.start();
  positionManager.start();
  sniperTracker.start();
  socket.connect();

  const reportInterval = setInterval(() => {
    const devSummary = devReputation.summary();
    const sniperSummary = sniperReputation.summary();
    const tuned = tuner.get();
    const balanceLine = config.dryRun
      ? `Paper balance: ${paperWallet!.solBalance.toFixed(4)} SOL | `
      : "";
    logger.info(
      `[STATUS] ${balanceLine}Open positions: ${positionManager.openCount} | ` +
        `Known devs: ${devSummary.totalDevs} (${devSummary.trusted} trusted, ${devSummary.blacklisted} blacklisted) | ` +
        `Known snipers: ${sniperSummary.totalSnipers} (${sniperSummary.trusted} trusted) | ` +
        `Tuned filters: minVolume=${tuned.minVolumeSol.toFixed(3)} SOL, maxDevHold=${tuned.maxDevHoldPct.toFixed(1)}%`
    );
  }, 30_000);
  reportInterval.unref();

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
