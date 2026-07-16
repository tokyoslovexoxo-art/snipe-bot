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

    // Subscription ack / error messages don't have txType; ignore them.
    if (typeof obj.txType !== "string") return;

    if (obj.txType === "create") {
      this.emit("newToken", obj as unknown as NewTokenEvent);
    } else if (obj.txType === "buy" || obj.txType === "sell") {
      this.emit("trade", obj as unknown as TokenTradeEvent);
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  subscribeNewTokens(): void {
    this.subscribedToNewTokens = true;
    this.send({ method: "subscribeNewToken" });
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
