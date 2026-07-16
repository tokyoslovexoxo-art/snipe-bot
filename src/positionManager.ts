import { config } from "./config";
import { logger } from "./logger";
import { PumpPortalSocket } from "./pumpportal/socket";
import { Trader } from "./pumpportal/trade";
import { DevReputationStore } from "./devReputation";
import { AdaptiveTuner } from "./adaptiveTuner";
import { SniperTracker, TrustedSniperSellSignal } from "./sniperTracker";
import { computeConfidenceScore, targetTakeProfitFromScore } from "./confidence";
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
    this.sniperTracker.on("trustedSell", (signal: TrustedSniperSellSignal) =>
      this.handleTrustedSniperSell(signal)
    );
    this.holdTimeCheck = setInterval(() => this.checkHoldTimes(), 1_000);
  }

  stop(): void {
    if (this.holdTimeCheck) clearInterval(this.holdTimeCheck);
  }

  get openCount(): number {
    return this.positions.size;
  }

  /** Read-only snapshot of currently open positions, for status/dashboard use. */
  getOpenPositions(): Position[] {
    return [...this.positions.values()].map((p) => ({ ...p }));
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

    const confidenceScore = computeConfidenceScore(signal);
    const targetTakeProfitPct = targetTakeProfitFromScore(
      confidenceScore,
      config.minTakeProfitPct,
      config.maxTakeProfitPct
    );

    const now = Date.now();
    const position: Position = {
      mint: signal.mint,
      symbol: signal.symbol,
      name: signal.name,
      creatorWallet: signal.creatorWallet,
      entryPricePerToken: result.pricePerToken,
      tokenAmount: result.filledTokens,
      solSpent: result.filledSol,
      originalSolSpent: result.filledSol,
      realizedPnlSolSoFar: 0,
      openedAt: now,
      currentPricePerToken: result.pricePerToken,
      currentMarketCapSol: signal.marketCapSolAtQualification,
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
      marketCapSolAtQualification: signal.marketCapSolAtQualification,
      confidenceScore,
      targetTakeProfitPct,
      sniperSupportSeen: this.sniperTracker.hasTrustedHolder(signal.mint),
      hasTakenPartialProfit: false,
    };
    this.positions.set(signal.mint, position);
    logger.info(
      `OPENED ${position.symbol} (${position.mint.slice(0, 8)}...) ` +
        `${position.solSpent.toFixed(4)} SOL @ ${position.entryPricePerToken.toExponential(4)} SOL/token ` +
        `(confidence=${confidenceScore.toFixed(2)}, target=+${targetTakeProfitPct.toFixed(0)}%)`
    );
  }

  private handleTrade(evt: TokenTradeEvent): void {
    const position = this.positions.get(evt.mint);
    if (!position) return;

    if (typeof evt.vSolInBondingCurve === "number" && typeof evt.vTokensInBondingCurve === "number") {
      position.currentPricePerToken = priceFromCurve(evt.vSolInBondingCurve, evt.vTokensInBondingCurve);
      position.lastUpdatedAt = Date.now();
    }
    if (typeof evt.marketCapSol === "number") {
      position.currentMarketCapSol = evt.marketCapSol;
    }

    this.evaluateExit(position);
  }

  private checkHoldTimes(): void {
    const now = Date.now();
    for (const position of this.positions.values()) {
      if (now - position.openedAt >= config.maxHoldTimeMs) {
        void this.closePosition(position, "max_hold_time");
        continue;
      }
      if (
        config.dynamicTakeProfitEnabled &&
        now - position.openedAt >= config.unsupportedMaxHoldMs &&
        !this.sniperTracker.hasTrustedHolder(position.mint)
      ) {
        void this.closePosition(position, "unsupported_timeout");
      }
    }
  }

  private handleTrustedSniperSell(signal: TrustedSniperSellSignal): void {
    if (!config.dynamicTakeProfitEnabled || !config.sniperExitEnabled) return;
    if (!signal.fullyExited) return; // partial sells just lower the effective target on the next price tick

    const position = this.positions.get(signal.mint);
    if (!position) return;

    logger.info(
      `Trusted sniper ${signal.wallet.slice(0, 8)}... fully exited ${position.symbol} — following out.`
    );
    void this.closePosition(position, "sniper_exit");
  }

  /**
   * Where the take-profit bar sits right now for this position:
   * - Dynamic mode off: the flat legacy TAKE_PROFIT_PCT.
   * - Never had any confirmed trusted-sniper backing: stand on the
   *   confidence-based target alone — sniper activity was never part of
   *   this trade's thesis, so its absence isn't held against it.
   * - Had backing and still has it: keep aiming for the confidence target.
   * - Had backing and lost it: drop to MIN_TAKE_PROFIT_PCT — the
   *   corroborating signal that justified aiming higher is gone.
   */
  private effectiveTakeProfitPct(position: Position): number {
    if (!config.dynamicTakeProfitEnabled) return config.takeProfitPct;

    const currentlySupported = this.sniperTracker.hasTrustedHolder(position.mint);
    if (currentlySupported) position.sniperSupportSeen = true;

    if (!position.sniperSupportSeen) return position.targetTakeProfitPct;
    return currentlySupported ? position.targetTakeProfitPct : config.minTakeProfitPct;
  }

  /**
   * Whether we hold the remainder for a bigger target (partial sell now,
   * keep the rest) instead of taking the full win at MIN_TAKE_PROFIT_PCT.
   * Deliberately a REAL-TIME confirmation check ("has this already grown
   * into the target zone"), not a prediction of where it's going — this bot
   * cannot forecast future market cap, see README.
   */
  private qualifiesForExtendedHold(position: Position): boolean {
    if (position.confidenceScore * 100 < config.extendedHoldMinConfidencePct) return false;
    const currentMarketCapUsd = position.currentMarketCapSol * config.solUsdPrice;
    return currentMarketCapUsd >= config.extendedHoldMinMarketCapUsd;
  }

  private evaluateExit(position: Position): void {
    const pnlPct =
      ((position.currentPricePerToken - position.entryPricePerToken) / position.entryPricePerToken) * 100;

    // Once a partial profit has been banked, the remainder's downside is
    // capped at breakeven (0%) instead of -STOP_LOSS_PCT — don't risk a
    // real, already-secured gain by giving the stop-loss room to bite again.
    const effectiveStopLossPct = position.hasTakenPartialProfit ? 0 : config.stopLossPct;
    if (pnlPct <= -effectiveStopLossPct) {
      void this.closePosition(position, position.hasTakenPartialProfit ? "breakeven_stop" : "stop_loss");
      return;
    }

    if (position.hasTakenPartialProfit) {
      // Already banked the base profit; the remainder chases the bigger
      // confidence/sniper-support-scaled target from here.
      if (pnlPct >= this.effectiveTakeProfitPct(position)) {
        void this.closePosition(position, "take_profit");
      }
      return;
    }

    if (pnlPct >= config.minTakeProfitPct) {
      if (config.dynamicTakeProfitEnabled && this.qualifiesForExtendedHold(position)) {
        void this.takePartialProfit(position);
      } else {
        // Default bias: take the whole win now rather than risk it holding
        // for more with no strong (80%+ confidence + real mcap growth)
        // reason to believe it's worth the extra exposure.
        void this.closePosition(position, "take_profit");
      }
    }
  }

  /** Sells PARTIAL_TAKE_PROFIT_SELL_PCT of the position, keeps the rest open. */
  private async takePartialProfit(position: Position): Promise<void> {
    if (this.closing.has(position.mint)) return;
    this.closing.add(position.mint);

    try {
      const sellPct = config.partialTakeProfitSellPct;
      const result = await this.trader.sell(
        position.mint,
        position.currentPricePerToken,
        position.tokenAmount,
        sellPct
      );

      if (!result.success) {
        logger.error(
          `Partial take-profit sell failed for ${position.symbol} (${position.mint}): ${result.error}. ` +
            `Position remains open and will be retried on the next price update.`
        );
        return;
      }

      const soldTokens = position.tokenAmount * (sellPct / 100);
      const costBasisOfSold = position.solSpent * (sellPct / 100);
      const stagePnlSol = result.filledSol - costBasisOfSold;
      const stagePnlPct = (stagePnlSol / costBasisOfSold) * 100;

      position.tokenAmount -= soldTokens;
      position.solSpent -= costBasisOfSold;
      position.realizedPnlSolSoFar += stagePnlSol;
      position.hasTakenPartialProfit = true;

      const partialRecord: ClosedPosition = {
        ...position,
        closedAt: Date.now(),
        exitReason: "partial_take_profit",
        exitPricePerToken: result.pricePerToken,
        solReceived: result.filledSol,
        stagePnlSol,
        stagePnlPct,
        pnlSol: position.realizedPnlSolSoFar,
        pnlPct: (position.realizedPnlSolSoFar / position.originalSolSpent) * 100,
        isPartialExit: true,
      };
      logger.trade(partialRecord);
      logger.info(
        `PARTIAL TAKE-PROFIT ${position.symbol} (${position.mint.slice(0, 8)}...): sold ${sellPct}%, ` +
          `holding remainder for up to +${config.maxTakeProfitPct}% (breakeven stop now active).`
      );
    } finally {
      this.closing.delete(position.mint);
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

      // Stage: this sell's own economics against the remaining cost basis.
      // Cumulative: the whole trade's result, including any earlier partial
      // sell(s) — this is the number that should drive dev/sniper reputation
      // and the adaptive tuner, not just this final slice.
      const stagePnlSol = result.filledSol - position.solSpent;
      const stagePnlPct = position.solSpent > 0 ? (stagePnlSol / position.solSpent) * 100 : 0;
      const totalPnlSol = position.realizedPnlSolSoFar + stagePnlSol;
      const totalPnlPct = (totalPnlSol / position.originalSolSpent) * 100;

      const closed: ClosedPosition = {
        ...position,
        closedAt: Date.now(),
        exitReason: reason,
        exitPricePerToken: result.pricePerToken,
        solReceived: result.filledSol,
        stagePnlSol,
        stagePnlPct,
        pnlSol: totalPnlSol,
        pnlPct: totalPnlPct,
        isPartialExit: false,
      };
      logger.trade(closed);

      if (position.creatorWallet) {
        this.devReputation.recordOutcome(position.creatorWallet, totalPnlSol, totalPnlSol > 0);
      }
      this.tuner.recordClose(closed);
    } finally {
      this.closing.delete(position.mint);
    }
  }
}
