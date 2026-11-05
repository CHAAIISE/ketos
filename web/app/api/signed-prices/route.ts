import { nearConfig } from "@/lib/near/config";
import { priceSigner, signedPriceAssets } from "@/lib/near/signed-prices";
import { workerSignedPrices } from "@/lib/near/signed-prices-server";

/** Paid TEE execution stays server-side; the contract remains the final verifier. */
export async function POST(request: Request) {
  let assets: string[] | null;
  try {
    const body: unknown = await request.json();
    assets = signedPriceAssets(body && typeof body === "object" && "assets" in body ? body.assets : null);
  } catch {
    assets = null;
  }
  const headers = { "Cache-Control": "no-store" };
  if (!assets) return Response.json({ error: "Request 1–12 uppercase asset symbols" }, { status: 400, headers });
  try {
    const signer = await priceSigner(nearConfig());
    if (!signer) return Response.json({ error: "Signed prices unavailable" }, { status: 503, headers });
    const prices = await workerSignedPrices(assets, signer);
    return prices
      ? Response.json(prices, { headers })
      : Response.json({ error: "Signed prices unavailable" }, { status: 503, headers });
  } catch {
    return Response.json({ error: "Signed prices unavailable" }, { status: 503, headers });
  }
}
