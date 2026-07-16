import { config } from "./config";
import { logger } from "./logger";
import { TradeResult } from "./types";

// Base Solana network fee per signature; negligible but included for realism.
const BASE_NETWORK_FEE_SOL = 0.000005;

/**
 * Virtual balance ledger used in DRY_RUN mode so you can watch the strategy
 * trade against live PumpPortal data without risking real SOL.
 *
 * Fills are not assumed perfect: we apply half of the configured slippage
 * tolerance as an estimated average price-impact/competition haircut, since
 * in reality other bots/latency will usually make your real fill worse than
 * the last quoted bonding-curve price. Treat dry-run PnL as an optimistic
 * upper bound, not a guarantee of live performance.
 */
export class PaperWallet {
  solBalance: number;

  constructor(startingBalanceSol: number = config.dryRunStartingBalanceSol) {
    this.solBalance = startingBalanceSol;
    logger.info(`[DRY RUN] Paper wallet initialized with ${startingBalanceSol} SOL.`);
  }

  private haircut(): number {
    return config.slippagePct / 2 / 100;
  }

  private txFee(): number {
    return BASE_NETWORK_FEE_SOL + config.priorityFeeSol;
  }

  simulateBuy(mint: string, solAmount: number, currentPricePerToken: number): TradeResult {
    const totalCost = solAmount + this.txFee();
    if (totalCost > this.solBalance) {
      return {
        success: false,
        filledSol: 0,
        filledTokens: 0,
        pricePerToken: currentPricePerToken,
        error: `Insufficient paper balance (${this.solBalance.toFixed(4)} SOL) for ${solAmount} SOL buy + fees`,
      };
    }
    const effectivePrice = currentPricePerToken * (1 + this.haircut());
    const filledTokens = solAmount / effectivePrice;
    this.solBalance -= totalCost;
    return {
      success: true,
      filledSol: solAmount,
      filledTokens,
      pricePerToken: effectivePrice,
    };
  }

  simulateSell(mint: string, tokenAmount: number, currentPricePerToken: number): TradeResult {
    const effectivePrice = currentPricePerToken * (1 - this.haircut());
    const solReceived = Math.max(0, tokenAmount * effectivePrice - this.txFee());
    this.solBalance += solReceived;
    return {
      success: true,
      filledSol: solReceived,
      filledTokens: tokenAmount,
      pricePerToken: effectivePrice,
    };
  }
}
