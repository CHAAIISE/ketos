import { describe, expect, it } from "vitest";
import { readContractState, type RawStatePage } from "./state";

const row = (key: string) => ({ key, value: "AA==" });
const page = (keys: string[], last_key?: string): RawStatePage => ({
  block_hash: "final-block", block_height: 42, values: keys.map(row), last_key,
});

describe("complete contract-state exports", () => {
  it("pins all later pages while retaining every storage key exactly once", async () => {
    const responses = [page(["AA==", "AQ=="], "AQ=="), page(["Ag=="])];
    const requests: Record<string, unknown>[] = [];
    const snapshot = await readContractState(async (params) => {
      requests.push(params);
      return responses.shift()!;
    }, "ketos.testnet", { finality: "final" });
    expect(snapshot?.values).toEqual([row("AA=="), row("AQ=="), row("Ag==")]);
    expect(requests[1]).toMatchObject({ block_id: "final-block", after_key_base64: "AQ==" });
    expect(requests[1]).not.toHaveProperty("finality");
  });
  it("refuses a changing block instead of combining incompatible account snapshots", async () => {
    const responses = [page(["AA=="], "AA=="), { ...page(["AQ=="]), block_hash: "other-block" }];
    await expect(readContractState(async () => responses.shift()!, "ketos.testnet", { finality: "final" }))
      .rejects.toThrow("changed block");
  });
  it("refuses missing or overlapping continuation pages", async () => {
    const missing = [page(["AA=="], "AA=="), null];
    await expect(readContractState(async () => missing.shift()!, "ketos.testnet", { finality: "final" }))
      .rejects.toThrow("disappeared");
    const overlapping = [page(["AA=="], "AA=="), page(["AA==", "AQ=="])];
    await expect(readContractState(async () => overlapping.shift()!, "ketos.testnet", { finality: "final" }))
      .rejects.toThrow("duplicate state key");
  });
  it("rejects an inconsistent cursor and an incorrect explicitly pinned block", async () => {
    await expect(readContractState(async () => page(["AA=="], "AQ=="), "ketos.testnet", { finality: "final" }))
      .rejects.toThrow("continuation cursor");
    await expect(readContractState(async () => page(["AA=="]), "ketos.testnet", { block_id: "expected-block" }))
      .rejects.toThrow("changed block");
  });
});
