import { DecisionContext } from "./types";

/**
 * Deterministic 0..1 confidence score used only to place a trade's
 * take-profit target within [MIN_TAKE_PROFIT_PCT, MAX_TAKE_PROFIT_PCT].
 * This is a fixed, documented formula over known signals already captured
 * in DecisionContext — NOT a learned/black-box model (see README's section
 * on why that distinction matters for this bot specifically).
 *
 * Formula, in order:
 * - Base score from how the trade qualified: dev/sniper fast-tracks start
 *   higher than a plain volume-confirmed buy, since they already passed a
 *   trust check the volume path didn't.
 * - Adjusted by the creator's realized win rate so far (if any samples
 *   exist), +/-0.2 swing.
 * - Adjusted the same way by the triggering sniper's win rate, if this was
 *   a sniper-triggered buy.
 * Clamped to [0, 1].
 */
export function computeConfidenceScore(context: DecisionContext): number {
  let score: number;
  switch (context.qualificationPath) {
    case "dev_trusted":
    case "sniper_trusted":
      score = 0.6;
      break;
    default:
      score = 0.25;
  }

  const devSamples = context.devWinsAtBuy + context.devLossesAtBuy;
  if (devSamples > 0) {
    const devWinRate = context.devWinsAtBuy / devSamples;
    score += (devWinRate - 0.5) * 0.4;
  }

  if (
    context.triggeringSniperWallet &&
    context.sniperWinsAtBuy !== null &&
    context.sniperLossesAtBuy !== null
  ) {
    const sniperSamples = context.sniperWinsAtBuy + context.sniperLossesAtBuy;
    if (sniperSamples > 0) {
      const sniperWinRate = context.sniperWinsAtBuy / sniperSamples;
      score += (sniperWinRate - 0.5) * 0.4;
    }
  }

  return Math.max(0, Math.min(1, score));
}

export function targetTakeProfitFromScore(
  score: number,
  minTakeProfitPct: number,
  maxTakeProfitPct: number
): number {
  return minTakeProfitPct + score * (maxTakeProfitPct - minTakeProfitPct);
}
