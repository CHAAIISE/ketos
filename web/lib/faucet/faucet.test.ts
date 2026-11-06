import { beforeEach, describe, expect, it, vi } from "vitest";
import { DAILY_GAS_LIMIT, FaucetError, FaucetService, GAS_TOP_UP, LOW_BALANCE, MIN_FAUCET_BALANCE,
  NEAR, fundingOutcome, hashIp, ingressIp, validAccountId, type FaucetChain } from "./service";

const NOW = 1_790_000_000_000;
const FAUCET = "faucet.ketos.testnet";
const TX = "confirmed-faucet-transaction";
type TestStatus = { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown };
function success(): { status: TestStatus; transaction_outcome: { outcome: { status: TestStatus } };
  receipts_outcome: { outcome: { status: TestStatus } }[] } {
  return { status: { SuccessValue: Buffer.from(JSON.stringify("1000000000")).toString("base64") },
    transaction_outcome: { outcome: { status: { SuccessReceiptId: "mint" } } },
    receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }, { outcome: { status: { SuccessValue: "" } } }] };
}
let chain: FaucetChain;
let service: FaucetService;
beforeEach(() => {
  chain = {
    availableBalance: vi.fn(async (id: string) => id === FAUCET ? 25n * NEAR : 0n),
    authorized: vi.fn(async () => true), availableAt: vi.fn(async () => 0n),
    config: vi.fn(async () => ({ faucet_id: FAUCET, gas_day: Math.floor(NOW / 86_400_000), gas_spent: "0" })),
    claim: vi.fn(async () => ({ outcome: success(), txHash: TX })),
  };
  service = new FaucetService(chain, FAUCET, () => NOW);
});

describe("faucet account validation", () => {
  it.each(["ab", "a-b_c.testnet", "0".repeat(64), "named.account.testnet"])("accepts NEAR account %s", (id) => {
    expect(validAccountId(id)).toBe(true);
  });
  it.each(["a", "a".repeat(65), "Alice.testnet", ".alice", "alice.", "a..b", "a-_b", "a_.b", " alice.testnet", "alice@near", "éa", "a/b", "", null, 42])(
    "rejects malformed account %s", (id) => { expect(validAccountId(id)).toBe(false); });
});

describe("gasless sponsored faucet policy", () => {

  it.each([LOW_BALANCE - 1n, LOW_BALANCE, LOW_BALANCE + 1n])("honors the exact available-balance threshold %s", async (balance) => {
    chain.availableBalance = vi.fn(async (id) => id === FAUCET ? 25n * NEAR : balance);
    const result = await service.fund("alice.testnet", "a".repeat(64));
    expect(chain.claim).toHaveBeenCalledExactlyOnceWith("alice.testnet", "a".repeat(64), balance < LOW_BALANCE ? GAS_TOP_UP : 0n);
    expect(result.gas_tx).toBe(balance < LOW_BALANCE ? TX : undefined);
  });

  it("rejects the shared wallet/sponsored recipient cooldown before sending", async () => {
    chain.availableAt = vi.fn(async () => BigInt(NOW + 37_001));
    await expect(service.fund("alice.testnet", "a".repeat(64))).rejects.toMatchObject({
      status: 429, code: "ERR_FAUCET_COOLDOWN", retryAfterSeconds: 38,
    });
    expect(chain.claim).not.toHaveBeenCalled();
  });

  it("rejects the authoritative sixth hourly IP claim race with a retry time", async () => {
    chain.claim = vi.fn(async () => ({ txHash: TX, outcome: { ...success(), status: {
      Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_FAUCET_IP_LIMIT: retry in 1200s" } } } },
    } } }));
    await expect(service.fund("alice.testnet", "a".repeat(64))).rejects.toMatchObject({
      status: 429, code: "ERR_FAUCET_IP_LIMIT", retryAfterSeconds: 1200,
    });
  });

  it("maps an onchain cooldown race rather than reporting minted tokens", async () => {
    chain.claim = vi.fn(async () => ({ txHash: TX, outcome: { ...success(), status: {
      Failure: { error: "ERR_FAUCET_COOLDOWN: retry in 59s" },
    } } }));
    await expect(service.fund("alice.testnet", "a".repeat(64))).rejects.toMatchObject({
      status: 429, code: "ERR_FAUCET_COOLDOWN", retryAfterSeconds: 59,
    });
  });

  it("refuses a reserve below two available NEAR before sending", async () => {
    chain.availableBalance = vi.fn(async () => MIN_FAUCET_BALANCE - 1n);
    await expect(service.fund("alice.testnet", "a".repeat(64))).rejects.toMatchObject({ status: 503, code: "FAUCET_LOW_RESERVE" });
    expect(chain.claim).not.toHaveBeenCalled();
  });

  it("allows the final half NEAR of the daily budget but refuses an overspend", async () => {
    chain.config = vi.fn(async () => ({ faucet_id: FAUCET, gas_day: Math.floor(NOW / 86_400_000), gas_spent: String(DAILY_GAS_LIMIT - GAS_TOP_UP) }));
    await expect(service.fund("alice.testnet", "a".repeat(64))).resolves.toHaveProperty("gas_tx", TX);
    chain.config = vi.fn(async () => ({ faucet_id: FAUCET, gas_day: Math.floor(NOW / 86_400_000), gas_spent: String(DAILY_GAS_LIMIT - GAS_TOP_UP + 1n) }));
    await expect(service.fund("bob.testnet", "a".repeat(64))).rejects.toMatchObject({ status: 429, code: "ERR_FAUCET_GAS_LIMIT", retryAfterSeconds: expect.any(Number) });
    expect(chain.claim).toHaveBeenCalledTimes(1);
  });

  it("resets a prior day's gas usage and does not spend budget for an already-funded account", async () => {
    chain.config = vi.fn(async () => ({ faucet_id: FAUCET, gas_day: Math.floor(NOW / 86_400_000) - 1, gas_spent: String(DAILY_GAS_LIMIT) }));
    await expect(service.fund("alice.testnet", "a".repeat(64))).resolves.toHaveProperty("gas_tx", TX);
    chain.config = vi.fn(async () => ({ faucet_id: FAUCET, gas_day: Math.floor(NOW / 86_400_000), gas_spent: String(DAILY_GAS_LIMIT) }));
    chain.availableBalance = vi.fn(async () => 25n * NEAR);
    await expect(service.fund("bob.testnet", "a".repeat(64))).resolves.toEqual({ usdc_tx: TX });
  });

  it("maps a contract-side daily-budget race to midnight UTC", async () => {
    chain.claim = vi.fn(async () => ({ txHash: TX, outcome: { ...success(), status: { Failure: "ERR_FAUCET_GAS_LIMIT" } } }));
    const failure = await service.fund("alice.testnet", "a".repeat(64)).catch((e: unknown) => e) as FaucetError;
    expect(failure.status).toBe(429);
    expect(failure.retryAfterSeconds).toBe(Math.ceil(((Math.floor(NOW / 86_400_000) + 1) * 86_400_000 - NOW) / 1000));
  });

  it("fails closed if the contract authorizes another faucet or the signer lacks full access", async () => {
    chain.config = vi.fn(async () => ({ faucet_id: "other.testnet", gas_day: 0, gas_spent: "0" }));
    await expect(service.fund("alice.testnet", "a".repeat(64))).rejects.toMatchObject({ status: 503, code: "FAUCET_CONFIG" });
    chain.config = vi.fn(async () => ({ faucet_id: FAUCET, gas_day: 0, gas_spent: "0" }));
    chain.authorized = vi.fn(async () => false);
    await expect(service.fund("alice.testnet", "a".repeat(64))).rejects.toMatchObject({ status: 503, code: "FAUCET_CONFIG" });
    expect(chain.claim).not.toHaveBeenCalled();
  });

  it("never echoes a secret or RPC stack on read failure", async () => {
    const secret = "ed25519:private-key-never-returned";
    chain.availableAt = vi.fn(async () => { throw new Error(`RPC failed with ${secret}`); });
    const failure = await service.fund("alice.testnet", "a".repeat(64)).catch((e: unknown) => e) as FaucetError;
    expect(failure.status).toBe(502);
    expect(JSON.stringify(failure.body())).not.toContain(secret);
    expect(JSON.stringify(failure.body())).not.toContain("stack");
    expect(chain.claim).not.toHaveBeenCalled();
  });

  it("rejects overlap without queuing another signer call, then releases the guard", async () => {
    const { promise, resolve } = Promise.withResolvers<bigint>();
    const { promise: started, resolve: signal } = Promise.withResolvers<void>();
    chain.availableAt = vi.fn(async () => { signal(); return promise; });
    const first = service.fund("alice.testnet", "a".repeat(64));
    await started;
    await expect(service.fund("bob.testnet", "b".repeat(64))).rejects.toMatchObject({ status: 503, code: "FAUCET_BUSY", retryAfterSeconds: 2 });
    resolve(0n);
    await first;
    await expect(service.fund("bob.testnet", "b".repeat(64))).resolves.toHaveProperty("usdc_tx", TX);
    expect(chain.claim).toHaveBeenCalledTimes(2);
  });

  it("does not retry an uncertain submitted transaction and releases the guard after failure", async () => {
    chain.claim = vi.fn(async () => { throw new FaucetError(502, "FAUCET_TX_UNCERTAIN", "Check transaction before retrying.", undefined, { tx_hash: TX }); });
    await expect(service.fund("alice.testnet", "a".repeat(64))).rejects.toMatchObject({ status: 502, evidence: { tx_hash: TX } });
    expect(chain.claim).toHaveBeenCalledTimes(1);
    chain.claim = vi.fn(async () => ({ outcome: success(), txHash: TX }));
    await expect(service.fund("bob.testnet", "b".repeat(64))).resolves.toHaveProperty("usdc_tx", TX);
  });
});

describe("all funding receipts", () => {
  it("reports minted USDC and a failed detached gas transfer even when the final status succeeded", () => {
    const outcome = success();
    outcome.receipts_outcome.push({ outcome: { status: { Failure: { error: "receiver disappeared" } } } });
    try {
      fundingOutcome(outcome, TX, GAS_TOP_UP, NOW);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FaucetError);
      expect((error as FaucetError).body()).toMatchObject({ code: "FAUCET_PARTIAL_SUCCESS", partial: true, usdc_tx: TX, gas_tx: TX, gas_failed: true });
    }
  });

  it("checks the transaction receipt too, not only detached receipts", () => {
    const outcome = success();
    outcome.transaction_outcome.outcome.status = { Failure: "failed transaction" };
    expect(() => fundingOutcome(outcome, TX, GAS_TOP_UP, NOW)).toThrow(FaucetError);
  });

  it("does not claim success for missing, pending, or undecodable mint results", () => {
    for (const raw of [null, {}, { ...success(), status: "Started" }, { ...success(), status: { SuccessValue: "" } }]) {
      try { fundingOutcome(raw, TX, GAS_TOP_UP, NOW); expect.unreachable(); }
      catch (error) { expect(error).toMatchObject({ code: "FAUCET_TX_UNCERTAIN", evidence: { tx_hash: TX } }); }
    }
  });
});

describe("private canonical IP quota keys", () => {
  it("normalizes IPv6, IPv4-mapped IPv6, and trusts only the Vercel-overwritten header there", () => {
    const request = (headers: Record<string, string>) => new Request("http://localhost", { headers });
    expect(ingressIp(request({ "x-vercel-forwarded-for": "2001:0DB8:0:0::1", "x-forwarded-for": "1.2.3.4" }), true)).toBe("2001:db8::1");
    expect(ingressIp(request({ "x-forwarded-for": "::ffff:192.0.2.1" }), false)).toBe("192.0.2.1");
    expect(ingressIp(request({ "x-forwarded-for": "::ffff:c000:201" }), false)).toBe("192.0.2.1");
    expect(ingressIp(request({ "x-forwarded-for": "1.2.3.4" }), true)).toBe("unknown");
    expect(ingressIp(request({ "x-forwarded-for": "arbitrary-user-controlled-text" }), false)).toBe("unknown");
    expect(ingressIp(request({}), false)).toBe("unknown");
  });

  it("uses stable unknown buckets and secret-keyed 64-character hex hashes, never raw IPs", () => {
    const secret = "server-only-key";
    expect(hashIp("unknown", secret)).toBe(hashIp("unknown", secret));
    expect(hashIp("192.0.2.1", secret)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashIp("192.0.2.1", secret)).not.toBe(hashIp("192.0.2.1", "another-key"));
  });
});
