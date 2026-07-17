import * as fs from "fs";
import * as path from "path";
import { config } from "./config";
import { logger } from "./logger";
import { ClosedPosition } from "./types";

export interface TunedParams {
  minVolumeSol: number;
  maxDevHoldPct: number;
  unsupportedMaxHoldMs: number;
}

const STEP_FRACTION = 0.1; // nudge by 10% of baseline per evaluation
// If one exit reason accounts for this much of a window, something
// structural is likely wrong rather than normal trade-to-trade variance.
const DOMINANT_EXIT_REASON_THRESHOLD = 0.5;

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
    this.current = this.load() ?? {
      minVolumeSol: config.minVolumeSol,
      maxDevHoldPct: config.maxDevHoldPct,
      unsupportedMaxHoldMs: config.unsupportedMaxHoldMs,
    };
  }

  get(): TunedParams {
    if (!config.adaptiveTuningEnabled) {
      return {
        minVolumeSol: config.minVolumeSol,
        maxDevHoldPct: config.maxDevHoldPct,
        unsupportedMaxHoldMs: config.unsupportedMaxHoldMs,
      };
    }
    return this.current;
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
