import * as fs from "fs";
import * as path from "path";
import { config } from "./config";
import { logger } from "./logger";
import { ClosedPosition, SniperRecord } from "./types";

export interface TunedParams {
  minVolumeSol: number;
  maxDevHoldPct: number;
  unsupportedMaxHoldMs: number;
  marketCapRangeUsd: { minUsd: number; maxUsd: number };
}

const STEP_FRACTION = 0.1; // nudge by 10% of baseline per evaluation
// If one exit reason accounts for this much of a window, something
// structural is likely wrong rather than normal trade-to-trade variance.
const DOMINANT_EXIT_REASON_THRESHOLD = 0.5;
// Need at least this many observed buys from a priority wallet before their
// average buy-context is trusted enough to nudge the entry gate.
const MIN_BUY_CONTEXT_SAMPLES = 3;

/**
 * Bounded, rule-based adaptation: after every TUNING_WINDOW_TRADES closed
 * trades, look at the realized win rate and nudge the *entry filters*
 * (minVolumeSol, maxDevHoldPct) tighter or looser — never past
 * +/-TUNING_MAX_ADJUST_PCT of your .env baseline. Deliberately does not
 * touch TAKE_PROFIT_PCT/STOP_LOSS_PCT (your explicit exit economics), and is
 * not a black-box model: every adjustment is logged with the stat that
 * triggered it, and current values persist to disk so they survive restarts.
 *
 * Also watches for one exit reason dominating the window (e.g. almost every
 * trade cut short by unsupportedMaxHoldMs before ever reaching a real
 * take-profit/stop-loss decision) — this is exactly the kind of structural
 * problem that showed up in practice: nearly all trades early on lack any
 * sniper backing (nothing has earned trust yet), so a too-short unsupported-
 * hold window can force-exit almost everything before it has a real chance,
 * silently draining the account one small loss at a time. When that pattern
 * is detected, unsupportedMaxHoldMs is nudged up (bounded, same as the other
 * params) so positions get more room.
 *
 * With a selective bot you may only see a handful of qualifying trades a
 * day, so treat this as a slow-moving safety adjustment, not fast learning.
 */
export class AdaptiveTuner {
  private current: TunedParams;
  private window: ClosedPosition[] = [];

  constructor() {
    this.current = this.load() ?? this.baseline();
    // Backward-compat: older tuning.json files predate marketCapRangeUsd.
    if (!this.current.marketCapRangeUsd) {
      this.current.marketCapRangeUsd = { minUsd: config.entryMinMarketCapUsd, maxUsd: config.entryMaxMarketCapUsd };
    }
  }

  private baseline(): TunedParams {
    return {
      minVolumeSol: config.minVolumeSol,
      maxDevHoldPct: config.maxDevHoldPct,
      unsupportedMaxHoldMs: config.unsupportedMaxHoldMs,
      marketCapRangeUsd: { minUsd: config.entryMinMarketCapUsd, maxUsd: config.entryMaxMarketCapUsd },
    };
  }

  get(): TunedParams {
    if (!config.adaptiveTuningEnabled) return this.baseline();
    return this.current;
  }

  /**
   * Nudges the market-cap entry range's center toward what a manually-
   * seeded priority sniper wallet actually buys at, once it has enough
   * observed samples (MIN_BUY_CONTEXT_SAMPLES) — the "build off what we've
   * learned about why this wallet picks what it picks" feedback loop.
   * Range width stays roughly constant; min/max are each still clamped to
   * TUNING_MAX_ADJUST_PCT of their own .env baseline, same as every other
   * tuned value.
   */
  considerPriorityWalletCharacteristics(records: SniperRecord[]): void {
    if (!config.adaptiveTuningEnabled) return;

    for (const rec of records) {
      if (rec.buyContextSamples < MIN_BUY_CONTEXT_SAMPLES) continue;

      const { minUsd, maxUsd } = this.current.marketCapRangeUsd;
      const currentCenter = (minUsd + maxUsd) / 2;
      const currentWidth = maxUsd - minUsd;
      const targetCenter = rec.avgMarketCapUsdAtBuy;
      if (Math.abs(targetCenter - currentCenter) < 1) continue; // already centered, nothing to do

      const newCenter = currentCenter + (targetCenter - currentCenter) * STEP_FRACTION;
      const newMinUsd = this.clamp(newCenter - currentWidth / 2, config.entryMinMarketCapUsd);
      const newMaxUsd = this.clamp(newCenter + currentWidth / 2, config.entryMaxMarketCapUsd);

      if (newMinUsd === minUsd && newMaxUsd === maxUsd) continue; // already at bounds

      this.current.marketCapRangeUsd = { minUsd: newMinUsd, maxUsd: newMaxUsd };
      logger.info(
        `[TUNER] Priority wallet ${rec.wallet.slice(0, 8)}... has bought at avg $${targetCenter.toFixed(0)} ` +
          `mcap over ${rec.buyContextSamples} observed buys — nudging entry range toward it: ` +
          `$${newMinUsd.toFixed(0)}-$${newMaxUsd.toFixed(0)} (was $${minUsd.toFixed(0)}-$${maxUsd.toFixed(0)}).`
      );
      this.save();
    }
  }

  recordClose(closed: ClosedPosition): void {
    if (!config.adaptiveTuningEnabled) return;

    this.window.push(closed);
    if (this.window.length >= config.tuningWindowTrades) {
      this.evaluate();
      this.window = [];
    }
  }

  private evaluate(): void {
    const wins = this.window.filter((t) => t.pnlSol > 0).length;
    const winRatePct = (wins / this.window.length) * 100;
    const stopLossExits = this.window.filter((t) => t.exitReason === "stop_loss");
    const avgStopLossPct =
      stopLossExits.length > 0
        ? stopLossExits.reduce((sum, t) => sum + t.pnlPct, 0) / stopLossExits.length
        : 0;

    let reason: string;

    if (winRatePct < 40 || (stopLossExits.length > 0 && avgStopLossPct < -config.stopLossPct * 1.5)) {
      this.current.minVolumeSol = this.clamp(
        this.current.minVolumeSol * (1 + STEP_FRACTION),
        config.minVolumeSol
      );
      this.current.maxDevHoldPct = this.clamp(
        this.current.maxDevHoldPct * (1 - STEP_FRACTION),
        config.maxDevHoldPct
      );
      reason =
        `win rate ${winRatePct.toFixed(0)}% / avg stop-loss exit ${avgStopLossPct.toFixed(1)}% ` +
        `worse than expected — tightening filters`;
    } else if (winRatePct > 60) {
      this.current.minVolumeSol = this.clamp(
        this.current.minVolumeSol * (1 - STEP_FRACTION),
        config.minVolumeSol
      );
      this.current.maxDevHoldPct = this.clamp(
        this.current.maxDevHoldPct * (1 + STEP_FRACTION),
        config.maxDevHoldPct
      );
      reason = `win rate ${winRatePct.toFixed(0)}% over last ${this.window.length} trades — loosening filters slightly`;
    } else {
      reason = `win rate ${winRatePct.toFixed(0)}% within normal range — no change`;
    }

    logger.info(
      `[TUNER] ${reason}. minVolumeSol=${this.current.minVolumeSol.toFixed(3)} ` +
        `maxDevHoldPct=${this.current.maxDevHoldPct.toFixed(1)}`
    );

    this.checkForDominantExitReason();
    this.save();
  }

  /**
   * If one exit reason explains most of the window, that's a structural
   * signal, not noise. Currently only self-corrects unsupported_timeout
   * dominance (the exact failure mode found in practice) by giving
   * positions more room before that early cutoff applies.
   */
  private checkForDominantExitReason(): void {
    const byReason: Record<string, number> = {};
    for (const t of this.window) {
      byReason[t.exitReason] = (byReason[t.exitReason] ?? 0) + 1;
    }

    const unsupportedCount = byReason["unsupported_timeout"] ?? 0;
    if (unsupportedCount / this.window.length >= DOMINANT_EXIT_REASON_THRESHOLD) {
      const before = this.current.unsupportedMaxHoldMs;
      this.current.unsupportedMaxHoldMs = this.clamp(
        this.current.unsupportedMaxHoldMs * (1 + STEP_FRACTION),
        config.unsupportedMaxHoldMs
      );
      logger.info(
        `[TUNER] ${unsupportedCount}/${this.window.length} trades in this window exited via ` +
          `unsupported_timeout — positions are likely being cut before they have a real chance. ` +
          `Raising unsupportedMaxHoldMs ${before.toFixed(0)}ms -> ${this.current.unsupportedMaxHoldMs.toFixed(0)}ms.`
      );
    }
  }

  private clamp(value: number, baseline: number): number {
    const min = baseline * (1 - config.tuningMaxAdjustPct / 100);
    const max = baseline * (1 + config.tuningMaxAdjustPct / 100);
    return Math.min(max, Math.max(min, value));
  }

  private load(): TunedParams | null {
    try {
      if (fs.existsSync(config.tuningStoreFile)) {
        const raw = JSON.parse(fs.readFileSync(config.tuningStoreFile, "utf-8")) as TunedParams;
        logger.info(`Loaded tuned params from ${config.tuningStoreFile}: ${JSON.stringify(raw)}`);
        return raw;
      }
    } catch (err) {
      logger.warn(`Failed to load tuning store: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(config.tuningStoreFile), { recursive: true });
      fs.writeFileSync(config.tuningStoreFile, JSON.stringify(this.current, null, 2));
    } catch (err) {
      logger.warn(`Failed to save tuning store: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
