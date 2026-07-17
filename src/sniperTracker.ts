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

interface PriorityCostBasis extends CostBasis {
  // When we first observed this wallet holding this mint — our best proxy
  // for "how long have they held," used as the sell-context timing basis in
  // copy-trade-only mode (see handlePriorityWalletTrade).
  firstSeenAt: number;
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
  marketCapSol: number;
  vSolInBondingCurve: number;
  vTokensInBondingCurve: number;
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
 * since launch) AND each sell (market cap, time since launch) into
 * SniperReputationStore — this is the "why does this wallet pick what it
 * picks, and when does it get out" analysis, built from what we can
 * actually observe rather than guessed. See positionManager.ts for how the
 * sell side feeds a preemptive-exit target.
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
  // wallet -> mint -> basis. Built directly from each priority wallet's own
  // account-trade stream (see socket.subscribeAccountTrades) — doesn't
  // depend on `active`/`startTracking` at all, so it works even for mints we
  // were never separately watching from creation. This is what makes
  // COPY_TRADE_ONLY_MODE correct: the old path below only ever noticed a
  // wallet's buy if we'd already been watching that exact mint since it was
  // created, which silently missed anything bought after our tracking
  // window closed (or after a bot restart wiped in-memory tracking state).
  private priorityCostBasis = new Map<string, Map<string, PriorityCostBasis>>();

  constructor(private socket: PumpPortalSocket, private sniperReputation: SniperReputationStore) {
    super();
  }

  start(): void {
    this.socket.on("trade", (evt: TokenTradeEvent) => this.handleTrade(evt));
    if (config.copyTradeOnlyMode && config.prioritySniperWallets.length > 0) {
      this.socket.subscribeAccountTrades(config.prioritySniperWallets);
    }
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
    if (mintBasis) {
      for (const [wallet, basis] of mintBasis) {
        if (basis.totalTokens > DUST_THRESHOLD && this.sniperReputation.isTrusted(wallet)) {
          return true;
        }
      }
    }
    // Copy-trade-only mode never populates `costBasis` above (see
    // handlePriorityWalletTrade), so check the wallet-keyed map instead.
    for (const [wallet, walletBasis] of this.priorityCostBasis) {
      const basis = walletBasis.get(mint);
      if (basis && basis.totalTokens > DUST_THRESHOLD && this.sniperReputation.isTrusted(wallet)) {
        return true;
      }
    }
    return false;
  }

  private handleTrade(evt: TokenTradeEvent): void {
    if (!config.sniperTrackingEnabled || !evt.mint) return;

    const wallet = evt.traderPublicKey;
    if (config.copyTradeOnlyMode) {
      // No `active`/startTracking bookkeeping in this mode at all — every
      // priority wallet trade is handled straight off the account-trade
      // stream, regardless of whether we were "watching" this mint.
      if (wallet && config.prioritySniperWallets.includes(wallet)) {
        this.handlePriorityWalletTrade(evt);
      }
      return;
    }

    if (!this.active.has(evt.mint)) return;
    const activeMint = this.active.get(evt.mint)!;
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
        this.emit("trustedBuy", {
          mint: evt.mint,
          wallet,
          marketCapSol: evt.marketCapSol ?? 0,
          vSolInBondingCurve: evt.vSolInBondingCurve ?? 0,
          vTokensInBondingCurve: evt.vTokensInBondingCurve ?? 0,
        } as TrustedSniperBuySignal);
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

      if (config.prioritySniperWallets.includes(wallet) && typeof evt.marketCapSol === "number") {
        this.sniperReputation.recordSellContext(
          wallet,
          evt.marketCapSol * config.solUsdPrice,
          Date.now() - activeMint.createdAt
        );
      }

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

  /**
   * Copy-trade-only mode's entire cost-basis/reputation pipeline, built
   * purely from a priority wallet's own account-trade stream. No dependency
   * on having seen this mint's creation or having called startTracking —
   * this is what fixes the "wallet bought and the bot did nothing" bug,
   * which happened whenever the token wasn't (or was no longer) in `active`.
   */
  private handlePriorityWalletTrade(evt: TokenTradeEvent): void {
    const wallet = evt.traderPublicKey;
    let walletBasis = this.priorityCostBasis.get(wallet);
    if (!walletBasis) {
      walletBasis = new Map();
      this.priorityCostBasis.set(wallet, walletBasis);
    }
    let basis = walletBasis.get(evt.mint);

    if (evt.txType === "buy") {
      if (!basis) {
        basis = { totalTokens: 0, totalSolSpent: 0, firstSeenAt: Date.now() };
        walletBasis.set(evt.mint, basis);
      }
      basis.totalTokens += evt.tokenAmount ?? 0;
      basis.totalSolSpent += evt.solAmount ?? 0;

      if (typeof evt.marketCapSol === "number") {
        // devHoldPct/timeSinceLaunch aren't knowable without watching this
        // mint from creation (which copy-trade-only mode deliberately
        // doesn't do) — omitted rather than faked, see recordBuyContext.
        this.sniperReputation.recordBuyContext(wallet, evt.marketCapSol * config.solUsdPrice);
      }

      // Respect revocation (see SNIPER_REVOKE_MIN_SAMPLES/MAX_WIN_RATE_PCT):
      // a priority wallet whose own real performance has proven bad enough
      // loses its free pass and stops triggering copy-buys, same as if it
      // had never been added to PRIORITY_SNIPER_WALLETS.
      if (this.sniperReputation.isTrusted(wallet)) {
        logger.info(
          `COPY-TRADE: priority wallet ${wallet.slice(0, 8)}... bought into ${evt.mint.slice(0, 8)}... — copying.`
        );
        this.emit("trustedBuy", {
          mint: evt.mint,
          wallet,
          marketCapSol: evt.marketCapSol ?? 0,
          vSolInBondingCurve: evt.vSolInBondingCurve ?? 0,
          vTokensInBondingCurve: evt.vTokensInBondingCurve ?? 0,
        } as TrustedSniperBuySignal);
      } else {
        logger.info(
          `Priority wallet ${wallet.slice(0, 8)}... bought into ${evt.mint.slice(0, 8)}... but its free pass ` +
            `has been revoked (poor observed performance) — not copying.`
        );
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

      if (typeof evt.marketCapSol === "number") {
        // Time-since-their-own-first-buy, not time-since-launch — actually
        // more precise for our purposes (their real observed hold duration)
        // than the launch-relative approximation the non-copy-trade path
        // above uses.
        this.sniperReputation.recordSellContext(
          wallet,
          evt.marketCapSol * config.solUsdPrice,
          Date.now() - basis.firstSeenAt
        );
      }

      const fullyExited = basis.totalTokens <= DUST_THRESHOLD;
      logger.info(
        `COPY-TRADE: priority wallet ${wallet.slice(0, 8)}... sold ${fullyExited ? "(fully exited)" : "(partial)"} ` +
          `${evt.mint.slice(0, 8)}... — following out.`
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
