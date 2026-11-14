import { z } from "zod";
import { hedgeFillSchema, type HedgeRecord } from "./types";

const outcomeSchema = z.object({
  executor_id: z.string(), tokens_burnt: z.string().regex(/^[0-9]+$/).transform(BigInt),
  status: z.record(z.string(), z.unknown()), logs: z.array(z.string()),
});
const transactionSchema = z.object({
  final_execution_status: z.literal("FINAL"),
  status: z.object({ SuccessValue: z.string() }),
  transaction: z.object({ hash: z.string(), receiver_id: z.string(), signer_id: z.string(),
    actions: z.array(z.object({ FunctionCall: z.object({ method_name: z.string(), args: z.string() }) })).length(1),
  }),
  transaction_outcome: z.object({ outcome: outcomeSchema }),
  receipts_outcome: z.array(z.object({ id: z.string(), outcome: outcomeSchema })),
});
export type HedgeEvidence = { transactionHash: string; receiptId: string; gasCostYocto: bigint; latencyMs: number };

/** A keeper-supplied hash alone is never a verified fill. Match the custody event and controller authorization. */
export function verifyHedgeEvidence(raw: unknown, record: HedgeRecord,
  controller: string, keeper: string, custody: string): HedgeEvidence {
  const outcome = transactionSchema.parse(raw);
  const transaction = outcome.transaction;
  if (transaction.hash !== record.reported_transaction_hash || transaction.receiver_id !== controller || transaction.signer_id !== keeper) {
    throw new Error("Hedge transaction identity mismatch");
  }
  const action = transaction.actions[0].FunctionCall;
  if (!["rebalance_hedge", "recover_hedge"].includes(action.method_name)) throw new Error("Not a hedge execution transaction");
  const args = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(action.args), (c) => c.charCodeAt(0)))) as { nonce?: number };
  if (args.nonce !== record.fill.nonce) throw new Error("Hedge authorization nonce mismatch");
  const receipts = outcome.receipts_outcome;
  if ([outcome.transaction_outcome, ...receipts].some(({ outcome: receipt }) => "Failure" in receipt.status ||
      (!("SuccessValue" in receipt.status) && !("SuccessReceiptId" in receipt.status)))) {
    throw new Error("Hedge receipt chain is not completely successful");
  }
  for (const receipt of receipts) {
    if (receipt.outcome.executor_id !== custody) continue;
    for (const line of receipt.outcome.logs) {
      if (!line.startsWith("EVENT_JSON:")) continue;
      let event: { standard?: string; version?: string; event?: string; data?: unknown[] };
      try { event = JSON.parse(line.slice(11)); } catch { continue; }
      if (event.standard !== "ketos_hedge" || event.version !== "1.0.0" || event.event !== "fill" || !Array.isArray(event.data)) continue;
      for (const entry of event.data) {
        const fill = hedgeFillSchema.safeParse(entry);
        if (!fill.success || Object.entries(record.fill).some(([key, value]) => fill.data[key as keyof typeof fill.data] !== value)) continue;
        return { transactionHash: transaction.hash, receiptId: receipt.id,
          gasCostYocto: [outcome.transaction_outcome, ...receipts].reduce((total, item) => total + item.outcome.tokens_burnt, 0n),
          latencyMs: fill.data.confirmed_at_ms - fill.data.started_at_ms };
      }
    }
  }
  throw new Error("No matching custody fill event in this transaction");
}
