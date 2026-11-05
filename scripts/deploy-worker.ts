import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { loadEnv, requireEnv } from "./lib/env.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const owner = "ketos.testnet";
const project = "ketos-prices";
const wasmPath = join(root, "workers/ketos-prices/target/wasm32-wasip2/release/ketos-prices.wasm");
const sha256 = createHash("sha256").update(readFileSync(wasmPath)).digest("hex");
loadEnv();
const privateKey = requireEnv("KETOS_PRIVATE_KEY");
const home = mkdtempSync(join(tmpdir(), "ketos-outlayer-"));
chmodSync(home, 0o700);

// The CLI saves login credentials; a disposable home keeps them off the developer's profile.
function cli(args: string[], input?: string): string {
  const result = spawnSync("outlayer", args, {
    cwd: root,
    env: { ...process.env, OUTLAYER_HOME: home },
    input,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.replaceAll(privateKey, "[redacted]");
  process.stdout.write(text);
  if (result.error || result.status !== 0) {
    throw new Error(`outlayer ${args[0]} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`);
  }
  return text;
}

try {
  cli(["login", "testnet"], `${owner}\n${privateKey}\n`);
  const upload = cli(["upload", wasmPath]);
  const url = upload.match(/FastFS URL: (https:\/\/test\.fastfs\.io\/\S+)/)?.[1];
  if (!url) throw new Error("OutLayer upload did not return a testnet FastFS URL");
  // Wait for indexing before registering a URL that OutLayer must be able to download.
  let indexed = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (response.ok) {
      const actual = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
      if (actual !== sha256) throw new Error("FastFS content does not match the local worker");
      indexed = true;
      break;
    }
    await response.body?.cancel();
    await setTimeout(2_000);
  }
  if (!indexed) throw new Error("FastFS has not indexed the uploaded worker");
  cli(["deploy", project, url, "--hash", sha256, "--target", "wasm32-wasip2"]);
  const manifest = {
    project_id: `${owner}/${project}`,
    network: "testnet",
    contract: "outlayer.testnet",
    endpoint: `https://testnet-api.outlayer.ai/call/${owner}/${project}`,
    wasm_url: url,
    wasm_sha256: sha256,
    build_target: "wasm32-wasip2",
    signed_prices: {
      domain: "ketos:prices:v1",
      commands: ["signed_prices", "get_public_key"],
      // HTTPS uses the plural `secrets_ref`; keep unsigned requests secret-free.
      secrets_ref: { profile: "price-signing", account_id: owner },
      public_key_format: "ed25519:base58",
      signature_format: "base64",
      max_assets: 12,
    },
  };
  writeFileSync(join(root, "deployments/worker-testnet.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Deployed ${manifest.project_id} at version ${sha256}`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
