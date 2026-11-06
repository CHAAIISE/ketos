import workerDeployment from "../../../../deployments/worker-testnet.json";
import { SIGNED_PRICE_MAX_AGE_MS, verifySignedPrices, type SignedPrices } from "@/lib/near/signed-prices";

const SUPPORTED_ASSETS: Record<string, true> = {
  BTC: true, ETH: true, NEAR: true, ZEC: true, SOL: true, AURORA: true, RHEA: true,
  DOGE: true, XRP: true, LTC: true, ADA: true, SUI: true, TRX: true, BNB: true,
  AVAX: true, LINK: true, UNI: true, AAVE: true, BCH: true, APT: true, ARB: true,
};
const CACHE_MS = 5_000;
const ATTEMPT_WINDOW_MS = 10_000;
const MAX_ATTEMPTS = 4;
const MAX_CACHE_SETS = 32;
const MAX_RESPONSE_BYTES = 16_384;
const WORKER_ORIGIN = new URL(workerDeployment.endpoint).origin;

type WorkerPrices = {
  prices: Record<string, { price: string; publish_time: number; sources: string[] }>;
  timestamp_ms: number;
  fetched_at_ms: number;
  call_id: string;
  attestation_url: string;
  signed_prices: SignedPrices;
};
type CacheEntry = { expiresAt: number; pending: boolean; value: Promise<WorkerPrices | null> };
const entries = new Map<string, CacheEntry>();
const attempts: number[] = [];
let inFlight = 0;

function requestedSymbols(request: Request): string[] | null {
  if (request.url.length > 1024) return null;
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => key !== "symbols") || params.getAll("symbols").length > 1) return null;
  const input = params.get("symbols") ?? "BTC,ETH,NEAR";
  if (input.length > 256) return null;
  const symbols = input.split(",").map((symbol) => symbol.trim().toUpperCase());
  if (!symbols.length || symbols.length > 12 || symbols.some((symbol) => !Object.hasOwn(SUPPORTED_ASSETS, symbol))) return null;
  return [...new Set(symbols)].sort();
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing worker response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Worker response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function execute(symbols: string[], paymentKey: string): Promise<WorkerPrices | null> {
  try {
    const response = await fetch(workerDeployment.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Payment-Key": paymentKey, "X-Compute-Limit": "10000" },
      body: JSON.stringify({
        input: { command: "signed_prices", assets: symbols },
        version_key: workerDeployment.wasm_sha256,
        secrets_ref: workerDeployment.signed_prices.secrets_ref,
        resource_limits: { max_execution_seconds: 8 },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const result = await boundedJson(response);
    if (!result || typeof result !== "object" || !("status" in result) || result.status !== "completed"
      || !("output" in result) || !("call_id" in result) || typeof result.call_id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.call_id)
      || !("attestation_url" in result) || typeof result.attestation_url !== "string") return null;
    // Use the execution's supplied evidence link, never the manifest's key-generation attestation.
    const attestation = new URL(result.attestation_url, WORKER_ORIGIN);
    if (attestation.origin !== WORKER_ORIGIN || attestation.username || attestation.password
      || attestation.pathname !== `/attestations/by-call/${result.call_id}` || attestation.search || attestation.hash) return null;
    const output: unknown = typeof result.output === "string" ? JSON.parse(result.output) : result.output;
    const signed = verifySignedPrices(output, workerDeployment.price_signer, symbols);
    if (!signed) return null;
    const { prices } = JSON.parse(signed.payload) as Pick<WorkerPrices, "prices">;
    if (Object.keys(prices).length !== symbols.length) return null;
    return {
      prices,
      timestamp_ms: Math.min(...Object.values(prices).map((price) => price.publish_time * 1000)),
      fetched_at_ms: Date.now(),
      call_id: result.call_id,
      attestation_url: attestation.href,
      signed_prices: signed,
    };
  } catch {
    // Upstream bodies and exceptions can contain payment credentials; do not expose or log them.
    return null;
  }
}

function unavailable(status = 503) {
  return Response.json({ error: status === 429 ? "Worker price request limit reached" : "Worker prices unavailable" }, {
    status,
    headers: { "Cache-Control": "no-store", "Retry-After": status === 429 ? "10" : "5" },
  });
}

/** Public reads are coalesced and paid attempts (including failures) are capped per server instance. */
export async function GET(request: Request) {
  const symbols = requestedSymbols(request);
  if (!symbols) return Response.json({ error: "Request 1–12 supported symbols in the symbols query parameter" }, {
    status: 400, headers: { "Cache-Control": "no-store" },
  });
  const paymentKey = process.env.OUTLAYER_PAYMENT_KEY?.trim();
  if (!paymentKey) return unavailable();
  const now = Date.now();
  for (const [key, entry] of entries) {
    if (!entry.pending && entry.expiresAt <= now) entries.delete(key);
  }
  while (attempts.length && attempts[0] <= now - ATTEMPT_WINDOW_MS) attempts.shift();
  const key = symbols.join(",");
  let entry = entries.get(key);
  if (!entry) {
    if (attempts.length >= MAX_ATTEMPTS || inFlight >= MAX_ATTEMPTS || entries.size >= MAX_CACHE_SETS) return unavailable(429);
    attempts.push(now);
    inFlight++;
    entry = { expiresAt: now + CACHE_MS, pending: true, value: execute(symbols, paymentKey) };
    entries.set(key, entry);
    const value = await entry.value;
    inFlight--;
    entry.pending = false;
    entry.expiresAt = value
      ? Math.min(Date.now() + CACHE_MS, value.timestamp_ms + SIGNED_PRICE_MAX_AGE_MS)
      : Date.now() + CACHE_MS;
  }
  const value = await entry.value;
  if (!value || entry.expiresAt <= Date.now()
    || !verifySignedPrices(value.signed_prices, workerDeployment.price_signer, symbols)) return unavailable();
  const maxAge = Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000));
  return Response.json(value, { headers: { "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}` } });
}
