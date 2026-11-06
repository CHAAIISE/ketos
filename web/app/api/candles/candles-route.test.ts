import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let now: number;
const upstream = vi.fn<typeof fetch>();
// Reimport after resetModules so each scenario gets its own process-local candle cache.
beforeEach(() => {
  vi.resetModules();
  upstream.mockReset();
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const request = (query: string) => new Request(`http://localhost/api/candles?${query}`);

describe("candles route", () => {
  it("refuses invalid query intervals before requesting a venue", async () => {
    const { GET } = await import("./route");
    const response = await GET(request("market=BTC&interval=2h"));
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("serves chronological candle values without retimestamping cache hits", async () => {
    upstream.mockResolvedValueOnce(Response.json([
      [600, 20, 26, 21, 25, 7], [300, 10, 23, 11, 22, 5],
    ]));
    const { GET } = await import("./route");
    const first = await GET(request("market=BTC&interval=5m"));
    const body = await first.json();
    expect(body.candles).toEqual([
      { time: 300, low: 10, high: 23, open: 11, close: 22, volume: 5 },
      { time: 600, low: 20, high: 26, open: 21, close: 25, volume: 7 },
    ]);
    now += 29_999;
    expect(await (await GET(request("market=BTC&interval=5m"))).json()).toEqual(body);
    upstream.mockResolvedValueOnce(Response.json([[900, 22, 30, 25, 28, 4]]));
    now += 1;
    const refreshed = await (await GET(request("market=BTC&interval=5m"))).json();
    expect(refreshed.candles[0].close).toBe(28);
    expect(refreshed.fetchedAtMs).toBe(now);
  });

  it("does not replace missing or malformed venue data with invented candles", async () => {
    upstream.mockResolvedValueOnce(Response.json({ message: "unavailable" }, { status: 503 }));
    const { GET } = await import("./route");
    expect((await GET(request("market=ETH&interval=1h"))).status).toBe(502);
    upstream.mockResolvedValueOnce(Response.json([[300, 1, 2]]));
    expect((await GET(request("market=ETH&interval=1h"))).status).toBe(502);
  });
});
