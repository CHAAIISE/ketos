import { createHash, timingSafeEqual } from "node:crypto";
import { keeperChain, oneClickDepthSource } from "@/lib/keeper/chain";
import { TickGate } from "@/lib/keeper/throttle";
import { runTick } from "@/lib/keeper/tick";
import { errorMessage } from "@/lib/utils";

export const maxDuration = 300;

const gate = new TickGate();

/** Scheduled callers authenticate; browser fallback also honours the latest on-chain measurement. */
export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret || !timingSafeEqual(
      createHash("sha256").update(authorization).digest(),
      createHash("sha256").update(`Bearer ${secret}`).digest(),
    )) {
      return Response.json({ ok: false, reason: "invalid keeper authorization" }, {
        status: 401, headers: { "Cache-Control": "no-store" },
      });
    }
  }
  const privateKey = process.env.KEEPER_PRIVATE_KEY?.trim();
  if (!privateKey) {
    return Response.json({ ok: false, reason: "keeper is not configured on this deployment" }, { status: 503 });
  }

  let chain;
  let lastTickMs: number | null = null;
  try {
    chain = await keeperChain(privateKey);
    if (authorization === null) {
      const markets = await chain.markets();
      lastTickMs = Math.max(0, ...markets.map((m) => m.depth_measured_at_ms)) || null;
    }
  } catch (e) {
    return Response.json({ ok: false, reason: `NEAR RPC unavailable: ${errorMessage(e)}` }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }

  const entry = gate.enter(Date.now(), lastTickMs);
  if (!entry.ok) {
    const seconds = Math.ceil(entry.retryAfterMs / 1000);
    return Response.json(
      { ok: true, state: "throttled", retryAfterMs: entry.retryAfterMs },
      { status: 200, headers: { "Retry-After": String(seconds), "Cache-Control": "no-store" } },
    );
  }
  try {
    const summary = await runTick(chain, oneClickDepthSource(process.env.ONECLICK_JWT?.trim() || undefined));
    return Response.json(summary, { status: summary.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ ok: false, reason: errorMessage(e) }, { status: 500, headers: { "Cache-Control": "no-store" } });
  } finally {
    entry.release();
  }
}
