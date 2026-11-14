import { nearConfig } from "@/lib/near/config";
import { priceSigner, signedPriceAssets } from "@/lib/near/signed-prices";
import { pollSignedPriceJob, submitSignedPriceJob, type SignedPriceJob } from "@/lib/near/signed-prices-server";

export const maxDuration = 30;

const headers = { "Cache-Control": "no-store" };

function respond(job: SignedPriceJob) {
  if (!job) return Response.json({ error: "Signed prices unavailable" }, { status: 503, headers });
  return job.status === "pending"
    ? Response.json({ status: "pending", callId: job.callId }, { status: 202, headers })
    : Response.json(job.prices, { headers });
}

/**
 * Paid TEE execution stays server-side; the contract remains the final verifier.
 * `{ assets }` starts one execution; `{ assets, callId }` only reads that execution.
 */
export async function POST(request: Request) {
  let assets: string[] | null;
  let callId: unknown;
  try {
    const body: unknown = await request.json();
    assets = signedPriceAssets(body && typeof body === "object" && "assets" in body ? body.assets : null);
    callId = body && typeof body === "object" && "callId" in body ? body.callId : undefined;
  } catch {
    assets = null;
  }
  if (!assets) return Response.json({ error: "Request 1–12 uppercase asset symbols" }, { status: 400, headers });
  try {
    const signer = await priceSigner(nearConfig());
    if (!signer) return respond(null);
    return respond(callId === undefined
      ? await submitSignedPriceJob(assets, signer)
      : await pollSignedPriceJob(callId, assets, signer));
  } catch {
    return respond(null);
  }
}
