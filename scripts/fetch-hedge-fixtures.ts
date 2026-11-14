// Sandbox uses the real, hash-pinned Ref and wNEAR binaries, never a simulated exchange.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { baseEncode } from "near-api-js";
import { z } from "zod";

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const manifest = z.object({
  network: z.literal("testnet"), fixture_block_hash: z.string().min(32),
  config: z.object({ exchange_id: z.literal("ref-finance-101.testnet"), wrapped_near_id: z.literal("wrap.testnet") }),
  exchange_code_hash: z.string().min(32), wrapped_near_code_hash: z.string().min(32),
}).parse(JSON.parse(readFileSync(root("deployments/hedge-testnet.json"), "utf8")));
const hash = (bytes: Uint8Array) => baseEncode(createHash("sha256").update(bytes).digest());
async function main() {
  mkdirSync(root("contracts/res"), { recursive: true });
  for (const [name, account, expected] of [
    ["ref_exchange", manifest.config.exchange_id, manifest.exchange_code_hash],
    ["wrapped_near", manifest.config.wrapped_near_id, manifest.wrapped_near_code_hash],
  ] as const) {
    const path = root(`contracts/res/${name}.wasm`);
    if (existsSync(path) && hash(readFileSync(path)) === expected) continue;
    const response = await fetch("https://archival-rpc.testnet.near.org", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: name, method: "query", params: {
        request_type: "view_code", account_id: account, block_id: manifest.fixture_block_hash,
      } }),
    });
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const parsed = z.object({ result: z.object({ code_base64: z.string(), block_hash: z.literal(manifest.fixture_block_hash) }) })
      .parse(await response.json());
    const bytes = Buffer.from(parsed.result.code_base64, "base64");
    if (hash(bytes) !== expected) throw new Error(`${name}: code hash mismatch; refusing an unpinned venue`);
    writeFileSync(`${path}.tmp`, bytes);
    renameSync(`${path}.tmp`, path);
    console.log(`${name}: ${bytes.length} bytes, ${expected}`);
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Fixture download failed"); process.exitCode = 1; });
