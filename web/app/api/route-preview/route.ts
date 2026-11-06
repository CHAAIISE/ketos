import { parseRouteQuery, quoteRoute, type RoutePreview } from "@/lib/intents/route-preview";
import { errorMessage } from "@/lib/utils";

const CACHE_MS = 20_000;
const MAX_CACHE_ENTRIES = 500;
const MAX_IN_FLIGHT = 20;
const TIMEOUT_MS = 8_000;
const MAX_IP_ENTRIES = 1000;
const BURST = 10;
const REFILL_MS = 6_000;
const cache = new Map<string, RoutePreview>();
const inFlight = new Map<string, Promise<RoutePreview>>();
const buckets = new Map<string, { tokens: number; atMs: number }>();

function retryAfter(ip: string): number {
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket) {
    for (const [key, hit] of buckets) {
      if (now - hit.atMs >= BURST * REFILL_MS) buckets.delete(key);
    }
    // Do not evict active clients: rotating new IPs must not reset existing limits.
    if (buckets.size >= MAX_IP_ENTRIES) return Math.ceil(BURST * REFILL_MS / 1000);
    bucket = { tokens: BURST, atMs: now };
    buckets.set(ip, bucket);
  }
  bucket.tokens = Math.min(BURST, bucket.tokens + Math.max(0, now - bucket.atMs) / REFILL_MS);
  bucket.atMs = now;
  if (bucket.tokens < 1) return Math.max(1, Math.ceil((1 - bucket.tokens) * REFILL_MS / 1000));
  bucket.tokens -= 1;
  return 0;
}

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

function success(preview: RoutePreview) {
  return Response.json(preview, {
    headers: {
      "Cache-Control": "public, s-maxage=20",
      Age: String(Math.max(0, Math.floor((Date.now() - preview.quotedAtMs) / 1000))),
    },
  });
}

/**
 * Read-only, three-significant-figure dry quote into USDC on NEAR.
 * IP limits and single-flight/cache state are per instance. The ingress must overwrite forwarded
 * IP headers; an untrusted direct deployment cannot treat caller-supplied headers as identity.
 */
export async function GET(request: Request) {
  const parsed = parseRouteQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return Response.json({ error: parsed.error }, {
    status: 400, headers: { "Cache-Control": "no-store" },
  });
  const ip = (request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-forwarded-for")
    ?? request.headers.get("x-real-ip") ?? "unknown").split(",")[0].trim().slice(0, 128);
  const retry = retryAfter(ip);
  if (retry) return Response.json({ error: "Too many route previews; retry shortly" }, {
    status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(retry) },
  });
  const { asset, amountIn } = parsed.query;
  const key = `${asset}:${amountIn}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.quotedAtMs < CACHE_MS) return success(hit);
  let pending = inFlight.get(key);
  if (!pending) {
    if (inFlight.size >= MAX_IN_FLIGHT) return Response.json({ error: "Route previews busy; retry shortly" }, {
      status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "1" },
    });
    pending = quoteRoute({
      asset, amountIn, jwt: process.env.ONECLICK_JWT?.trim() || undefined,
      fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" }),
    }).then((preview) => {
      remember(key, preview);
      return preview;
    }).finally(() => { inFlight.delete(key); });
    inFlight.set(key, pending);
  }
  try {
    return success(await pending);
  } catch (error) {
    return Response.json({ error: `Route quote unavailable: ${errorMessage(error)}` }, {
      status: 502, headers: { "Cache-Control": "no-store" },
    });
  }
}
