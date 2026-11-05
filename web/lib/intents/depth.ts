// Exit-liquidity rules shared with the perps contract (`set_depth`): any change here must be mirrored on-chain.
import {
  dryQuote,
  feeBpsFor,
  grossImpactBps,
  impactBps,
  OneClickError,
  type DryQuoteParams,
  type FetchImpl,
  type OneClickToken,
} from "./oneclick";

export const SAMPLE_SIZES_USD = [1_000, 10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000] as const;
export const MAX_EXIT_IMPACT_BPS = 100;
export const MIN_OPEN_CAPACITY_USD = 10_000;
export const MAX_DEPTH_AGE_MS = 30 * 60_000;

export interface DepthSample {
  size_usd: number;
  /** Net impact in bps after the 1Click fee; null when 1Click reports no liquidity. */
  impact_bps: number | null;
}

export interface DepthSampleDetail extends DepthSample {
  amount_in: string;
  gross_bps: number | null;
  amount_in_usd: number | null;
  amount_out_usd: number | null;
}

export interface AssetDepth {
  asset_id: string;
  price_usd: number;
  fee_bps: number;
  samples: DepthSample[];
  details: DepthSampleDetail[];
}

export interface SampleAssetOptions {
  tokens: readonly OneClickToken[];
  jwt?: string;
  fetchImpl?: FetchImpl;
  /** Explicit grids are sampled exactly; only the default grid can extend beyond $1M. */
  sizesUsd?: readonly number[];
}

// Token prices are scaled to 1e-12 USD so the USD → base-unit conversion stays in integer arithmetic.
const PRICE_SCALE_DIGITS = 12;

/** Converts a whole-dollar USD size into origin-asset base units at the given token price, rounded down. */
export function usdToBaseUnits(sizeUsd: number, priceUsd: number, decimals: number): string {
  if (!Number.isSafeInteger(sizeUsd) || sizeUsd < 0) throw new RangeError(`size must be a whole USD amount, got ${sizeUsd}`);
  if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) throw new RangeError(`price must be positive, got ${priceUsd}`);
  const scaledPrice = BigInt(Math.round(priceUsd * 10 ** PRICE_SCALE_DIGITS));
  if (scaledPrice === BigInt(0)) throw new RangeError(`price ${priceUsd} is below the supported precision`);
  const ten = BigInt(10);
  const numerator = BigInt(sizeUsd) * ten ** BigInt(decimals) * ten ** BigInt(PRICE_SCALE_DIGITS);
  return (numerator / scaledPrice).toString();
}

async function quoteWithRetry(params: DryQuoteParams) {
  try {
    const result = await dryQuote(params);
    if (result.status === "ok") return result;
  } catch {
    // Retry once, but let an exhausted request error escape instead of publishing false illiquidity.
  }
  return dryQuote(params);
}

/** Quotes each size sequentially (one asset never has more than one request in flight). */
export async function sampleAsset(assetId: string, { tokens, jwt, fetchImpl, sizesUsd }: SampleAssetOptions): Promise<AssetDepth> {
  const token = tokens.find((t) => t.assetId === assetId);
  if (!token) throw new OneClickError(`${assetId} is not listed by 1Click`, null);

  const details: DepthSampleDetail[] = [];
  const sampleSize = async (size: number) => {
    const amountIn = usdToBaseUnits(size, token.price, token.decimals);
    const result = await quoteWithRetry({ originAsset: assetId, amountIn, jwt, fetchImpl });
    if (result.status === "no_liquidity") {
      details.push({ size_usd: size, impact_bps: null, amount_in: amountIn, gross_bps: null, amount_in_usd: null, amount_out_usd: null });
    } else {
      details.push({
        size_usd: size,
        impact_bps: impactBps(result.amountInUsd, result.amountOutUsd, result.feeBps),
        amount_in: amountIn,
        gross_bps: grossImpactBps(result.amountInUsd, result.amountOutUsd),
        amount_in_usd: result.amountInUsd,
        amount_out_usd: result.amountOutUsd,
      });
    }
  };
  for (const size of sizesUsd ?? SAMPLE_SIZES_USD) await sampleSize(size);
  if (sizesUsd === undefined && exitCapacityUsd(details) === 1_000_000) {
    for (const size of [2_500_000, 5_000_000]) await sampleSize(size);
  }

  let previousImpact = 0;
  const samples = details.map(({ size_usd, impact_bps }) => {
    if (impact_bps === null) return { size_usd, impact_bps };
    previousImpact = Math.max(previousImpact, impact_bps);
    return { size_usd, impact_bps: previousImpact };
  });

  return {
    asset_id: assetId,
    price_usd: token.price,
    fee_bps: feeBpsFor(jwt),
    samples,
    details,
  };
}

/** Largest sampled size whose impact, and that of every smaller size, is within the threshold; 0 if none. */
export function exitCapacityUsd(samples: readonly DepthSample[]): number {
  const ordered = [...samples].sort((a, b) => a.size_usd - b.size_usd);
  let capacity = 0;
  for (const sample of ordered) {
    if (sample.impact_bps === null || sample.impact_bps > MAX_EXIT_IMPACT_BPS) break;
    capacity = sample.size_usd;
  }
  return capacity;
}

export function maxLeverage(capacityUsd: number): number {
  if (capacityUsd >= 1_000_000) return 20;
  if (capacityUsd >= 250_000) return 10;
  if (capacityUsd >= 50_000) return 5;
  return 2;
}

/** New positions are refused when exit liquidity is too thin or the measurement is stale. */
export function isMarketOpen(capacityUsd: number, measuredAtMs: number, nowMs: number): boolean {
  return capacityUsd >= MIN_OPEN_CAPACITY_USD && nowMs - measuredAtMs <= MAX_DEPTH_AGE_MS;
}

export function maxOiPerSide(hardCapUsd: number, capacityUsd: number): number {
  return Math.min(hardCapUsd, capacityUsd);
}
