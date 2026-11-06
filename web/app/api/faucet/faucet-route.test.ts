import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEAR, type FaucetChain } from "@/lib/faucet/service";

const mocks = vi.hoisted(() => ({ faucetChain: vi.fn(), faucetServerConfig: vi.fn() }));
vi.mock("@/lib/faucet/chain", () => mocks);
const NOW = 1_790_000_000_000;
const SECRET = "ed25519:server-secret-never-in-response";
let chain: FaucetChain;
// Dynamic imports intentionally reload the route's process-local signer guard after resetModules.
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.stubEnv("VERCEL", "1");
  chain = {
    availableBalance: vi.fn(async (id) => id === "faucet.ketos.testnet" ? 25n * NEAR : 0n),
    authorized: vi.fn(async () => true), availableAt: vi.fn(async () => 0n),
    config: vi.fn(async () => ({ faucet_id: "faucet.ketos.testnet", gas_day: 0, gas_spent: "0" })),
    claim: vi.fn(async () => ({ txHash: "funding-hash", outcome: {
      status: { SuccessValue: Buffer.from(JSON.stringify("1000000000")).toString("base64") },
      transaction_outcome: { outcome: { status: { SuccessReceiptId: "mint" } } },
      receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }],
    } })),
  };
  mocks.faucetChain.mockReturnValue(chain);
  mocks.faucetServerConfig.mockReturnValue({ faucetId: "faucet.ketos.testnet", privateKey: SECRET });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function request(body: unknown = { accountId: "alice.testnet" }, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/faucet", { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-vercel-forwarded-for": "192.0.2.1", ...headers } });
}

describe("POST /api/faucet", () => {
  it("never caches a successful funding response", async () => {
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([{}, { accountId: "Alice.testnet" }, { accountId: "a..b" }, { accountId: "a".repeat(65) }, null, []])(
    "rejects invalid JSON account input %j before reaching the signer", async (body) => {
      const { POST } = await import("./route");
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.faucetChain).not.toHaveBeenCalled();
    });

  it("rejects malformed JSON and non-JSON content types", async () => {
    const { POST } = await import("./route");
    const malformed = await POST(new Request("http://localhost/api/faucet", { method: "POST", body: "{", headers: { "content-type": "application/json" } }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "INVALID_JSON" });
    expect((await POST(request(undefined, { "content-type": "text/plain" }))).status).toBe(400);
    expect(mocks.faucetChain).not.toHaveBeenCalled();
  });

  it("bounds actual streamed bytes, not just the client-supplied length", async () => {
    const { POST } = await import("./route");
    const response = await POST(request({ accountId: "alice.testnet", padding: "x".repeat(1100) }, { "content-length": "20" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_BODY" });
    expect(mocks.faucetChain).not.toHaveBeenCalled();
    expect((await POST(request(undefined, { "content-length": "99999999999" }))).status).toBe(400);
  });

  it("exposes a shared-recipient cooldown as a human-readable 429 and Retry-After", async () => {
    chain.availableAt = vi.fn(async () => BigInt(NOW + 89_100));
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("90");
    expect(await response.json()).toMatchObject({ code: "ERR_FAUCET_COOLDOWN", retryAfterSeconds: 90, error: expect.stringContaining("already claimed") });
    expect(chain.claim).not.toHaveBeenCalled();
  });

  it("returns authoritative onchain IP rejection without exposing contract internals", async () => {
    chain.claim = vi.fn(async () => ({ txHash: "failed-hash", outcome: {
      status: { Failure: { error: "ERR_FAUCET_IP_LIMIT: retry in 83s" } },
      transaction_outcome: { outcome: { status: { SuccessReceiptId: "mint" } } }, receipts_outcome: [],
    } }));
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("83");
    expect(await response.json()).toEqual({ error: "This IP has reached the five-claims-per-hour limit. Retry in 83s.", code: "ERR_FAUCET_IP_LIMIT", retryAfterSeconds: 83 });
  });


  it("returns low reserves as a 503 and never leaks a key on arbitrary RPC failure", async () => {
    chain.availableBalance = vi.fn(async () => NEAR);
    const { POST } = await import("./route");
    const reserve = await POST(request());
    expect(reserve.status).toBe(503);
    expect(await reserve.json()).toMatchObject({ code: "FAUCET_LOW_RESERVE", error: expect.stringContaining("2 NEAR") });
    chain.availableAt = vi.fn(async () => { throw new Error(`RPC exception stack ${SECRET}`); });
    const rpc = await POST(request());
    expect(rpc.status).toBe(502);
    expect(await rpc.text()).not.toContain(SECRET);
  });

  it("returns a missing signer as a safe 503 instead of constructing a chain", async () => {
    // Import the same class instance as the reset route to preserve error identity.
    const { FaucetError: RouteError } = await import("@/lib/faucet/service");
    mocks.faucetServerConfig.mockImplementation(() => { throw new RouteError(503, "FAUCET_KEY_MISSING", "The faucet server signer is not configured."); });
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "FAUCET_KEY_MISSING" });
    expect(mocks.faucetChain).not.toHaveBeenCalled();
  });

  it("reports partial USDC success explicitly when a detached gas receipt fails", async () => {
    chain.claim = vi.fn(async () => ({ txHash: "partial-hash", outcome: {
      status: { SuccessValue: Buffer.from(JSON.stringify("1000000000")).toString("base64") },
      transaction_outcome: { outcome: { status: { SuccessReceiptId: "mint" } } },
      receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }, { outcome: { status: { Failure: "gas transfer failed" } } }],
    } }));
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ partial: true, usdc_tx: "partial-hash", gas_tx: "partial-hash", gas_failed: true, error: expect.stringContaining("1,000 USDC was minted") });
  });

  it("guards the shared signer across simultaneous HTTP requests", async () => {
    const { promise, resolve } = Promise.withResolvers<bigint>();
    const { promise: started, resolve: signal } = Promise.withResolvers<void>();
    chain.availableAt = vi.fn(async () => { signal(); return promise; });
    const { POST } = await import("./route");
    const first = POST(request());
    await started;
    const busy = await POST(request({ accountId: "bob.testnet" }));
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("2");
    expect(await busy.json()).toMatchObject({ code: "FAUCET_BUSY" });
    resolve(0n);
    expect((await first).status).toBe(200);
    expect(chain.claim).toHaveBeenCalledTimes(1);
  });
});
