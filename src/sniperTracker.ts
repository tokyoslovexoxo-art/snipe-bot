import { EventEmitter } from "events";
import { config } from "./config";
import { logger } from "./logger";
import { PumpPortalSocket } from "./pumpportal/socket";
import { SniperReputationStore } from "./sniperReputation";
import { TokenTradeEvent } from "./types";

interface CostBasis {
  totalTokens: number;
  totalSolSpent: number;
}

interface ActiveMint {
  creatorWallet: string;
  devHoldPct: number;
  createdAt: number;
}

// Floating-point residue after repeated subtraction; treat anything at or
// below this as "fully sold out" rather than requiring an exact zero.
const DUST_THRESHOLD = 1e-9;

export interface TrustedSniperBuySignal {
  mint: string;
  wallet: string;
}

export interface TrustedSniperSellSignal {
  mint: string;
  wallet: string;
  remainingTokens: number;
  fullyExited: boolean;
}

/**
 * Builds sniper reputations from real observed round-trips. While a mint is
 * "active" here (from the moment discovery/positionManager start watching
 * it until they stop), every other wallet's buy is recorded with its cost
 * basis; if we then see that same wallet sell before we stop watching, we
 * compute their realized PnL on that round trip and feed it to
 * SniperReputationStore.
 *
 * For manually-seeded PRIORITY_SNIPER_WALLETS specifically, also records the
 * situational context of each buy (market cap, creator's dev-hold%, time
 * since launch) into SniperReputationStore — this is the "why does this
 * wallet pick what it picks" analysis, built from what we can actually
 * observe rather than guessed.
 *
 * IMPORTANT sampling caveat: we only ever see the portion of a sniper's
 * activity that happens while we're actively watching a given mint (the
 * qualification window, or the lifetime of a position we hold). A sniper
 * who buys and holds longer than that, or exits after we've stopped
 * watching, is invisible to us for that trade. This biases the sample
 * toward fast in-and-out snipers — see README.
 */
export class SniperTracker extends EventEmitter {
  private active = new Map<string, ActiveMint>();
  private costBasis = new Map<string, Map<string, CostBasis>>(); // mint -> wallet -> basis

  constructor(private socket: PumpPortalSocket, private sniperReputation: SniperReputationStore) {
    super();
  }

  start(): void {
    this.socket.on("trade", (evt: TokenTradeEvent) => this.handleTrade(evt));
  }

  startTracking(mint: string, creatorWallet: string, devHoldPct: number, createdAt: number): void {
    this.active.set(mint, { creatorWallet, devHoldPct, createdAt });
    if (!this.costBasis.has(mint)) this.costBasis.set(mint, new Map());
  }

  stopTracking(mint: string): void {
    this.active.delete(mint);
    this.costBasis.delete(mint);
  }

  /** Is any trusted sniper currently holding a nonzero balance of this mint? */
  hasTrustedHolder(mint: string): boolean {
    const mintBasis = this.costBasis.get(mint);
    if (!mintBasis) return false;
    for (const [wallet, basis] of mintBasis) {
      if (basis.totalTokens > DUST_THRESHOLD && this.sniperReputation.isTrusted(wallet)) {
        return true;
      }
    }
    return false;
  }

  private handleTrade(evt: TokenTradeEvent): void {
    if (!config.sniperTrackingEnabled) return;
    if (!evt.mint || !this.active.has(evt.mint)) return;

    const activeMint = this.active.get(evt.mint)!;
    const wallet = evt.traderPublicKey;
    if (!wallet || wallet === activeMint.creatorWallet) return; // dev's own activity is tracked separately

    const mintBasis = this.costBasis.get(evt.mint);
    if (!mintBasis) return;
    let basis = mintBasis.get(wallet);

    if (evt.txType === "buy") {
      if (!basis) {
        basis = { totalTokens: 0, totalSolSpent: 0 };
        mintBasis.set(wallet, basis);
      }
      basis.totalTokens += evt.tokenAmount ?? 0;
      basis.totalSolSpent += evt.solAmount ?? 0;

      if (config.prioritySniperWallets.includes(wallet) && typeof evt.marketCapSol === "number") {
        this.sniperReputation.recordBuyContext(
          wallet,
          evt.marketCapSol * config.solUsdPrice,
          activeMint.devHoldPct,
          Date.now() - activeMint.createdAt
        );
      }

      if (this.sniperReputation.isTrusted(wallet)) {
        logger.info(
          `Trusted sniper ${wallet.slice(0, 8)}... just bought into a tracked launch (${evt.mint.slice(0, 8)}...).`
        );
        this.emit("trustedBuy", { mint: evt.mint, wallet } as TrustedSniperBuySignal);
      }
    } else if (evt.txType === "sell") {
      if (!basis || basis.totalTokens <= 0) return; // never saw their buy; can't attribute a cost basis
      const avgBuyPrice = basis.totalSolSpent / basis.totalTokens;
      const soldTokens = Math.min(evt.tokenAmount ?? 0, basis.totalTokens);
      const costOfSold = soldTokens * avgBuyPrice;
      const proceeds = evt.solAmount ?? 0;
      const pnlSol = proceeds - costOfSold;

      basis.totalTokens -= soldTokens;
      basis.totalSolSpent -= costOfSold;

      this.sniperReputation.recordRoundTrip(wallet, pnlSol, pnlSol > 0);

      if (this.sniperReputation.isTrusted(wallet)) {
        const fullyExited = basis.totalTokens <= DUST_THRESHOLD;
        logger.info(
          `Trusted sniper ${wallet.slice(0, 8)}... sold ${fullyExited ? "(fully exited)" : "(partial)"} ` +
            `on a tracked launch (${evt.mint.slice(0, 8)}...).`
        );
        this.emit("trustedSell", {
          mint: evt.mint,
          wallet,
          remainingTokens: basis.totalTokens,
          fullyExited,
        } as TrustedSniperSellSignal);
      }
    }
  }
}
