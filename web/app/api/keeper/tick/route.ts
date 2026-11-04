import { keeperChain, oneClickDepthSource } from "@/lib/keeper/chain";
import { TickGate } from "@/lib/keeper/throttle";
import { runTick } from "@/lib/keeper/tick";

export const maxDuration = 300;

const gate = new TickGate();

/** Runs one keeper pass at most once a minute; the app calls it while a page is open. */
export async function POST() {
  const privateKey = process.env.KEEPER_PRIVATE_KEY?.trim();
  if (!privateKey) {
    return Response.json({ ok: false, reason: "keeper is not configured on this deployment" }, { status: 503 });
  }

  let chain;
  let lastTickMs: number | null;
  try {
    chain = await keeperChain(privateKey);
    const markets = await chain.markets();
    lastTickMs = Math.max(0, ...markets.map((m) => m.depth_measured_at_ms)) || null;
  } catch (e) {
    return Response.json({ ok: false, reason: `NEAR RPC unavailable: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }

  const entry = gate.enter(Date.now(), lastTickMs);
  if (!entry.ok) {
    const seconds = Math.ceil(entry.retryAfterMs / 1000);
    return Response.json(
      { ok: false, reason: `last tick was less than 60 s ago, retry in ${seconds} s` },
      { status: 429, headers: { "Retry-After": String(seconds) } },
    );
  }
  try {
    const summary = await runTick(chain, oneClickDepthSource(process.env.ONECLICK_JWT?.trim() || undefined));
    return Response.json(summary, { status: summary.ok ? 200 : 503 });
  } catch (e) {
    return Response.json({ ok: false, reason: e instanceof Error ? e.message : String(e) }, { status: 500 });
  } finally {
    entry.release();
  }
}
