import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GET as RouteGet } from "./route";

const loaders = vi.hoisted(() => ({ loadMarketRegistry: vi.fn(), loadListableMarkets: vi.fn() }));
vi.mock("@/lib/server/listable-markets", () => loaders);
const NOW = 1_790_000_000_000;
let now: number;
let GET: typeof RouteGet;

beforeEach(async () => {
  // A fresh module is required to isolate process-local caches, the queue and the flight map.
  vi.resetModules();
  vi.clearAllMocks();
  now = NOW;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  loaders.loadMarketRegistry.mockResolvedValue({ markets: [{ id: "BTC" }, { id: "ETH" }] });
  loaders.loadListableMarkets.mockResolvedValue({ assets: [{ symbol: "UNI" }] });
  ({ GET } = await import("./route"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function get(symbols: string) {
  return GET(new Request(`http://localhost/api/market-stats?symbols=${encodeURIComponent(symbols)}`));
}

function stats() {
  return Response.json({ open: "100", last: "105" });
}

describe("hardened market stats", () => {
  it.each(["", "btc", "BTC/ETH", "A".repeat(17), Array.from({ length: 101 }, (_, index) => `M${index}`).join(",")])(
    "rejects invalid symbols %s before any dependency access", async (symbols) => {
      const upstream = vi.fn<typeof fetch>(async () => stats());
      vi.stubGlobal("fetch", upstream);
      const response = await get(symbols);
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(loaders.loadMarketRegistry).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown symbols atomically without amplifying to Coinbase", async () => {
    const upstream = vi.fn<typeof fetch>(async () => stats());
    vi.stubGlobal("fetch", upstream);
    const response = await get("BTC,UNKNOWN");
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(upstream).not.toHaveBeenCalled();
    expect(loaders.loadListableMarkets).toHaveBeenCalledTimes(1);
  });

  it("accepts registry and listable symbols and deduplicates repeated tickers", async () => {
    const upstream = vi.fn<typeof fetch>(async () => stats());
    vi.stubGlobal("fetch", upstream);
    const response = await get("BTC,UNI,BTC");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
    expect(await response.json()).toMatchObject({ fetchedAtMs: NOW, changes: {
      BTC: { open: 100, last: 105, percent: 5 }, UNI: { open: 100, last: 105, percent: 5 },
    } });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("keeps valid registry symbols functional without the listing token dependency", async () => {
    loaders.loadListableMarkets.mockRejectedValue(new Error("1Click unavailable"));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => stats()));
    expect((await get("BTC")).status).toBe(200);
    expect(loaders.loadListableMarkets).not.toHaveBeenCalled();
  });

  it("preserves actual fetch time on cache hits and refreshes at the TTL boundary", async () => {
    const upstream = vi.fn<typeof fetch>(async () => stats());
    vi.stubGlobal("fetch", upstream);
    await get("BTC");
    now += 59_999;
    const cached = await get("BTC");
    expect((await cached.json()).fetchedAtMs).toBe(NOW);
    expect(cached.headers.get("Age")).toBe("59");
    expect(upstream).toHaveBeenCalledTimes(1);
    now += 1;
    expect((await (await get("BTC")).json()).fetchedAtMs).toBe(now);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("uses the oldest constituent fetch time when combining cached and fresh stats", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => stats()));
    await get("BTC");
    now += 30_000;
    const response = await get("BTC,ETH");
    expect((await response.json()).fetchedAtMs).toBe(NOW);
    expect(response.headers.get("Age")).toBe("30");
  });

  it("bounds global concurrent work and its queue, deduplicating identical requests", async () => {
    const symbols = Array.from({ length: 101 }, (_, index) => `M${index}`);
    loaders.loadMarketRegistry.mockResolvedValue({ markets: symbols.map((id) => ({ id })) });
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { promise: started, resolve: signalStarted } = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    const upstream = vi.fn<typeof fetch>(async () => {
      active += 1;
      peak = Math.max(peak, active);
      if (active === 4) signalStarted();
      await gate;
      active -= 1;
      return stats();
    });
    vi.stubGlobal("fetch", upstream);
    const first = get(symbols.slice(0, 100).join(","));
    await started;
    const duplicate = get("M0");
    const busy = await get("M100");
    expect(busy.status).toBe(429);
    expect(busy.headers.get("Cache-Control")).toBe("no-store");
    expect(busy.headers.get("Retry-After")).toBe("1");
    expect(upstream).toHaveBeenCalledTimes(4);
    release();
    expect((await first).status).toBe(200);
    expect((await duplicate).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(100);
    expect(peak).toBe(4);
    expect((await get("M100")).status).toBe(200);
  });

  it("evicts old entries at the 500-entry cache bound", async () => {
    const symbols = Array.from({ length: 501 }, (_, index) => `M${index}`);
    loaders.loadMarketRegistry.mockResolvedValue({ markets: symbols.map((id) => ({ id })) });
    const upstream = vi.fn<typeof fetch>(async () => stats());
    vi.stubGlobal("fetch", upstream);
    for (let index = 0; index < symbols.length; index += 100) {
      expect((await get(symbols.slice(index, index + 100).join(","))).status).toBe(200);
    }
    expect((await get("M0")).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(502);
  });

  it("caches an unsupported valid venue product as null, not an arbitrary ticker", async () => {
    const upstream = vi.fn<typeof fetch>(async () => Response.json({}, { status: 404 }));
    vi.stubGlobal("fetch", upstream);
    expect(await (await get("BTC")).json()).toMatchObject({ changes: { BTC: null } });
    expect((await get("BTC")).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("does not cache upstream errors or silently relabel stale data as fresh", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValueOnce(stats())
      .mockResolvedValueOnce(Response.json({}, { status: 503 })).mockImplementation(async () => stats());
    vi.stubGlobal("fetch", upstream);
    await get("BTC");
    now += 60_000;
    const failed = await get("BTC");
    expect(failed.status).toBe(502);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    expect((await (await get("BTC")).json()).fetchedAtMs).toBe(now);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("fails closed without cacheable responses when the registry cannot be loaded", async () => {
    loaders.loadMarketRegistry.mockRejectedValue(new Error("RPC unavailable"));
    const upstream = vi.fn<typeof fetch>(async () => stats());
    vi.stubGlobal("fetch", upstream);
    const failed = await get("BTC");
    expect(failed.status).toBe(502);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    expect(upstream).not.toHaveBeenCalled();
  });
});
