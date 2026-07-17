import { config } from "./config";
import { logger } from "./logger";
import { PumpPortalSocket } from "./pumpportal/socket";
import { Trader } from "./pumpportal/trade";
import { DevReputationStore } from "./devReputation";
import { AdaptiveTuner } from "./adaptiveTuner";
import { SniperTracker, TrustedSniperSellSignal } from "./sniperTracker";
import { SniperReputationStore } from "./sniperReputation";
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
    private sniperTracker: SniperTracker,
    private sniperReputation: SniperReputationStore
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

    // Fast-follow (NOT front-running, see config.priorityWalletFollowFeeSol):
    // when this buy was triggered by a manually-seeded priority wallet, use a
    // higher priority fee so our copy-trade lands/confirms sooner.
    const isPriorityWalletFollow =
      signal.qualificationPath === "sniper_trusted" &&
      signal.triggeringSniperWallet !== null &&
      config.prioritySniperWallets.includes(signal.triggeringSniperWallet);
    const priorityFeeOverride = isPriorityWalletFollow ? config.priorityWalletFollowFeeSol : undefined;

    const result = await this.trader.buy(
      signal.mint,
      config.buyAmountSol,
      signal.currentPricePerToken,
      priorityFeeOverride
    );
    if (!result.success) {
      logger.error(`Buy failed for ${signal.symbol} (${signal.mint}): ${result.error}`);
      return;
    }

    this.socket.watchMint(signal.mint);
    if (signal.creatorWallet) this.devReputation.recordBuy(signal.creatorWallet);

    const confidenceScore = computeConfidenceScore(signal);
    let targetTakeProfitPct = targetTakeProfitFromScore(
      confidenceScore,
      config.minTakeProfitPct,
      config.maxTakeProfitPct
    );

    const now = Date.now();
    let preemptiveExitAtMs: number | null = null;

    if (isPriorityWalletFollow) {
      const record = this.sniperReputation.getRecord(signal.triggeringSniperWallet!);
      if (record && record.sellContextSamples >= config.preemptiveExitMinSamples) {
        // Preemptive exit timing: aim to close a bit before this wallet's
        // own average hold time (time from launch to their sell), measured
        // from our best estimate of launch time (openedAt minus how long it
        // took us to qualify — we bought right when they did).
        const launchTimeApprox = now - signal.timeToQualifyMs;
        const targetHoldMs =
          record.avgTimeSinceLaunchMsAtSell * (config.preemptiveExitFractionPct / 100);
        preemptiveExitAtMs = launchTimeApprox + targetHoldMs;

        // Take-profit target: use this wallet's own observed average
        // multiple (avg sell mcap / avg buy mcap) if we also have enough buy
        // samples — real data on what THIS wallet actually realizes beats a
        // generic confidence score once we have it.
        if (
          record.buyContextSamples >= config.preemptiveExitMinSamples &&
          record.avgMarketCapUsdAtBuy > 0
        ) {
          const impliedMultiplePct =
            (record.avgMarketCapUsdAtSell / record.avgMarketCapUsdAtBuy - 1) * 100;
          targetTakeProfitPct = Math.min(
            config.maxTakeProfitPct,
            Math.max(config.minTakeProfitPct, impliedMultiplePct)
          );
        }
      }
    }

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
      preemptiveExitAtMs,
    };
    this.positions.set(signal.mint, position);
    const preemptiveNote =
      preemptiveExitAtMs !== null
        ? `, preemptive exit in ${((preemptiveExitAtMs - now) / 1000).toFixed(0)}s`
        : "";
    logger.info(
      `OPENED ${position.symbol} (${position.mint.slice(0, 8)}...) ` +
        `${position.solSpent.toFixed(4)} SOL @ ${position.entryPricePerToken.toExponential(4)} SOL/token ` +
        `(confidence=${confidenceScore.toFixed(2)}, target=+${targetTakeProfitPct.toFixed(0)}%${preemptiveNote})`
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

  /**
   * BUGFIX (identified from live dry-run data: 18/18 trades exiting via
   * unsupported_timeout at a suspiciously uniform ~-5%): this used to fire
   * for ANY position lacking a trusted sniper holder, including ones that
   * never had one to begin with (the "volume"/"dev_trusted" paths, which
   * don't involve a sniper at all). Since sniper trust takes real observed
   * round-trips to earn, almost nothing qualifies as "trusted" early on —
   * so in practice EVERY position was getting force-sold at
   * UNSUPPORTED_MAX_HOLD_MS regardless of qualification path, before ever
   * getting a real chance at the take-profit target. Over enough rapid
   * 3-minute cycles this alone can and did drain the whole paper balance.
   *
   * Fixed to use the same distinction as effectiveTakeProfitPct: only cut
   * early when a position HAD confirmed sniper backing and LOST it — never
   * having any sniper signal isn't held against a trade.
   */
  private checkHoldTimes(): void {
    const now = Date.now();
    const tunedUnsupportedMaxHoldMs = this.tuner.get().unsupportedMaxHoldMs;
    for (const position of this.positions.values()) {
      if (now - position.openedAt >= config.maxHoldTimeMs) {
        void this.closePosition(position, "max_hold_time");
        continue;
      }

      if (position.preemptiveExitAtMs !== null && now >= position.preemptiveExitAtMs) {
        void this.closePosition(position, "preemptive_exit");
        continue;
      }

      if (!config.dynamicTakeProfitEnabled) continue;

      const currentlySupported = this.sniperTracker.hasTrustedHolder(position.mint);
      if (currentlySupported) position.sniperSupportSeen = true;

      if (
        position.sniperSupportSeen &&
        !currentlySupported &&
        now - position.openedAt >= tunedUnsupportedMaxHoldMs
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
   * Every winning trade is a single full sell — no partial-sell/hold-for-
   * more logic. The only thing that varies per-trade is WHERE the target
   * sits within [MIN_TAKE_PROFIT_PCT, MAX_TAKE_PROFIT_PCT], via
   * effectiveTakeProfitPct's confidence/sniper-support scoring.
   */
  private evaluateExit(position: Position): void {
    const pnlPct =
      ((position.currentPricePerToken - position.entryPricePerToken) / position.entryPricePerToken) * 100;

    if (pnlPct <= -config.stopLossPct) {
      void this.closePosition(position, "stop_loss");
      return;
    }

    if (pnlPct >= this.effectiveTakeProfitPct(position)) {
      void this.closePosition(position, "take_profit");
    }
  }

  private async closePosition(position: Position, reason: ExitReason): Promise<void> {
    if (this.closing.has(position.mint)) return;
    this.closing.add(position.mint);

    try {
      // Same fast-follow fee as the buy side (see config.priorityWalletFollowFeeSol):
      // any exit on a copy-traded position benefits from confirming quickly,
      // whether it's the preemptive timer, following the wallet's own sell,
      // or a plain TP/SL hit while riding alongside them.
      const isPriorityWalletCopy =
        position.qualificationPath === "sniper_trusted" &&
        position.triggeringSniperWallet !== null &&
        config.prioritySniperWallets.includes(position.triggeringSniperWallet);
      const priorityFeeOverride = isPriorityWalletCopy ? config.priorityWalletFollowFeeSol : undefined;

      const result = await this.trader.sell(
        position.mint,
        position.currentPricePerToken,
        position.tokenAmount,
        100,
        priorityFeeOverride
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
