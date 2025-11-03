import { supabase } from "./client.js";

export async function recordVolumeInBuckets(
  mint: string,
  volume: number,
  blockTimeIso: string | null
) {
  if (!blockTimeIso) return;

  const { error } = await supabase.rpc("record_volume_in_buckets", {
    m_mint: mint,
    m_volume: volume,
    m_block_time: blockTimeIso,
  });
  if (error) throw error;
}

export async function getVolumeStats(mint: string) {
  const { data, error } = await supabase.rpc("get_volume_stats", {
    m_mint: mint,
  });
  if (error) throw error;
  return data?.[0] as {
    volume_5m: number;
    trades_5m: number;
    volume_1h: number;
    trades_1h: number;
    volume_6h: number;
    trades_6h: number;
    volume_24h: number;
    trades_24h: number;
  } | null;
}

export async function cleanupOldVolumeBuckets() {
  const { error } = await supabase.rpc("cleanup_old_volume_buckets");
  if (error) throw error;
}
