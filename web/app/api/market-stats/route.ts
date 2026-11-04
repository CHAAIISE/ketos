import { CANDLE_SOURCE } from "@/lib/prices/candles";
import {
  coinbaseStatsUrl,
  parseCoinbaseStats,
  statsQuerySchema,
  type Change24h,
  type MarketStatsResponse,
} from "@/lib/prices/market-stats";

const USER_AGENT = "ketos-stats/0.1 (+https://ketos-three.vercel.app)";
const CACHE_MS = 60_000;
const TIMEOUT_MS = 8_000;
// Coinbase's public API allows a few requests per second per IP.
const CONCURRENCY = 4;

// Per-instance cache shared by every visitor of the markets table.
const cache = new Map<string, { atMs: number; change: Change24h | null }>();

async function fetchChange(symbol: string): Promise<Change24h | null> {
  const res = await fetch(coinbaseStatsUrl(symbol), {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  // Unknown or delisted product: the venue has no 24h figure for this ticker.
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`${CANDLE_SOURCE} answered HTTP ${res.status}`);
  return parseCoinbaseStats(await res.json());
}

/** 24h change of each ticker's USD spot market on Coinbase Exchange, proxied and cached. */
export async function GET(request: Request) {
  const query = statsQuerySchema.safeParse(new URL(request.url).searchParams.get("symbols") ?? "");
  if (!query.success) {
    return Response.json({ error: "symbols must be a comma-separated list of 1 to 100 tickers, e.g. BTC,ETH" }, { status: 400 });
  }
  const symbols = query.data;
  const now = Date.now();
  const missing = symbols.filter((s) => {
    const hit = cache.get(s);
    return !hit || now - hit.atMs >= CACHE_MS;
  });

  let failures = 0;
  let lastError = "";
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    await Promise.all(
      missing.slice(i, i + CONCURRENCY).map(async (symbol) => {
        try {
          cache.set(symbol, { atMs: Date.now(), change: await fetchChange(symbol) });
        } catch (e) {
          failures += 1;
          lastError = e instanceof Error ? e.message : String(e);
        }
      }),
    );
  }
  if (missing.length > 0 && failures === missing.length && symbols.every((s) => !cache.has(s))) {
    return Response.json({ error: `${CANDLE_SOURCE} 24h stats unavailable: ${lastError}` }, { status: 502 });
  }

  const body: MarketStatsResponse = {
    source: CANDLE_SOURCE,
    fetchedAtMs: Date.now(),
    changes: Object.fromEntries(symbols.map((s) => [s, cache.get(s)?.change ?? null])),
  };
  return Response.json(body, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=60" } });
}
