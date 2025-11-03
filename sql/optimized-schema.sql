-- This file combines and optimizes the SQL schema for the Analos token indexer.
-- It is designed to be idempotent and can be run multiple times safely.

-- Main 'tokens' table with all volume columns
CREATE TABLE IF NOT EXISTS public.tokens (
  mint_address text PRIMARY KEY,
  name text,
  symbol text,
  decimals int,
  created_at timestamptz DEFAULT now(),
  raw_account jsonb,
  metadata_extensions jsonb,
  tx_count int NOT NULL DEFAULT 0,
  buy_count int NOT NULL DEFAULT 0,
  sell_count int NOT NULL DEFAULT 0,
  created_sig text,
  image text,
  description text,
  price numeric,
  market_cap numeric,
  liquidity numeric,
  supply numeric,
  volume_24h numeric,
  trades_24h int,
  volume_6h numeric,
  trades_6h int,
  volume_1h numeric,
  trades_1h int,
  volume_5m numeric,
  trades_5m int,
  pools jsonb,
  last_trade_at timestamptz,
  holder_count INT NOT NULL DEFAULT 0
);

-- 'token_holders' table to track token holders and their balances
CREATE TABLE IF NOT EXISTS public.token_holders (
  mint_address text NOT NULL,
  holder_address text NOT NULL,
  balance numeric NOT NULL,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (mint_address, holder_address)
);

-- 'events' table for transaction logs
CREATE TABLE IF NOT EXISTS public.events (
  signature text NOT NULL,
  instruction_index int NOT NULL DEFAULT 0,
  event_type text NOT NULL CHECK (event_type IN ('buy','sell','update','unknown')),
  program_id text NOT NULL,
  block_time timestamptz,
  parsed jsonb,
  raw_logs jsonb,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (signature, instruction_index)
);

-- 'token_event_marks' for idempotency
CREATE TABLE IF NOT EXISTS public.token_event_marks (
  signature text NOT NULL,
  mint_address text NOT NULL,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (signature, mint_address)
);

-- 'token_volume_buckets' for time-bucketed volume tracking
CREATE TABLE IF NOT EXISTS public.token_volume_buckets (
  mint_address text NOT NULL,
  bucket_start timestamptz NOT NULL,
  bucket_size interval NOT NULL,
  volume numeric NOT NULL DEFAULT 0,
  trade_count int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (mint_address, bucket_start, bucket_size)
);

-- 'token_transactions' table to track per-trade details
CREATE TABLE IF NOT EXISTS public.token_transactions (
  id bigserial PRIMARY KEY,
  signature text,
  mint_address text NOT NULL REFERENCES public.tokens(mint_address) ON UPDATE CASCADE ON DELETE CASCADE,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  amount numeric,
  price numeric,
  value numeric,
  trader_address text,
  block_time timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- 'token_candles' for OHLC charting
CREATE TABLE IF NOT EXISTS public.token_candles (
  mint_address text NOT NULL,
  bucket_start timestamptz NOT NULL,
  bucket_size interval NOT NULL,
  open numeric NOT NULL,
  high numeric NOT NULL,
  low numeric NOT NULL,
  close numeric NOT NULL,
  volume_quote numeric NOT NULL DEFAULT 0,
  trade_count int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (mint_address, bucket_start, bucket_size)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS events_program_time_idx ON public.events (program_id, block_time DESC);
CREATE INDEX IF NOT EXISTS tokens_created_at_idx ON public.tokens (created_at DESC);
CREATE INDEX IF NOT EXISTS token_volume_buckets_mint_time_idx ON public.token_volume_buckets (mint_address, bucket_start DESC);
CREATE INDEX IF NOT EXISTS token_volume_buckets_time_idx ON public.token_volume_buckets (bucket_start DESC);
CREATE INDEX IF NOT EXISTS token_transactions_mint_time_idx ON public.token_transactions (mint_address, block_time DESC);
CREATE INDEX IF NOT EXISTS token_transactions_trader_time_idx ON public.token_transactions (trader_address, block_time DESC);
CREATE INDEX IF NOT EXISTS token_transactions_side_time_idx ON public.token_transactions (side, block_time DESC);
CREATE INDEX IF NOT EXISTS token_candles_mint_time_idx ON public.token_candles (mint_address, bucket_start DESC);
CREATE INDEX IF NOT EXISTS tokens_last_trade_at_idx ON public.tokens (last_trade_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'token_transactions_sig_mint_unique'
  ) THEN
    CREATE UNIQUE INDEX token_transactions_sig_mint_unique
      ON public.token_transactions (signature, mint_address)
      WHERE signature IS NOT NULL;
  END IF;
END $$;

-- Functions and Triggers

CREATE OR REPLACE FUNCTION public.preserve_created_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.created_at IS NULL OR NEW.created_at > OLD.created_at THEN
      NEW.created_at := OLD.created_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tokens_preserve_created_at ON public.tokens;
CREATE TRIGGER tokens_preserve_created_at
BEFORE UPDATE ON public.tokens
FOR EACH ROW EXECUTE FUNCTION public.preserve_created_at();

CREATE OR REPLACE FUNCTION public.get_time_bucket(ts timestamptz, bucket_size interval)
RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
  SELECT date_trunc('hour', ts) + (floor(extract(minute FROM ts)::numeric / (extract(epoch FROM bucket_size) / 60)) * (extract(epoch FROM bucket_size) / 60)) * interval '1 minute'
$$;

CREATE OR REPLACE FUNCTION public.record_ohlc_trade(m_mint text, m_price numeric, m_volume_quote numeric, m_block_time timestamptz)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  bucket_sizes interval[] := ARRAY['1 minute', '5 minutes', '15 minutes', '30 minutes', '1 hour', '2 hours', '4 hours', '8 hours', '12 hours', '24 hours'];
  current_bucket_size interval;
  bs timestamptz;
BEGIN
  IF m_price IS NULL OR m_price <= 0 OR m_block_time IS NULL THEN RETURN; END IF;
  FOREACH current_bucket_size IN ARRAY bucket_sizes LOOP
    bs := public.get_time_bucket(m_block_time, current_bucket_size);
    INSERT INTO public.token_candles (mint_address, bucket_start, bucket_size, open, high, low, close, volume_quote, trade_count)
    VALUES (m_mint, bs, current_bucket_size, m_price, m_price, m_price, m_price, abs(COALESCE(m_volume_quote, 0)), 1)
    ON CONFLICT (mint_address, bucket_start, bucket_size) DO UPDATE SET
      high = GREATEST(token_candles.high, EXCLUDED.high),
      low = LEAST(token_candles.low, EXCLUDED.low),
      close = EXCLUDED.close,
      volume_quote = token_candles.volume_quote + EXCLUDED.volume_quote,
      trade_count = token_candles.trade_count + 1,
      updated_at = now();
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_token_tx(m_sig text, m_mint text, m_side text, m_block_time timestamptz)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.token_event_marks(signature, mint_address) VALUES (m_sig, m_mint) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.tokens SET
    tx_count = tx_count + 1,
    buy_count = buy_count + (CASE WHEN lower(m_side) = 'buy' THEN 1 ELSE 0 END),
    sell_count = sell_count + (CASE WHEN lower(m_side) = 'sell' THEN 1 ELSE 0 END),
    last_trade_at = COALESCE(GREATEST(last_trade_at, m_block_time), m_block_time)
  WHERE mint_address = m_mint;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_volume_in_buckets(m_mint text, m_volume numeric, m_block_time timestamptz)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  bucket_sizes interval[] := ARRAY['1 minute', '5 minutes', '15 minutes', '30 minutes', '1 hour', '2 hours', '4 hours', '6 hours', '8 hours', '12 hours', '24 hours'];
  current_bucket_size interval;
  calculated_bucket_start timestamptz;
BEGIN
  FOREACH current_bucket_size IN ARRAY bucket_sizes LOOP
    calculated_bucket_start := get_time_bucket(m_block_time, current_bucket_size);
    INSERT INTO public.token_volume_buckets (mint_address, bucket_start, bucket_size, volume, trade_count)
    VALUES (m_mint, calculated_bucket_start, current_bucket_size, abs(m_volume), 1)
    ON CONFLICT (mint_address, bucket_start, bucket_size) DO UPDATE SET
      volume = EXCLUDED.volume + token_volume_buckets.volume,
      trade_count = EXCLUDED.trade_count + token_volume_buckets.trade_count,
      updated_at = now();
  END LOOP;
  PERFORM public.update_token_volume_metrics(m_mint);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_volume_stats(m_mint text, base_time timestamptz DEFAULT now())
RETURNS TABLE(volume_5m numeric, trades_5m int, volume_1h numeric, trades_1h int, volume_6h numeric, trades_6h int, volume_24h numeric, trades_24h int)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COALESCE(SUM(volume), 0) FROM public.token_volume_buckets WHERE mint_address = m_mint AND bucket_size = '5 minutes'::interval AND bucket_start >= base_time - interval '5 minutes') as volume_5m,
    (SELECT COALESCE(SUM(trade_count), 0)::int FROM public.token_volume_buckets WHERE mint_address = m_mint AND bucket_size = '5 minutes'::interval AND bucket_start >= base_time - interval '5 minutes') as trades_5m,
    (SELECT COALESCE(SUM(volume), 0) FROM public.token_volume_buckets WHERE mint_address = m_mint AND bucket_size = '1 hour'::interval AND bucket_start >= base_time - interval '1 hour') as volume_1h,
    (SELECT COALESCE(SUM(trade_count), 0)::int FROM public.token_volume_buckets WHERE mint_address = m_mint AND bucket_size = '1 hour'::interval AND bucket_start >= base_time - interval '1 hour') as trades_1h,
    (SELECT COALESCE(SUM(volume), 0) FROM public.token_volume_buckets WHERE mint_address = m_mint AND bucket_size = '6 hours'::interval AND bucket_start >= base_time - interval '6 hours') as volume_6h,
    (SELECT COALESCE(SUM(trade_count), 0)::int FROM public.token_volume_buckets WHERE mint_address = m_mint AND bucket_size = '6 hours'::interval AND bucket_start >= base_time - interval '6 hours') as trades_6h,
    (SELECT COALESCE(SUM(volume), 0) FROM public.token_volume_buckets WHERE mint_address = m_mint AND bucket_size = '24 hours'::interval AND bucket_start >= base_time - interval '24 hours') as volume_24h,
    (SELECT COALESCE(SUM(trade_count), 0)::int FROM public.token_volume_buckets WHERE mint_address = m_mint AND bucket_size = '24 hours'::interval AND bucket_start >= base_time - interval '24 hours') as trades_24h;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_old_volume_buckets()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.token_volume_buckets WHERE bucket_start < now() - interval '90 days';
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_recent_tokens_metrics(horizon interval DEFAULT '24 hours', max_tokens int DEFAULT 5000)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT mint_address FROM public.tokens WHERE last_trade_at IS NOT NULL AND last_trade_at >= now() - horizon ORDER BY last_trade_at DESC LIMIT max_tokens LOOP
    PERFORM public.update_token_volume_metrics(r.mint_address);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_token_volume_metrics(m_mint text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  stats record;
BEGIN
  SELECT * INTO stats FROM get_volume_stats(m_mint);
  UPDATE public.tokens SET
    volume_5m = stats.volume_5m, trades_5m = stats.trades_5m,
    volume_1h = stats.volume_1h, trades_1h = stats.trades_1h,
    volume_6h = stats.volume_6h, trades_6h = stats.trades_6h,
    volume_24h = stats.volume_24h, trades_24h = stats.trades_24h
  WHERE mint_address = m_mint;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_holder_count()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.tokens SET holder_count = (SELECT COUNT(*) FROM public.token_holders WHERE mint_address = COALESCE(NEW.mint_address, OLD.mint_address) AND balance > 0)
  WHERE mint_address = COALESCE(NEW.mint_address, OLD.mint_address);
  RETURN NULL;
END;
$$;

CREATE TRIGGER token_holders_change_trigger
AFTER INSERT OR UPDATE OR DELETE ON public.token_holders
FOR EACH ROW EXECUTE FUNCTION public.update_holder_count();

CREATE OR REPLACE FUNCTION public.record_token_holder(m_mint text, m_holder text, m_balance numeric)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF m_balance > 0 THEN
    INSERT INTO public.token_holders (mint_address, holder_address, balance) VALUES (m_mint, m_holder, m_balance)
    ON CONFLICT (mint_address, holder_address) DO UPDATE SET balance = m_balance, updated_at = now();
  ELSE
    DELETE FROM public.token_holders WHERE mint_address = m_mint AND holder_address = m_holder;
  END IF;
END;
$$;
