import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { JsonRpcProvider, KeyType, PublicKey } from "near-api-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AMBIGUOUS_HOLD_MS, SignedPriceCache } from "./signed-prices-server";
import { KeeperPriceFeed } from "../keeper/price-feed";
import { signedPriceAssets, signedPricesFor, verifySignedObservations, verifySignedPrices, type SignedPrices } from "./signed-prices";

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
    const prices = envelope(["ETH"], 0, ["coinbase", "bitstamp"]);
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

  it("keeps fresh observations independently without authorizing an incomplete user action", () => {
    const original = envelope(["BTC", "ETH"]);
    const payload = JSON.parse(original.payload);
    payload.prices.ETH.publish_time -= 16;
    const bytes = JSON.stringify(payload);
    const prices = { ...original, payload: bytes, signature: sign(null, Buffer.from(bytes), privateKey).toString("base64") };
    expect(verifySignedObservations(prices, publicKey, ["BTC", "ETH"], NOW)).toEqual({
      signedPrices: prices, assets: ["BTC"],
    });
    expect(verifySignedPrices(prices, publicKey, ["BTC", "ETH"], NOW)).toBeNull();
    expect(verifySignedObservations({ ...prices, payload: bytes.replace("12300000000", "12300000001") },
      publicKey, ["BTC", "ETH"], NOW)).toBeNull();
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

  it("polls a queued browser job, reuses only a just-observed batch, and rejects stale deliveries", async () => {
    vi.spyOn(JsonRpcProvider.prototype, "callFunction").mockResolvedValue(publicKey);
    const callId = "3a7e3ff9-0dce-4568-b477-e34204d7f60e";
    let prices = envelope(["ETH"], -90_000);
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (!body.callId || Date.now() < NOW + 90_000) return Response.json({ status: "pending", callId }, { status: 202 });
      return Response.json(prices);
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = { kind: "markets" as const, markets: ["ETH"] };
    const fresh = signedPricesFor(contracts, request);
    await vi.advanceTimersByTimeAsync(91_000);
    expect(await fresh).toEqual(prices);
    expect(fetchMock.mock.calls.filter(([, init]) => !JSON.parse(String(init?.body)).callId)).toHaveLength(1);
    const calls = fetchMock.mock.calls.length;
    expect(await signedPricesFor(contracts, request)).toEqual(prices);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    vi.setSystemTime(Date.now() + 8_000);
    prices = envelope(["ETH"], -60_000);
    const stale = signedPricesFor(contracts, request);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await stale).toBeNull();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
  });
});

describe("signed-price paid execution cache", () => {
  beforeEach(() => vi.stubEnv("OUTLAYER_PAYMENT_KEY", "unit-test-payment-key"));

  it("accepts freshly observed prices after dispatch delay but rejects prices aged during delivery", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    vi.stubGlobal("fetch", vi.fn((_input, init) => new Promise<Response>((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
      setTimeout(() => {
        const original = envelope(["BTC", "ETH"]);
        const payload = JSON.parse(original.payload);
        payload.prices.BTC.publish_time += 20;
        const bytes = JSON.stringify(payload);
        resolve(Response.json({ status: "completed", output: {
          ...original, payload: bytes, signature: sign(null, Buffer.from(bytes), privateKey).toString("base64"),
        } }));
      }, 20_000);
    })));
    const request = new SignedPriceCache().available(["BTC", "ETH"], publicKey);
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await request;
    expect(result?.assets).toEqual(["BTC"]);
    expect(verifySignedPrices(result?.signedPrices, publicKey, ["BTC", "ETH"], Date.now())).toBeNull();
  });

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

  it("does not cache failures, wrong signatures, or observations for unrequested assets", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: "failed", error: "secret upstream error" }))
      .mockResolvedValueOnce(Response.json({ status: "completed", output: envelope(["BTC"]) }))
      .mockResolvedValueOnce(Response.json({ status: "completed", output: { ...envelope(), signature: "A".repeat(86) + "==" } }))
      .mockResolvedValueOnce(Response.json({ status: "completed", output: JSON.stringify(envelope()) }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new SignedPriceCache();
    for (let i = 0; i < 3; i++) expect(await cache.get(["ETH"], publicKey)).toBeNull();
    expect(await cache.get(["ETH"], publicKey)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("shares a paid partial result without billing again or letting it authorize the missing asset", async () => {
    const prices = envelope(["BTC"], 12_000);
    const fetchMock = vi.fn(async () => Response.json({ status: "completed", output: prices }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new SignedPriceCache();
    expect(await cache.get(["BTC", "ETH"], publicKey)).toBeNull();
    expect(await cache.available(["BTC", "ETH"], publicKey)).toEqual({ signedPrices: prices, assets: ["BTC"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 4_000);
    expect(await cache.available(["BTC", "ETH"], publicKey)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resumes a billed asynchronous job after a local deadline instead of buying another", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    let submissions = 0;
    const fetchMock = vi.fn(async (_input, init) => {
      if (init.method === "POST") {
        submissions++;
        return Response.json({ status: "pending", call_id: "accepted-price-job" });
      }
      return Response.json(Date.now() < NOW + 60_000
        ? { status: "pending" }
        : { status: "completed", output: envelope(["BTC", "ETH"], NOW - Date.now()) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const cache = new SignedPriceCache();
    const first = cache.get(["ETH", "BTC"], publicKey);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await first).toBeNull();
    const resumed = cache.get(["BTC", "ETH", "BTC"], publicKey);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await resumed).toEqual(envelope(["BTC", "ETH"], -60_000));
    expect(submissions).toBe(1);
  });

  it("retains an accepted job through a failed result lookup", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: "pending", call_id: "accepted-price-job" }))
      .mockRejectedValueOnce(new Error("result transport unavailable"))
      .mockResolvedValueOnce(Response.json({ status: "completed", output: envelope() }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new SignedPriceCache();
    const first = cache.get(["ETH"], publicKey);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toBeNull();
    const resumed = cache.get(["ETH"], publicKey);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await resumed).toEqual(envelope());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("holds an ambiguous submission, then resubmits only when the ledger shows no billed call", async () => {
    vi.stubEnv("OUTLAYER_PAYMENT_KEY", "owner.testnet:2:secret");
    const fresh = envelope(["ETH"], -(AMBIGUOUS_HOLD_MS + 1));
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("connection lost after submission"))
      .mockResolvedValueOnce(Response.json({ usage: [
        { call_id: "older-call", project_id: "ketos.testnet/ketos-prices", created_at: new Date(NOW - 60_000).toISOString() },
      ] }))
      .mockResolvedValueOnce(Response.json({ status: "completed", output: fresh }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new SignedPriceCache();
    expect(await cache.get(["ETH"], publicKey)).toBeNull();
    vi.setSystemTime(NOW + AMBIGUOUS_HOLD_MS - 1);
    expect(await cache.get(["ETH"], publicKey)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + AMBIGUOUS_HOLD_MS + 1);
    expect(await cache.get(["ETH"], publicKey)).toEqual(fresh);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/public/payment-keys/owner.testnet/2/usage");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });

  it("resumes a ledger-matched ambiguous submission instead of charging again", async () => {
    vi.stubEnv("OUTLAYER_PAYMENT_KEY", "owner.testnet:2:secret");
    const fresh = envelope(["ETH"], -(AMBIGUOUS_HOLD_MS + 1_000));
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("connection lost after submission"))
      .mockResolvedValueOnce(Response.json({ usage: [
        { call_id: "billed-call", project_id: "ketos.testnet/ketos-prices", created_at: new Date(NOW + 500).toISOString() },
      ] }))
      .mockResolvedValueOnce(Response.json({ status: "completed", output: fresh }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new SignedPriceCache();
    expect(await cache.get(["ETH"], publicKey)).toBeNull();
    vi.setSystemTime(NOW + AMBIGUOUS_HOLD_MS);
    const resumed = cache.get(["ETH"], publicKey);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await resumed).toEqual(fresh);
    expect(String(fetchMock.mock.calls[2][0])).toContain("/calls/billed-call");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("keeps the hold when the ledger cannot be read", async () => {
    vi.stubEnv("OUTLAYER_PAYMENT_KEY", "owner.testnet:2:secret");
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("connection lost after submission"))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new SignedPriceCache();
    expect(await cache.get(["ETH"], publicKey)).toBeNull();
    vi.setSystemTime(NOW + AMBIGUOUS_HOLD_MS);
    expect(await cache.get(["ETH"], publicKey)).toBeNull();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("allows another submission after an explicit pre-dispatch rejection", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ status: "completed", output: envelope() }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new SignedPriceCache();
    expect(await cache.get(["ETH"], publicKey)).toBeNull();
    expect(await cache.get(["ETH"], publicKey)).toEqual(envelope());
  });

  it("recovers after an insufficient-credit rejection and top-up without restarting the cache", async () => {
    const replenishedQuote = envelope(["ETH"], -60_000);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "insufficient_balance" }, { status: 402 }))
      .mockResolvedValueOnce(Response.json({ status: "completed", output: replenishedQuote }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new SignedPriceCache();
    expect(await cache.get(["ETH"], publicKey)).toBeNull();
    vi.setSystemTime(NOW + 60_000);
    expect(await cache.get(["ETH"], publicKey)).toEqual(replenishedQuote);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

describe("continuous keeper price acquisition", () => {
  it("wakes for a usable observation before the regular tick would expire it, without repurchasing", async () => {
    const quote = envelope(["ETH"], 8_000);
    const load = vi.fn(() => new Promise<SignedPrices>((resolve) => setTimeout(() => resolve(quote), 2_000)));
    const feed = new KeeperPriceFeed(load);
    const signal = new AbortController().signal;
    const revision = feed.revision;
    feed.request(["ETH"], publicKey);
    let resumedAt: number | undefined;
    const waiting = feed.waitForUpdate(revision, 10_000, signal).then(() => { resumedAt = Date.now(); });
    await vi.advanceTimersByTimeAsync(2_000);
    await waiting;
    expect(resumedAt).toBe(NOW + 2_000);
    expect(feed.get(["ETH"], publicKey)).toEqual(quote);
    expect(verifySignedPrices(quote, publicKey, ["ETH"], NOW + 10_000)).toBeNull();
    // The quote can also arrive while the caller is still executing its prior cycle.
    let remembered = false;
    void feed.waitForUpdate(revision, 8_000, signal).then(() => { remembered = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(remembered).toBe(true);
    feed.request(["ETH"], publicKey);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    await feed.close();
  });

  it("does not wake for expired observations and releases an idle wait on shutdown", async () => {
    const feed = new KeeperPriceFeed(async () => envelope(["ETH"], 15_001));
    const revision = feed.revision;
    let resumed = false;
    const waiting = feed.waitForUpdate(revision, 10_000, new AbortController().signal)
      .then(() => { resumed = true; });
    feed.request(["ETH"], publicKey);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(resumed).toBe(false);
    expect(feed.available(["ETH"], publicKey)).toEqual([]);
    await feed.close();
    await waiting;
    expect(resumed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces pending canonical sets while bounding independent acquisitions", async () => {
    const load = vi.fn((assets: string[]) => new Promise<SignedPrices>((resolve) =>
      setTimeout(() => resolve(envelope(assets, NOW - Date.now())), 45_000)));
    const feed = new KeeperPriceFeed(load);
    feed.request(["ETH"], publicKey);
    await vi.advanceTimersByTimeAsync(10_000);
    feed.request(["ETH", "ETH"], publicKey);
    for (const asset of ["BTC", "SOL", "NEAR", "AAVE"]) feed.request([asset], publicKey);
    feed.request(["DOGE"], publicKey);
    await vi.advanceTimersByTimeAsync(0);
    expect(load.mock.calls.map(([assets]) => assets)).toEqual([["ETH"], ["BTC"], ["SOL"], ["NEAR"], ["AAVE"]]);
    expect(feed.available(["ETH"], publicKey)).toEqual([]);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(feed.get(["ETH"], publicKey)).toEqual(envelope(["ETH"], -45_000));
    const closed = feed.close();
    await vi.advanceTimersByTimeAsync(10_000);
    await closed;
  });

  it("paces canonical asset sets even when the worker responds immediately", async () => {
    const load = vi.fn(async () => envelope(["BTC", "ETH"]));
    const feed = new KeeperPriceFeed(load);
    feed.request(["ETH", "BTC"], publicKey);
    await vi.advanceTimersByTimeAsync(9_999);
    feed.request(["BTC", "ETH", "BTC"], publicKey);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    feed.request(["BTC", "ETH"], publicKey);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    await feed.close();
  });

  it("never renews source freshness when an old response arrives late", async () => {
    const delayed = Promise.withResolvers<SignedPrices>();
    const load = vi.fn().mockResolvedValueOnce(envelope()).mockReturnValueOnce(delayed.promise);
    const feed = new KeeperPriceFeed(load);
    feed.request(["ETH"], publicKey);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(feed.get(["ETH"], publicKey)).toEqual(envelope());
    feed.request(["ETH"], publicKey);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(feed.get(["ETH"], publicKey)).toBeNull();
    delayed.resolve(envelope());
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.available(["ETH"], publicKey)).toEqual([]);
    await feed.close();
  });

  it("selects newest observations across out-of-order partial responses without combining signatures", async () => {
    const delayed = Promise.withResolvers<SignedPrices>();
    const newer = envelope(["BTC"], -10_000);
    const older = envelope(["BTC", "ETH"]);
    const load = vi.fn().mockReturnValueOnce(delayed.promise).mockResolvedValueOnce(newer);
    const feed = new KeeperPriceFeed(load);
    feed.request(["BTC", "ETH"], publicKey);
    await vi.advanceTimersByTimeAsync(10_000);
    feed.request(["BTC"], publicKey);
    await vi.advanceTimersByTimeAsync(1_000);
    delayed.resolve(older);
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.available(["BTC", "ETH"], publicKey)).toEqual([
      { signedPrices: newer, assets: ["BTC"] },
      { signedPrices: older, assets: ["ETH"] },
    ]);
    expect(feed.get(["BTC", "ETH"], publicKey)).toEqual(older);
    expect(feed.get(["BTC", "ETH"], "ed25519:11111111111111111111111111111111")).toBeNull();
    await feed.close();
  });

  it("drains existing acquisition on shutdown without starting more paid requests", async () => {
    const delayed = Promise.withResolvers<SignedPrices>();
    const load = vi.fn(() => delayed.promise);
    const feed = new KeeperPriceFeed(load);
    feed.request(["ETH"], publicKey);
    await vi.advanceTimersByTimeAsync(0);
    let drained = false;
    const closing = feed.close().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(10_000);
    feed.request(["BTC"], publicKey);
    expect(drained).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    delayed.resolve(envelope());
    await closing;
    expect(drained).toBe(true);
    feed.request(["ETH"], publicKey);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
