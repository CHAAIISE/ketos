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
  vi.stubEnv("KEEPER_HTTP_ENABLED", "1");
  publishedAt = NOW - 20_000;
  chain = {
    markets: async () => [{ id: "NEAR", depth_measured_at_ms: publishedAt,
      oi_long: 0n, oi_short: 0n, price: 0n, funding: { last_accrual_ms: NOW },
    } as Market],
    ketosBalanceYocto: async () => MIN_KETOS_BALANCE_YOCTO,
    hedge: async () => null,
    rebalanceHedge: async () => ({ status: "disabled" }),
    openPositions: async () => [], openOrders: async () => [],
    setDepth: async (_market, _samples, at) => { publishedAt = at; return "tx-depth"; },
    vaults: async () => [{ id: "core", last_snapshot_at_ms: NOW }, { id: "long-tail", last_snapshot_at_ms: NOW }],
    crossAccount: async () => { throw new Error("unexpected cross read"); },
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

  it.each([NOW - 20_000, NOW - 600_000])("rejects anonymous visitors regardless of depth age", async (measurement) => {
    publishedAt = measurement;
    const { POST } = await import("./route");
    expect((await POST(request())).status).toBe(401);
    expect(mocks.keeperChain).not.toHaveBeenCalled();
    expect(publishedAt).toBe(measurement);
  });

  it("does not let an authenticated caller compete with standalone ownership", async () => {
    vi.stubEnv("KEEPER_HTTP_ENABLED", "");
    const { POST } = await import("./route");
    expect((await POST(request(`Bearer ${secret}`))).status).toBe(409);
    expect(mocks.keeperChain).not.toHaveBeenCalled();
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

  it("reports degraded maintenance as unavailable rather than a successful tick", async () => {
    mocks.oneClickDepthSource.mockReturnValue({ sample: async () => { throw new Error("depth offline"); } });
    const { POST } = await import("./route");
    const response = await POST(request(`Bearer ${secret}`));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ degraded: true, errors: [{ step: "depth", error: "depth offline" }] });
  });
});
