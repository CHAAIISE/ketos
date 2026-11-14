import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { faucetChain, faucetServerConfig, type FaucetServerConfig } from "./chain";
import { FaucetError, LOW_BALANCE, NEAR } from "./service";

const rpc = vi.hoisted(() => ({
  viewAccount: vi.fn(), viewAccessKey: vi.fn(), getNetworkId: vi.fn(), callFunction: vi.fn(),
  sendTransactionUntil: vi.fn(), viewTransactionStatusWithReceipts: vi.fn(), createSignedTransaction: vi.fn(), fromSecretKey: vi.fn(),
}));
vi.mock("near-api-js", () => ({
  JsonRpcProvider: class {
    viewAccount = rpc.viewAccount;
    viewAccessKey = rpc.viewAccessKey;
    getNetworkId = rpc.getNetworkId;
    callFunction = rpc.callFunction;
    sendTransactionUntil = rpc.sendTransactionUntil;
    viewTransactionStatusWithReceipts = rpc.viewTransactionStatusWithReceipts;
  },
  Account: class { createSignedTransaction = rpc.createSignedTransaction; },
  KeyPairSigner: { fromSecretKey: rpc.fromSecretKey },
  baseEncode: () => "precomputed-signed-hash",
  teraToGas: (gas: number) => BigInt(gas) * 10n ** 12n,
  actions: { functionCall: (methodName: string, args: unknown, gas: bigint, deposit: bigint) => ({ methodName, args, gas, deposit }) },
}));

const config: FaucetServerConfig = { network: "testnet", rpcUrl: "https://rpc.testnet.near.org",
  faucetId: "faucet.ketos.testnet", usdcContract: "usdc.ketos.testnet", privateKey: "ed25519:test-only-secret" };
beforeEach(() => {
  vi.clearAllMocks();
  rpc.fromSecretKey.mockReturnValue({ getPublicKey: async () => ({ toString: () => "ed25519:public" }) });
  rpc.viewAccount.mockResolvedValue({ amount: NEAR, storage_usage: 182 });
  rpc.viewAccessKey.mockResolvedValue({ permission: "FullAccess" });
  rpc.getNetworkId.mockResolvedValue("testnet");
  rpc.createSignedTransaction.mockResolvedValue({ transaction: { encode: () => Uint8Array.of(1, 2, 3) } });
  rpc.sendTransactionUntil.mockResolvedValue({ status: { SuccessValue: "" } });
  vi.stubEnv("FAUCET_NETWORK", "testnet");
  vi.stubEnv("FAUCET_RPC_URL", "https://rpc.testnet.near.org");
  vi.stubEnv("FAUCET_USDC_CONTRACT", "usdc.ketos.testnet");
  vi.stubEnv("FAUCET_PRIVATE_KEY", config.privateKey);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("faucet server-only deployment configuration", () => {
  it("fixes the public testnet faucet account even if another account is supplied", () => {
    vi.stubEnv("FAUCET_ACCOUNT_ID", "attacker.testnet");
    expect(faucetServerConfig().faucetId).toBe("faucet.ketos.testnet");
  });

  it("requires a configured sandbox account and RPC rather than silently using testnet", () => {
    vi.stubEnv("FAUCET_NETWORK", "sandbox");
    vi.stubEnv("FAUCET_ACCOUNT_ID", "faucet.test.near");
    vi.stubEnv("FAUCET_RPC_URL", "http://127.0.0.1:3030");
    expect(faucetServerConfig()).toMatchObject({ network: "sandbox", faucetId: "faucet.test.near", rpcUrl: "http://127.0.0.1:3030" });
    vi.stubEnv("FAUCET_ACCOUNT_ID", "");
    expect(() => faucetServerConfig()).toThrow(FaucetError);
  });

  it("uses the established public contract and network config when server overrides are absent", () => {
    delete process.env.FAUCET_NETWORK;
    delete process.env.FAUCET_RPC_URL;
    delete process.env.FAUCET_USDC_CONTRACT;
    vi.stubEnv("NEXT_PUBLIC_NEAR_NETWORK", "testnet");
    vi.stubEnv("NEXT_PUBLIC_RPC_URL", "https://test.rpc.fastnear.com");
    vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT", "usdc.ketos.testnet");
    expect(faucetServerConfig()).toMatchObject({ network: "testnet", rpcUrl: "https://test.rpc.fastnear.com", usdcContract: "usdc.ketos.testnet" });
  });

  it("refuses mainnet and missing signing keys without exposing any configured values", () => {
    vi.stubEnv("FAUCET_NETWORK", "mainnet");
    try { faucetServerConfig(); expect.unreachable(); }
    catch (error) { expect(error).toMatchObject({ status: 503, code: "FAUCET_CONFIG" }); expect(String(error)).not.toContain(config.privateKey); }
    vi.stubEnv("FAUCET_NETWORK", "testnet");
    vi.stubEnv("FAUCET_PRIVATE_KEY", "");
    expect(() => faucetServerConfig()).toThrow("signer is not configured");
  });

  it("sanitizes a key decoder failure rather than returning the offending key", () => {
    rpc.fromSecretKey.mockImplementationOnce(() => { throw new Error(`invalid ${config.privateKey}`); });
    try { faucetChain(config); expect.unreachable(); }
    catch (error) { expect(error).toMatchObject({ status: 503, code: "FAUCET_KEY_INVALID" }); expect(String(error)).not.toContain(config.privateKey); }
  });
});

describe("real account availability and authorized signer checks", () => {
  it.each([0n, LOW_BALANCE - 1n, LOW_BALANCE, LOW_BALANCE + 1n])("does not deduct storage for NEP-448 exempt accounts at %s", async (amount) => {
    rpc.viewAccount.mockResolvedValue({ amount, storage_usage: 182 });
    expect(await faucetChain(config).availableBalance("zero.testnet")).toBe(amount);
  });

  it("honors the exemption through 770 bytes and deducts full storage staking above it", async () => {
    const chain = faucetChain(config);
    rpc.viewAccount.mockResolvedValueOnce({ amount: NEAR, storage_usage: 770 });
    expect(await chain.availableBalance("small.testnet")).toBe(NEAR);
    rpc.viewAccount.mockResolvedValueOnce({ amount: NEAR, storage_usage: 771 });
    expect(await chain.availableBalance("large.testnet")).toBe(NEAR - 771n * 10n ** 19n);
    rpc.viewAccount.mockResolvedValueOnce({ amount: 1n, storage_usage: 771 });
    expect(await chain.availableBalance("large.testnet")).toBe(0n);
  });

  it("rejects nonexistent recipients, but treats a missing sponsor as unavailable configuration", async () => {
    rpc.viewAccount.mockRejectedValue(new Error("UNKNOWN_ACCOUNT: UnknownAccount does not exist"));
    const chain = faucetChain(config);
    await expect(chain.availableBalance("missing.testnet")).rejects.toMatchObject({ status: 400, code: "ACCOUNT_NOT_FOUND" });
    await expect(chain.availableBalance(config.faucetId)).rejects.toMatchObject({ status: 503, code: "FAUCET_CONFIG" });
  });

  it("refuses function-call keys and a live RPC that reports mainnet", async () => {
    const chain = faucetChain(config);
    rpc.viewAccessKey.mockResolvedValueOnce({ permission: { FunctionCall: { method_names: ["faucet_for"] } } });
    expect(await chain.authorized()).toBe(false);
    rpc.getNetworkId.mockResolvedValueOnce("mainnet");
    await expect(chain.authorized()).rejects.toMatchObject({ status: 503, code: "FAUCET_CONFIG" });
  });

  it("accepts the dedicated full-access key on the expected network", async () => {
    expect(await faucetChain(config).authorized()).toBe(true);
  });
});

describe("single-submit faucet signer", () => {
  it("reads an uncertain send by its hash, then reports it unconfirmed without resubmitting", async () => {
    vi.useFakeTimers();
    rpc.sendTransactionUntil.mockRejectedValueOnce(new Error(`timeout ${config.privateKey}`));
    rpc.viewTransactionStatusWithReceipts.mockRejectedValue(new Error("UNKNOWN_TRANSACTION"));
    const chain = faucetChain(config);
    const claim = chain.claim("zero.testnet", "a".repeat(64), NEAR / 2n).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    const failure = await claim;
    vi.useRealTimers();
    expect(failure).toMatchObject({ status: 502, code: "FAUCET_TX_UNCERTAIN", evidence: { tx_hash: "precomputed-signed-hash" } });
    expect(String(failure)).not.toContain(config.privateKey);
    expect(rpc.sendTransactionUntil).toHaveBeenCalledTimes(1);
    expect(rpc.sendTransactionUntil.mock.calls[0][1]).toBe("FINAL");
    expect(rpc.createSignedTransaction).toHaveBeenCalledTimes(1);
    expect(rpc.viewTransactionStatusWithReceipts).toHaveBeenCalledTimes(5);
  });

  it("returns the confirmed outcome when the broadcast transaction is found by hash", async () => {
    vi.useFakeTimers();
    const final = { status: { SuccessValue: "" }, receipts_outcome: [] };
    rpc.sendTransactionUntil.mockRejectedValueOnce(new Error("Public endpoint rate limit"));
    rpc.viewTransactionStatusWithReceipts.mockRejectedValueOnce(new Error("UNKNOWN_TRANSACTION")).mockResolvedValueOnce(final);
    const claim = faucetChain(config).claim("zero.testnet", "a".repeat(64), 0n);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(claim).resolves.toEqual({ outcome: final, txHash: "precomputed-signed-hash" });
    vi.useRealTimers();
    expect(rpc.viewTransactionStatusWithReceipts).toHaveBeenCalledWith({
      txHash: "precomputed-signed-hash", accountId: config.faucetId, waitUntil: "FINAL" });
    expect(rpc.sendTransactionUntil).toHaveBeenCalledTimes(1);
  });
});
