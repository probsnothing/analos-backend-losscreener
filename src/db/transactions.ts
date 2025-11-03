import { supabase } from "./client.js";
import { TokenTransaction } from "./types.js";

export async function insertTokenTransaction(tx: TokenTransaction) {
  const { error } = await supabase.from("token_transactions").insert({
    signature: tx.signature ?? null,
    mint_address: tx.mint_address,
    side: tx.side,
    amount: tx.amount ?? null,
    price: tx.price ?? null,
    value: tx.value ?? (tx.amount && tx.price ? tx.amount * tx.price : null),
    trader_address: tx.trader_address ?? null,
    block_time: tx.block_time,
  });
  if (error) throw error;
}

export async function recordTokenTx(
  signature: string,
  mint: string,
  side: "buy" | "sell" | "unknown",
  blockTimeIso: string | null
) {
  const { error } = await supabase.rpc("record_token_tx", {
    m_sig: signature,
    m_mint: mint,
    m_side: side,
    m_block_time: blockTimeIso,
  });
  if (error) throw error;
}
