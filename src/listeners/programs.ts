import { Connection, PublicKey } from "@solana/web3.js";
import { ENV } from "../config/env.js";
import {
  makeHttpConnection,
  makeWsConnection,
  fetchTransaction,
  getBlockTimeSafe,
} from "../utils/solana.js";
import { upsertEvent } from "../db/events.js";
import { getToken, upsertToken } from "../db/tokens.js";
import { recordTokenTx, insertTokenTransaction } from "../db/transactions.js";
import { recordVolumeInBuckets } from "../db/volume.js";
import { recordOhlcTrade } from "../db/candles.js";
import { recordTokenHolder } from "../db/holders.js";
import { updateTokenMetrics, computeTokenMetrics } from "../lib/metrics.js";

function classifyEvent(logs: string[]): "buy" | "sell" | "update" | "unknown" {
  const joined = logs.join("\n").toLowerCase();
  if (joined.includes("purchase") || joined.includes("acquire")) return "buy";
  if (
    joined.includes("redeem") &&
    !joined.includes("buy") &&
    !joined.includes("purchase")
  )
    return "sell";
  if (joined.includes("update") || joined.includes("configure"))
    return "update";
  return "unknown";
}

async function enrichTokenIfMissing(http: Connection, mintStr: string) {
  try {
    const existing = await getToken(mintStr);
    const needsName = !existing?.name;
    const needsSymbol = !existing?.symbol;
    const needsImage = !existing?.image;
    const needsDesc = !existing?.description;
    if (!needsName && !needsSymbol && !needsImage && !needsDesc) return;

    const mintPk = new PublicKey(mintStr);
    let name: string | null = existing?.name ?? null;
    let symbol: string | null = existing?.symbol ?? null;
    let image: string | null = existing?.image ?? null;
    let description: string | null = existing?.description ?? null;

    let uri: string | null = null;
    let metadataExtensions: any | null | undefined = undefined;
    try {
      const parsed = await http.getParsedAccountInfo(mintPk, "confirmed");
      const pdata: any = parsed?.value?.data;
      const info = pdata?.parsed?.info;
      if (info && Array.isArray(info.extensions)) {
        metadataExtensions = info.extensions;
      }
      const ext = info?.extensions?.find(
        (e: any) => e.extension === "tokenMetadata"
      );
      if (ext?.state) {
        if (!name) name = ext.state.name || null;
        if (!symbol) symbol = ext.state.symbol || null;
        uri = ext.state.uri || null;
      }
    } catch {}

    if (uri && (needsImage || needsDesc)) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(uri, { signal: controller.signal });
        clearTimeout(t);
        if (res.ok) {
          const j: any = await res.json().catch(() => null);
          if (j) {
            if (!image && typeof j.image === "string") image = j.image;
            if (!description && typeof j.description === "string")
              description = j.description;
            if (!name && typeof j.name === "string") name = j.name;
            if (!symbol && typeof j.symbol === "string") symbol = j.symbol;
          }
        }
      } catch {}
    }

    await upsertToken({
      mint_address: mintStr,
      name,
      symbol,
      decimals: existing?.decimals ?? null,
      raw_account: existing?.raw_account ?? null,
      metadata_extensions:
        metadataExtensions !== undefined
          ? metadataExtensions
          : existing?.metadata_extensions ?? null,
      image: image ?? null,
      description: description ?? null,
    });
  } catch (e) {
    console.error(`[enrichToken] Error enriching ${mintStr}:`, e);
  }
}

export async function startLogsListenerForPrograms() {
  const http = makeHttpConnection();
  const ws = makeWsConnection();

  const programIds = [ENV.PROGRAMS.BONDING_CURVE, ENV.PROGRAMS.DAMM];
  const subIds: number[] = [];

  for (const pid of programIds) {
    console.log("[logs] subscribing to program logs", pid.toBase58());
    const id = await ws.onLogs(
      pid,
      async (logs, ctx) => {
        try {
          const signature = logs.signature;
          const programId = pid.toBase58();
          let eventType = classifyEvent(logs.logs);
          const blockTime = await getBlockTimeSafe(http, ctx.slot);

          const tx = await fetchTransaction(http, signature);
          if (!tx) return;

          const accounts =
            tx?.transaction?.message?.staticAccountKeys?.map((k) =>
              k.toBase58()
            ) || [];

          const ixDataSizes: number[] = [];
          try {
            const message = tx?.transaction?.message as any;
            if (message && message.compiledInstructions) {
              for (const ix of message.compiledInstructions) {
                const progKey = message.staticAccountKeys[ix.programIdIndex];
                if (
                  progKey?.equals?.(pid) ||
                  progKey?.toBase58?.() === programId
                ) {
                  ixDataSizes.push(ix.data?.length || 0);
                }
              }
            }
          } catch {}

          const accountSizes: Record<string, number> = {};
          if (ENV.DEBUG_VERBOSE) {
            for (const a of accounts.slice(0, 10)) {
              try {
                const info = await http.getAccountInfo(new PublicKey(a));
                accountSizes[a] = info?.data ? (info.data as Buffer).length : 0;
              } catch {}
            }
          }

          const ixCount =
            tx?.meta?.logMessages?.filter((l) => l.includes(pid.toBase58()))
              .length || 1;

          const amounts = logs.logs
            .map((l) => {
              const m = l.match(/(amount|qty|in|out)[^\d]*(\d+[\.]?\d*)/i);
              return m ? Number(m[2]) : null;
            })
            .filter((v) => v !== null);

          let mintDeltaObj: Record<string, number> = {};
          let primaryMintCaptured: string | null = null;
          let primaryDeltaCaptured = 0;
          try {
            const pre = tx?.meta?.preTokenBalances || [];
            const post = tx?.meta?.postTokenBalances || [];
            const byKey = new Map<string, { pre?: any; post?: any }>();
            for (const b of pre) {
              const key = `${b.mint}:${b.accountIndex}`;
              byKey.set(key, { pre: b });
            }
            for (const b of post) {
              const key = `${b.mint}:${b.accountIndex}`;
              const cur = byKey.get(key) || {};
              cur.post = b;
              byKey.set(key, cur);
            }

            const mintDelta = new Map<string, number>();
            const ownerMintDelta = new Map<string, Map<string, number>>();
            for (const [, v] of byKey) {
              const pr = v.pre?.uiTokenAmount?.uiAmount || 0;
              const po = v.post?.uiTokenAmount?.uiAmount || 0;
              const mint = v.post?.mint || v.pre?.mint;
              const owner = v.post?.owner || v.pre?.owner || null;
              if (!mint) continue;
              mintDelta.set(mint, (mintDelta.get(mint) || 0) + (po - pr));
              if (owner) {
                const inner =
                  ownerMintDelta.get(owner) || new Map<string, number>();
                inner.set(mint, (inner.get(mint) || 0) + (po - pr));
                ownerMintDelta.set(owner, inner);
              }
            }
            mintDeltaObj = Object.fromEntries(mintDelta);

            const losMint = ENV.LOS_MINT.toBase58();
            let primaryMint: string | null = null;
            let primaryDelta = 0;
            for (const [m, d] of mintDelta) {
              if (m === losMint) continue;
              if (Math.abs(d) > Math.abs(primaryDelta)) {
                primaryMint = m;
                primaryDelta = d;
              }
            }
            if (!primaryMint) {
              for (const [m, d] of mintDelta) {
                if (Math.abs(d) > Math.abs(primaryDelta)) {
                  primaryMint = m;
                  primaryDelta = d;
                }
              }
            }

            if (
              !primaryMint ||
              primaryMint === losMint ||
              Math.abs(primaryDelta) === 0
            ) {
              const mintFlow = new Map<string, number>();
              for (const [, v] of byKey) {
                const pr = v.pre?.uiTokenAmount?.uiAmount || 0;
                const po = v.post?.uiTokenAmount?.uiAmount || 0;
                const m = v.post?.mint || v.pre?.mint;
                if (!m) continue;
                const deltaAbs = Math.abs((po as number) - (pr as number));
                mintFlow.set(
                  m,
                  (mintFlow.get(m) || 0) + (isFinite(deltaAbs) ? deltaAbs : 0)
                );
              }
              let bestMint: string | null = null;
              let bestFlow = 0;
              for (const [m, f] of mintFlow) {
                if (m === losMint) continue;
                if (f > bestFlow) {
                  bestFlow = f;
                  bestMint = m;
                }
              }
              if (bestMint) {
                primaryMint = bestMint;
                primaryDelta = Number(mintDeltaObj[bestMint] || 0);
              }
            }

            if (primaryMint) {
              primaryMintCaptured = primaryMint;
              primaryDeltaCaptured = primaryDelta;
              await enrichTokenIfMissing(http, primaryMint);

              const isBondingCurve = pid.equals(ENV.PROGRAMS.BONDING_CURVE);
              const isDamm = pid.equals(ENV.PROGRAMS.DAMM);
              const los = ENV.LOS_MINT.toBase58();
              const losDelta = Number(mintDeltaObj[los] ?? 0);
              const payer =
                tx.transaction.message.staticAccountKeys[0]?.toBase58() || null;
              const payerMap = payer ? ownerMintDelta.get(payer) : undefined;
              const payerPrimaryDelta =
                payerMap && primaryMint
                  ? Number(payerMap.get(primaryMint) || 0)
                  : 0;
              const payerLosDelta = payerMap
                ? Number(payerMap.get(los) || 0)
                : 0;

              if (
                (isBondingCurve || isDamm) &&
                (payerPrimaryDelta !== 0 || payerLosDelta !== 0)
              ) {
                if (payerPrimaryDelta !== 0) {
                  eventType = payerPrimaryDelta > 0 ? "buy" : "sell";
                } else {
                  eventType = payerLosDelta < 0 ? "buy" : "sell";
                }
              } else if ((isBondingCurve || isDamm) && losDelta !== 0) {
                eventType = losDelta < 0 ? "buy" : "sell";
              } else {
                eventType =
                  primaryDelta > 0
                    ? "buy"
                    : primaryDelta < 0
                    ? "sell"
                    : "update";
              }

              const iso = blockTime
                ? new Date(blockTime * 1000).toISOString()
                : null;
              await recordTokenTx(
                signature,
                primaryMint,
                eventType === "buy" || eventType === "sell"
                  ? eventType
                  : "unknown",
                iso
              );

              if (Math.abs(losDelta) > 0 && iso) {
                await recordVolumeInBuckets(
                  primaryMint,
                  Math.abs(losDelta),
                  iso
                );
              }

              let price: number | null = null;
              try {
                const m = await computeTokenMetrics(http, primaryMint);
                const mp = m?.price ?? null;
                if (mp && isFinite(mp) && mp > 0) price = mp;
              } catch {}

              if (!price || !isFinite(price) || price <= 0) {
                const tDeltaPayer = Math.abs(payerPrimaryDelta);
                const lDeltaPayer = Math.abs(payerLosDelta);
                const tokDelta =
                  tDeltaPayer > 0
                    ? tDeltaPayer
                    : Math.abs(Number(mintDeltaObj[primaryMint] ?? 0));
                const losDeltaCalc =
                  lDeltaPayer > 0
                    ? lDeltaPayer
                    : Math.abs(Number(mintDeltaObj[los] ?? 0));
                const derived =
                  tokDelta > 0 && losDeltaCalc > 0
                    ? losDeltaCalc / tokDelta
                    : null;
                if (
                  derived &&
                  isFinite(derived) &&
                  derived > 0 &&
                  derived < 1e3
                ) {
                  price = derived;
                }
              }

              const losDeltaAbs = Math.abs(Number(mintDeltaObj[los] ?? 0));
              if (price && isFinite(price) && price > 0 && iso) {
                await recordOhlcTrade(primaryMint, price, losDeltaAbs, iso);
              }

              const baseAmount = Math.abs(
                payerPrimaryDelta || mintDeltaObj[primaryMint] || 0
              );
              const side =
                eventType === "buy" || eventType === "sell"
                  ? eventType
                  : primaryDelta > 0
                  ? "buy"
                  : "sell";
              if (iso && (baseAmount > 0 || (price && losDeltaAbs > 0))) {
                await insertTokenTransaction({
                  signature,
                  mint_address: primaryMint,
                  side,
                  amount: isFinite(baseAmount) ? baseAmount : null,
                  price: price && isFinite(price) ? price : null,
                  value:
                    baseAmount && price && isFinite(price)
                      ? baseAmount * price
                      : losDeltaAbs && isFinite(losDeltaAbs)
                      ? losDeltaAbs
                      : null,
                  trader_address: payer,
                  block_time: iso,
                });
              }

              await updateTokenMetrics(http, primaryMint, {
                mintDeltas: mintDeltaObj,
              });
            }

            for (const [, v] of byKey) {
              const mint = v.post?.mint || v.pre?.mint;
              const owner = v.post?.owner || v.pre?.owner;
              const balance = v.post?.uiTokenAmount?.uiAmount || 0;
              if (mint && owner) {
                await recordTokenHolder(mint, owner, balance);
              }
            }
          } catch (e) {
            console.error(
              `[programs/logs] error processing deltas for ${signature}`,
              e
            );
          }

          for (let i = 0; i < ixCount; i++) {
            await upsertEvent({
              signature,
              instruction_index: i,
              event_type: eventType,
              program_id: programId,
              block_time: blockTime
                ? new Date(blockTime * 1000).toISOString()
                : null,
              parsed: {
                accounts,
                amounts,
                ixDataSizes,
                accountSizes,
                primaryMint: primaryMintCaptured,
                primaryDelta: primaryDeltaCaptured,
                mintDeltas: mintDeltaObj,
              },
              raw_logs: logs.logs,
            });
          }

          if (ENV.DEBUG_VERBOSE) {
            console.log("[logs]", programId, signature, {
              eventType,
              ixDataSizes,
              sampleAccountSizes: accountSizes,
            });
          }
        } catch (e) {
          console.error("[logs] upsert error", e);
        }
      },
      "confirmed"
    );
    subIds.push(id);
  }

  return { ws, subIds };
}
