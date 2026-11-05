import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { JsonRpcProvider, KeyType, PublicKey } from "near-api-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignedPriceCache } from "./signed-prices-server";
import { signedPriceAssets, signedPricesFor, verifySignedPrices } from "./signed-prices";

// Deterministic native unit-test key only; no production prices are signed outside the TEE.
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]),
  format: "der", type: "pkcs8",
});
const publicKey = new PublicKey({
  keyType: KeyType.ED25519,
  data: new Uint8Array(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32)),
}).toString();
const NOW = 1_790_000_000_000;
const contracts = { rpcUrl: "https://rpc.test.invalid", ketosContract: "ketos.testnet", usdcContract: "usdc.ketos.testnet" };

function envelope(assets = ["ETH"], ageMs = 0, sources = ["coinbase", "kraken"]) {
  const payload = JSON.stringify({
    domain: "ketos:prices:v1",
    prices: Object.fromEntries(assets.map((asset) => [asset, {
      price: "12300000000", publish_time: Math.floor((NOW - ageMs) / 1000), sources,
    }])),
  });
  return { payload, signature: sign(null, Buffer.from(payload), privateKey).toString("base64"), public_key: publicKey };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("signed envelope verification", () => {
  it("verifies the original bytes against the pinned Ed25519 signer", () => {
    const prices = envelope();
    expect(verifySignedPrices(prices, publicKey, ["ETH"], NOW)).toEqual(prices);
    expect(verifySignedPrices({ ...prices, payload: prices.payload.replace("12300000000", "12300000001") }, publicKey, ["ETH"], NOW)).toBeNull();
    expect(verifySignedPrices(prices, "ed25519:11111111111111111111111111111111", ["ETH"], NOW)).toBeNull();
    expect(verifySignedPrices({ ...prices, signature: "A".repeat(86) + "==" }, publicKey, ["ETH"], NOW)).toBeNull();
    expect(verifySignedPrices({ ...prices, signature: prices.signature.replace(/==$/, "") }, publicKey, ["ETH"], NOW)).toBeNull();
  });

  it("requires every requested symbol, fresh seconds, and distinct approved sources", () => {
    expect(verifySignedPrices(envelope(), publicKey, ["ETH", "BTC"], NOW)).toBeNull();
    expect(verifySignedPrices(envelope(["ETH"], 15_000), publicKey, ["ETH"], NOW)).not.toBeNull();
    expect(verifySignedPrices(envelope(["ETH"], 15_000), publicKey, ["ETH"], NOW + 1)).toBeNull();
    expect(verifySignedPrices(envelope(["ETH"], -1000), publicKey, ["ETH"], NOW)).toBeNull();
    expect(verifySignedPrices(envelope(["ETH"], 0, ["kraken", "kraken"]), publicKey, ["ETH"], NOW)).toBeNull();
    expect(verifySignedPrices(envelope(["ETH"], 0, ["kraken", "unknown"]), publicKey, ["ETH"], NOW)).toBeNull();
  });

  it("canonicalizes symbols without allowing oversized or malformed paid requests", () => {
    expect(signedPriceAssets(["ETH", "BTC", "ETH"])).toEqual(["BTC", "ETH"]);
    expect(signedPriceAssets([])).toBeNull();
    expect(signedPriceAssets(Array.from({ length: 13 }, (_, i) => `ASSET${i}`))).toBeNull();
    expect(signedPriceAssets(["eth"])).toBeNull();
    expect(signedPriceAssets(["ETH/BTC"])).toBeNull();
  });

  it("falls back before external requests when the signer is absent, unreadable, or sandboxed", async () => {
    // The SDK omits null from its return type although nullable NEAR views return it.
    const absentSigner = null as unknown as Awaited<ReturnType<JsonRpcProvider["callFunction"]>>;
    const rpc = vi.spyOn(JsonRpcProvider.prototype, "callFunction").mockResolvedValue(absentSigner);
    const load = vi.fn();
    const request = { kind: "markets" as const, markets: ["ETH"] };
    expect(await signedPricesFor(contracts, request, load)).toBeNull();
    rpc.mockRejectedValueOnce(new Error("older contract method unavailable"));
    expect(await signedPricesFor(contracts, request, load)).toBeNull();
    rpc.mockClear();
    expect(await signedPricesFor({ ...contracts, network: "sandbox" }, request, load)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});

describe("signed-price paid execution cache", () => {
  beforeEach(() => vi.stubEnv("OUTLAYER_PAYMENT_KEY", "unit-test-payment-key"));

  it("coalesces canonical sets for five seconds without extending their lifetime on hits", async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: "completed", output: envelope(["BTC", "ETH"]) }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new SignedPriceCache();
    const [a, b] = await Promise.all([cache.get(["ETH", "BTC"], publicKey), cache.get(["BTC", "ETH", "BTC"], publicKey)]);
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 4999);
    expect(await cache.get(["ETH", "BTC"], publicKey)).toEqual(a);
    vi.setSystemTime(NOW + 5000);
    expect(await cache.get(["ETH", "BTC"], publicKey)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache failed, partial, or wrongly signed executions", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce(Response.json({ status: "failed", error: "secret upstream error" }))
      .mockResolvedValueOnce(Response.json({ status: "completed", output: envelope(["BTC"]) }))
      .mockResolvedValueOnce(Response.json({ status: "completed", output: { ...envelope(), signature: "A".repeat(86) + "==" } }))
      .mockResolvedValueOnce(Response.json({ status: "completed", output: JSON.stringify(envelope()) }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new SignedPriceCache();
    for (let i = 0; i < 4; i++) expect(await cache.get(["ETH"], publicKey)).toBeNull();
    expect(await cache.get(["ETH"], publicKey)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("bounds paid in-flight symbol sets and rejects invalid inputs without upstream calls", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => {
      const { promise, resolve } = Promise.withResolvers<Response>();
      pending.push(resolve);
      return promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const cache = new SignedPriceCache();
    const requests = Array.from({ length: 32 }, (_, i) => cache.get([`ASSET${i}`], publicKey));
    vi.setSystemTime(NOW + 5000);
    expect(await cache.get(["OVERFLOW"], publicKey)).toBeNull();
    expect(await cache.get(Array(13).fill("ETH"), publicKey)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(32);
    pending.forEach((resolve) => resolve(Response.json({ status: "failed" })));
    await Promise.all(requests);
    expect(await cache.get([], publicKey)).toBeNull();
    vi.stubEnv("OUTLAYER_PAYMENT_KEY", "");
    expect(await cache.get(["ETH"], publicKey)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(32);
  });
});
