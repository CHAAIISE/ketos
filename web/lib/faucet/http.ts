import { chainError, FaucetError, hashIp, ingressIp, validAccountId, type FaucetService } from "./service";

const MAX_BODY_BYTES = 1024;
export interface FaucetHandlerDependencies {
  getService(): { service: Pick<FaucetService, "fund">; privateKey: string };
  vercel(): boolean;
}

export function createFaucetHandler(deps: FaucetHandlerDependencies) {
  return async function POST(request: Request): Promise<Response> {
    try {
      if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        throw new FaucetError(400, "INVALID_CONTENT_TYPE", "Send a JSON request with Content-Type: application/json.");
      }
      const length = request.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
        throw new FaucetError(400, "INVALID_BODY", "The faucet request body must be at most 1,024 bytes.");
      }
      if (!request.body) throw new FaucetError(400, "INVALID_BODY", "Send a JSON object containing accountId.");
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY_BYTES) {
            void reader.cancel().catch(() => {});
            throw new FaucetError(400, "INVALID_BODY", "The faucet request body must be at most 1,024 bytes.");
          }
          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof FaucetError) throw error;
        throw new FaucetError(400, "INVALID_BODY", "The faucet request body could not be read.");
      } finally { reader.releaseLock(); }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
      catch { throw new FaucetError(400, "INVALID_JSON", "Send valid JSON containing accountId."); }
      if (!body || typeof body !== "object" || Array.isArray(body) || !("accountId" in body) || !validAccountId(body.accountId)) {
        throw new FaucetError(400, "INVALID_ACCOUNT", "Enter a valid NEAR account ID (2–64 lowercase characters).");
      }
      const { service, privateKey } = deps.getService();
      const result = await service.fund(body.accountId, hashIp(ingressIp(request, deps.vercel()), privateKey));
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const failure = chainError(error, Date.now());
      return Response.json(failure.body(), { status: failure.status, headers: {
        "Cache-Control": "no-store",
        ...(failure.retryAfterSeconds === undefined ? {} : { "Retry-After": String(failure.retryAfterSeconds) }),
      } });
    }
  };
}
