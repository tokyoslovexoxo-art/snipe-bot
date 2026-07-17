import { EventEmitter } from "events";
import WebSocket from "ws";
import { logger } from "../logger";
import { NewTokenEvent, TokenTradeEvent } from "../types";

const WS_URL = "wss://pumpportal.fun/api/data";
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Thin wrapper around PumpPortal's public data websocket.
 * Emits "newToken" and "trade" events, and reconnects with backoff while
 * re-issuing whatever subscriptions were active (new-token subscription is
 * global; per-mint trade subscriptions are tracked in `watchedMints`).
 */
export class PumpPortalSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private closedByUser = false;
  private watchedMints = new Set<string>();
  private subscribedToNewTokens = false;
  private subscribedAccounts = new Set<string>();

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    logger.info(`Connecting to PumpPortal (${WS_URL})...`);
    this.ws = new WebSocket(WS_URL);

    this.ws.on("open", () => {
      logger.info("PumpPortal websocket connected.");
      this.reconnectAttempt = 0;
      if (this.subscribedToNewTokens) {
        this.send({ method: "subscribeNewToken" });
      }
      if (this.watchedMints.size > 0) {
        this.send({ method: "subscribeTokenTrade", keys: [...this.watchedMints] });
      }
      if (this.subscribedAccounts.size > 0) {
        this.send({ method: "subscribeAccountTrade", keys: [...this.subscribedAccounts] });
      }
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      this.handleMessage(raw.toString());
    });

    this.ws.on("close", () => {
      if (this.closedByUser) return;
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      logger.error(`PumpPortal websocket error: ${err.message}`);
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt += 1;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1),
      RECONNECT_MAX_MS
    );
    logger.warn(`PumpPortal websocket closed. Reconnecting in ${delay}ms...`);
    setTimeout(() => this.open(), delay);
  }

  private handleMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const obj = msg as Record<string, unknown>;

    // Subscription ack / error messages don't have txType. Log them instead
    // of silently discarding — this is the only visibility we have into
    // whether PumpPortal actually accepted a subscribeAccountTrade request
    // (e.g. a malformed request could come back as an error here rather
    // than a thrown exception, and we'd otherwise never see it).
    if (typeof obj.txType !== "string") {
      logger.info(`[PumpPortal] Non-trade message: ${JSON.stringify(obj).slice(0, 500)}`);
      return;
    }

    if (obj.txType === "create") {
      this.emit("newToken", obj as unknown as NewTokenEvent);
    } else if (obj.txType === "buy" || obj.txType === "sell") {
      this.emit("trade", obj as unknown as TokenTradeEvent);
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      logger.info(`[PumpPortal] Sending: ${JSON.stringify(payload)}`);
      this.ws.send(JSON.stringify(payload));
    } else {
      logger.warn(`[PumpPortal] Socket not open, could not send: ${JSON.stringify(payload)}`);
    }
  }

  subscribeNewTokens(): void {
    this.subscribedToNewTokens = true;
    this.send({ method: "subscribeNewToken" });
  }

  /**
   * Subscribes to every buy/sell made by these specific wallets, across ANY
   * mint — not just ones we're separately watching via watchMint/
   * subscribeTokenTrade. This is what makes copy-trade-only mode work
   * without scanning every new launch: we don't need to have seen a token
   * created or be already watching it to notice the tracked wallet trading
   * it, since this subscription is keyed by wallet, not by mint.
   */
  subscribeAccountTrades(wallets: string[]): void {
    const newOnes = wallets.filter((w) => !this.subscribedAccounts.has(w));
    if (newOnes.length === 0) return;
    for (const w of newOnes) this.subscribedAccounts.add(w);
    this.send({ method: "subscribeAccountTrade", keys: newOnes });
  }

  watchMint(mint: string): void {
    if (this.watchedMints.has(mint)) return;
    this.watchedMints.add(mint);
    this.send({ method: "subscribeTokenTrade", keys: [mint] });
  }

  unwatchMint(mint: string): void {
    if (!this.watchedMints.has(mint)) return;
    this.watchedMints.delete(mint);
    this.send({ method: "unsubscribeTokenTrade", keys: [mint] });
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }
}
