import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { getToken, upsertToken } from "../db/tokens.js";
import { ENV } from "../config/env.js";
import {
  makeHttpConnection,
  makeWsConnection,
  fetchTransaction,
  getBlockTimeSafe,
} from "../utils/solana.js";

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

function asBase64(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

export async function startToken2022MintListener() {
  const http = makeHttpConnection();
  const ws = makeWsConnection();
  const programId = ENV.PROGRAMS.TOKEN_2022;

  console.log(
    "[token2022] subscribing to logs for InitializeMint",
    programId.toBase58()
  );

  const subId = await ws.onLogs(
    programId,
    async (logs, ctx) => {
      try {
        const signature = logs.signature;
        const tx = await fetchTransaction(http, signature);
        if (!tx) return;
        const blockTime = await getBlockTimeSafe(http, ctx.slot);

        const accounts = tx.transaction.message.staticAccountKeys.map((k) =>
          k.toBase58()
        );

        for (const acc of accounts) {
          try {
            const pk = new PublicKey(acc);
            const mint = await getMint(
              http as any,
              pk,
              "confirmed" as any,
              programId as any
            );

            const ai = await http.getAccountInfo(pk, {
              commitment: "confirmed",
            });
            if (!ai || !ai.data) continue;
            const raw = ai.data as Buffer;

            let name: string | null = null;
            let symbol: string | null = null;
            let metadataExtensions: any | null | undefined = undefined;
            try {
              const parsed = await http.getParsedAccountInfo(pk, "confirmed");
              const pdata: any = parsed?.value?.data;
              const info = pdata?.parsed?.info;
              if (info && Array.isArray(info.extensions)) {
                metadataExtensions = info.extensions;
              }
              const ext = info?.extensions?.find(
                (e: any) => e.extension === "tokenMetadata"
              );
              if (ext?.state) {
                name = ext.state.name || null;
                symbol = ext.state.symbol || null;
              }
            } catch {}

            await upsertToken({
              mint_address: acc,
              name,
              symbol,
              decimals: Number(mint.decimals),
              created_sig: signature,
              metadata_extensions:
                metadataExtensions !== undefined ? metadataExtensions : null,
              created_at: blockTime
                ? new Date(blockTime * 1000).toISOString()
                : undefined,
              raw_account: {
                base64: asBase64(raw),
                owner: ai.owner.toBase58(),
                executable: ai.executable,
                lamports: ai.lamports,
              },
            });
            await enrichTokenIfMissing(http, acc);
          } catch (e) {
            // ignore individual account parse errors
          }
        }
      } catch (e) {
        console.error("[token2022/logs] error", e);
      }
    },
    "confirmed"
  );

  return { ws, subId };
}
