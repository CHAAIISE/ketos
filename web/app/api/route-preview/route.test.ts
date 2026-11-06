import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GET as RouteGet } from "./route";
import routeSol from "@/lib/intents/fixtures/quote-route-sol.json";

const NOW = 1_790_000_000_000;
let now: number;
let GET: typeof RouteGet;

beforeEach(async () => {
  // Static imports cannot isolate the process-local quote cache, in-flight work and token buckets.
  vi.resetModules();
  now = NOW;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubEnv("ONECLICK_JWT", "");
  ({ GET } = await import("./route"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function get(amount = "1", ip?: string, asset = "SOL") {
  return GET(new Request(`http://localhost/api/route-preview?asset=${asset}&amount=${amount}`, {
    headers: ip ? { "x-forwarded-for": ip } : {},
  }));
}

function quoteResponse() {
  return Response.json(routeSol, { status: 201 });
}

describe("hardened route previews", () => {
  it("sends and reports the normalized amount, not the original typed amount", async () => {
    const upstream = vi.fn<typeof fetch>(async () => quoteResponse());
    vi.stubGlobal("fetch", upstream);
    const first = await get("1.234499999");
    expect(await first.json()).toMatchObject({ amountIn: "1230000000", amountInFormatted: "1.23", quotedAtMs: NOW });
    expect(JSON.parse(String(upstream.mock.calls[0][1]?.body)).amount).toBe("1230000000");
    const second = await get("1.230000001");
    expect(await second.json()).toMatchObject({ amountIn: "1230000000", amountInFormatted: "1.23" });
    expect(second.headers.get("Cache-Control")).toBe("public, s-maxage=20");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["0.999499999", "999000000", "0.999"],
    ["0.9995", "1000000000", "1"],
    ["0.000000001", "1", "0.000000001"],
  ])("keeps normalization boundary %s honest", async (amount, baseUnits, formatted) => {
    const upstream = vi.fn<typeof fetch>(async () => quoteResponse());
    vi.stubGlobal("fetch", upstream);
    const response = await get(amount);
    expect(await response.json()).toMatchObject({ amountIn: baseUnits, amountInFormatted: formatted });
    expect(JSON.parse(String(upstream.mock.calls[0][1]?.body)).amount).toBe(baseUnits);
  });

  it("preserves the quote timestamp and CDN age, then refreshes at the exact TTL", async () => {
    const upstream = vi.fn(async () => quoteResponse());
    vi.stubGlobal("fetch", upstream);
    const initial = await (await get()).json();
    now += 19_999;
    const cached = await get();
    expect(cached.headers.get("Age")).toBe("19");
    expect((await cached.json()).quotedAtMs).toBe(initial.quotedAtMs);
    expect(upstream).toHaveBeenCalledTimes(1);
    now += 1;
    expect((await (await get()).json()).quotedAtMs).toBe(now);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent amounts that round into the same bucket", async () => {
    const { promise: release, resolve } = Promise.withResolvers<void>();
    const { promise: started, resolve: signalStarted } = Promise.withResolvers<void>();
    const upstream = vi.fn(async () => { signalStarted(); await release; return quoteResponse(); });
    vi.stubGlobal("fetch", upstream);
    const first = get("1.231");
    await started;
    const second = get("1.234");
    resolve();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await responses[0].json()).toEqual(await responses[1].json());
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("rate limits one IP with Retry-After, refills after six seconds and isolates clients", async () => {
    const upstream = vi.fn(async () => quoteResponse());
    vi.stubGlobal("fetch", upstream);
    for (let index = 0; index < 10; index += 1) expect((await get("1", "192.0.2.1")).status).toBe(200);
    const limited = await get("2", "192.0.2.1");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("6");
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    expect((await get("2", "192.0.2.2")).status).toBe(200);
    now += 5_999;
    expect((await get("3", "192.0.2.1")).headers.get("Retry-After")).toBe("1");
    now += 1;
    expect((await get("3", "192.0.2.1")).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("keeps direct localhost callers usable in one shared anonymous bucket", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => quoteResponse()));
    for (let index = 0; index < 10; index += 1) expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(429);
  });

  it("bounds distinct in-flight quotes while still accepting an identical concurrent quote", async () => {
    const { promise: release, resolve } = Promise.withResolvers<void>();
    const upstream = vi.fn(async () => { await release; return quoteResponse(); });
    vi.stubGlobal("fetch", upstream);
    const pending = Array.from({ length: 20 }, (_, index) => get(String(index + 1), `192.0.2.${index + 1}`));
    const duplicate = get("1", "192.0.2.100");
    const busy = await get("21", "192.0.2.101");
    expect(busy.status).toBe(429);
    expect(busy.headers.get("Cache-Control")).toBe("no-store");
    expect(busy.headers.get("Retry-After")).toBe("1");
    expect(upstream).toHaveBeenCalledTimes(20);
    resolve();
    expect((await Promise.all([...pending, duplicate])).every((response) => response.status === 200)).toBe(true);
  });

  it("caps the successful quote cache at 500 entries", async () => {
    const upstream = vi.fn(async () => quoteResponse());
    vi.stubGlobal("fetch", upstream);
    for (let index = 1; index <= 501; index += 1) {
      expect((await get(String(index), `cache-client-${index}`)).status).toBe(200);
    }
    expect((await get("1", "another-client")).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(502);
  });

  it("bounds IP accounting without evicting active clients and reclaims idle buckets", async () => {
    const upstream = vi.fn(async () => quoteResponse());
    vi.stubGlobal("fetch", upstream);
    for (let index = 0; index < 1000; index += 1) {
      expect((await get("1", `ip-client-${index}`)).status).toBe(200);
    }
    const full = await get("2", "new-client");
    expect(full.status).toBe(429);
    expect(full.headers.get("Retry-After")).toBe("60");
    now += 60_000;
    expect((await get("2", "new-client")).status).toBe(200);
  });

  it("does not cache upstream errors or leak them into a later successful request", async () => {
    const upstream = vi.fn().mockResolvedValueOnce(Response.json({ message: "Service Unavailable" }, { status: 503 }))
      .mockImplementation(async () => quoteResponse());
    vi.stubGlobal("fetch", upstream);
    const failed = await get();
    expect(failed.status).toBe(502);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    expect((await get()).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
