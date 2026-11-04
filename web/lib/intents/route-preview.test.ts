import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/route-preview/route";
import noLiquidity from "./fixtures/quote-no-liquidity.json";
import routeSol from "./fixtures/quote-route-sol.json";
import { OneClickError, USDC_NEAR_ASSET_ID, type FetchImpl } from "./oneclick";
import { parseRouteQuery, quoteRoute, routePreviewSchema } from "./route-preview";

function respond(status: number, body: unknown) {
  return vi.fn<FetchImpl>(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

function query(search: string) {
  return parseRouteQuery(new URLSearchParams(search));
}

describe("parseRouteQuery", () => {
  it("converts the amount to the origin asset's base units", () => {
    expect(query("asset=SOL&amount=1")).toEqual({ ok: true, query: { asset: "SOL", amountIn: 1_000_000_000n } });
    expect(query("asset=BTC&amount=0.015")).toEqual({ ok: true, query: { asset: "BTC", amountIn: 1_500_000n } });
    expect(query("asset=ETH_BASE&amount=0.1")).toEqual({ ok: true, query: { asset: "ETH_BASE", amountIn: 100_000_000_000_000_000n } });
  });

  it.each([
    ["", "missing params"],
    ["asset=DOGE&amount=1", "an unknown asset"],
    ["asset=SOL", "a missing amount"],
    ["asset=SOL&amount=abc", "a non-numeric amount"],
    ["asset=SOL&amount=0", "a zero amount"],
    ["asset=SOL&amount=-1", "a negative amount"],
    ["asset=BTC&amount=0.000000001", "more fraction digits than the asset has"],
    [`asset=SOL&amount=${"9".repeat(41)}`, "an oversized amount"],
  ])("rejects %s (%s)", (search) => {
    const result = query(search);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^Expected \?asset=ETH_BASE\|SOL\|BTC/);
  });
});

describe("quoteRoute", () => {
  it("asks 1Click for a dry origin-chain quote into USDC on NEAR", async () => {
    const fetchImpl = respond(201, routeSol);
    await quoteRoute({ asset: "SOL", amountIn: 1_000_000_000n, fetchImpl });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      dry: true,
      swapType: "EXACT_INPUT",
      originAsset: "nep141:sol.omft.near",
      depositType: "ORIGIN_CHAIN",
      destinationAsset: USDC_NEAR_ASSET_ID,
      amount: "1000000000",
      refundType: "INTENTS",
      recipientType: "INTENTS",
    });
  });

  it("maps a quote to USDC received, route cost and time estimate", async () => {
    const preview = await quoteRoute({ asset: "SOL", amountIn: 1_000_000_000n, fetchImpl: respond(201, routeSol) });

    expect(routePreviewSchema.parse(preview)).toEqual(preview);
    expect(preview).toMatchObject({
      status: "ok",
      asset: "SOL",
      originAssetId: "nep141:sol.omft.near",
      destinationAssetId: USDC_NEAR_ASSET_ID,
      amountIn: "1000000000",
      amountInFormatted: "1",
      amountInUsd: 95.23,
      amountOut: "94981067",
      amountOutFormatted: "94.981067",
      minAmountOutFormatted: "94.03",
      amountOutUsd: 94.950483096426,
      routeCostBps: 30,
      platformFeeBps: 25,
      timeEstimateSec: 20,
    });
    if (preview.status !== "ok") throw new Error("expected a quote");
    expect(preview.routeCostUsd).toBeCloseTo(0.279517, 6);
    expect(Math.abs(Date.now() - preview.quotedAtMs)).toBeLessThan(5_000);
  });

  it("reports the partner fee when a key is set", async () => {
    const preview = await quoteRoute({ asset: "SOL", amountIn: 1_000_000_000n, jwt: "partner-key", fetchImpl: respond(201, routeSol) });
    expect(preview).toMatchObject({ status: "ok", platformFeeBps: 20 });
  });

  it("turns 'No liquidity available' into a no_liquidity preview", async () => {
    const preview = await quoteRoute({ asset: "BTC", amountIn: 100_000_000_000_000n, fetchImpl: respond(400, noLiquidity) });
    expect(routePreviewSchema.parse(preview)).toEqual(preview);
    expect(preview).toMatchObject({ status: "no_liquidity", asset: "BTC", amountInFormatted: "1,000,000", originAssetId: "nep141:btc.omft.near" });
  });

  it("throws a OneClickError on any other failure", async () => {
    await expect(quoteRoute({ asset: "SOL", amountIn: 1n, fetchImpl: respond(400, { message: "Failed to get quote" }) })).rejects.toBeInstanceOf(
      OneClickError,
    );
  });

  it("rejects a quote without a time estimate", async () => {
    const quote = { ...routeSol.quote, timeEstimate: undefined };
    await expect(
      quoteRoute({ asset: "SOL", amountIn: 1_000_000_000n, fetchImpl: respond(201, { ...routeSol, quote }) }),
    ).rejects.toBeInstanceOf(OneClickError);
  });
});

describe("GET /api/route-preview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function get(search: string) {
    return GET(new Request(`http://localhost/api/route-preview?${search}`));
  }

  it("answers 400 on bad input without calling 1Click", async () => {
    const fetchImpl = respond(201, routeSol);
    vi.stubGlobal("fetch", fetchImpl);
    const res = await get("asset=SOL&amount=1.0000000001");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/amount/) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("serves a quote and caches it per asset and amount", async () => {
    vi.stubEnv("ONECLICK_JWT", "");
    const fetchImpl = respond(201, routeSol);
    vi.stubGlobal("fetch", fetchImpl);

    const first = await get("asset=SOL&amount=1");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "ok", amountOutFormatted: "94.981067", platformFeeBps: 25 });
    const second = await get("asset=SOL&amount=1.000");
    expect(await second.json()).toMatchObject({ status: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("answers 200 with no_liquidity when 1Click has no route", async () => {
    vi.stubGlobal("fetch", respond(400, noLiquidity));
    const res = await get("asset=ETH_BASE&amount=100000");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "no_liquidity", asset: "ETH_BASE" });
  });

  it("answers 502 when 1Click is down", async () => {
    vi.stubGlobal("fetch", respond(503, { message: "Service Unavailable" }));
    const res = await get("asset=BTC&amount=0.5");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/^Route quote unavailable: POST \/quote returned HTTP 503/) });
  });
});
