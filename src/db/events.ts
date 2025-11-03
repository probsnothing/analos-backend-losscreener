import { supabase } from "./client.js";
import { EventRow } from "./types.js";

export async function upsertEvent(evt: EventRow) {
  const { data, error } = await supabase
    .from("events")
    .upsert(evt, { onConflict: "signature,instruction_index" })
    .select();
  if (error) throw error;
  return data;
}

export async function getRecentEventsForMint(
  mint: string,
  sinceIso: string,
  limit = 1000
) {
  const q = supabase
    .from("events")
    .select("signature, event_type, block_time, parsed")
    .contains("parsed", { primaryMint: mint })
    .gte("block_time", sinceIso)
    .order("block_time", { ascending: false })
    .limit(limit);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []) as Array<{
    signature: string;
    event_type: string;
    block_time: string | null;
    parsed: any;
  }>;
}
