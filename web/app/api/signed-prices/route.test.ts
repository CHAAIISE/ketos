import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { KeyType, PublicKey } from "near-api-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 9)]),
  format: "der", type: "pkcs8",
});
const signer = new PublicKey({
  keyType: KeyType.ED25519,
  data: new Uint8Array(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32)),
}).toString();
const NOW = 1_790_000_000_000;
const CALL = "3a7e3ff9-0dce-4568-b477-e34204d7f60e";

vi.mock("@/lib/near/config", () => ({ nearConfig: () => ({}) }));
vi.mock("@/lib/near/signed-prices", async (original) => ({
  ...await original<object>(),
  priceSigner: async () => signer,
}));

function envelope() {
  const payload = JSON.stringify({
    domain: "ketos:prices:v1",
    prices: { ETH: { price: "12300000000", publish_time: Math.floor(NOW / 1000), sources: ["coinbase", "kraken"] } },
  });
  return { payload, signature: sign(null, Buffer.from(payload), privateKey).toString("base64"), public_key: signer };
}

const post = async (body: unknown) => {
  const { POST } = await import("./route");
  return POST(new Request("http://test/api/signed-prices", { method: "POST", body: JSON.stringify(body) }));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("OUTLAYER_PAYMENT_KEY", "owner.testnet:2:secret");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("signed-price route", () => {
  it("returns an accepted job immediately, then only polls it without paying again", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: "pending", call_id: CALL }))
      .mockResolvedValueOnce(Response.json({ status: "pending" }))
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(Response.json({ status: "completed", output: JSON.stringify(envelope()) }));
    vi.stubGlobal("fetch", fetchMock);

    const submitted = await post({ assets: ["ETH"] });
    expect(submitted.status).toBe(202);
    expect(await submitted.json()).toEqual({ status: "pending", callId: CALL });
    expect((await post({ assets: ["ETH"], callId: CALL })).status).toBe(202);
    expect((await post({ assets: ["ETH"], callId: CALL })).status).toBe(202);
    const done = await post({ assets: ["ETH"], callId: CALL });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual(envelope());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(String(fetchMock.mock.calls[1][0])).toBe(`https://testnet-api.outlayer.ai/calls/${CALL}`);
  });

  it("rejects malformed call IDs and stale observations without upstream payment", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ status: "completed", output: envelope() }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await post({ assets: ["ETH"], callId: "../wallet/v1/withdraw" })).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + 15_001);
    expect((await post({ assets: ["ETH"], callId: CALL })).status).toBe(503);
  });
});
