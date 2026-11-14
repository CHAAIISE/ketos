import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GET as ListingGet } from "./route";
import type { GET as StatsGet } from "../market-stats/route";
import type { OneClickToken } from "@/lib/intents/oneclick";
import { listableResponseSchema } from "@/lib/intents/listing";

const mocks = vi.hoisted(() => ({
  markets: vi.fn(), config: vi.fn(), workerAssets: vi.fn(), oracleAssetIds: vi.fn(), getTokens: vi.fn(),
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/near/config", () => ({ nearConfig: () => ({ rpcUrl: "https://rpc.invalid", ketosContract: "ketos.testnet", usdcContract: "usdc.testnet" }) }));
vi.mock("@/lib/near/views", () => ({ KetosViews: class {
  markets = mocks.markets;
  config = mocks.config;
  workerAssets = mocks.workerAssets;
  oracleAssetIds = mocks.oracleAssetIds;
} }));
vi.mock("@/lib/intents/oneclick", async (importOriginal) => ({
  ...await importOriginal<object>(), getTokens: mocks.getTokens,
}));

const NOW = 1_790_000_000_000;
const UNI_ROUTE = "nep141:eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near";
let now: number;
let GET: typeof ListingGet;
let statsGet: typeof StatsGet;
function token(symbol: string): OneClickToken {
  return { symbol, assetId: `nep141:${symbol.toLowerCase()}.near`, blockchain: "near", decimals: 8, price: 1 };
}

beforeEach(async () => {
  // Reload the routes and shared loader to isolate all process-local snapshots and flights.
  vi.resetModules();
  vi.clearAllMocks();
  now = NOW;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubEnv("ONECLICK_JWT", "");
  mocks.markets.mockResolvedValue(["BTC", "ETH", "NEAR"].map((id) => ({
    id, oracle_asset_id: `${id.toLowerCase()}-existing.near`, intents_asset_id: `nep141:${id.toLowerCase()}-existing.near`,
  })));
  mocks.config.mockResolvedValue({ oracle_id: "oracle.testnet" });
  mocks.workerAssets.mockResolvedValue(["UNI"]);
  mocks.oracleAssetIds.mockResolvedValue(["usdt.near", "frax.near", "wbtc.near", "weth.near", "wnear.near", "link.near"]);
  mocks.getTokens.mockResolvedValue([
    ...["USDT", "FRAX", "WBTC", "WETH", "WNEAR", "LINK"].map(token),
    { ...token("UNI"), assetId: UNI_ROUTE },
  ]);
  ({ GET } = await import("./route"));
  ({ GET: statsGet } = await import("../market-stats/route"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("listable assets route and shared server loader", () => {
  it("admits an authorized worker route but excludes arbitrary oracle routes, stablecoins and wrapped duplicates", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = listableResponseSchema.parse(await response.json());
    expect(body.assets.map((asset) => asset.symbol)).toEqual(["UNI"]);
    expect(body.fetchedAtMs).toBe(NOW);
    expect(body.oracleId).toBe("oracle.testnet");
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
    expect(mocks.oracleAssetIds).toHaveBeenCalledWith("oracle.testnet");
  });

  it("shares the loader with market stats directly, without a self-HTTP request", async () => {
    await GET();
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ open: "100", last: "105" }));
    vi.stubGlobal("fetch", upstream);
    const response = await statsGet(new Request("http://localhost/api/market-stats?symbols=UNI,BTC"));
    expect(response.status).toBe(200);
    expect(mocks.getTokens).toHaveBeenCalledTimes(1);
    expect(mocks.markets).toHaveBeenCalledTimes(1);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(upstream.mock.calls.every(([input]) => String(input).startsWith("https://api.exchange.coinbase.com/products/"))).toBe(true);
  });

  it("never lets filtered stablecoins or wrapped duplicates reach the stats venue", async () => {
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ open: "100", last: "105" }));
    vi.stubGlobal("fetch", upstream);
    const response = await statsGet(new Request("http://localhost/api/market-stats?symbols=USDT,FRAX,WBTC"));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(upstream).not.toHaveBeenCalled();
    expect(mocks.getTokens).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent listing refreshes", async () => {
    const { promise, resolve } = Promise.withResolvers<OneClickToken[]>();
    const { promise: started, resolve: signalStarted } = Promise.withResolvers<void>();
    mocks.getTokens.mockImplementationOnce(() => { signalStarted(); return promise; });
    const first = GET();
    await started;
    const second = GET();
    resolve([token("LINK")]);
    const responses = await Promise.all([first, second]);
    expect(await responses[0].json()).toEqual(await responses[1].json());
    expect(mocks.markets).toHaveBeenCalledTimes(1);
    expect(mocks.getTokens).toHaveBeenCalledTimes(1);
    expect(mocks.oracleAssetIds).toHaveBeenCalledTimes(1);
  });

  it("retains the source timestamp and age on cache hits and refreshes at expiry", async () => {
    await GET();
    now += 59_999;
    const cached = await GET();
    expect((await cached.json()).fetchedAtMs).toBe(NOW);
    expect(cached.headers.get("Age")).toBe("59");
    expect(mocks.getTokens).toHaveBeenCalledTimes(1);
    now += 1;
    expect((await (await GET()).json()).fetchedAtMs).toBe(now);
    expect(mocks.getTokens).toHaveBeenCalledTimes(2);
    expect(mocks.markets).toHaveBeenCalledTimes(2);
  });

  it("never relabels an older shared registry snapshot with a new listing timestamp", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ open: "100", last: "105" })));
    await statsGet(new Request("http://localhost/api/market-stats?symbols=BTC"));
    now += 30_000;
    const listing = await GET();
    expect((await listing.json()).fetchedAtMs).toBe(NOW);
    expect(listing.headers.get("Age")).toBe("30");
  });

  it.each(["markets", "getTokens", "oracleAssetIds"] as const)("does not cache or disclose %s failures", async (dependency) => {
    mocks[dependency].mockRejectedValueOnce(new Error("upstream private diagnostic"));
    const failed = await GET();
    expect(failed.status).toBe(502);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    expect(await failed.json()).toEqual({ error: "Listable assets unavailable" });
    expect((await GET()).status).toBe(200);
  });
});
