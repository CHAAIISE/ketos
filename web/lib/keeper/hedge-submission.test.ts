import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "near-api-js";
import { afterEach, expect, it, vi } from "vitest";
import { HedgeSubmissions } from "./hedge-submission";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ketos-hedge-journal-")); directories.push(directory);
  const path = join(directory, "journal.json");
  const provider = {
    sendTransactionUntil: vi.fn(async () => { throw new Error("unknown after broadcast"); }),
    viewTransactionStatusWithReceipts: vi.fn(async () => ({ status: { SuccessValue: Buffer.from("true").toString("base64") }, receipts_outcome: [] })),
  };
  const createSignedTransaction = vi.fn(async () => ({ transaction: { encode: () => new Uint8Array([1, 2, 3]) } }));
  const account = { accountId: "keeper.test", provider, createSignedTransaction } as unknown as Account;
  return { path, provider, createSignedTransaction, account, journal: new HedgeSubmissions(path, account, "ketos.test") };
}
it("keeps the original transaction across a timeout and restart without signing or broadcasting twice", async () => {
  const f = fixture();
  await expect(f.journal.send("rebalance_hedge", { nonce: 2 }, 300)).rejects.toThrow("unknown after broadcast");
  const stored = JSON.parse(readFileSync(f.path, "utf8"));
  expect(stored.entries[0].hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  const restarted = new HedgeSubmissions(f.path, f.account, "ketos.test");
  expect(restarted.locator(2)).toBe(stored.entries[0].hash);
  await restarted.send("rebalance_hedge", { nonce: 2, amount_in: "different" }, 300);
  expect(f.createSignedTransaction).toHaveBeenCalledTimes(1);
  expect(f.provider.sendTransactionUntil).toHaveBeenCalledTimes(1);
  expect(f.provider.viewTransactionStatusWithReceipts).toHaveBeenCalledWith({
    txHash: stored.entries[0].hash, accountId: "keeper.test", waitUntil: "FINAL",
  });
});
it("blocks cross-operation nonce reuse and a changed custody controller", async () => {
  const f = fixture();
  await expect(f.journal.send("fund_hedge", { nonce: 1 }, 300)).rejects.toThrow("unknown after broadcast");
  await expect(f.journal.send("rebalance_hedge", { nonce: 1 }, 300)).rejects.toThrow("already submitted");
  expect(() => new HedgeSubmissions(f.path, f.account, "another.test").locator(1)).toThrow("identity mismatch");
  expect(f.provider.sendTransactionUntil).toHaveBeenCalledTimes(1);
});
