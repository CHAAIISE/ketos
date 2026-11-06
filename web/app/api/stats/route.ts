import { connection } from "next/server";
import { getStats } from "@/lib/stats-server";

/** Shared onchain aggregates; no wallet, signer or browser-side history fanout. */
export async function GET() {
  await connection();
  try {
    const stats = await getStats();
    return Response.json(stats, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=60",
        // A process-cache hit must not restart the CDN's 60-second freshness window.
        Age: Math.floor(Math.max(0, Date.now() - stats.fetchedAtMs) / 1_000).toString(),
      },
    });
  } catch {
    // SDK errors may contain RPC URLs or upstream bodies; never expose them publicly.
    return Response.json({ error: "Onchain statistics unavailable" }, {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
