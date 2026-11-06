import { z } from "zod";
import { formatUnits, parseUnits, USDC_DECIMALS } from "@/lib/near/format";
import { dryQuote, grossImpactBps, OneClickError, USDC_NEAR_ASSET_ID, type FetchImpl } from "./oneclick";

/** Origin assets a route preview can start from; ids and decimals as listed by 1Click `GET /v0/tokens`. */
export const ROUTE_ASSETS = {
  ETH_BASE: { assetId: "nep141:base.omft.near", symbol: "ETH", chain: "Base", decimals: 18 },
  SOL: { assetId: "nep141:sol.omft.near", symbol: "SOL", chain: "Solana", decimals: 9 },
  BTC: { assetId: "nep141:btc.omft.near", symbol: "BTC", chain: "Bitcoin", decimals: 8 },
} as const;
export const ROUTE_ASSET_KEYS = ["ETH_BASE", "SOL", "BTC"] as const;
export const routeAssetSchema = z.enum(ROUTE_ASSET_KEYS);
export type RouteAsset = z.infer<typeof routeAssetSchema>;

/** Longest amount string accepted, enough for 18 decimals plus a large integer part. */
const MAX_AMOUNT_LENGTH = 40;

/** Round half up to three significant decimal digits using only integer base units. */
function normalizeAmount(amountIn: bigint): bigint {
  const droppedDigits = amountIn.toString().length - 3;
  if (droppedDigits <= 0) return amountIn;
  const quantum = 10n ** BigInt(droppedDigits);
  return ((amountIn + quantum / 2n) / quantum) * quantum;
}

export const routeQuerySchema = z
  .object({
    asset: routeAssetSchema,
    amount: z.string().trim().min(1).max(MAX_AMOUNT_LENGTH),
  })
  .transform(({ asset, amount }, ctx) => {
    const amountIn = parseUnits(amount, ROUTE_ASSETS[asset].decimals);
    if (amountIn === null || amountIn === 0n) {
      ctx.addIssue({
        code: "custom",
        path: ["amount"],
        message: `amount must be a positive decimal with at most ${ROUTE_ASSETS[asset].decimals} fraction digits`,
      });
      return z.NEVER;
    }
    return { asset, amountIn: normalizeAmount(amountIn) };
  });
export type RouteQuery = z.output<typeof routeQuerySchema>;

/** `?asset=SOL&amount=1.5` to a validated, three-significant-figure query, or its invalid reason. */
export function parseRouteQuery(params: URLSearchParams): { ok: true; query: RouteQuery } | { ok: false; error: string } {
  const parsed = routeQuerySchema.safeParse({ asset: params.get("asset") ?? undefined, amount: params.get("amount") ?? undefined });
  if (parsed.success) return { ok: true, query: parsed.data };
  return {
    ok: false,
    error: `Expected ?asset=${ROUTE_ASSET_KEYS.join("|")}&amount=<positive decimal in origin units>: ${parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "query"} ${issue.message}`)
      .join("; ")}`,
  };
}

const routeBaseSchema = z.object({
  asset: routeAssetSchema,
  originAssetId: z.string(),
  destinationAssetId: z.string(),
  /** Input in the origin asset's base units. */
  amountIn: z.string(),
  amountInFormatted: z.string(),
  quotedAtMs: z.number(),
});

export const routePreviewSchema = z.discriminatedUnion("status", [
  routeBaseSchema.extend({
    status: z.literal("ok"),
    amountInUsd: z.number(),
    /** USDC on NEAR received, in 6-decimal base units. */
    amountOut: z.string(),
    amountOutFormatted: z.string(),
    /** Floor after the quote's 1% slippage tolerance. */
    minAmountOutFormatted: z.string(),
    amountOutUsd: z.number(),
    /** Everything the route costs at 1Click's own prices: platform fee, spread and network fees. */
    routeCostUsd: z.number(),
    routeCostBps: z.number(),
    /** 1Click platform fee included in the cost: 20 bps with a partner key, 25 bps without. */
    platformFeeBps: z.number(),
    /** 1Click estimate from the origin-chain deposit to USDC on NEAR, in seconds. */
    timeEstimateSec: z.number(),
  }),
  routeBaseSchema.extend({ status: z.literal("no_liquidity") }),
]);
export type RoutePreview = z.infer<typeof routePreviewSchema>;

const routeQuoteSchema = z.looseObject({
  amountOut: z.string().regex(/^\d+$/),
  minAmountOut: z.string().regex(/^\d+$/),
  timeEstimate: z.number().nonnegative(),
});

export interface QuoteRouteParams extends RouteQuery {
  jwt?: string;
  fetchImpl?: FetchImpl;
}

/**
 * Dry 1Click EXACT_INPUT quote from the asset on its own chain into USDC on NEAR. Read-only: a dry
 * quote never returns a deposit address. Throws `OneClickError` when 1Click fails for any reason
 * other than missing liquidity.
 */
export async function quoteRoute({ asset, amountIn, jwt, fetchImpl }: QuoteRouteParams): Promise<RoutePreview> {
  const origin = ROUTE_ASSETS[asset];
  const result = await dryQuote({
    originAsset: origin.assetId,
    amountIn: amountIn.toString(),
    depositType: "ORIGIN_CHAIN",
    jwt,
    fetchImpl,
  });
  const base = {
    asset,
    originAssetId: origin.assetId,
    destinationAssetId: USDC_NEAR_ASSET_ID,
    amountIn: amountIn.toString(),
    amountInFormatted: formatUnits(amountIn, origin.decimals, { minFractionDigits: 0 }),
    quotedAtMs: Date.now(),
  };
  if (result.status === "no_liquidity") return { ...base, status: "no_liquidity" };

  const quote = routeQuoteSchema.safeParse(result.quote);
  if (!quote.success) throw new OneClickError(`POST /quote returned an unexpected quote: ${quote.error.message}`, null);
  const amountOut = BigInt(quote.data.amountOut);
  return {
    ...base,
    status: "ok",
    amountInUsd: result.amountInUsd,
    amountOut: amountOut.toString(),
    amountOutFormatted: formatUnits(amountOut, USDC_DECIMALS, { minFractionDigits: 0 }),
    minAmountOutFormatted: formatUnits(BigInt(quote.data.minAmountOut), USDC_DECIMALS, { maxFractionDigits: 2 }),
    amountOutUsd: result.amountOutUsd,
    routeCostUsd: result.amountInUsd - result.amountOutUsd,
    routeCostBps: grossImpactBps(result.amountInUsd, result.amountOutUsd),
    platformFeeBps: result.feeBps,
    timeEstimateSec: quote.data.timeEstimate,
  };
}
