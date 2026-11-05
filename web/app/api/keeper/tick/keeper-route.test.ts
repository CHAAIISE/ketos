import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Market } from "@/lib/near/types";
import { MIN_KETOS_BALANCE_YOCTO, type KeeperChain } from "@/lib/keeper/tick";

const mocks = vi.hoisted(() => ({ keeperChain: vi.fn(), oneClickDepthSource: vi.fn() }));
vi.mock("@/lib/keeper/chain", () => mocks);

const NOW = 1_790_000_000_000;
let secret: string;
let publishedAt: number;
let chain: KeeperChain;

// Each case imports a fresh route after resetModules: its process-local TickGate must start empty.
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  secret = randomUUID();
  vi.stubEnv("CRON_SECRET", secret);
  vi.stubEnv("KEEPER_PRIVATE_KEY", "test signer supplied by chain seam");
  publishedAt = NOW - 20_000;
  chain = {
    markets: async () => [{ id: "NEAR", depth_measured_at_ms: publishedAt,
      oi_long: 0n, oi_short: 0n, price: 0n, funding: { last_accrual_ms: NOW },
    } as Market],
    ketosBalanceYocto: async () => MIN_KETOS_BALANCE_YOCTO,
    openPositions: async () => [], openOrders: async () => [],
    setDepth: async (_market, _samples, at) => { publishedAt = at; return "tx-depth"; },
    lastSnapshotMs: async () => NOW,
    crossAccount: async () => { throw new Error("unexpected cross read"); },
    lastPriceRequestMs: async () => { throw new Error("unexpected price read"); },
    refreshPrices: async () => { throw new Error("unexpected price request"); },
    executeOrders: async () => { throw new Error("unexpected order execution"); },
    liquidate: async () => { throw new Error("unexpected liquidation"); },
    liquidateCross: async () => { throw new Error("unexpected cross liquidation"); },
    settleFunding: async () => { throw new Error("unexpected funding"); },
    snapshotVaults: async () => { throw new Error("unexpected snapshot"); },
  };
  mocks.keeperChain.mockResolvedValue(chain);
  mocks.oneClickDepthSource.mockReturnValue({ sample: async () => [{
    market: "NEAR", measuredAtMs: NOW, samples: [{ size_usd: 10_000, impact_bps: 50 }],
  }] });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function request(authorization?: string) {
  return new Request("http://localhost/api/keeper/tick", {
    method: "POST", headers: authorization === undefined ? {} : { authorization },
  });
}

describe("keeper route access", () => {
  it("rejects an invalid supplied credential before reaching the signer", async () => {
    const { POST } = await import("./route");
    const response = await POST(request(`Bearer ${randomUUID()}`));
    expect(response.status).toBe(401);
    expect(mocks.keeperChain).not.toHaveBeenCalled();
    expect(publishedAt).toBe(NOW - 20_000);
  });

  it("never accepts a supplied credential if the server secret is missing", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const { POST } = await import("./route");
    expect((await POST(request(`Bearer ${secret}`))).status).toBe(401);
    expect(mocks.keeperChain).not.toHaveBeenCalled();
  });

  it("returns a normal waiting response for a recent on-chain browser tick", async () => {
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Retry-After")).toBe("40");
    expect(await response.json()).toMatchObject({ state: "throttled", retryAfterMs: 40_000 });
    expect(publishedAt).toBe(NOW - 20_000);
  });

  it("allows a browser pass at the on-chain minute boundary", async () => {
    publishedAt = NOW - 60_000;
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(publishedAt).toBe(NOW);
  });

  it("lets a valid scheduler pass a recent measurement but does not overlap runs", async () => {
    const { promise: pending, resolve: release } = Promise.withResolvers<void>();
    const { promise: started, resolve: sampled } = Promise.withResolvers<void>();
    mocks.oneClickDepthSource.mockReturnValue({ sample: async () => {
      sampled();
      await pending;
      return [{ market: "NEAR", measuredAtMs: NOW, samples: [{ size_usd: 10_000, impact_bps: 50 }] }];
    } });
    const { POST } = await import("./route");
    const first = POST(request(`Bearer ${secret}`));
    await started;
    try {
      const second = await POST(request(`Bearer ${secret}`));
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ state: "throttled" });
      expect(publishedAt).toBe(NOW - 20_000);
    } finally {
      release();
    }
    expect((await first).status).toBe(200);
    expect(publishedAt).toBe(NOW);
  });

  it("fails closed for anonymous callers when on-chain freshness cannot be read", async () => {
    chain.markets = async () => { throw new Error("RPC unavailable"); };
    const { POST } = await import("./route");
    expect((await POST(request())).status).toBe(502);
    expect(publishedAt).toBe(NOW - 20_000);
  });
});
