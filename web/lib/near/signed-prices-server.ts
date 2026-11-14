import workerDeployment from "../../../deployments/worker-testnet.json";
import { signedPriceAssets, verifySignedObservations, type SignedPrices } from "./signed-prices";

const API_URL = "https://testnet-api.outlayer.ai";
const WORKER_URL = `${API_URL}/call/ketos.testnet/ketos-prices`;
const CACHE_MS = 5_000;
const MAX_CACHE_SETS = 32;
/** Covers the 45-second submission window plus ledger indexing before reconciliation. */
export const AMBIGUOUS_HOLD_MS = 120_000;

type Job = { callId: string } | { ambiguousSince: number };

/** Short single-flight cache, keyed by canonical symbol set and the onchain trust anchor. */
export class SignedPriceCache {
  private readonly entries = new Map<string, { atMs: number; pending: boolean; value: Promise<SignedPrices | null> }>();
  // A local deadline does not cancel a billed remote job. An ambiguous submission
  // is held, then reconciled against the payment-key ledger: a matching call is
  // resumed, and only a ledger without one releases the set for a new submission.
  private readonly jobs = new Map<string, Job>();

  async get(input: unknown, signer: string): Promise<SignedPrices | null> {
    const assets = signedPriceAssets(input);
    if (!assets) return null;
    const observations = await this.available(assets, signer);
    return observations?.assets.length === assets.length ? observations.signedPrices : null;
  }

  async available(input: unknown, signer: string) {
    const assets = signedPriceAssets(input);
    if (!assets) return null;
    return verifySignedObservations(await this.load(assets, signer), signer, assets);
  }

  private async load(input: unknown, signer: string): Promise<SignedPrices | null> {
    const assets = signedPriceAssets(input);
    const paymentKey = process.env.OUTLAYER_PAYMENT_KEY?.trim();
    if (!assets || !paymentKey) return null;
    const nowMs = Date.now();
    const key = JSON.stringify([signer, assets]);
    for (const [entryKey, entry] of this.entries) {
      if (!entry.pending && nowMs - entry.atMs >= CACHE_MS) this.entries.delete(entryKey);
    }
    const cached = this.entries.get(key);
    if (cached) return cached.value;
    if (this.entries.size >= MAX_CACHE_SETS) {
      // Bound in-flight paid executions as well as completed cache entries.
      return null;
    }
    if (!this.jobs.has(key) && this.jobs.size >= MAX_CACHE_SETS) return null;
    const entry = { atMs: nowMs, pending: true, value: this.fetch(assets, signer, paymentKey, key) };
    this.entries.set(key, entry);
    const value = await entry.value;
    entry.pending = false;
    if ((!value || Date.now() - entry.atMs >= CACHE_MS) && this.entries.get(key) === entry) this.entries.delete(key);
    return value;
  }

  /** Finds a call billed to this key and project inside the ambiguous submission window. */
  private async reconcile(since: number, paymentKey: string, signal: AbortSignal): Promise<string | null | undefined> {
    const [owner, nonce] = paymentKey.split(":");
    if (!owner || !nonce) return undefined;
    const response = await fetch(
      `${API_URL}/public/payment-keys/${encodeURIComponent(owner)}/${encodeURIComponent(nonce)}/usage?limit=20&offset=0`,
      { signal },
    );
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("usage" in body) || !Array.isArray(body.usage)) return undefined;
    for (const entry of body.usage as unknown[]) {
      if (!entry || typeof entry !== "object") continue;
      const { call_id: callId, project_id: project, created_at: createdAt } = entry as Record<string, unknown>;
      if (typeof callId !== "string" || project !== "ketos.testnet/ketos-prices" || typeof createdAt !== "string") continue;
      const at = Date.parse(createdAt);
      if (at >= since - 5_000 && at <= since + 50_000) return callId;
    }
    return null;
  }

  private async fetch(assets: string[], signer: string, paymentKey: string, key: string): Promise<SignedPrices | null> {
    const signal = AbortSignal.timeout(45_000);
    const headers = { "Content-Type": "application/json", "X-Payment-Key": paymentKey };
    try {
      let result: unknown;
      const job = this.jobs.get(key);
      let callId = job && "callId" in job ? job.callId : undefined;
      if (job && "ambiguousSince" in job) {
        if (Date.now() - job.ambiguousSince < AMBIGUOUS_HOLD_MS) return null;
        const found = await this.reconcile(job.ambiguousSince, paymentKey, signal);
        if (found === undefined) return null;
        if (found === null) this.jobs.delete(key);
        else {
          callId = found;
          this.jobs.set(key, { callId });
        }
      }
      if (!this.jobs.has(key)) {
        this.jobs.set(key, { ambiguousSince: Date.now() });
        const response = await fetch(WORKER_URL, {
          method: "POST", headers, signal,
          body: JSON.stringify({
            async: true,
            input: { command: "signed_prices", assets },
            version_key: workerDeployment.wasm_sha256,
            secrets_ref: { profile: "price-signing", account_id: "ketos.testnet" },
          }),
        });
        if (!response.ok) {
          // Documented pre-dispatch failures cannot have bought an execution.
          if ([400, 401, 402, 403, 404, 422, 429, 503].includes(response.status)) this.jobs.delete(key);
          return null;
        }
        result = await response.json();
        if (result && typeof result === "object" && "call_id" in result && typeof result.call_id === "string") {
          callId = result.call_id;
          this.jobs.set(key, { callId });
        }
      } else {
        if (!callId) return null;
        result = { status: "pending" };
      }
      while (!signal.aborted) {
        if (!result || typeof result !== "object" || !("status" in result)) return null;
        if (result.status === "completed" || result.status === "failed") {
          this.jobs.delete(key);
          if (result.status !== "completed" || !("output" in result)) return null;
          const output: unknown = typeof result.output === "string" ? JSON.parse(result.output) : result.output;
          return verifySignedObservations(output, signer, assets)?.signedPrices ?? null;
        }
        if (result.status !== "pending" || !callId) return null;
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        if (signal.aborted) return null;
        const response = await fetch(`https://testnet-api.outlayer.ai/calls/${encodeURIComponent(callId)}`, {
          headers, signal,
        });
        if (!response.ok) return null;
        result = await response.json();
      }
      return null;
    } catch {
      // Never expose upstream error bodies, request headers, or server credentials.
      return null;
    }
  }
}

const cache = new SignedPriceCache();
export const workerSignedPrices = (assets: string[], signer: string) => cache.get(assets, signer);
export const workerSignedObservations = (assets: string[], signer: string) => cache.available(assets, signer);

const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SignedPriceJob = { status: "pending"; callId: string } | { status: "completed"; prices: SignedPrices } | null;

function jobResult(result: unknown, callId: string, signer: string, assets: string[]): SignedPriceJob {
  if (!result || typeof result !== "object" || !("status" in result)) return null;
  if (result.status === "pending") return { status: "pending", callId };
  if (result.status !== "completed" || !("output" in result)) return null;
  const output: unknown = typeof result.output === "string" ? JSON.parse(result.output) : result.output;
  const prices = verifySignedObservations(output, signer, assets);
  return prices?.assets.length === assets.length ? { status: "completed", prices: prices.signedPrices } : null;
}

/**
 * Starts one paid asynchronous execution and returns its call ID immediately, so a
 * browser can wait out provider queueing without a serverless deadline buying a
 * replacement job. Freshness is still enforced on the returned observation.
 */
export async function submitSignedPriceJob(input: unknown, signer: string): Promise<SignedPriceJob> {
  const assets = signedPriceAssets(input);
  const paymentKey = process.env.OUTLAYER_PAYMENT_KEY?.trim();
  if (!assets || !paymentKey) return null;
  try {
    const response = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Payment-Key": paymentKey },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        async: true,
        input: { command: "signed_prices", assets },
        version_key: workerDeployment.wasm_sha256,
        secrets_ref: { profile: "price-signing", account_id: "ketos.testnet" },
      }),
    });
    if (!response.ok) return null;
    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || !("call_id" in result) || typeof result.call_id !== "string") return null;
    return CALL_ID.test(result.call_id) ? jobResult(result, result.call_id, signer, assets) : null;
  } catch {
    return null;
  }
}

/** Reads an existing execution; never submits or pays for another one. */
export async function pollSignedPriceJob(callId: unknown, input: unknown, signer: string): Promise<SignedPriceJob> {
  const assets = signedPriceAssets(input);
  const paymentKey = process.env.OUTLAYER_PAYMENT_KEY?.trim();
  if (!assets || !paymentKey || typeof callId !== "string" || !CALL_ID.test(callId)) return null;
  try {
    const response = await fetch(`${API_URL}/calls/${callId}`, {
      headers: { "X-Payment-Key": paymentKey },
      signal: AbortSignal.timeout(10_000),
    });
    // A failed lookup says nothing about the accepted job: keep waiting, never resubmit.
    if (!response.ok) return response.status >= 500 ? { status: "pending", callId } : null;
    return jobResult(await response.json(), callId, signer, assets);
  } catch {
    return { status: "pending", callId };
  }
}
