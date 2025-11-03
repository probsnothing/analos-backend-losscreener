import { supabase } from "./client.js";
import { CandleBucket } from "./types.js";

export async function recordOhlcTrade(
  mint: string,
  price: number | null,
  volumeQuote: number,
  blockTimeIso: string | null
) {
  if (!blockTimeIso || price == null || !isFinite(price) || price <= 0) return;
  const { error } = await supabase.rpc("record_ohlc_trade", {
    m_mint: mint,
    m_price: price,
    m_volume_quote: volumeQuote,
    m_block_time: blockTimeIso,
  });
  if (error) throw error;
}

export async function getCandles(
  mint: string,
  sinceIso: string,
  bucket: CandleBucket,
  limit = 500
) {
  const { data, error } = await supabase
    .from("token_candles")
    .select("bucket_start, open, high, low, close, volume_quote, trade_count")
    .eq("mint_address", mint)
    .eq("bucket_size", bucket)
    .gte("bucket_start", sinceIso)
    .order("bucket_start", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data as Array<{
    bucket_start: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume_quote: number;
    trade_count: number;
  }>;
}
