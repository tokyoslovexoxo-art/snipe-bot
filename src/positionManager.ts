import { config } from "./config";
import { logger } from "./logger";
import { PumpPortalSocket } from "./pumpportal/socket";
import { Trader } from "./pumpportal/trade";
import { DevReputationStore } from "./devReputation";
import { AdaptiveTuner } from "./adaptiveTuner";
import { SniperTracker } from "./sniperTracker";
import { ClosedPosition, ExitReason, Position, TokenTradeEvent } from "./types";
import { QualifiedSignal } from "./discovery";

function priceFromCurve(vSol: number, vTokens: number): number {
  if (!vTokens || vTokens <= 0) return 0;
  return vSol / vTokens;
}

/**
 * Owns all open positions: buys in on a qualified signal (respecting the
 * concurrent-position cap), tracks live price via the trade event stream,
 * and sells on take-profit, stop-loss, or the max-hold-time safety net.
 */
export class PositionManager {
  private positions = new Map<string, Position>();
  private closing = new Set<string>();
  private holdTimeCheck: NodeJS.Timeout | null = null;

  constructor(
    private socket: PumpPortalSocket,
    private trader: Trader,
    private devReputation: DevReputationStore,
    private tuner: AdaptiveTuner,
    private sniperTracker: SniperTracker
  ) {}

  start(): void {
    this.socket.on("trade", (evt: TokenTradeEvent) => this.handleTrade(evt));
    this.holdTimeCheck = setInterval(() => this.checkHoldTimes(), 1_000);
  }

  stop(): void {
    if (this.holdTimeCheck) clearInterval(this.holdTimeCheck);
  }

  get openCount(): number {
    return this.positions.size;
  }

  async onQualified(signal: QualifiedSignal): Promise<void> {
    if (this.positions.has(signal.mint)) return;
    if (this.positions.size >= config.maxConcurrentPositions) {
      logger.info(
        `Skipping ${signal.symbol}: at max concurrent positions (${config.maxConcurrentPositions}).`
      );
      return;
    }

    const result = await this.trader.buy(signal.mint, config.buyAmountSol, signal.currentPricePerToken);
    if (!result.success) {
      logger.error(`Buy failed for ${signal.symbol} (${signal.mint}): ${result.error}`);
      return;
    }

    this.socket.watchMint(signal.mint);
    if (signal.creatorWallet) this.devReputation.recordBuy(signal.creatorWallet);

    const now = Date.now();
    const position: Position = {
      mint: signal.mint,
      symbol: signal.symbol,
      name: signal.name,
      creatorWallet: signal.creatorWallet,
      entryPricePerToken: result.pricePerToken,
      tokenAmount: result.filledTokens,
      solSpent: result.filledSol,
      openedAt: now,
      currentPricePerToken: result.pricePerToken,
      lastUpdatedAt: now,
      qualificationPath: signal.qualificationPath,
      devHoldPctAtBuy: signal.devHoldPctAtBuy,
      devTrustLevelAtBuy: signal.devTrustLevelAtBuy,
      devWinsAtBuy: signal.devWinsAtBuy,
      devLossesAtBuy: signal.devLossesAtBuy,
      devTotalPnlSolAtBuy: signal.devTotalPnlSolAtBuy,
      triggeringSniperWallet: signal.triggeringSniperWallet,
      sniperWinsAtBuy: signal.sniperWinsAtBuy,
      sniperLossesAtBuy: signal.sniperLossesAtBuy,
      volumeAtQualificationSol: signal.volumeAtQualificationSol,
      timeToQualifyMs: signal.timeToQualifyMs,
      tunedMinVolumeSolAtBuy: signal.tunedMinVolumeSolAtBuy,
      tunedMaxDevHoldPctAtBuy: signal.tunedMaxDevHoldPctAtBuy,
    };
    this.positions.set(signal.mint, position);
    logger.info(
      `OPENED ${position.symbol} (${position.mint.slice(0, 8)}...) ` +
        `${position.solSpent.toFixed(4)} SOL @ ${position.entryPricePerToken.toExponential(4)} SOL/token`
    );
  }

  private handleTrade(evt: TokenTradeEvent): void {
    const position = this.positions.get(evt.mint);
    if (!position) return;

    if (typeof evt.vSolInBondingCurve === "number" && typeof evt.vTokensInBondingCurve === "number") {
      position.currentPricePerToken = priceFromCurve(evt.vSolInBondingCurve, evt.vTokensInBondingCurve);
      position.lastUpdatedAt = Date.now();
    }

    this.evaluateExit(position);
  }

  private checkHoldTimes(): void {
    const now = Date.now();
    for (const position of this.positions.values()) {
      if (now - position.openedAt >= config.maxHoldTimeMs) {
        void this.closePosition(position, "max_hold_time");
      }
    }
  }

  private evaluateExit(position: Position): void {
    const pnlPct =
      ((position.currentPricePerToken - position.entryPricePerToken) / position.entryPricePerToken) * 100;

    if (pnlPct >= config.takeProfitPct) {
      void this.closePosition(position, "take_profit");
    } else if (pnlPct <= -config.stopLossPct) {
      void this.closePosition(position, "stop_loss");
    }
  }

  private async closePosition(position: Position, reason: ExitReason): Promise<void> {
    if (this.closing.has(position.mint)) return;
    this.closing.add(position.mint);

    try {
      const result = await this.trader.sell(
        position.mint,
        position.currentPricePerToken,
        position.tokenAmount
      );

      if (!result.success) {
        logger.error(
          `Sell failed for ${position.symbol} (${position.mint}), reason=${reason}: ${result.error}. ` +
            `Position remains open and will be retried on the next price update.`
        );
        return;
      }

      this.positions.delete(position.mint);
      this.socket.unwatchMint(position.mint);
      this.sniperTracker.stopTracking(position.mint);

      const pnlSol = result.filledSol - position.solSpent;
      const pnlPct = (pnlSol / position.solSpent) * 100;
      const closed: ClosedPosition = {
        ...position,
        closedAt: Date.now(),
        exitReason: reason,
        exitPricePerToken: result.pricePerToken,
        solReceived: result.filledSol,
        pnlSol,
        pnlPct,
      };
      logger.trade(closed);

      if (position.creatorWallet) {
        this.devReputation.recordOutcome(position.creatorWallet, pnlSol, pnlSol > 0);
      }
      this.tuner.recordClose(closed);
    } finally {
      this.closing.delete(position.mint);
    }
  }
}
