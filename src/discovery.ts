import { EventEmitter } from "events";
import { config } from "./config";
import { logger } from "./logger";
import { PumpPortalSocket } from "./pumpportal/socket";
import { DevReputationStore } from "./devReputation";
import { AdaptiveTuner } from "./adaptiveTuner";
import { SniperReputationStore } from "./sniperReputation";
import { SniperTracker, TrustedSniperBuySignal } from "./sniperTracker";
import { DecisionContext, NewTokenEvent, QualificationPath, TokenTradeEvent } from "./types";

interface TrackedToken {
  mint: string;
  symbol: string;
  name: string;
  creatorWallet: string;
  devHoldPct: number;
  createdAt: number;
  cumulativeVolumeSol: number;
  currentPricePerToken: number;
}

export interface QualifiedSignal extends DecisionContext {
  mint: string;
  symbol: string;
  name: string;
  creatorWallet: string;
  currentPricePerToken: number;
}

function priceFromCurve(vSol: number, vTokens: number): number {
  if (!vTokens || vTokens <= 0) return 0;
  return vSol / vTokens;
}

/**
 * Watches new pump.fun launches, tracks cumulative bonding-curve volume per
 * token, applies safety filters, and emits "qualified" once a token clears
 * the (adaptively tuned) minimum volume within VOLUME_WINDOW_MS. Tokens that
 * never clear the bar in time are dropped (and unwatched) to keep the
 * subscription set bounded.
 *
 * Creator wallets with a known-bad track record are skipped outright;
 * creator wallets with a known-good track record are fast-tracked (bought
 * immediately at launch instead of waiting for volume confirmation) — see
 * DevReputationStore. Separately, if a proven-profitable OTHER wallet
 * (a "sniper", not the creator) buys into a token we're still watching, that
 * also fast-tracks a buy — see SniperTracker.
 *
 * Every qualification path captures a full DecisionContext snapshot — this
 * is what makes the eventual trade log self-contained and reusable as
 * training data later, instead of just a bare PnL number.
 */
export class DiscoveryService extends EventEmitter {
  private tracked = new Map<string, TrackedToken>();
  private pruneInterval: NodeJS.Timeout | null = null;

  constructor(
    private socket: PumpPortalSocket,
    private devReputation: DevReputationStore,
    private tuner: AdaptiveTuner,
    private sniperTracker: SniperTracker,
    private sniperReputation: SniperReputationStore
  ) {
    super();
  }

  start(): void {
    this.socket.on("newToken", (evt: NewTokenEvent) => this.handleNewToken(evt));
    this.socket.on("trade", (evt: TokenTradeEvent) => this.handleTrade(evt));
    this.sniperTracker.on("trustedBuy", (signal: TrustedSniperBuySignal) =>
      this.handleTrustedSniperBuy(signal)
    );
    this.socket.subscribeNewTokens();
    this.pruneInterval = setInterval(() => this.pruneStale(), 5_000);
  }

  stop(): void {
    if (this.pruneInterval) clearInterval(this.pruneInterval);
  }

  private buildDecisionContext(
    creatorWallet: string,
    devHoldPct: number,
    qualificationPath: QualificationPath,
    volumeAtQualificationSol: number,
    timeToQualifyMs: number,
    triggeringSniperWallet: string | null
  ): DecisionContext {
    const devTrustLevel = creatorWallet ? this.devReputation.getTrustLevel(creatorWallet) : "neutral";
    const devRecord = creatorWallet ? this.devReputation.getRecord(creatorWallet) : undefined;
    const sniperRecord = triggeringSniperWallet
      ? this.sniperReputation.getRecord(triggeringSniperWallet)
      : undefined;
    const tuned = this.tuner.get();

    return {
      qualificationPath,
      devHoldPctAtBuy: devHoldPct,
      devTrustLevelAtBuy: devTrustLevel,
      devWinsAtBuy: devRecord?.wins ?? 0,
      devLossesAtBuy: devRecord?.losses ?? 0,
      devTotalPnlSolAtBuy: devRecord?.totalPnlSol ?? 0,
      triggeringSniperWallet,
      sniperWinsAtBuy: triggeringSniperWallet ? sniperRecord?.wins ?? 0 : null,
      sniperLossesAtBuy: triggeringSniperWallet ? sniperRecord?.losses ?? 0 : null,
      volumeAtQualificationSol,
      timeToQualifyMs,
      tunedMinVolumeSolAtBuy: tuned.minVolumeSol,
      tunedMaxDevHoldPctAtBuy: tuned.maxDevHoldPct,
    };
  }

  private handleNewToken(evt: NewTokenEvent): void {
    if (!evt.mint || typeof evt.vSolInBondingCurve !== "number") return;

    const creatorWallet = evt.traderPublicKey ?? "";
    if (creatorWallet) this.devReputation.recordLaunch(creatorWallet);

    const trustLevel = creatorWallet ? this.devReputation.getTrustLevel(creatorWallet) : "neutral";
    if (trustLevel === "blacklisted") {
      logger.info(
        `Skipping ${evt.symbol ?? evt.mint}: creator ${creatorWallet.slice(0, 8)}... has a poor track record with this bot.`
      );
      return;
    }

    const maxDevHoldPct = this.tuner.get().maxDevHoldPct;
    const devTokens = evt.initialBuy ?? 0;
    const curveTokensAfterDevBuy = evt.vTokensInBondingCurve ?? 0;
    const devHoldPct =
      devTokens > 0 ? (devTokens / (curveTokensAfterDevBuy + devTokens)) * 100 : 0;

    if (devHoldPct > maxDevHoldPct) {
      logger.info(
        `Skipping ${evt.symbol ?? evt.mint}: creator holds ~${devHoldPct.toFixed(1)}% of supply ` +
          `(max allowed ${maxDevHoldPct.toFixed(1)}%) — likely rug risk.`
      );
      return;
    }

    const currentPrice = priceFromCurve(evt.vSolInBondingCurve, evt.vTokensInBondingCurve);
    const symbol = evt.symbol ?? "?";
    const name = evt.name ?? "?";
    const initialVolume = evt.solAmount ?? 0;

    if (trustLevel === "trusted") {
      logger.info(
        `FAST-TRACK: ${symbol} (${evt.mint.slice(0, 8)}...) — creator ${creatorWallet.slice(0, 8)}... ` +
          `has a strong track record with this bot, buying immediately without waiting for volume.`
      );
      this.socket.watchMint(evt.mint);
      this.sniperTracker.startTracking(evt.mint, creatorWallet);
      const context = this.buildDecisionContext(
        creatorWallet,
        devHoldPct,
        "dev_trusted",
        initialVolume,
        0,
        null
      );
      this.emit("qualified", {
        mint: evt.mint,
        symbol,
        name,
        creatorWallet,
        currentPricePerToken: currentPrice,
        ...context,
      } as QualifiedSignal);
      return;
    }

    const entry: TrackedToken = {
      mint: evt.mint,
      symbol,
      name,
      creatorWallet,
      devHoldPct,
      createdAt: Date.now(),
      cumulativeVolumeSol: initialVolume,
      currentPricePerToken: currentPrice,
    };
    this.tracked.set(evt.mint, entry);
    this.socket.watchMint(evt.mint);
    this.sniperTracker.startTracking(evt.mint, creatorWallet);

    logger.info(
      `New launch: ${entry.symbol} (${entry.mint.slice(0, 8)}...) initial volume ${initialVolume.toFixed(3)} SOL`
    );

    this.maybeQualify(entry);
  }

  private handleTrade(evt: TokenTradeEvent): void {
    const entry = this.tracked.get(evt.mint);
    if (!entry) return;

    entry.cumulativeVolumeSol += evt.solAmount ?? 0;
    if (typeof evt.vSolInBondingCurve === "number" && typeof evt.vTokensInBondingCurve === "number") {
      entry.currentPricePerToken = priceFromCurve(evt.vSolInBondingCurve, evt.vTokensInBondingCurve);
    }

    this.maybeQualify(entry);
  }

  private handleTrustedSniperBuy(signal: TrustedSniperBuySignal): void {
    const entry = this.tracked.get(signal.mint);
    if (!entry) return; // already qualified/pruned, or dev-fast-tracked already

    this.tracked.delete(signal.mint);
    logger.info(
      `FAST-TRACK: ${entry.symbol} (${signal.mint.slice(0, 8)}...) — trusted sniper ` +
        `${signal.wallet.slice(0, 8)}... just bought in.`
    );
    const context = this.buildDecisionContext(
      entry.creatorWallet,
      entry.devHoldPct,
      "sniper_trusted",
      entry.cumulativeVolumeSol,
      Date.now() - entry.createdAt,
      signal.wallet
    );
    this.emit("qualified", {
      mint: entry.mint,
      symbol: entry.symbol,
      name: entry.name,
      creatorWallet: entry.creatorWallet,
      currentPricePerToken: entry.currentPricePerToken,
      ...context,
    } as QualifiedSignal);
  }

  private maybeQualify(entry: TrackedToken): void {
    const minVolumeSol = this.tuner.get().minVolumeSol;
    if (entry.cumulativeVolumeSol < minVolumeSol) return;

    this.tracked.delete(entry.mint);
    logger.info(
      `QUALIFIED: ${entry.symbol} (${entry.mint.slice(0, 8)}...) crossed ${minVolumeSol.toFixed(3)} SOL ` +
        `volume (${entry.cumulativeVolumeSol.toFixed(3)} SOL) in ${Date.now() - entry.createdAt}ms`
    );
    const context = this.buildDecisionContext(
      entry.creatorWallet,
      entry.devHoldPct,
      "volume",
      entry.cumulativeVolumeSol,
      Date.now() - entry.createdAt,
      null
    );
    const signal: QualifiedSignal = {
      mint: entry.mint,
      symbol: entry.symbol,
      name: entry.name,
      creatorWallet: entry.creatorWallet,
      currentPricePerToken: entry.currentPricePerToken,
      ...context,
    };
    this.emit("qualified", signal);
  }

  private pruneStale(): void {
    const now = Date.now();
    const minVolumeSol = this.tuner.get().minVolumeSol;
    for (const [mint, entry] of this.tracked) {
      if (now - entry.createdAt >= config.volumeWindowMs) {
        this.tracked.delete(mint);
        this.socket.unwatchMint(mint);
        this.sniperTracker.stopTracking(mint);
        logger.info(
          `Giving up on ${entry.symbol} (${mint.slice(0, 8)}...): only reached ` +
            `${entry.cumulativeVolumeSol.toFixed(3)}/${minVolumeSol.toFixed(3)} SOL volume in ${config.volumeWindowMs}ms`
        );
      }
    }
  }
}
