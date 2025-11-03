import { supabase } from "./client.js";
import { UpsertToken, TokenRow } from "./types.js";

export async function upsertToken(token: UpsertToken) {
  const { data, error } = await supabase
    .from("tokens")
    .upsert(token, { onConflict: "mint_address" })
    .select();
  if (error) throw error;
  return data;
}

export async function getToken(mint: string): Promise<TokenRow | null> {
  const { data, error } = await supabase
    .from("tokens")
    .select("*")
    .eq("mint_address", mint)
    .maybeSingle();
  if (error) throw error;
  return data;
}
