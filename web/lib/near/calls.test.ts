import { JsonRpcProvider } from "near-api-js";
import { afterEach, expect, it, vi } from "vitest";
import { depositVaultTx } from "./calls";

const contracts = { rpcUrl: "https://rpc.test.invalid", ketosContract: "ketos.testnet", usdcContract: "usdc.ketos.testnet" };

afterEach(() => vi.restoreAllMocks());

it("rejects a negative oracle quote before preparing a token transfer", async () => {
  vi.spyOn(JsonRpcProvider.prototype, "callFunction").mockResolvedValue("-1");
  await expect(depositVaultTx(contracts, "core", 1_000_000n)).rejects.toThrow();
});
