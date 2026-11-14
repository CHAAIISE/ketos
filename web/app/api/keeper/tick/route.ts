import { createHash, timingSafeEqual } from "node:crypto";
import { keeperChain, oneClickDepthSource } from "@/lib/keeper/chain";
import { TickGate } from "@/lib/keeper/throttle";
import { runTick } from "@/lib/keeper/tick";
import { errorMessage } from "@/lib/utils";

export const maxDuration = 300;

const gate = new TickGate();

/** Explicit operator fallback only; normal surveillance belongs to the standalone runner. */
export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET?.trim();
  if (!authorization || !secret || !timingSafeEqual(
    createHash("sha256").update(authorization).digest(),
    createHash("sha256").update(`Bearer ${secret}`).digest(),
  )) {
    return Response.json({ ok: false, reason: "invalid keeper authorization" }, {
      status: 401, headers: { "Cache-Control": "no-store" },
    });
  }
  if (process.env.KEEPER_HTTP_ENABLED !== "1") {
    return Response.json({ ok: false, reason: "maintenance is owned by the standalone runner" }, {
      status: 409, headers: { "Cache-Control": "no-store" },
    });
  }
  const privateKey = process.env.KEEPER_PRIVATE_KEY?.trim();
  if (!privateKey) {
    return Response.json({ ok: false, reason: "keeper is not configured on this deployment" }, { status: 503 });
  }

  let chain;
  try {
    chain = await keeperChain(privateKey);
  } catch (e) {
    return Response.json({ ok: false, reason: `NEAR RPC unavailable: ${errorMessage(e)}` }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }

  const entry = gate.enter(Date.now(), null);
  if (!entry.ok) {
    const seconds = Math.ceil(entry.retryAfterMs / 1000);
    return Response.json(
      { ok: true, state: "throttled", retryAfterMs: entry.retryAfterMs },
      { status: 200, headers: { "Retry-After": String(seconds), "Cache-Control": "no-store" } },
    );
  }
  try {
    const summary = await runTick(chain, oneClickDepthSource(process.env.ONECLICK_JWT?.trim() || undefined));
    return Response.json(summary, { status: summary.ok && !summary.degraded ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ ok: false, reason: errorMessage(e) }, { status: 500, headers: { "Cache-Control": "no-store" } });
  } finally {
    entry.release();
  }
}
