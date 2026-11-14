import { PublicKey } from "near-api-js";
import { z } from "zod";
import type { NearConfig } from "./config";
import { positionSchema, type MarginMode, type MarketId, type VaultId } from "./types";
import { KetosViews } from "./views";

export const MAX_SIGNED_PRICE_ASSETS = 12;
export const SIGNED_PRICE_MAX_AGE_MS = 15_000;
const MAX_PAYLOAD_BYTES = 4096;
const symbolSchema = z.string().regex(/^[A-Z0-9]{1,16}$/);
const envelopeSchema = z.object({
  payload: z.string().min(1).max(MAX_PAYLOAD_BYTES),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  public_key: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/),
});
const payloadSchema = z.object({
  domain: z.literal("ketos:prices:v1"),
  prices: z.record(symbolSchema, z.object({
    price: z.string().regex(/^[1-9]\d{0,38}$/).refine((price) => BigInt(price) < 2n ** 128n),
    publish_time: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER / 1000),
    sources: z.array(z.enum(["coinbase", "kraken", "binance", "bitstamp"])).min(2).max(3)
      .refine((sources) => new Set(sources).size === sources.length),
  })),
});
export type SignedPrices = z.infer<typeof envelopeSchema>;
export type PriceContracts = Pick<NearConfig, "rpcUrl" | "ketosContract" | "usdcContract"> & Partial<Pick<NearConfig, "network">>;

/** Decode an observation after the caller has verified the envelope against the onchain signer. */
export function signedPriceObservation(signed: SignedPrices, asset: MarketId) {
  const observation = payloadSchema.parse(JSON.parse(signed.payload)).prices[asset];
  if (!observation) throw new Error(`Missing signed observation for ${asset}.`);
  return { price: BigInt(observation.price), price_timestamp_ms: observation.publish_time * 1000 };
}

/** Canonical keys bound both request cost and the per-instance cache. */
export function signedPriceAssets(input: unknown): string[] | null {
  const parsed = z.array(symbolSchema).min(1).max(MAX_SIGNED_PRICE_ASSETS).safeParse(input);
  return parsed.success ? [...new Set(parsed.data)].sort() : null;
}

/** Validate original signed bytes; expose only requested observations still inside the age bound. */
export function verifySignedObservations(input: unknown, signer: string, assets: readonly string[], nowMs = Date.now()): { signedPrices: SignedPrices; assets: string[] } | null {
  try {
    const envelope = envelopeSchema.parse(input);
    if (envelope.public_key !== signer) return null;
    const key = PublicKey.fromString(signer);
    if (key.data.length !== 32) return null;
    const bytes = new TextEncoder().encode(envelope.payload);
    if (bytes.length > MAX_PAYLOAD_BYTES) return null;
    const signature = Uint8Array.from(atob(envelope.signature), (char) => char.charCodeAt(0));
    if (btoa(String.fromCharCode(...signature)) !== envelope.signature || !key.verify(bytes, signature)) return null;
    const { prices } = payloadSchema.parse(JSON.parse(envelope.payload));
    if (Object.keys(prices).length > MAX_SIGNED_PRICE_ASSETS || assets.length === 0) return null;
    const available = assets.filter((asset) => {
      const price = prices[asset];
      return price && price.publish_time * 1000 <= nowMs && nowMs - price.publish_time * 1000 <= SIGNED_PRICE_MAX_AGE_MS;
    });
    return available.length > 0 ? { signedPrices: envelope, assets: available } : null;
  } catch {
    return null;
  }
}

/** User actions require their entire requested set; a partial keeper refresh cannot authorize them. */
export function verifySignedPrices(input: unknown, signer: string, assets: readonly string[], nowMs = Date.now()): SignedPrices | null {
  const observations = verifySignedObservations(input, signer, assets, nowMs);
  return observations?.assets.length === assets.length ? observations.signedPrices : null;
}

export async function priceSigner(c: PriceContracts, views = new KetosViews(c.rpcUrl, c.ketosContract, c.usdcContract)): Promise<string | null> {
  if (c.network === "sandbox" || !c.rpcUrl.startsWith("https://")) return null;
  try {
    const signer = await views.provider.callFunction({ contractId: c.ketosContract, method: "get_price_signer", args: {} });
    if (typeof signer !== "string" || !envelopeSchema.shape.public_key.safeParse(signer).success) return null;
    return PublicKey.fromString(signer).data.length === 32 ? signer : null;
  } catch {
    // Older deployments and the native sandbox have no signer: keep the T51 adapter path.
    return null;
  }
}

export type SignedPriceRequest =
  | { kind: "markets"; markets: MarketId[] }
  | { kind: "open"; market: MarketId; accountId: string; marginMode: MarginMode }
  | { kind: "position"; positionId: number }
  | { kind: "orders"; ids: number[] }
  | { kind: "cross"; accountId: string }
  | { kind: "vault"; vaultId: VaultId };

async function requestedAssets(views: KetosViews, request: SignedPriceRequest): Promise<string[]> {
  const crossMarkets = async (accountId: string) => (await views.positions(accountId))
    .filter((position) => position.margin_mode === "cross").map((position) => position.market_id);
  const positionMarket = async (positionId: number) => {
    const raw = await views.provider.callFunction({
      contractId: views.ketosContract, method: "get_position", args: { position_id: positionId },
    });
    const position = positionSchema.nullable().parse(raw);
    return position ? [position.market_id] : [];
  };
  switch (request.kind) {
    case "markets": return request.markets;
    case "open": return [request.market, ...(request.marginMode === "cross" ? await crossMarkets(request.accountId) : [])];
    case "position": return positionMarket(request.positionId);
    case "cross": return crossMarkets(request.accountId);
    case "vault": return (await views.markets()).filter((market) => market.vault_id === request.vaultId
      && (!market.isolated_only || market.oi_long > 0n || market.oi_short > 0n)).map((market) => market.id);
    case "orders": {
      const ids = new Set(request.ids);
      const nowMs = Date.now();
      const orders = (await views.allOpenOrders()).filter((order) =>
        ids.has(order.id) && order.execution !== null && nowMs <= order.execution.expires_at_ms);
      const accounts = new Map<string, Promise<string[]>>();
      const markets = await Promise.all(orders.map(async (order) => {
        const entry = order.request;
        if (!("market_id" in entry)) return positionMarket(entry.position_id);
        if (entry.margin_mode !== "cross") return [entry.market_id];
        let cross = accounts.get(order.account_id);
        if (!cross) {
          cross = crossMarkets(order.account_id);
          accounts.set(order.account_id, cross);
        }
        return [entry.market_id, ...await cross];
      }));
      return markets.flat();
    }
  }
}

export type SignedPriceLoader = (assets: string[], signer: string) => Promise<SignedPrices | null>;

const fetchSignedPrices: SignedPriceLoader = async (assets) => {
  const response = await fetch("/api/signed-prices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assets }),
    signal: AbortSignal.timeout(50_000),
  });
  return response.ok ? envelopeSchema.parse(await response.json()) : null;
};

/** Missing signer, unsupported sets, and worker failures never prevent the funded T51 action. */
export async function signedPricesFor(c: PriceContracts, request: SignedPriceRequest, load: SignedPriceLoader = fetchSignedPrices): Promise<SignedPrices | null> {
  try {
    const views = new KetosViews(c.rpcUrl, c.ketosContract, c.usdcContract);
    const signer = await priceSigner(c, views);
    if (!signer) return null;
    const assets = signedPriceAssets([...new Set(await requestedAssets(views, request))]);
    if (!assets) return null;
    return verifySignedPrices(await load(assets, signer), signer, assets);
  } catch {
    return null;
  }
}

export function signedPricesArg(prices: SignedPrices | null): { signed_prices?: SignedPrices } {
  return prices ? { signed_prices: prices } : {};
}
