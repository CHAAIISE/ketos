import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests have no Next request context; aggregate computation itself stays real.
vi.mock("next/server", () => ({ connection: async () => {} }));

const chain = vi.hoisted(() => ({
  markets: vi.fn(), vaults: vi.fn(), leaderboard: vi.fn(), history: vi.fn(),
}));
vi.mock("@/lib/near/views", () => ({
  ACCOUNT_HISTORY_LEN: 200,
  LEADERBOARD_MAX: 500,
  KetosViews: class {
    markets = chain.markets;
    vaults = chain.vaults;
    leaderboard = chain.leaderboard;
    history = chain.history;
  },
}));
vi.mock("@/lib/near/config", () => ({ nearConfig: () => ({
  rpcUrl: "https://rpc.example", ketosContract: "ketos.testnet", usdcContract: "usdc.testnet",
}) }));

const NOW = 1_800_000_000_000;
let now: number;

// Reloading the route isolates its process-local cache; static imports cannot reset it.
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  now = NOW;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  chain.markets.mockResolvedValue([{
    id: "NEAR", oi_long: 12n, oi_short: 8n, depth_measured_at_ms: NOW,
    exit_capacity: 10_000_000_000n, is_open: true, price: 1n, price_timestamp_ms: NOW,
  }]);
  chain.vaults.mockResolvedValue([{ id: "core", nav: 50n }, { id: "long-tail", nav: 30n }]);
  chain.leaderboard.mockResolvedValue([{ account_id: "alice.near" }]);
  chain.history.mockResolvedValue([
    { sequence: 0, kind: "open", size: 15n, timestamp_ms: NOW },
    { sequence: 1, kind: "order_fill", size: 15n, timestamp_ms: NOW },
    { sequence: 2, kind: "close", size: 15n, timestamp_ms: NOW },
  ]);
});

afterEach(() => vi.restoreAllMocks());

describe("/api/stats", () => {
  it("returns computed chain aggregates and ages cached snapshots without retimestamping", async () => {
    const { GET } = await import("./route");
    const first = await GET();
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=0, s-maxage=60");
    expect(first.headers.get("Age")).toBe("0");
    const body = await first.json();
    expect(body).toMatchObject({
      volume24h: "30", trades24h: 2, traders24h: 1, totalOi: "20", vaultTvl: "80",
      marketsCount: 1, openMarketsCount: 1, fetchedAtMs: NOW,
    });
    now += 59_999;
    const cached = await GET();
    expect(cached.headers.get("Age")).toBe("59");
    expect(await cached.json()).toEqual(body);
    expect(chain.history).toHaveBeenCalledTimes(1);
    now += 1;
    expect((await (await GET()).json()).fetchedAtMs).toBe(now);
    expect(chain.history).toHaveBeenCalledTimes(2);
  });

  it("does not cache upstream failures or disclose their details", async () => {
    const { GET } = await import("./route");
    chain.history.mockRejectedValueOnce(new Error("sensitive upstream URL and body"));
    const failed = await GET();
    expect(failed.status).toBe(502);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    expect(await failed.json()).toEqual({ error: "Onchain statistics unavailable" });
    expect((await GET()).status).toBe(200);
    expect(chain.history).toHaveBeenCalledTimes(2);
  });

  it("fails closed for unknown onchain data instead of returning successful zero stats", async () => {
    const { GET } = await import("./route");
    chain.vaults.mockResolvedValue([{ id: "core" }, { id: "long-tail", nav: 30n }]);
    const response = await GET();
    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).not.toHaveProperty("volume24h");
  });
});
