import { describe, expect, it, vi } from "vitest";
import noLiquidity from "./fixtures/quote-no-liquidity.json";
import quoteOk from "./fixtures/quote-ok.json";
import tokens from "./fixtures/tokens.json";
import {
  dryQuote,
  getTokens,
  grossImpactBps,
  impactBps,
  ONECLICK_BASE,
  OneClickError,
  ORIGIN_ASSETS,
  USDC_NEAR_ASSET_ID,
  type FetchImpl,
} from "./oneclick";

function respond(status: number, body: unknown) {
  return vi.fn<FetchImpl>(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

const quoteParams = { originAsset: ORIGIN_ASSETS.NEAR, amountIn: quoteOk.quote.amountIn };

describe("impactBps", () => {
  it("subtracts the platform fee from the gross impact", () => {
    expect(grossImpactBps(10_000, 9_880)).toBe(120);
    expect(impactBps(10_000, 9_880, 20)).toBe(100);
    expect(impactBps(10_000, 9_880, 25)).toBe(95);
  });

  it("rounds a fractional gross impact up against the trader", () => {
    expect(grossImpactBps(1_000, 998.464277501783)).toBe(16);
    expect(impactBps(1_000, 989.99, 20)).toBe(81);
  });

  it("does not round float noise up to the next basis point", () => {
    expect(grossImpactBps(0.3, 0.3 - 0.3 * 0.0012)).toBe(12);
  });

  it("floors the net impact at zero when the quote beats the fee", () => {
    expect(impactBps(1_000, 999, 20)).toBe(0);
    expect(impactBps(1_000, 1_001, 20)).toBe(0);
  });
});

describe("dryQuote", () => {
  it("parses a 201 quote and reports the partner fee when a key is set", async () => {
    const fetchImpl = respond(201, quoteOk);
    const result = await dryQuote({ ...quoteParams, jwt: "partner-key", fetchImpl });

    expect(result).toMatchObject({ status: "ok", amountInUsd: 1000.00000098, amountOutUsd: 998.464277501783, feeBps: 20 });
    if (result.status !== "ok") throw new Error("expected a quote");
    expect(grossImpactBps(result.amountInUsd, result.amountOutUsd)).toBe(16);
    expect(impactBps(result.amountInUsd, result.amountOutUsd, result.feeBps)).toBe(0);
  });

  it("sends a dry EXACT_INPUT request into USDC on NEAR with the partner key", async () => {
    const fetchImpl = respond(201, quoteOk);
    await dryQuote({ ...quoteParams, jwt: "partner-key", fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${ONECLICK_BASE}/quote`);
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("partner-key");
    expect(headers["User-Agent"]).toMatch(/^ketos-depth\//);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      dry: true,
      swapType: "EXACT_INPUT",
      originAsset: ORIGIN_ASSETS.NEAR,
      destinationAsset: USDC_NEAR_ASSET_ID,
      amount: quoteOk.quote.amountIn,
      depositType: "INTENTS",
      refundType: "INTENTS",
      recipientType: "INTENTS",
    });
    expect(Date.parse(body.deadline)).toBeGreaterThan(Date.now());
  });

  it("uses the public fee and omits the key header without a key", async () => {
    const fetchImpl = respond(201, { ...quoteOk, quote: { ...quoteOk.quote, amountInUsd: "1000", amountOutUsd: "990" } });
    const result = await dryQuote({ ...quoteParams, fetchImpl });

    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBeUndefined();
    if (result.status !== "ok") throw new Error("expected a quote");
    expect(result.feeBps).toBe(25);
    expect(impactBps(result.amountInUsd, result.amountOutUsd, result.feeBps)).toBe(75);
  });

  it("maps HTTP 400 'No liquidity available' to no_liquidity", async () => {
    await expect(dryQuote({ ...quoteParams, fetchImpl: respond(400, noLiquidity) })).resolves.toEqual({ status: "no_liquidity" });
  });

  it("throws on any other HTTP 400", async () => {
    const error = await dryQuote({ ...quoteParams, fetchImpl: respond(400, { message: "amount is too low" }) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OneClickError);
    expect((error as OneClickError).status).toBe(400);
  });

  it("throws a OneClickError carrying the status on HTTP 403", async () => {
    const error = await dryQuote({ ...quoteParams, fetchImpl: respond(403, { message: "Forbidden" }) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OneClickError);
    expect((error as OneClickError).status).toBe(403);
  });

  it("throws a OneClickError without status on network failure", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => {
      throw new TypeError("fetch failed");
    });
    const error = await dryQuote({ ...quoteParams, fetchImpl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OneClickError);
    expect((error as OneClickError).status).toBeNull();
  });

  it("rejects a 201 body without USD amounts", async () => {
    await expect(dryQuote({ ...quoteParams, fetchImpl: respond(201, { quote: { amountIn: "1" } }) })).rejects.toBeInstanceOf(OneClickError);
  });
});

describe("getTokens", () => {
  it("validates the token list and keeps extra fields", async () => {
    const list = await getTokens({ fetchImpl: respond(200, tokens) });
    const near = list.find((t) => t.assetId === ORIGIN_ASSETS.NEAR);
    expect(near).toMatchObject({ decimals: 24, blockchain: "near" });
    expect(near?.contractAddress).toBe("wrap.near");
    expect(list.map((t) => t.assetId)).toEqual(expect.arrayContaining([...Object.values(ORIGIN_ASSETS), USDC_NEAR_ASSET_ID]));
  });

  it("rejects tokens without a numeric price", async () => {
    const broken = [{ ...tokens[0], price: "3.8" }];
    await expect(getTokens({ fetchImpl: respond(200, broken) })).rejects.toBeInstanceOf(OneClickError);
  });
});
