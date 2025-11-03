# Losscreener.com Backend

This package powers the indexing and data pipelines that feed [losscreener.com](https://losscreener.com). It listens to key Solana programs, enriches the on-chain activity it observes, and persists normalized analytics in Supabase so the frontend can surface fresh token insights.

## Requirements

- Node.js 18 or newer (see `package.json` `engines` field)
- npm 9+ (ships with Node.js 18)
- Access to a Solana RPC endpoint and matching WebSocket endpoint
- A Supabase project with the provided schema deployed

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the example environment file and fill in the missing secrets:
   ```bash
   cp .env.example .env
   # edit .env
   ```
3. Apply the SQL schema to your Supabase instance (see [Database Setup](#database-setup)).
4. Build the TypeScript sources:
   ```bash
   npm run build
   ```
5. Start the compiled service:
   ```bash
   npm start
   ```

During development you can skip the build step and run the TypeScript entrypoint directly with hot reload:

```bash
npm run dev
```

## Environment Variables

All variables shown in `.env.example` are required unless marked optional.

| Variable                      | Description                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `RPC_URL`                     | HTTPS Solana RPC endpoint used for historical lookups. Defaults to `https://rpc.analos.io` when unset. |
| `WS_URL`                      | WebSocket Solana endpoint for real-time logs. Defaults to `wss://ws.analos.io` when unset.             |
| `PROGRAM_TOKEN_2022`          | Token-2022 program public key to monitor for new mints.                                                |
| `ASSOCIATED_TOKEN_PROGRAM_ID` | Associated token program ID used while parsing accounts.                                               |
| `PROGRAM_BONDING_CURVE`       | Bonding curve program public key whose transactions should be ingested.                                |
| `PROGRAM_DAMM`                | DAMM program public key whose transactions should be ingested.                                         |
| `LOS_MINT`                    | Mint address for the LOS token; used when deriving prices and trade sides.                             |
| `DEBUG_VERBOSE`               | Set to `1` to enable extra logging during event processing. Optional.                                  |
| `SUPABASE_URL`                | Supabase project REST URL.                                                                             |
| `SUPABASE_ANON_KEY`           | Supabase service role key (store securely, do not ship to clients).                                    |

> ⚠️ Never commit real Supabase keys. Keep `.env` files out of version control.

## Database Setup

The Supabase schema and helper routines live in `sql/optimized-schema.sql`. Run the statements inside that file against your Supabase project (SQL editor or `psql`). The script is idempotent and can be re-run safely when deploying updates.

Key tables created by the schema:

- `tokens`: canonical token metadata with rolling volume metrics
- `events`: low-level program log captures for auditing
- `token_transactions`: per-trade records used for analytics
- `token_volume_buckets` & `token_candles`: aggregated volume and OHLC data
- `token_holders`: snapshot of current holders per mint

Several Postgres functions and triggers maintain rolling metrics and clean up historical buckets automatically.

## npm Scripts

| Command             | Purpose                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `npm run dev`       | Start the watcher in development mode with live reload via `ts-node-dev`. |
| `npm run build`     | Bundle TypeScript to `dist/` using `tsup`.                                |
| `npm start`         | Run the compiled JavaScript (`dist/index.cjs`).                           |
| `npm run typecheck` | Perform a TypeScript type pass (`tsc --noEmit`).                          |
| `npm run clean`     | Delete the compiled `dist/` directory.                                    |

## Service Overview

The entrypoint (`src/index.ts`) orchestrates several long-running jobs:

- **Token 2022 Mint Listener** (`listeners/token2022.ts`): captures new token creations and enriches mint metadata.
- **Program Log Listener** (`listeners/programs.ts`): tails bonding-curve and DAMM program logs, reconstructs trades, classifies events, records volume, candles, holders, and per-transaction analytics in Supabase.
- **Volume Cleanup Task** (`tasks/volumeCleanup.ts`): periodically prunes expired volume buckets to keep storage lean.

Supporting modules under `src/db/` handle Supabase persistence, while `src/utils/solana.ts` centralizes Solana connection helpers and retries.

## Deployment Notes

- Ensure the service can reach your Supabase instance and Solana RPC endpoints with low latency.
- For production, run `npm run build` during CI/CD and deploy the contents of `dist/` (plus package assets) to your runtime environment.
- Monitor logs for `Supabase readiness check failed` messages; the process retries connection setup before beginning to stream events.

## Troubleshooting

- **Schema mismatches**: Re-run `sql/optimized-schema.sql` to reconcile Supabase tables and functions.
- **Permission errors**: Verify the Supabase service role key is present and the associated role has rights to call the Postgres functions.
- **Dropped WebSocket connections**: Check RPC/WebSocket provider limits; the listeners automatically resubscribe on restarts but do not currently implement backoff for mid-session drops.

## Contributing

- Run `npm run typecheck` before pushing changes.
- Keep configuration defaults in `.env.example` current whenever new variables are introduced.
- Submit schema changes alongside updated SQL scripts and documentation notes.
