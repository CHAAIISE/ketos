import { listableAssets, type ListableResponse } from "@/lib/intents/listing";
import { getTokens } from "@/lib/intents/oneclick";
import { nearConfig } from "@/lib/near/config";
import { KetosViews } from "@/lib/near/views";

const CACHE_MS = 60_000;

// Per-instance cache: the 1Click token list and the oracle's asset list change rarely.
let cached: { atMs: number; body: ListableResponse } | null = null;

/** Assets that can be listed right now; 1Click is only ever called from the server. */
export async function GET() {
  if (cached && Date.now() - cached.atMs < CACHE_MS) return Response.json(cached.body);
  try {
    const { rpcUrl, ketosContract, usdcContract } = nearConfig();
    const views = new KetosViews(rpcUrl, ketosContract, usdcContract);
    const [config, markets, tokens] = await Promise.all([
      views.config(),
      views.markets(),
      getTokens({ jwt: process.env.ONECLICK_JWT?.trim() || undefined }),
    ]);
    const oracleAssetIds = await views.oracleAssetIds(config.oracle_id);
    const body: ListableResponse = {
      fetchedAtMs: Date.now(),
      oracleId: config.oracle_id,
      assets: listableAssets({ markets, oracleAssetIds, tokens }),
    };
    cached = { atMs: body.fetchedAtMs, body };
    return Response.json(body);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return Response.json({ error: `Listable assets unavailable: ${reason}` }, { status: 502 });
  }
}
