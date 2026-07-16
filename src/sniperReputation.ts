import * as fs from "fs";
import * as path from "path";
import { config } from "./config";
import { logger } from "./logger";
import { SniperRecord } from "./types";

/**
 * Persistent per-wallet track record for OTHER buyers/snipers the bot
 * observes (not the token creators — see DevReputationStore for that).
 * A wallet is scored on realized round-trip PnL for the portion of their
 * trading we actually witness (see SniperTracker for the exact mechanics
 * and its sampling caveat).
 *
 * Two paths to "trusted":
 * - Earned: enough observed round-trips at a high enough win rate.
 * - Manual (PRIORITY_SNIPER_WALLETS): trusted immediately on your say-so,
 *   but not unconditionally forever — once we've observed enough of that
 *   wallet's own round-trips and their real win rate is bad, the free pass
 *   is revoked.
 */
export class SniperReputationStore {
  private snipers = new Map<string, SniperRecord>();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(config.sniperStoreFile)) {
        const raw = JSON.parse(fs.readFileSync(config.sniperStoreFile, "utf-8")) as SniperRecord[];
        for (const rec of raw) this.snipers.set(rec.wallet, rec);
        logger.info(`Loaded ${this.snipers.size} known sniper wallet(s) from ${config.sniperStoreFile}`);
      }
    } catch (err) {
      logger.warn(
        `Failed to load sniper reputation store: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    for (const wallet of config.prioritySniperWallets) {
      logger.info(`Priority sniper wallet configured: ${wallet.slice(0, 8)}... (trusted until proven otherwise)`);
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(config.sniperStoreFile), { recursive: true });
      fs.writeFileSync(config.sniperStoreFile, JSON.stringify([...this.snipers.values()], null, 2));
    } catch (err) {
      logger.warn(
        `Failed to save sniper reputation store: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private getOrCreate(wallet: string): SniperRecord {
    let rec = this.snipers.get(wallet);
    if (!rec) {
      rec = { wallet, roundTrips: 0, wins: 0, losses: 0, totalPnlSol: 0, lastSeenAt: Date.now() };
      this.snipers.set(wallet, rec);
    }
    return rec;
  }

  recordRoundTrip(wallet: string, pnlSol: number, win: boolean): void {
    const rec = this.getOrCreate(wallet);
    rec.roundTrips += 1;
    if (win) rec.wins += 1;
    else rec.losses += 1;
    rec.totalPnlSol += pnlSol;
    rec.lastSeenAt = Date.now();
    this.save();
    logger.info(
      `Sniper ${wallet.slice(0, 8)}... round-trip recorded: ${rec.wins}W/${rec.losses}L, ` +
        `total observed PnL ${rec.totalPnlSol.toFixed(4)} SOL (trusted=${this.isTrusted(wallet)})`
    );
  }

  /** Read-only snapshot of a wallet's current record, if any is known yet. */
  getRecord(wallet: string): SniperRecord | undefined {
    const rec = this.snipers.get(wallet);
    return rec ? { ...rec } : undefined;
  }

  isTrusted(wallet: string): boolean {
    if (!config.sniperTrackingEnabled) return false;

    const rec = this.snipers.get(wallet);
    const samples = rec ? rec.wins + rec.losses : 0;
    const winRatePct = samples > 0 ? (rec!.wins / samples) * 100 : 0;

    if (config.prioritySniperWallets.includes(wallet)) {
      if (samples >= config.sniperRevokeMinSamples && winRatePct <= config.sniperRevokeMaxWinRatePct) {
        return false; // proven otherwise — revoke the free pass
      }
      return true; // trusted until proven otherwise
    }

    if (samples === 0) return false;
    return samples >= config.sniperTrustMinSamples && winRatePct >= config.sniperTrustMinWinRatePct;
  }

  summary(): { totalSnipers: number; trusted: number } {
    let trusted = 0;
    for (const wallet of this.snipers.keys()) {
      if (this.isTrusted(wallet)) trusted += 1;
    }
    for (const wallet of config.prioritySniperWallets) {
      if (!this.snipers.has(wallet) && this.isTrusted(wallet)) trusted += 1;
    }
    return { totalSnipers: this.snipers.size, trusted };
  }
}
