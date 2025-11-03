import { Connection, PublicKey } from "@solana/web3.js";
import { CpAmm, getPriceFromSqrtPrice } from "@analosfork/damm-sdk";
import { DynamicBondingCurveClient } from "@analosfork/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { ENV } from "../config/env.js";
import { upsertToken } from "../db/tokens.js";
import { getRecentEventsForMint } from "../db/events.js";
import { getVolumeStats } from "../db/volume.js";
import { PoolInfo } from "../db/types.js";

export type TokenMetrics = {
  price: number | null;
  liquidity: number | null;
  supply: number | null;
  decimals: number | null;
  market_cap: number | null;
  pools: PoolInfo[];
  volume_24h: number | null;
  trades_24h: number | null;
  volume_6h: number | null;
  trades_6h: number | null;
  volume_1h: number | null;
  trades_1h: number | null;
  volume_5m: number | null;
  trades_5m: number | null;
};

async function getMintInfo(
  conn: Connection,
  mint: PublicKey
): Promise<{ supply: number | null; decimals: number | null }> {
  try {
    const acc = await conn.getParsedAccountInfo(mint, "confirmed");
    const parsed: any = acc?.value?.data;
    const info = parsed?.parsed?.info;
    const supplyRaw = info?.supply;
    const decimals = typeof info?.decimals === "number" ? info.decimals : null;
    let supply: number | null = null;
    if (supplyRaw != null && decimals != null) {
      const supplyBn = BigInt(String(supplyRaw));
      supply = Number(supplyBn) / Math.pow(10, decimals);
    }
    return { supply, decimals };
  } catch {
    return { supply: null, decimals: null };
  }
}

async function getVaultUiAmount(
  conn: Connection,
  tokenAccount: PublicKey
): Promise<number> {
  try {
    const bal = await conn.getTokenAccountBalance(tokenAccount);
    const s = bal?.value?.uiAmountString || bal?.value?.amount;
    const n = parseFloat(s || "0");
    return isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function getMintDecimals(conn: Connection, mint: PublicKey) {
  try {
    const acc = await conn.getParsedAccountInfo(mint, "confirmed");
    const parsed: any = acc?.value?.data;
    const info = parsed?.parsed?.info;
    const dec = typeof info?.decimals === "number" ? info.decimals : null;
    return dec as number | null;
  } catch {
    return null;
  }
}

async function computeFromDamm(
  conn: Connection,
  mint: PublicKey
): Promise<{
  price: number | null;
  liquidity: number | null;
  pools: PoolInfo[];
}> {
  try {
    const cpAmm = new CpAmm(conn);
    const allPools: any[] = (await cpAmm.getAllPools().catch(() => [])) || [];
    const mintStr = mint.toBase58();
    const los = ENV.LOS_MINT.toBase58();
    const losPools = allPools.filter((p) => {
      try {
        const a = p.account.tokenAMint.toBase58();
        const b = p.account.tokenBMint.toBase58();
        return (a === mintStr || b === mintStr) && (a === los || b === los);
      } catch {
        return false;
      }
    });

    if (!losPools.length) {
      return { price: null, liquidity: null, pools: [] };
    }

    const scored = await Promise.all(
      losPools.slice(0, 6).map(async (p) => {
        const av = await getVaultUiAmount(conn, p.account.tokenAVault);
        const bv = await getVaultUiAmount(conn, p.account.tokenBVault);
        return { p, score: av + bv };
      })
    );
    const topPools = scored
      .sort((x, y) => y.score - x.score)
      .slice(0, 2)
      .map((s) => s.p);

    let price: number | null = null;
    let liquidity: number | null = null;
    const best = topPools[0];
    if (best) {
      const isA = best.account.tokenAMint.toBase58() === mintStr;
      const tokenVault = isA
        ? best.account.tokenAVault
        : best.account.tokenBVault;
      const losVault = isA
        ? best.account.tokenBVault
        : best.account.tokenAVault;
      const [tBal, lBal] = await Promise.all([
        conn.getTokenAccountBalance(tokenVault).catch(() => null),
        conn.getTokenAccountBalance(losVault).catch(() => null),
      ]);
      const tAmt = parseFloat(tBal?.value?.uiAmountString ?? "0");
      const lAmt = parseFloat(lBal?.value?.uiAmountString ?? "0");

      const priceVR = tAmt > 0 ? lAmt / tAmt : null;

      let priceSqrt: number | null = null;
      try {
        const sqrt =
          best.account.sqrtPrice ||
          best.account.sqrtPriceX64 ||
          best.account.sqrtPriceQ64 ||
          null;
        const decA = await getMintDecimals(conn, best.account.tokenAMint);
        const decB = await getMintDecimals(conn, best.account.tokenBMint);
        if (
          sqrt &&
          typeof getPriceFromSqrtPrice === "function" &&
          decA != null &&
          decB != null
        ) {
          const pAB = Number(getPriceFromSqrtPrice(sqrt, decA, decB));
          if (isFinite(pAB) && pAB > 0) {
            priceSqrt = isA ? pAB : 1 / pAB;
          }
        }
      } catch {}

      if (
        priceSqrt != null &&
        isFinite(priceSqrt) &&
        (priceVR == null ||
          (priceSqrt > priceVR / 5 && priceSqrt < priceVR * 5))
      ) {
        price = priceSqrt;
      } else {
        price = priceVR;
      }

      liquidity =
        price && isFinite(price)
          ? lAmt + tAmt * price
          : isFinite(lAmt)
          ? lAmt
          : null;
    }

    const pools: PoolInfo[] = await Promise.all(
      topPools.map(async (p: any) => {
        const poolAddress = p.publicKey.toBase58();
        const tokenA = p.account.tokenAMint.toBase58();
        const tokenB = p.account.tokenBMint.toBase58();

        const isA = tokenA === mintStr;
        const tokenVault = isA ? p.account.tokenAVault : p.account.tokenBVault;
        const losVault = isA ? p.account.tokenBVault : p.account.tokenAVault;

        const [tBal, lBal] = await Promise.all([
          conn.getTokenAccountBalance(tokenVault).catch(() => null),
          conn.getTokenAccountBalance(losVault).catch(() => null),
        ]);

        const tAmt = parseFloat(tBal?.value?.uiAmountString ?? "0");
        const lAmt = parseFloat(lBal?.value?.uiAmountString ?? "0");

        const priceVR = tAmt > 0 ? lAmt / tAmt : 0;
        let poolPrice = priceVR;
        try {
          const sqrt =
            p.account.sqrtPrice ||
            p.account.sqrtPriceX64 ||
            p.account.sqrtPriceQ64 ||
            null;
          if (sqrt) {
            const decA = await getMintDecimals(conn, p.account.tokenAMint);
            const decB = await getMintDecimals(conn, p.account.tokenBMint);

            if (getPriceFromSqrtPrice && decA != null && decB != null) {
              const pAB = Number(getPriceFromSqrtPrice(sqrt, decA, decB));
              if (isFinite(pAB) && pAB > 0) {
                const priceSqrt = isA ? pAB : 1 / pAB;
                if (priceSqrt > priceVR / 5 && priceSqrt < priceVR * 5) {
                  poolPrice = priceSqrt;
                }
              }
            }
          }
        } catch {
          poolPrice = priceVR;
        }

        const poolLiquidity =
          poolPrice && isFinite(poolPrice) ? lAmt + tAmt * poolPrice : lAmt;

        return {
          address: poolAddress,
          tokenA,
          tokenB,
          liquidity: poolLiquidity,
          volume24h: 0,
          price: poolPrice,
          type: "damm" as const,
        };
      })
    );

    return { price, liquidity, pools };
  } catch (e) {
    if (ENV.DEBUG_VERBOSE) {
      console.log("[metrics][DAMM] error", e);
    }
    return { price: null, liquidity: null, pools: [] };
  }
}

async function computeFromBondingCurve(
  conn: Connection,
  mint: PublicKey
): Promise<{
  price: number | null;
  liquidity: number | null;
  pools: PoolInfo[];
}> {
  try {
    const bc = new DynamicBondingCurveClient(conn, "confirmed");

    let bondingPool: any = null;
    try {
      const addr = mint.toBase58();
      bondingPool = await bc.state.getPoolByBaseMint(addr);
    } catch {}

    if (!bondingPool) {
      return { price: null, liquidity: null, pools: [] };
    }

    const ps: any = bondingPool.account;
    const poolAddress = bondingPool.publicKey.toBase58();

    let poolConfig: any = null;
    try {
      if (ps?.config) {
        poolConfig = await bc.state.getPoolConfig(ps.config);
      }
    } catch {}

    let quoteMintStr = ENV.LOS_MINT.toBase58();
    try {
      if (poolConfig?.quoteMint) quoteMintStr = poolConfig.quoteMint.toBase58();
    } catch {}

    const baseDecimals: number =
      typeof poolConfig?.tokenDecimal === "number"
        ? poolConfig.tokenDecimal
        : (await getMintDecimals(conn, mint)) ?? 9;
    const quoteDecimals: number =
      quoteMintStr === ENV.LOS_MINT.toBase58()
        ? 9
        : (await getMintDecimals(conn, new PublicKey(quoteMintStr))) ?? 9;

    const baseReserve = Number(
      ps?.baseReserve?.toString?.() ?? ps?.baseReserve ?? 0
    );
    const quoteReserve = Number(
      ps?.quoteReserve?.toString?.() ?? ps?.quoteReserve ?? 0
    );
    const base = baseReserve / Math.pow(10, baseDecimals);
    const quote = quoteReserve / Math.pow(10, quoteDecimals);

    if (!(base > 0)) {
      return { price: null, liquidity: null, pools: [] };
    }

    let price: number | null = null;
    try {
      const activationType: number = Number(poolConfig?.activationType ?? 0);
      let currentPoint: BN;
      if (activationType === 1) {
        currentPoint = new BN(Math.floor(Date.now() / 1000));
      } else {
        currentPoint = new BN(await conn.getSlot("confirmed"));
      }

      const oneBase = new BN(10).pow(new BN(baseDecimals));
      const quoteRes: any = await bc.pool.swapQuote({
        virtualPool: ps,
        config: poolConfig,
        swapBaseForQuote: true,
        amountIn: oneBase,
        slippageBps: 0,
        hasReferral: false,
        currentPoint,
      });
      const outRaw =
        quoteRes?.outAmount ??
        quoteRes?.expectedAmountOut ??
        quoteRes?.minimumAmountOut ??
        quoteRes?.amountOut;
      const outNum = Number(outRaw?.toString() ?? 0);
      if (isFinite(outNum) && outNum > 0) {
        price = outNum / Math.pow(10, quoteDecimals);
      }
    } catch (e) {
      if (ENV.DEBUG_VERBOSE) {
        console.log("[metrics][DBC] swapQuote failed", e);
      }
    }

    if (price == null || !isFinite(price) || price <= 0) {
      price = quote / base;
    }

    const liquidity = quote + base * price;

    let bondingCurveProgress: number | undefined;
    try {
      bondingCurveProgress = await bc.state.getPoolCurveProgress(poolAddress);
    } catch (error) {
      bondingCurveProgress = undefined;
    }

    const pool: PoolInfo = {
      address: poolAddress,
      tokenA: ps?.baseMint?.toBase58?.() ?? mint.toBase58(),
      tokenB: quoteMintStr,
      liquidity,
      volume24h: 0,
      price,
      type: "bonding-curve",
      bondingCurveProgress,
    };

    return {
      price: isFinite(price) ? price : null,
      liquidity,
      pools: [pool],
    };
  } catch (e) {
    if (ENV.DEBUG_VERBOSE) {
      console.log("[metrics][DBC] error", e);
    }
    return { price: null, liquidity: null, pools: [] };
  }
}

export async function computeTokenMetrics(
  conn: Connection,
  mintStr: string,
  opts?: { mintDeltas?: Record<string, number> }
): Promise<TokenMetrics> {
  const mint = new PublicKey(mintStr);

  const [{ supply, decimals }, damm, bc] = await Promise.all([
    getMintInfo(conn, mint),
    computeFromDamm(conn, mint),
    computeFromBondingCurve(conn, mint),
  ]);

  const dammHas = (damm.pools?.length || 0) > 0 && damm.price != null;
  const bcHas = (bc.pools?.length || 0) > 0 && bc.price != null;
  const migrated = (bc.pools || []).some(
    (p) => p.type === "bonding-curve" && (p.bondingCurveProgress ?? 0) >= 1
  );
  let price: number | null = null;
  let liquidity: number | null = null;
  if (migrated && dammHas) {
    price = damm.price!;
    liquidity = damm.liquidity ?? null;
  } else if (!migrated && bcHas) {
    price = bc.price!;
    liquidity = bc.liquidity ?? null;
  } else if (bcHas && !dammHas) {
    price = bc.price!;
    liquidity = bc.liquidity ?? null;
  } else if (!bcHas && dammHas) {
    price = damm.price!;
    liquidity = damm.liquidity ?? null;
  } else {
    price = damm.price ?? bc.price ?? null;
    liquidity = damm.liquidity ?? bc.liquidity ?? null;
  }

  const pools: PoolInfo[] = [...damm.pools, ...bc.pools];

  let market_cap = supply != null && price != null ? supply * price : null;

  let volume_5m: number | null = null;
  let trades_5m: number | null = null;
  let volume_1h: number | null = null;
  let trades_1h: number | null = null;
  let volume_6h: number | null = null;
  let trades_6h: number | null = null;
  let volume_24h: number | null = null;
  let trades_24h: number | null = null;

  try {
    const volumeStats = await getVolumeStats(mintStr);
    if (volumeStats) {
      volume_5m = volumeStats.volume_5m || null;
      trades_5m = volumeStats.trades_5m || null;
      volume_1h = volumeStats.volume_1h || null;
      trades_1h = volumeStats.trades_1h || null;
      volume_6h = volumeStats.volume_6h || null;
      trades_6h = volumeStats.trades_6h || null;
      volume_24h = volumeStats.volume_24h || null;
      trades_24h = volumeStats.trades_24h || null;
    }
  } catch (e) {
    if (ENV.DEBUG_VERBOSE) {
      console.log("[metrics] volume stats error:", e);
    }
  }

  if ((price == null || !isFinite(price)) && opts?.mintDeltas) {
    try {
      const los = ENV.LOS_MINT.toBase58();
      const losDelta = Math.abs(Number(opts.mintDeltas[los] ?? 0));
      const tokenDelta = Math.abs(Number(opts.mintDeltas[mintStr] ?? 0));
      if (losDelta > 0 && tokenDelta > 0) {
        price = losDelta / tokenDelta;
        market_cap = supply != null && price != null ? supply * price : null;
      }
    } catch {}
  }

  return {
    price,
    liquidity,
    supply,
    decimals,
    market_cap,
    pools,
    volume_24h,
    trades_24h,
    volume_6h,
    trades_6h,
    volume_1h,
    trades_1h,
    volume_5m,
    trades_5m,
  };
}

export async function updateTokenMetrics(
  conn: Connection,
  mintStr: string,
  opts?: { mintDeltas?: Record<string, number> }
) {
  const m = await computeTokenMetrics(conn, mintStr, opts);
  const payload = Object.fromEntries(
    Object.entries({
      mint_address: mintStr,
      price: m.price,
      market_cap: m.market_cap,
      liquidity: m.liquidity,
      supply: m.supply ?? undefined,
      decimals: m.decimals ?? undefined,
      volume_24h: m.volume_24h ?? undefined,
      trades_24h: m.trades_24h != null ? Math.trunc(m.trades_24h) : undefined,
      volume_6h: m.volume_6h ?? undefined,
      trades_6h: m.trades_6h != null ? Math.trunc(m.trades_6h) : undefined,
      volume_1h: m.volume_1h ?? undefined,
      trades_1h: m.trades_1h != null ? Math.trunc(m.trades_1h) : undefined,
      volume_5m: m.volume_5m ?? undefined,
      trades_5m: m.trades_5m != null ? Math.trunc(m.trades_5m) : undefined,
      pools: m.pools,
    }).filter(([, v]) => v !== undefined)
  ) as any;
  await upsertToken(payload);
}
