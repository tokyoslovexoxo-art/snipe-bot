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
  currentMarketCapSol: number;
  // True if this token failed the normal anti-rug checks (blacklisted dev,
  // or dev-hold% too high). Normal qualification paths (market_cap/volume)
  // skip these — only a manually-seeded PRIORITY_SNIPER_WALLETS buy can
  // still override and trigger a buy anyway (see handleTrustedSniperBuy).
  blockedByAntiRugFilter: boolean;
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
 * Watches new pump.fun launches and emits "qualified" once a token clears
 * its entry gate.
 *
 * In COPY_TRADE_ONLY_MODE (the default), this class does NOT scan new
 * launches at all — see start(). The only thing that qualifies a buy is a
 * PRIORITY_SNIPER_WALLETS wallet buying, detected directly off that
 * wallet's own account-trade stream (SniperTracker.handlePriorityWalletTrade)
 * regardless of whether we'd been separately tracking that mint. This is
 * deliberately simpler than the old approach of watching every new token
 * from creation, which could silently miss a wallet's buy on a token we'd
 * stopped tracking (or never started, e.g. across a bot restart).
 * market_cap/volume/dev_trusted qualification and earned-trust
 * (non-priority) sniper fast-tracking are all disabled in this mode.
 *
 * With COPY_TRADE_ONLY_MODE=false, the class works as before: every new
 * launch is tracked, ENTRY_FILTER_MODE (market-cap range, volume threshold,
 * or both) decides normal qualification, creator wallets with a known-bad
 * track record or too-high dev-hold% are skipped (except a
 * PRIORITY_SNIPER_WALLETS buy still overrides that), and known-good
 * creators are fast-tracked — see DevReputationStore.
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
    this.sniperTracker.on("trustedBuy", (signal: TrustedSniperBuySignal) =>
      this.handleTrustedSniperBuy(signal)
    );

    // Copy-trade-only mode doesn't scan new launches at all — it has no use
    // for market_cap/volume/dev_trust qualification, and NOT subscribing
    // avoids tracking thousands of irrelevant tokens per hour just to watch
    // ~all of them get pruned unused. Priority-wallet buys arrive directly
    // via SniperTracker's account-trade subscription instead (see
    // handleTrustedSniperBuy below), regardless of whether we've seen this
    // mint's creation.
    if (config.copyTradeOnlyMode) return;

    this.socket.on("newToken", (evt: NewTokenEvent) => this.handleNewToken(evt));
    this.socket.on("trade", (evt: TokenTradeEvent) => this.handleTrade(evt));
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
    triggeringSniperWallet: string | null,
    marketCapSolAtQualification: number
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
      marketCapSolAtQualification,
    };
  }

  private handleNewToken(evt: NewTokenEvent): void {
    if (!evt.mint || typeof evt.vSolInBondingCurve !== "number") return;

    const creatorWallet = evt.traderPublicKey ?? "";
    if (creatorWallet) this.devReputation.recordLaunch(creatorWallet);

    const trustLevel = creatorWallet ? this.devReputation.getTrustLevel(creatorWallet) : "neutral";
    const maxDevHoldPct = this.tuner.get().maxDevHoldPct;
    const devTokens = evt.initialBuy ?? 0;
    const curveTokensAfterDevBuy = evt.vTokensInBondingCurve ?? 0;
    const devHoldPct =
      devTokens > 0 ? (devTokens / (curveTokensAfterDevBuy + devTokens)) * 100 : 0;

    const blacklisted = trustLevel === "blacklisted";
    const devHoldTooHigh = devHoldPct > maxDevHoldPct;
    const blockedByAntiRugFilter = blacklisted || devHoldTooHigh;

    const currentPrice = priceFromCurve(evt.vSolInBondingCurve, evt.vTokensInBondingCurve);
    const symbol = evt.symbol ?? "?";
    const name = evt.name ?? "?";
    const initialVolume = evt.solAmount ?? 0;
    const createdAt = Date.now();

    // Always watch/track — even tokens we wouldn't normally buy ourselves —
    // so a manually-trusted priority sniper wallet's buy can still surface
    // and override the filter below.
    this.socket.watchMint(evt.mint);
    this.sniperTracker.startTracking(evt.mint, creatorWallet, devHoldPct, createdAt);

    if (blockedByAntiRugFilter) {
      const why = blacklisted
        ? `creator ${creatorWallet.slice(0, 8)}... has a poor track record with this bot`
        : `creator holds ~${devHoldPct.toFixed(1)}% of supply (max allowed ${maxDevHoldPct.toFixed(1)}%)`;
      logger.info(
        `Skipping ${symbol}: ${why} — likely rug risk. Still watching in case a manually-trusted ` +
          `priority sniper wallet buys in anyway.`
      );
    }

    if (trustLevel === "trusted" && !blockedByAntiRugFilter && !config.copyTradeOnlyMode) {
      logger.info(
        `FAST-TRACK: ${symbol} (${evt.mint.slice(0, 8)}...) — creator ${creatorWallet.slice(0, 8)}... ` +
          `has a strong track record with this bot, buying immediately without waiting for volume.`
      );
      const context = this.buildDecisionContext(
        creatorWallet,
        devHoldPct,
        "dev_trusted",
        initialVolume,
        0,
        null,
        evt.marketCapSol ?? 0
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
      createdAt,
      cumulativeVolumeSol: initialVolume,
      currentPricePerToken: currentPrice,
      currentMarketCapSol: evt.marketCapSol ?? 0,
      blockedByAntiRugFilter,
    };
    this.tracked.set(evt.mint, entry);

    logger.info(
      `New launch: ${entry.symbol} (${entry.mint.slice(0, 8)}...) initial volume ${initialVolume.toFixed(3)} SOL`
    );

    if (!blockedByAntiRugFilter) this.maybeQualify(entry);
  }

  private handleTrade(evt: TokenTradeEvent): void {
    const entry = this.tracked.get(evt.mint);
    if (!entry) return;

    entry.cumulativeVolumeSol += evt.solAmount ?? 0;
    if (typeof evt.vSolInBondingCurve === "number" && typeof evt.vTokensInBondingCurve === "number") {
      entry.currentPricePerToken = priceFromCurve(evt.vSolInBondingCurve, evt.vTokensInBondingCurve);
    }
    if (typeof evt.marketCapSol === "number") {
      entry.currentMarketCapSol = evt.marketCapSol;
    }

    if (!entry.blockedByAntiRugFilter) this.maybeQualify(entry);
  }

  private handleTrustedSniperBuy(signal: TrustedSniperBuySignal): void {
    if (config.copyTradeOnlyMode) {
      // No TrackedToken bookkeeping exists in this mode (see start()) — the
      // signal itself carries everything needed to buy immediately. Symbol/
      // name/creator/dev-hold aren't knowable without having watched this
      // mint's creation, which this mode deliberately skips; logs fall back
      // to the mint's short prefix instead of a ticker symbol.
      const symbol = signal.mint.slice(0, 8);
      logger.info(`COPY-TRADE: ${symbol}... — copying priority wallet ${signal.wallet.slice(0, 8)}...'s buy.`);
      const context = this.buildDecisionContext(
        "",
        0,
        "sniper_trusted",
        0,
        0,
        signal.wallet,
        signal.marketCapSol
      );
      this.emit("qualified", {
        mint: signal.mint,
        symbol,
        name: symbol,
        creatorWallet: "",
        currentPricePerToken: priceFromCurve(signal.vSolInBondingCurve, signal.vTokensInBondingCurve),
        ...context,
      } as QualifiedSignal);
      return;
    }

    const entry = this.tracked.get(signal.mint);
    if (!entry) return; // already qualified/pruned, or dev-fast-tracked already

    const isPriorityWallet = config.prioritySniperWallets.includes(signal.wallet);
    if (entry.blockedByAntiRugFilter && !isPriorityWallet) {
      // Only a manually-seeded priority wallet's judgment overrides the
      // anti-rug filter; an ordinary earned-trust sniper's doesn't.
      return;
    }

    this.tracked.delete(signal.mint);
    const overrideNote = entry.blockedByAntiRugFilter
      ? " (OVERRIDING anti-rug filter — manually-trusted priority wallet)"
      : "";
    logger.info(
      `FAST-TRACK: ${entry.symbol} (${signal.mint.slice(0, 8)}...) — trusted sniper ` +
        `${signal.wallet.slice(0, 8)}... just bought in${overrideNote}.`
    );
    const context = this.buildDecisionContext(
      entry.creatorWallet,
      entry.devHoldPct,
      "sniper_trusted",
      entry.cumulativeVolumeSol,
      Date.now() - entry.createdAt,
      signal.wallet,
      entry.currentMarketCapSol
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

  /**
   * Whether a tracked token currently clears its entry gate, per
   * ENTRY_FILTER_MODE:
   * - "market_cap": current market cap (converted from marketCapSol via
   *   SOL_USD_PRICE) falls within [ENTRY_MIN_MARKET_CAP_USD,
   *   ENTRY_MAX_MARKET_CAP_USD]. No volume wait — this can qualify within
   *   the first second if the launch's market cap is already in range.
   * - "volume": the original behavior — cumulative bonding-curve buys have
   *   reached the (adaptively tuned) MIN_VOLUME_SOL.
   * - "both": both conditions at once.
   */
  private meetsEntryCondition(entry: TrackedToken): boolean {
    const tuned = this.tuner.get();
    const volumeMet = entry.cumulativeVolumeSol >= tuned.minVolumeSol;

    const marketCapUsd = entry.currentMarketCapSol * config.solUsdPrice;
    const { minUsd, maxUsd } = tuned.marketCapRangeUsd;
    const inMarketCapRange = marketCapUsd >= minUsd && marketCapUsd <= maxUsd;

    switch (config.entryFilterMode) {
      case "market_cap":
        return inMarketCapRange;
      case "both":
        return inMarketCapRange && volumeMet;
      case "volume":
      default:
        return volumeMet;
    }
  }

  private maybeQualify(entry: TrackedToken): void {
    // Copy-trade-only mode: the market_cap/volume entry gate is disabled
    // entirely — only a priority wallet's own buy (handleTrustedSniperBuy)
    // can qualify a token.
    if (config.copyTradeOnlyMode) return;
    if (!this.meetsEntryCondition(entry)) return;

    this.tracked.delete(entry.mint);
    const marketCapUsd = entry.currentMarketCapSol * config.solUsdPrice;
    const qualificationPath: QualificationPath = config.entryFilterMode === "volume" ? "volume" : "market_cap";
    logger.info(
      `QUALIFIED: ${entry.symbol} (${entry.mint.slice(0, 8)}...) via "${config.entryFilterMode}" gate ` +
        `(mcap=$${marketCapUsd.toFixed(0)}, volume=${entry.cumulativeVolumeSol.toFixed(3)} SOL) ` +
        `in ${Date.now() - entry.createdAt}ms`
    );
    const context = this.buildDecisionContext(
      entry.creatorWallet,
      entry.devHoldPct,
      qualificationPath,
      entry.cumulativeVolumeSol,
      Date.now() - entry.createdAt,
      null,
      entry.currentMarketCapSol
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
    // Copy-trade-only mode waits much longer for the priority wallet's own
    // buy to show up, rather than a short volume/market-cap confirmation
    // window that doesn't apply in this mode.
    const windowMs = config.copyTradeOnlyMode ? config.copyTradeWatchWindowMs : config.volumeWindowMs;
    for (const [mint, entry] of this.tracked) {
      if (now - entry.createdAt >= windowMs) {
        this.tracked.delete(mint);
        this.socket.unwatchMint(mint);
        this.sniperTracker.stopTracking(mint);
        if (config.copyTradeOnlyMode) {
          logger.info(
            `Giving up on ${entry.symbol} (${mint.slice(0, 8)}...): no priority wallet bought in within ${windowMs}ms`
          );
        } else {
          const marketCapUsd = entry.currentMarketCapSol * config.solUsdPrice;
          logger.info(
            `Giving up on ${entry.symbol} (${mint.slice(0, 8)}...): never cleared the "${config.entryFilterMode}" ` +
              `entry gate (mcap=$${marketCapUsd.toFixed(0)}, volume=${entry.cumulativeVolumeSol.toFixed(3)} SOL) ` +
              `within ${windowMs}ms`
          );
        }
      }
    }
  }
}
