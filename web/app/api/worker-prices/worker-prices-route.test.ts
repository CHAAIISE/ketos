import { createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { KeyType, PublicKey } from "near-api-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signer = vi.hoisted(() => ({ publicKey: "" }));
vi.mock("../../../../deployments/worker-testnet.json", async (importOriginal) => {
  const original = await importOriginal<{ default: Record<string, unknown> }>();
  return { default: { ...original.default, price_signer: signer.publicKey } };
});

// Deterministic test-only signing key; the production route only verifies TEE signatures.
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]),
  format: "der", type: "pkcs8",
});
signer.publicKey = new PublicKey({
  keyType: KeyType.ED25519,
  data: new Uint8Array(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32)),
}).toString();
const NOW = 1_790_000_000_000;
const CALL_ID = "550e8400-e29b-41d4-a716-446655440000";
const ATTESTATION_PATH = `/attestations/by-call/${CALL_ID}`;
const ORIGIN = "https://testnet-api.outlayer.ai";
let paymentKey: string;

function envelope(symbols = ["ETH"], publishedAt = NOW, sources = ["coinbase", "kraken"]) {
  const payload = JSON.stringify({
    domain: "ketos:prices:v1",
    prices: Object.fromEntries(symbols.map((symbol) => [symbol, {
      price: "12300000000", publish_time: Math.floor(publishedAt / 1000), sources,
    }])),
  });
  return { payload, signature: sign(null, Buffer.from(payload), privateKey).toString("base64"), public_key: signer.publicKey };
}

function completed(symbols = ["ETH"], overrides: Record<string, unknown> = {}) {
  return {
    status: "completed", call_id: CALL_ID, attestation_url: ATTESTATION_PATH,
    output: envelope(symbols), ...overrides,
  };
}

function request(query = "symbols=ETH") {
  return new Request(`http://localhost/api/worker-prices${query ? `?${query}` : ""}`);
}

// Fresh module imports are intentional: each test needs isolated paid-attempt/cache state.
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  paymentKey = randomUUID();
  vi.stubEnv("OUTLAYER_PAYMENT_KEY", paymentKey);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("worker price route input and configuration", () => {
  it.each([
    "symbols=", "symbols=ETH,", "symbols=NOTREAL", "symbols=USDT", "symbols=__proto__",
    "symbols=ETH&symbols=BTC", "symbols=ETH&version_key=untrusted", "assets=ETH",
    `symbols=${Array(13).fill("ETH").join(",")}`, `symbols=${"E".repeat(257)}`,
    `symbols=${"E".repeat(1100)}`,
  ])("rejects invalid or oversized input without a paid execution: %s", async (query) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("./route");
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a safe unavailable response when the server key is absent", async () => {
    vi.stubEnv("OUTLAYER_PAYMENT_KEY", " ");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("./route");
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Worker prices unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns verified worker prices and execution evidence for canonicalized symbols without exposing payment", async () => {
    const execution = completed(["BTC", "ETH"]);
    const fetchMock = vi.fn().mockResolvedValue(Response.json(execution));
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("./route");
    const response = await GET(request("symbols=%20eth%20,btc,ETH"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      prices: JSON.parse(execution.output.payload).prices,
      timestamp_ms: NOW, fetched_at_ms: NOW, call_id: CALL_ID,
      attestation_url: `${ORIGIN}${ATTESTATION_PATH}`, signed_prices: execution.output,
    });
    expect(JSON.stringify(body)).not.toContain(paymentKey);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=5, s-maxage=5");
  });

  it("defaults to BTC, ETH, and NEAR and accepts string-encoded signed output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(completed(["BTC", "ETH", "NEAR"], {
      output: JSON.stringify(envelope(["BTC", "ETH", "NEAR"])),
    }))));
    const { GET } = await import("./route");
    const response = await GET(request(""));
    expect(response.status).toBe(200);
    expect(Object.keys((await response.json()).prices)).toEqual(["BTC", "ETH", "NEAR"]);
  });
});

describe("worker price response validation", () => {
  it.each([
    { status: "failed", error: "private execution details" },
    { status: "pending" },
    { output: "invalid JSON" },
    { output: envelope(["BTC"]) },
    { output: envelope(["ETH", "BTC"]) },
    { output: envelope(["ETH"], NOW - 16_000) },
    { output: envelope(["ETH"], NOW + 1000) },
    { output: envelope(["ETH"], NOW, ["kraken", "kraken"]) },
    { output: { ...envelope(), signature: "A".repeat(86) + "==" } },
    { output: { ...envelope(), public_key: "ed25519:11111111111111111111111111111111" } },
    { attestation_url: undefined },
    { attestation_url: "https://attacker.invalid/attestation" },
    { attestation_url: "//attacker.invalid/attestation" },
    { attestation_url: `${ATTESTATION_PATH}?secret=unexpected` },
    { attestation_url: `/attestations/by-call/${randomUUID()}` },
    { call_id: "not-a-call-id" },
  ])("fails closed for malformed, unsigned, stale, or unrelated evidence: %j", async (overrides) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(completed(["ETH"], overrides))));
    const { GET } = await import("./route");
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Worker prices unavailable" });
  });

  it.each(["http", "network", "oversized", "json"])("contains %s failures without leaking payment credentials", async (failure) => {
    const fetchMock = vi.fn();
    if (failure === "http") fetchMock.mockResolvedValue(new Response(paymentKey, { status: 401 }));
    if (failure === "network") fetchMock.mockRejectedValue(new Error(`secret ${paymentKey}`));
    if (failure === "oversized") fetchMock.mockResolvedValue(new Response("x".repeat(16_385)));
    if (failure === "json") fetchMock.mockResolvedValue(new Response("{broken"));
    vi.stubGlobal("fetch", fetchMock);
    const errorLog = vi.spyOn(console, "error");
    const { GET } = await import("./route");
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(paymentKey);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("accepts an absolute API-origin evidence URL without replacing it with manifest evidence", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(completed(["ETH"], {
      attestation_url: `${ORIGIN}${ATTESTATION_PATH}`,
    }))));
    const { GET } = await import("./route");
    expect((await (await GET(request())).json()).attestation_url).toBe(`${ORIGIN}${ATTESTATION_PATH}`);
  });
});

describe("bounded paid execution caching", () => {
  it("single-flights canonical sets and keeps source/fetch timestamps unchanged on cache hits", async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(promise).mockImplementation(async () => Response.json(completed(["BTC", "ETH"])));
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("./route");
    const first = GET(request("symbols=ETH,BTC"));
    const second = GET(request("symbols=btc,eth,btc"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(Response.json(completed(["BTC", "ETH"])));
    const [a, b] = await Promise.all([first, second]);
    const original = await a.json();
    expect(await b.json()).toEqual(original);
    vi.setSystemTime(NOW + 4000);
    const cached = await GET(request("symbols=BTC,ETH"));
    expect(await cached.json()).toEqual(original);
    expect(cached.headers.get("Cache-Control")).toBe("public, max-age=1, s-maxage=1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 5000);
    const refreshed = await GET(request("symbols=BTC,ETH"));
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).fetched_at_ms).toBe(NOW + 5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("negative-caches failed paid calls for five seconds", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ status: "failed" }))
      .mockImplementation(async () => Response.json(completed()));
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("./route");
    expect((await GET(request())).status).toBe(503);
    vi.setSystemTime(NOW + 4999);
    expect((await GET(request())).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 5000);
    expect((await GET(request())).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps attempts across distinct symbol sets even when all executions fail", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ status: "failed" }));
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("./route");
    for (const symbol of ["BTC", "ETH", "NEAR", "SOL"]) expect((await GET(request(`symbols=${symbol}`))).status).toBe(503);
    const limited = await GET(request("symbols=DOGE"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    expect(limited.headers.get("Retry-After")).toBe("10");
    vi.setSystemTime(NOW + 5000);
    expect((await GET(request("symbols=BTC"))).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.setSystemTime(NOW + 10_000);
    expect((await GET(request("symbols=DOGE"))).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("keeps the in-flight bound after the attempt window resets", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => {
      const { promise, resolve } = Promise.withResolvers<Response>();
      pending.push(resolve);
      return promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("./route");
    const requests = ["BTC", "ETH", "NEAR", "SOL"].map((symbol) => GET(request(`symbols=${symbol}`)));
    vi.setSystemTime(NOW + 10_000);
    expect((await GET(request("symbols=DOGE"))).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    pending.forEach((resolve) => resolve(Response.json({ status: "failed" })));
    await Promise.all(requests);
    expect((await GET(request("symbols=BTC"))).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("never serves a cached signature beyond its source freshness limit", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json(completed(["ETH"], {
      output: envelope(["ETH"], NOW - 14_000),
    })));
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("./route");
    const fresh = await GET(request());
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("Cache-Control")).toBe("public, max-age=1, s-maxage=1");
    vi.setSystemTime(NOW + 1001);
    expect((await GET(request())).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
