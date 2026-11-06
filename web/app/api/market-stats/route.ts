import { CANDLE_SOURCE } from "@/lib/prices/candles";
import {
  coinbaseStatsUrl,
  parseCoinbaseStats,
  statsQuerySchema,
  type Change24h,
  type MarketStatsResponse,
} from "@/lib/prices/market-stats";
import { loadListableMarkets, loadMarketRegistry } from "@/lib/server/listable-markets";

const USER_AGENT = "ketos-stats/0.1 (+https://ketos-three.vercel.app)";
const CACHE_MS = 60_000;
const TIMEOUT_MS = 8_000;
const MAX_CACHE_ENTRIES = 500;
const MAX_IN_FLIGHT = 100;
// This limit is shared across every request in this instance, not reset per visitor.
const CONCURRENCY = 4;
type Entry = { atMs: number; change: Change24h | null };
const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<Entry>>();
const waiting: (() => void)[] = [];
let active = 0;

async function fetchChange(symbol: string): Promise<Change24h | null> {
  const res = await fetch(coinbaseStatsUrl(symbol), {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`${CANDLE_SOURCE} answered HTTP ${res.status}`);
  return parseCoinbaseStats(await res.json());
}

async function refresh(symbol: string): Promise<Entry> {
  if (active >= CONCURRENCY) {
    // Node 20.12 has no Promise.withResolvers.
    await new Promise<void>((resolve) => { waiting.push(resolve); });
  } else active += 1;
  try {
    const change = await fetchChange(symbol);
    const entry = { atMs: Date.now(), change };
    for (const [key, hit] of cache) {
      if (entry.atMs - hit.atMs >= CACHE_MS) cache.delete(key);
    }
    cache.delete(symbol);
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(symbol, entry);
    return entry;
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
}

/** Only on-chain or currently listable tickers may reach the public spot venue. */
export async function GET(request: Request) {
  const query = statsQuerySchema.safeParse(new URL(request.url).searchParams.get("symbols") ?? "");
  if (!query.success) {
    return Response.json({ error: "symbols must be a comma-separated list of 1 to 100 tickers, e.g. BTC,ETH" }, {
      status: 400, headers: { "Cache-Control": "no-store" },
    });
  }
  const symbols = query.data;
  try {
    const registry = await loadMarketRegistry();
    const allowed = new Set(registry.markets.map((market) => market.id));
    if (symbols.some((symbol) => !allowed.has(symbol))) {
      const listing = await loadListableMarkets();
      for (const asset of listing.assets) allowed.add(asset.symbol);
    }
    if (symbols.some((symbol) => !allowed.has(symbol))) {
      return Response.json({ error: "symbols must belong to the market registry or current listable assets" }, {
        status: 400, headers: { "Cache-Control": "no-store" },
      });
    }

    const now = Date.now();
    const missing = symbols.filter((symbol) => {
      const hit = cache.get(symbol);
      return (!hit || now - hit.atMs >= CACHE_MS) && !inFlight.has(symbol);
    });
    // Reserve the whole request synchronously; the queue and the single-flight map stay bounded.
    if (inFlight.size + missing.length > MAX_IN_FLIGHT) {
      return Response.json({ error: "Market stats busy; retry shortly" }, {
        status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "1" },
      });
    }
    for (const symbol of missing) {
      const pending = refresh(symbol).finally(() => { inFlight.delete(symbol); });
      inFlight.set(symbol, pending);
    }
    const results = await Promise.allSettled(symbols.map((symbol) => {
      const hit = cache.get(symbol);
      return hit && now - hit.atMs < CACHE_MS ? Promise.resolve(hit) : inFlight.get(symbol)!;
    }));
    if (results.some((result) => result.status === "rejected")) {
      return Response.json({ error: `${CANDLE_SOURCE} 24h stats unavailable` }, {
        status: 502, headers: { "Cache-Control": "no-store" },
      });
    }
    const entries = results.map((result) => {
      if (result.status !== "fulfilled") throw new Error("Unreachable failed stats result");
      return result.value;
    });
    const body: MarketStatsResponse = {
      source: CANDLE_SOURCE,
      fetchedAtMs: Math.min(...entries.map((entry) => entry.atMs)),
      changes: Object.fromEntries(symbols.map((symbol, index) => [symbol, entries[index].change])),
    };
    return Response.json(body, {
      headers: {
        "Cache-Control": "public, s-maxage=60",
        Age: String(Math.max(0, Math.floor((Date.now() - body.fetchedAtMs) / 1000))),
      },
    });
  } catch {
    return Response.json({ error: "Market stats unavailable" }, {
      status: 502, headers: { "Cache-Control": "no-store" },
    });
  }
}
