// Server-only: holds the 1Click partner key path; import from route handlers and scripts, never from client components.
import { z } from "zod";

export const ONECLICK_BASE = "https://1click.chaindefuser.com/v0";
export const USDC_NEAR_ASSET_ID = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const ORIGIN_ASSETS = {
  BTC: "nep141:btc.omft.near",
  ETH: "nep141:eth.omft.near",
  NEAR: "nep141:wrap.near",
  ZEC: "nep141:zec.omft.near",
} as const;
export type MarketSymbol = keyof typeof ORIGIN_ASSETS;

// 1Click rejects some clients without a User-Agent (HTTP 403), so always send one.
const USER_AGENT = "ketos-depth/0.1 (+https://github.com/ketos)";
// The platform fee is baked into every quote: 20 bps on the partner schedule, 25 bps without a key.
export const PARTNER_FEE_BPS = 20;
export const PUBLIC_FEE_BPS = 25;
const NO_LIQUIDITY_MESSAGE = "No liquidity available";
const QUOTE_TTL_MS = 10 * 60_000;

export type FetchImpl = typeof fetch;

export interface OneClickOptions {
  jwt?: string;
  fetchImpl?: FetchImpl;
}

export class OneClickError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OneClickError";
    this.status = status;
  }
}

const tokenSchema = z.looseObject({
  assetId: z.string(),
  decimals: z.number().int().nonnegative(),
  symbol: z.string(),
  blockchain: z.string(),
  price: z.number(),
});
export type OneClickToken = z.infer<typeof tokenSchema>;

const quoteResponseSchema = z.looseObject({
  quote: z.looseObject({
    amountIn: z.string(),
    amountInUsd: z.string(),
    amountOut: z.string(),
    amountOutUsd: z.string(),
  }),
});
export type OneClickQuote = z.infer<typeof quoteResponseSchema>["quote"];

const errorBodySchema = z.object({ message: z.string() });

export type DryQuoteResult =
  | { status: "ok"; amountInUsd: number; amountOutUsd: number; feeBps: number; quote: OneClickQuote }
  | { status: "no_liquidity" };

export function feeBpsFor(jwt: string | undefined): number {
  return jwt ? PARTNER_FEE_BPS : PUBLIC_FEE_BPS;
}

function headersFor(jwt: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": USER_AGENT };
  if (jwt) headers["X-API-Key"] = jwt;
  return headers;
}

async function send(fetchImpl: FetchImpl, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (cause) {
    throw new OneClickError(`1Click request to ${url} failed`, null, { cause });
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

export async function getTokens({ jwt, fetchImpl = fetch }: OneClickOptions = {}): Promise<OneClickToken[]> {
  const res = await send(fetchImpl, `${ONECLICK_BASE}/tokens`, { headers: headersFor(jwt) });
  const body = await readJson(res);
  if (!res.ok) throw new OneClickError(`GET /tokens returned HTTP ${res.status}`, res.status);
  const parsed = z.array(tokenSchema).safeParse(body);
  if (!parsed.success) throw new OneClickError(`GET /tokens returned an unexpected body: ${parsed.error.message}`, res.status);
  return parsed.data;
}

export interface DryQuoteParams extends OneClickOptions {
  originAsset: string;
  /** Amount of the origin asset in its base units, as a decimal integer string. */
  amountIn: string;
  /**
   * Where the input would be deposited: already inside NEAR Intents (default) or on the asset's own
   * chain, which makes `timeEstimate` include that chain's confirmations.
   */
  depositType?: "INTENTS" | "ORIGIN_CHAIN";
}

export async function dryQuote({
  originAsset,
  amountIn,
  depositType = "INTENTS",
  jwt,
  fetchImpl = fetch,
}: DryQuoteParams): Promise<DryQuoteResult> {
  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset,
    depositType,
    destinationAsset: USDC_NEAR_ASSET_ID,
    amount: amountIn,
    // Dry quotes never open a deposit; refunds stay inside NEAR Intents so no chain address is needed.
    refundTo: "intents.near",
    refundType: "INTENTS",
    recipient: "intents.near",
    recipientType: "INTENTS",
    deadline: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
  };
  const res = await send(fetchImpl, `${ONECLICK_BASE}/quote`, {
    method: "POST",
    headers: headersFor(jwt),
    body: JSON.stringify(body),
  });
  const json = await readJson(res);

  if (!res.ok) {
    const error = errorBodySchema.safeParse(json);
    const message = error.success ? error.data.message : undefined;
    if (res.status === 400 && message === NO_LIQUIDITY_MESSAGE) return { status: "no_liquidity" };
    throw new OneClickError(`POST /quote returned HTTP ${res.status}${message ? `: ${message}` : ""}`, res.status);
  }

  const parsed = quoteResponseSchema.safeParse(json);
  if (!parsed.success) throw new OneClickError(`POST /quote returned an unexpected body: ${parsed.error.message}`, res.status);
  const { quote } = parsed.data;
  const amountInUsd = Number(quote.amountInUsd);
  const amountOutUsd = Number(quote.amountOutUsd);
  if (!Number.isFinite(amountInUsd) || !Number.isFinite(amountOutUsd) || amountInUsd <= 0) {
    throw new OneClickError(`POST /quote returned non-numeric USD amounts`, res.status);
  }
  return { status: "ok", amountInUsd, amountOutUsd, feeBps: feeBpsFor(jwt), quote };
}

// Absorbs float noise such as 12.000000000001 so it does not round up to the next basis point.
const BPS_EPSILON = 1e-9;

/** Gross price impact in bps (fee included), rounded up against the trader. May be negative. */
export function grossImpactBps(amountInUsd: number, amountOutUsd: number): number {
  return Math.ceil(((amountInUsd - amountOutUsd) / amountInUsd) * 10_000 - BPS_EPSILON);
}

/** Net price impact in bps once the 1Click platform fee is removed, floored at zero. */
export function impactBps(amountInUsd: number, amountOutUsd: number, feeBps: number): number {
  return Math.max(0, grossImpactBps(amountInUsd, amountOutUsd) - feeBps);
}
