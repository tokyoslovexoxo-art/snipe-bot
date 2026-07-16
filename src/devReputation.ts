import * as fs from "fs";
import * as path from "path";
import { config } from "./config";
import { logger } from "./logger";
import { DevRecord, TrustLevel } from "./types";

/**
 * Persistent per-creator-wallet track record, so the bot "remembers" devs
 * across restarts. This is plain, explainable bookkeeping (counts + a
 * threshold), not a model — see AdaptiveTuner / README for the reasoning
 * behind keeping it this way for a live-money bot.
 */
export class DevReputationStore {
  private devs = new Map<string, DevRecord>();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(config.devStoreFile)) {
        const raw = JSON.parse(fs.readFileSync(config.devStoreFile, "utf-8")) as DevRecord[];
        for (const rec of raw) this.devs.set(rec.wallet, rec);
        logger.info(`Loaded ${this.devs.size} known dev wallet(s) from ${config.devStoreFile}`);
      }
    } catch (err) {
      logger.warn(
        `Failed to load dev reputation store: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(config.devStoreFile), { recursive: true });
      fs.writeFileSync(config.devStoreFile, JSON.stringify([...this.devs.values()], null, 2));
    } catch (err) {
      logger.warn(
        `Failed to save dev reputation store: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private getOrCreate(wallet: string): DevRecord {
    let rec = this.devs.get(wallet);
    if (!rec) {
      rec = {
        wallet,
        tokensLaunched: 0,
        tokensBought: 0,
        wins: 0,
        losses: 0,
        totalPnlSol: 0,
        lastSeenAt: Date.now(),
      };
      this.devs.set(wallet, rec);
    }
    return rec;
  }

  recordLaunch(wallet: string): void {
    const rec = this.getOrCreate(wallet);
    rec.tokensLaunched += 1;
    rec.lastSeenAt = Date.now();
    this.save();
  }

  recordBuy(wallet: string): void {
    const rec = this.getOrCreate(wallet);
    rec.tokensBought += 1;
    this.save();
  }

  recordOutcome(wallet: string, pnlSol: number, win: boolean): void {
    const rec = this.getOrCreate(wallet);
    if (win) rec.wins += 1;
    else rec.losses += 1;
    rec.totalPnlSol += pnlSol;
    this.save();
    logger.info(
      `Dev ${wallet.slice(0, 8)}... record: ${rec.wins}W/${rec.losses}L, total PnL ` +
        `${rec.totalPnlSol.toFixed(4)} SOL (trust=${this.getTrustLevel(wallet)})`
    );
  }

  /** Read-only snapshot of a wallet's current record, if any is known yet. */
  getRecord(wallet: string): DevRecord | undefined {
    const rec = this.devs.get(wallet);
    return rec ? { ...rec } : undefined;
  }

  getTrustLevel(wallet: string): TrustLevel {
    if (!config.devTrackingEnabled) return "neutral";

    const rec = this.devs.get(wallet);
    if (!rec) return "neutral";

    const samples = rec.wins + rec.losses;
    if (samples === 0) return "neutral";
    const winRatePct = (rec.wins / samples) * 100;

    if (samples >= config.blacklistMinSamples && winRatePct < config.blacklistMaxWinRatePct) {
      return "blacklisted";
    }
    if (samples >= config.trustMinSamples && winRatePct >= config.trustMinWinRatePct) {
      return "trusted";
    }
    return "neutral";
  }

  summary(): { totalDevs: number; trusted: number; blacklisted: number } {
    let trusted = 0;
    let blacklisted = 0;
    for (const wallet of this.devs.keys()) {
      const level = this.getTrustLevel(wallet);
      if (level === "trusted") trusted += 1;
      else if (level === "blacklisted") blacklisted += 1;
    }
    return { totalDevs: this.devs.size, trusted, blacklisted };
  }
}
