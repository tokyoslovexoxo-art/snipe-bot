import { EventEmitter } from "events";
import { config } from "./config";
import { logger } from "./logger";
import { PumpPortalSocket } from "./pumpportal/socket";
import { NewTokenEvent, TokenTradeEvent } from "./types";

interface TrackedToken {
  mint: string;
  symbol: string;
  name: string;
  createdAt: number;
  cumulativeVolumeSol: number;
  currentPricePerToken: number;
}

export interface QualifiedSignal {
  mint: string;
  symbol: string;
  name: string;
  currentPricePerToken: number;
}

function priceFromCurve(vSol: number, vTokens: number): number {
  if (!vTokens || vTokens <= 0) return 0;
  return vSol / vTokens;
}

/**
 * Watches new pump.fun launches, tracks cumulative bonding-curve volume per
 * token, applies safety filters, and emits "qualified" once a token clears
 * MIN_VOLUME_SOL within VOLUME_WINDOW_MS. Tokens that never clear the bar in
 * time are dropped (and unwatched) to keep the subscription set bounded.
 */
export class DiscoveryService extends EventEmitter {
  private tracked = new Map<string, TrackedToken>();
  private pruneInterval: NodeJS.Timeout | null = null;

  constructor(private socket: PumpPortalSocket) {
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

    const devTokens = evt.initialBuy ?? 0;
    const curveTokensAfterDevBuy = evt.vTokensInBondingCurve ?? 0;
    const devHoldPct =
      devTokens > 0 ? (devTokens / (curveTokensAfterDevBuy + devTokens)) * 100 : 0;

    if (devHoldPct > config.maxDevHoldPct) {
      logger.info(
        `Skipping ${evt.symbol ?? evt.mint}: creator holds ~${devHoldPct.toFixed(1)}% of supply ` +
          `(max allowed ${config.maxDevHoldPct}%) — likely rug risk.`
      );
      return;
    }

    const initialVolume = evt.solAmount ?? 0;
    const currentPrice = priceFromCurve(evt.vSolInBondingCurve, evt.vTokensInBondingCurve);

    const entry: TrackedToken = {
      mint: evt.mint,
      symbol: evt.symbol ?? "?",
      name: evt.name ?? "?",
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
    if (entry.cumulativeVolumeSol < config.minVolumeSol) return;

    this.tracked.delete(entry.mint);
    logger.info(
      `QUALIFIED: ${entry.symbol} (${entry.mint.slice(0, 8)}...) crossed ${config.minVolumeSol} SOL ` +
        `volume (${entry.cumulativeVolumeSol.toFixed(3)} SOL) in ${Date.now() - entry.createdAt}ms`
    );
    const signal: QualifiedSignal = {
      mint: entry.mint,
      symbol: entry.symbol,
      name: entry.name,
      currentPricePerToken: entry.currentPricePerToken,
    };
    this.emit("qualified", signal);
  }

  private pruneStale(): void {
    const now = Date.now();
    for (const [mint, entry] of this.tracked) {
      if (now - entry.createdAt >= config.volumeWindowMs) {
        this.tracked.delete(mint);
        this.socket.unwatchMint(mint);
        logger.info(
          `Giving up on ${entry.symbol} (${mint.slice(0, 8)}...): only reached ` +
            `${entry.cumulativeVolumeSol.toFixed(3)}/${config.minVolumeSol} SOL volume in ${config.volumeWindowMs}ms`
        );
      }
    }
  }
}
