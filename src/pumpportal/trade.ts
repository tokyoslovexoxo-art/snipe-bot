import { VersionedTransaction } from "@solana/web3.js";
import { config } from "../config";
import { getConnection, getKeypair } from "../wallet";
import { logger } from "../logger";
import { PaperWallet } from "../paperWallet";
import { TradeResult } from "../types";

const TRADE_LOCAL_URL = "https://pumpportal.fun/api/trade-local";

/**
 * Executes buys/sells. In DRY_RUN mode, delegates to the PaperWallet (no
 * network calls, no real funds). In live mode, uses PumpPortal's
 * *non-custodial* "local transaction" API: PumpPortal only builds an
 * unsigned transaction from these parameters, we sign it locally with our
 * own keypair and broadcast it via our own RPC connection. Your private key
 * is never sent anywhere.
 *
 * NOTE: this was built from PumpPortal's publicly documented request/response
 * shape, but pumpportal.fun blocked automated doc fetches while building this
 * (403), so the exact field semantics (e.g. percentage-based sell amounts)
 * could not be triple-checked against the live docs. Before flipping
 * DRY_RUN=false, do a single manual small-amount test trade and confirm the
 * transaction does what you expect.
 *
 * Also note: the trade-local response doesn't return the realized fill
 * price/amount, so live-mode fills below are an *approximation* (last quoted
 * price adjusted by your slippage tolerance), not the exact on-chain result.
 * Good enough to drive the TP/SL/time-exit logic, but for exact accounting
 * you'd want to reconcile against subscribeAccountTrade events or a
 * post-trade balance check.
 */
export class Trader {
  constructor(private paperWallet: PaperWallet | null) {}

  async buy(mint: string, solAmount: number, currentPricePerToken: number): Promise<TradeResult> {
    if (config.dryRun) {
      return this.paperWallet!.simulateBuy(mint, solAmount, currentPricePerToken);
    }
    return this.executeLive(
      { action: "buy", mint, amount: solAmount, denominatedInSol: "true" },
      currentPricePerToken,
      solAmount
    );
  }

  /**
   * Sells the given percentage of holdings (0-100, default 100 = full exit).
   * Selling by percentage rather than a tracked token amount avoids dust /
   * decimal-precision mismatches between our local bookkeeping and the
   * wallet's actual on-chain balance.
   */
  async sell(
    mint: string,
    currentPricePerToken: number,
    tokenAmountHeld: number,
    percentageOfHolding: number = 100
  ): Promise<TradeResult> {
    if (config.dryRun) {
      const amountToSell = (tokenAmountHeld * percentageOfHolding) / 100;
      return this.paperWallet!.simulateSell(mint, amountToSell, currentPricePerToken);
    }
    return this.executeLive(
      { action: "sell", mint, amount: `${percentageOfHolding}%`, denominatedInSol: "false" },
      currentPricePerToken,
      (tokenAmountHeld * percentageOfHolding) / 100
    );
  }

  private async executeLive(
    params: {
      action: "buy" | "sell";
      mint: string;
      amount: number | string;
      denominatedInSol: "true" | "false";
    },
    // Last quoted bonding-curve price and requested size, used only to
    // approximate fill numbers below (see note on realizedFill*).
    quotedPricePerToken: number,
    requestedSize: number
  ): Promise<TradeResult> {
    const keypair = getKeypair();
    const connection = getConnection();

    try {
      const response = await fetch(TRADE_LOCAL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicKey: keypair.publicKey.toBase58(),
          action: params.action,
          mint: params.mint,
          amount: params.amount,
          denominatedInSol: params.denominatedInSol,
          slippage: config.slippagePct,
          priorityFee: config.priorityFeeSol,
          pool: config.pool,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          success: false,
          filledSol: 0,
          filledTokens: 0,
          pricePerToken: 0,
          error: `trade-local HTTP ${response.status}: ${body}`,
        };
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      const tx = VersionedTransaction.deserialize(bytes);
      tx.sign([keypair]);

      const signature = await connection.sendTransaction(tx, { maxRetries: 3 });
      const confirmation = await connection.confirmTransaction(signature, "confirmed");

      if (confirmation.value.err) {
        return {
          success: false,
          filledSol: 0,
          filledTokens: 0,
          pricePerToken: 0,
          txSignature: signature,
          error: `Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`,
        };
      }

      logger.info(`Live ${params.action} tx confirmed: ${signature}`);
      // PumpPortal's trade-local response doesn't include the realized fill
      // amount, and we didn't wire up subscribeAccountTrade reconciliation
      // (see file header). We approximate the fill using the last quoted
      // bonding-curve price at decision time plus our configured slippage
      // tolerance as a conservative estimate. Real fills can differ from
      // this, most importantly during high-volume launches where price
      // moves fast between quote and confirmation.
      const slippageFraction = config.slippagePct / 100;
      const approxPrice =
        params.action === "buy"
          ? quotedPricePerToken * (1 + slippageFraction)
          : quotedPricePerToken * (1 - slippageFraction);
      const approxSol = params.action === "buy" ? requestedSize : requestedSize * approxPrice;
      const approxTokens = params.action === "buy" ? requestedSize / approxPrice : requestedSize;
      return {
        success: true,
        txSignature: signature,
        filledSol: approxSol,
        filledTokens: approxTokens,
        pricePerToken: approxPrice,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Live ${params.action} for ${params.mint} failed: ${message}`);
      return {
        success: false,
        filledSol: 0,
        filledTokens: 0,
        pricePerToken: 0,
        error: message,
      };
    }
  }
}
