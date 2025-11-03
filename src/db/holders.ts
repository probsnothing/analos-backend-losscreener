import { supabase } from "./client.js";

export async function recordTokenHolder(
  mint: string,
  holder: string,
  balance: number
) {
  const { error } = await supabase.rpc("record_token_holder", {
    m_mint: mint,
    m_holder: holder,
    m_balance: balance,
  });
  if (error) throw error;
}
