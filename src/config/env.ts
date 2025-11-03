import "dotenv/config";
import { PublicKey } from "@solana/web3.js";

function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  return value;
}

export const ENV = {
  SOLANA_RPC_URL: process.env.RPC_URL || "https://rpc.analos.io",
  SOLANA_WSS_URL: process.env.WS_URL || "wss://ws.analos.io",
  DEBUG_VERBOSE: Boolean(process.env.DEBUG_VERBOSE),
  PROGRAMS: {
    TOKEN_2022: new PublicKey(getEnv("PROGRAM_TOKEN_2022")),
    BONDING_CURVE: new PublicKey(getEnv("PROGRAM_BONDING_CURVE")),
    DAMM: new PublicKey(getEnv("PROGRAM_DAMM")),
  },
  LOS_MINT: new PublicKey(getEnv("LOS_MINT")),
  SUPABASE_URL: getEnv("SUPABASE_URL"),
  SUPABASE_ANON_KEY: getEnv("SUPABASE_ANON_KEY"),
};
