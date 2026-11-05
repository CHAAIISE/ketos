import workerDeployment from "../../../deployments/worker-testnet.json";
import { signedPriceAssets, verifySignedPrices, type SignedPrices } from "./signed-prices";

const WORKER_URL = "https://testnet-api.outlayer.ai/call/ketos.testnet/ketos-prices";
const CACHE_MS = 5_000;
const MAX_CACHE_SETS = 32;

/** Short single-flight cache, keyed by canonical symbol set and the onchain trust anchor. */
export class SignedPriceCache {
  private readonly entries = new Map<string, { atMs: number; pending: boolean; value: Promise<SignedPrices | null> }>();

  async get(input: unknown, signer: string): Promise<SignedPrices | null> {
    const assets = signedPriceAssets(input);
    const paymentKey = process.env.OUTLAYER_PAYMENT_KEY?.trim();
    if (!assets || !paymentKey) return null;
    const nowMs = Date.now();
    const key = JSON.stringify([signer, assets]);
    for (const [entryKey, entry] of this.entries) {
      if (!entry.pending && nowMs - entry.atMs >= CACHE_MS) this.entries.delete(entryKey);
    }
    const cached = this.entries.get(key);
    if (cached) return verifySignedPrices(await cached.value, signer, assets);
    if (this.entries.size >= MAX_CACHE_SETS) {
      // Bound in-flight paid executions as well as completed cache entries.
      return null;
    }
    const entry = { atMs: nowMs, pending: true, value: this.fetch(assets, signer, paymentKey) };
    this.entries.set(key, entry);
    const value = await entry.value;
    entry.pending = false;
    if ((!value || Date.now() - entry.atMs >= CACHE_MS) && this.entries.get(key) === entry) this.entries.delete(key);
    return value;
  }

  private async fetch(assets: string[], signer: string, paymentKey: string): Promise<SignedPrices | null> {
    try {
      const response = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Payment-Key": paymentKey },
        body: JSON.stringify({
          input: { command: "signed_prices", assets },
          version_key: workerDeployment.wasm_sha256,
          secrets_ref: { profile: "price-signing", account_id: "ketos.testnet" },
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return null;
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("status" in result) || result.status !== "completed" || !("output" in result)) return null;
      const output: unknown = typeof result.output === "string" ? JSON.parse(result.output) : result.output;
      return verifySignedPrices(output, signer, assets);
    } catch {
      // Never expose upstream error bodies, request headers, or server credentials.
      return null;
    }
  }
}

const cache = new SignedPriceCache();
export const workerSignedPrices = (assets: string[], signer: string) => cache.get(assets, signer);
