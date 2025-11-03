export type PoolInfo = {
  address: string;
  tokenA: string;
  tokenB: string;
  liquidity: number;
  volume24h: number;
  price: number;
  type: "damm" | "bonding-curve";
  bondingCurveProgress?: number;
};

export type TokenRow = {
  mint_address: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  created_at?: string | null;
  raw_account?: any;
  metadata_extensions?: any;
  tx_count?: number;
  buy_count?: number;
  sell_count?: number;
  created_sig?: string | null;
  image?: string | null;
  description?: string | null;
  price?: number | null;
  market_cap?: number | null;
  liquidity?: number | null;
  supply?: number | null;
  volume_24h?: number | null;
  trades_24h?: number | null;
  volume_6h?: number | null;
  trades_6h?: number | null;
  volume_1h?: number | null;
  trades_1h?: number | null;
  volume_5m?: number | null;
  trades_5m?: number | null;
  pools?: PoolInfo[];
  last_trade_at?: string | null;
  holder_count?: number;
};

export type UpsertToken = Partial<TokenRow> & { mint_address: string };

export type EventRow = {
  signature: string;
  instruction_index: number;
  event_type: "buy" | "sell" | "update" | "unknown";
  program_id: string;
  block_time: string | null;
  parsed: any;
  raw_logs: any;
};

export type TokenTransaction = {
  signature?: string | null;
  mint_address: string;
  side: "buy" | "sell";
  amount?: number | null; // base token amount
  price?: number | null; // quote per base
  value?: number | null; // total quote value
  trader_address?: string | null;
  block_time: string; // ISO timestamp
};

export type CandleBucket =
  | "1 minute"
  | "5 minutes"
  | "15 minutes"
  | "30 minutes"
  | "1 hour"
  | "2 hours"
  | "4 hours"
  | "8 hours"
  | "12 hours"
  | "24 hours";
