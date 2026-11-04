import {
  CANDLE_SOURCE,
  candlesQuerySchema,
  coinbaseCandlesUrl,
  coinbaseProduct,
  parseCoinbaseCandles,
  type CandlesResponse,
} from "@/lib/prices/candles";

const USER_AGENT = "ketos-candles/0.1 (+https://ketos-three.vercel.app)";
const CACHE_MS = 30_000;
const TIMEOUT_MS = 8_000;

// Per-instance cache: every visitor's chart polls the same few series.
const cache = new Map<string, { atMs: number; body: CandlesResponse }>();

/** OHLC candles from Coinbase Exchange's public API, proxied so the browser never calls it directly. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = candlesQuerySchema.safeParse({ market: params.get("market"), interval: params.get("interval") });
  if (!query.success) {
    return Response.json({ error: "market must be BTC, ETH, NEAR or ZEC; interval must be 5m, 1h or 1d" }, { status: 400 });
  }
  const { market, interval } = query.data;
  const key = `${market}:${interval}`;
  const headers = { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=30" };

  const cached = cache.get(key);
  if (cached && Date.now() - cached.atMs < CACHE_MS) return Response.json(cached.body, { headers });

  try {
    const res = await fetch(coinbaseCandlesUrl(market, interval), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`${CANDLE_SOURCE} answered HTTP ${res.status}`);
    const body: CandlesResponse = {
      source: CANDLE_SOURCE,
      product: coinbaseProduct(market),
      interval,
      fetchedAtMs: Date.now(),
      candles: parseCoinbaseCandles(await res.json()),
    };
    cache.set(key, { atMs: body.fetchedAtMs, body });
    return Response.json(body, { headers });
  } catch (e) {
    if (cached) return Response.json(cached.body, { headers });
    const reason = e instanceof Error ? e.message : String(e);
    return Response.json({ error: `${CANDLE_SOURCE} candles unavailable: ${reason}` }, { status: 502 });
  }
}
