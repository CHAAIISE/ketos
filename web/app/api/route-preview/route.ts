import { parseRouteQuery, quoteRoute, type RoutePreview } from "@/lib/intents/route-preview";

const CACHE_MS = 20_000;
const MAX_CACHE_ENTRIES = 500;

// Per-instance cache keyed by asset and exact base-unit amount, so typing the same amount twice is free.
const cache = new Map<string, RoutePreview>();

function remember(key: string, preview: RoutePreview) {
  const now = Date.now();
  for (const [k, hit] of cache) {
    if (now - hit.quotedAtMs >= CACHE_MS) cache.delete(k);
  }
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, preview);
}

/**
 * Read-only route preview: a dry 1Click quote from ETH on Base, SOL or BTC on its own chain into
 * USDC on NEAR. 1Click is only ever called from the server; no deposit address is ever requested.
 */
export async function GET(request: Request) {
  const parsed = parseRouteQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const { asset, amountIn } = parsed.query;

  const key = `${asset}:${amountIn}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.quotedAtMs < CACHE_MS) return Response.json(hit);
  try {
    const preview = await quoteRoute({ asset, amountIn, jwt: process.env.ONECLICK_JWT?.trim() || undefined });
    remember(key, preview);
    return Response.json(preview);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return Response.json({ error: `Route quote unavailable: ${reason}` }, { status: 502 });
  }
}
