import { describe, expect, it } from "vitest";
import { TxFailureError, settleOutcome } from "./tx";

const b64 = (text: string) => btoa(text);

function outcome(status: unknown, receiptStatuses: unknown[] = []) {
  return {
    final_execution_status: "EXECUTED_OPTIMISTIC",
    status,
    transaction: { hash: "9fGkPq3Zs1", signer_id: "alice.testnet", receiver_id: "usdc.ketos-dev.testnet" },
    transaction_outcome: { id: "9fGkPq3Zs1", block_hash: "B1", outcome: { status: { SuccessReceiptId: "R0" } } },
    receipts_outcome: receiptStatuses.map((s, i) => ({
      id: `R${i}`,
      block_hash: "B2",
      outcome: { executor_id: "perps.ketos-dev.testnet", logs: [], status: s },
    })),
  };
}

describe("settleOutcome", () => {
  it("decodes the JSON return value", () => {
    const result = settleOutcome(outcome({ SuccessValue: b64('"1000000000"') }, [{ SuccessValue: "" }]));
    expect(result).toEqual({ txHash: "9fGkPq3Zs1", value: "1000000000" });
    expect(settleOutcome(outcome({ SuccessValue: "" })).value).toBeUndefined();
  });

  it("throws on a failed transaction", () => {
    const failure = {
      ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_STALE_PRICE" } } },
    };
    expect(() => settleOutcome(outcome({ Failure: failure }, [{ SuccessValue: b64('"100"') }]))).toThrow(TxFailureError);
  });

  it("returns the resolved zero accepted amount when a rejected FT deposit was refunded", () => {
    // ft_transfer_call → ft_on_transfer panics → ft_resolve_transfer refunds and returns "0".
    const raw = outcome({ SuccessValue: b64('"0"') }, [
      { SuccessReceiptId: "R1" },
      {
        Failure: {
          ActionError: {
            index: 0,
            kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_MIN_FIRST_DEPOSIT: 1 USDC" } },
          },
        },
      },
      { SuccessValue: b64('"0"') },
    ]);
    expect(settleOutcome(raw)).toEqual({ txHash: "9fGkPq3Zs1", value: "0" });
  });

  it("returns a successful fallback close payout despite a failed oracle receipt", () => {
    const raw = outcome({ SuccessValue: b64('"97500000"') }, [
      { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Oracle unavailable" } } } } },
      { SuccessValue: b64("false") },
      { SuccessValue: b64('"97500000"') },
    ]);
    expect(settleOutcome(raw)).toEqual({ txHash: "9fGkPq3Zs1", value: "97500000" });
  });

  it("preserves an explicit action cancellation after oracle failure", () => {
    const raw = outcome({ SuccessValue: b64("null") }, [
      { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Oracle unavailable" } } } } },
      { SuccessValue: b64("null") },
    ]);
    expect(settleOutcome(raw)).toEqual({ txHash: "9fGkPq3Zs1", value: null });
  });

  it("tolerates wallets that return no outcome", () => {
    expect(settleOutcome(undefined)).toEqual({ txHash: null, value: undefined });
  });
});
