import { z } from "zod";

/** A function call, in the one shape both wallet implementations convert from. */
export interface FunctionCall {
  methodName: string;
  args: Record<string, unknown>;
  /** Gas units. */
  gas: bigint;
  /** Attached deposit, yoctoNEAR. */
  deposit: bigint;
}

export interface NearTransaction {
  receiverId: string;
  actions: FunctionCall[];
}

export interface TxResult {
  /** Null when the wallet did not report the outcome. */
  txHash: string | null;
  /** JSON-decoded return value of the called method, undefined when there is none. */
  value: unknown;
}

/** Raised when a transaction or one of its receipts failed; `failure` is the RPC error JSON. */
export class TxFailureError extends Error {
  constructor(
    readonly failure: unknown,
    readonly txHash: string | null,
  ) {
    super(`Transaction failed: ${JSON.stringify(failure)}`);
    this.name = "TxFailureError";
  }
}

const statusSchema = z
  .object({ SuccessValue: z.string().optional(), Failure: z.unknown().optional() })
  .loose();

const outcomeSchema = z
  .object({
    status: z.union([statusSchema, z.string()]).optional(),
    transaction: z.object({ hash: z.string().optional() }).loose().optional(),
    transaction_outcome: z.object({ id: z.string().optional() }).loose().optional(),
    receipts_outcome: z
      .array(z.object({ outcome: z.object({ status: z.union([statusSchema, z.string()]) }).loose() }).loose())
      .optional(),
  })
  .loose();

function decodeSuccessValue(base64: string): unknown {
  if (!base64) return undefined;
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Decodes the final execution result. Oracle failures can be recovered by an action callback,
 * and rejected FT receiver calls by the token resolver, so final success takes precedence over
 * intermediate receipt failures. Callers interpret null cancellations and refunded FT amounts.
 */
export function settleOutcome(raw: unknown): TxResult {
  const parsed = outcomeSchema.safeParse(raw);
  if (raw == null || !parsed.success) return { txHash: null, value: undefined };
  const outcome = parsed.data;
  const txHash = outcome.transaction?.hash ?? outcome.transaction_outcome?.id ?? null;

  const status = typeof outcome.status === "object" ? outcome.status : undefined;
  if (status?.Failure !== undefined) throw new TxFailureError(status.Failure, txHash);
  if (status?.SuccessValue !== undefined) {
    return { txHash, value: decodeSuccessValue(status.SuccessValue) };
  }
  for (const receipt of outcome.receipts_outcome ?? []) {
    const receiptStatus = receipt.outcome.status;
    if (typeof receiptStatus === "object" && receiptStatus.Failure !== undefined) {
      throw new TxFailureError(receiptStatus.Failure, txHash);
    }
  }
  return { txHash, value: undefined };
}
