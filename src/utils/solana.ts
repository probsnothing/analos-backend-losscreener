import { Connection, Transaction, VersionedTransaction } from "@solana/web3.js";
import { ENV } from "../config/env.js";

let httpConnection: Connection | null = null;
let wsConnection: Connection | null = null;

export function makeHttpConnection() {
  if (!httpConnection) {
    httpConnection = new Connection(ENV.SOLANA_RPC_URL, {
      commitment: "confirmed",
      wsEndpoint: ENV.SOLANA_WSS_URL,
    });
  }
  return httpConnection;
}

export function makeWsConnection() {
  return makeHttpConnection();
}

export async function fetchTransaction(http: Connection, signature: string) {
  try {
    const tx = await http.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    return tx;
  } catch (e) {
    console.error(`[solana] failed to fetch tx ${signature}`, e);
    return null;
  }
}

export async function getBlockTimeSafe(http: Connection, slot: number) {
  try {
    return await http.getBlockTime(slot);
  } catch (e) {
    console.warn(`[solana] failed to get block time for slot ${slot}`, e);
    return null;
  }
}
