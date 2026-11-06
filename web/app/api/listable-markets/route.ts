import { connection } from "next/server";
import { loadListableMarkets } from "@/lib/server/listable-markets";

/** Assets that can be listed right now; 1Click is only ever called from the server. */
export async function GET() {
  try {
    await connection();
    const body = await loadListableMarkets();
    return Response.json(body, {
      headers: {
        "Cache-Control": "public, s-maxage=60",
        Age: String(Math.max(0, Math.floor((Date.now() - body.fetchedAtMs) / 1000))),
      },
    });
  } catch {
    return Response.json({ error: "Listable assets unavailable" }, {
      status: 502, headers: { "Cache-Control": "no-store" },
    });
  }
}
