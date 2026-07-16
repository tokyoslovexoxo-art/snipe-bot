import { EventEmitter } from "events";
import { config } from "./config";
import { logger } from "./logger";
import { PumpPortalSocket } from "./pumpportal/socket";
import { DevReputationStore } from "./devReputation";
import { AdaptiveTuner } from "./adaptiveTuner";
import { NewTokenEvent, TokenTradeEvent } from "./types";

interface TrackedToken {
  mint: string;
  symbol: string;
  name: string;
  creatorWallet: string;
  createdAt: number;
  cumulativeVolumeSol: number;
  currentPricePerToken: number;
}

export interface QualifiedSignal {
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
 * DevReputationStore.
 */
export class DiscoveryService extends EventEmitter {
  private tracked = new Map<string, TrackedToken>();
  private pruneInterval: NodeJS.Timeout | null = null;

  constructor(
    private socket: PumpPortalSocket,
    private devReputation: DevReputationStore,
    private tuner: AdaptiveTuner
  ) {
    super();
  }

  start(): void {
    this.socket.on("newToken", (evt: NewTokenEvent) => this.handleNewToken(evt));
    this.socket.on("trade", (evt: TokenTradeEvent) => this.handleTrade(evt));
    this.socket.subscribeNewTokens();
    this.pruneInterval = setInterval(() => this.pruneStale(), 5_000);
  }

  stop(): void {
    if (this.pruneInterval) clearInterval(this.pruneInterval);
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

    if (trustLevel === "trusted") {
      logger.info(
        `FAST-TRACK: ${symbol} (${evt.mint.slice(0, 8)}...) — creator ${creatorWallet.slice(0, 8)}... ` +
          `has a strong track record with this bot, buying immediately without waiting for volume.`
      );
      this.socket.watchMint(evt.mint);
      this.emit("qualified", {
        mint: evt.mint,
        symbol,
        name,
        creatorWallet,
        currentPricePerToken: currentPrice,
      } as QualifiedSignal);
      return;
    }

    const initialVolume = evt.solAmount ?? 0;
    const entry: TrackedToken = {
      mint: evt.mint,
      symbol,
      name,
      creatorWallet,
      createdAt: Date.now(),
      cumulativeVolumeSol: initialVolume,
      currentPricePerToken: currentPrice,
    };
    this.tracked.set(evt.mint, entry);
    this.socket.watchMint(evt.mint);

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

  private maybeQualify(entry: TrackedToken): void {
    const minVolumeSol = this.tuner.get().minVolumeSol;
    if (entry.cumulativeVolumeSol < minVolumeSol) return;

    this.tracked.delete(entry.mint);
    logger.info(
      `QUALIFIED: ${entry.symbol} (${entry.mint.slice(0, 8)}...) crossed ${minVolumeSol.toFixed(3)} SOL ` +
        `volume (${entry.cumulativeVolumeSol.toFixed(3)} SOL) in ${Date.now() - entry.createdAt}ms`
    );
    const signal: QualifiedSignal = {
      mint: entry.mint,
      symbol: entry.symbol,
      name: entry.name,
      creatorWallet: entry.creatorWallet,
      currentPricePerToken: entry.currentPricePerToken,
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
        logger.info(
          `Giving up on ${entry.symbol} (${mint.slice(0, 8)}...): only reached ` +
            `${entry.cumulativeVolumeSol.toFixed(3)}/${minVolumeSol.toFixed(3)} SOL volume in ${config.volumeWindowMs}ms`
        );
      }
    }
  }
}
