import { expect, it } from "vitest";
import { hedgeFillSchema } from "./types";
import { verifyHedgeEvidence } from "./hedge-evidence";

const fill = { nonce: 2, side: "Buy", amount_in: "1000000", amount_out: "248000000000000000000000",
  reference_price: "400000000", reference_timestamp_ms: 1000, started_at_ms: 1200, confirmed_at_ms: 4000,
  execution_cost: "8000", realized_pnl: "0", recovered: false };
const record = { fill: hedgeFillSchema.parse(fill), reported_transaction_hash: "confirmed-hash" };
function transaction() {
  return { final_execution_status: "FINAL", status: { SuccessValue: btoa("true") },
    transaction: { hash: "confirmed-hash", receiver_id: "ketos.test", signer_id: "keeper.test",
      actions: [{ FunctionCall: { method_name: "rebalance_hedge", args: btoa(JSON.stringify({ nonce: 2 })) } }] },
    transaction_outcome: { outcome: { executor_id: "keeper.test", tokens_burnt: "100", status: { SuccessReceiptId: "receipt" }, logs: [] } },
    receipts_outcome: [{ id: "receipt", outcome: { executor_id: "custody.test", tokens_burnt: "200",
      status: { SuccessValue: "" } as Record<string, unknown>, logs: [`EVENT_JSON:${JSON.stringify({ standard: "ketos_hedge", version: "1.0.0", event: "fill", data: [fill] })}`] } }],
  };
}
const verify = (raw: unknown) => verifyHedgeEvidence(raw, record, "ketos.test", "keeper.test", "custody.test");
it("derives actual burn and latency from a matching final custody receipt", () => {
  expect(verify(transaction())).toEqual({ transactionHash: "confirmed-hash", receiptId: "receipt", gasCostYocto: 300n, latencyMs: 2800 });
});
it("rejects an identical event emitted by another account", () => {
  const raw = transaction();
  raw.receipts_outcome[0].outcome.executor_id = "forged.test";
  expect(() => verify(raw)).toThrow("No matching custody fill");
});
it("rejects a locator for a different fill or authorization", () => {
  const raw = transaction();
  raw.receipts_outcome[0].outcome.logs[0] = raw.receipts_outcome[0].outcome.logs[0].replace('"1000000"', '"2000000"');
  expect(() => verify(raw)).toThrow("No matching custody fill");
  const wrongNonce = transaction();
  wrongNonce.transaction.actions[0].FunctionCall.args = btoa(JSON.stringify({ nonce: 3 }));
  expect(() => verify(wrongNonce)).toThrow("nonce mismatch");
});
it("does not call a successful outer callback proof of successful execution", () => {
  const raw = transaction();
  raw.receipts_outcome[0].outcome.status = { Failure: { ActionError: "swap rejected" } };
  expect(() => verify(raw)).toThrow("not completely successful");
});
