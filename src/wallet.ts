import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config";

let cachedKeypair: Keypair | null = null;
let cachedConnection: Connection | null = null;

export function getKeypair(): Keypair {
  if (cachedKeypair) return cachedKeypair;
  if (!config.privateKey) {
    throw new Error("PRIVATE_KEY is not set (required outside DRY_RUN mode).");
  }
  cachedKeypair = Keypair.fromSecretKey(bs58.decode(config.privateKey));
  return cachedKeypair;
}

export function getConnection(): Connection {
  if (cachedConnection) return cachedConnection;
  cachedConnection = new Connection(config.rpcUrl, "confirmed");
  return cachedConnection;
}
