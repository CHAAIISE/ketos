import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const manifestPath = join(root, "deployments/worker-testnet.json");
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) as {
  wasm_sha256: string; price_signer?: string; price_signer_attestation_url?: string;
} : null;
const verifier = existsSync(join(root, "out/tools/bin/outlayer-verify"))
  ? join(root, "out/tools/bin/outlayer-verify") : "outlayer-verify";
loadEnv();
const privateKey = requireEnv("KETOS_PRIVATE_KEY");
const paymentKey = previous?.price_signer ? requireEnv("OUTLAYER_PAYMENT_KEY") : undefined;
if (previous?.price_signer && spawnSync(verifier, ["--help"], { stdio: "ignore" }).status !== 0) {
  throw new Error("Install outlayer-verify before upgrading the protected price signer build");
}
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
  let text = `${result.stdout ?? ""}${result.stderr ?? ""}`.replaceAll(privateKey, "[redacted]");
  if (paymentKey) text = text.replaceAll(paymentKey, "[redacted]");
  process.stdout.write(text);
  if (result.error || result.status !== 0) {
    throw new Error(`outlayer ${args[0]} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`);
  }
  return text;
}

try {
  cli(["login", "testnet"], `${owner}\n${privateKey}\n`);
  let url = `https://test.fastfs.io/${owner}/outlayer.testnet/${sha256}.wasm`;
  const existing = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  let indexed = false;
  if (existing.ok) {
    if (createHash("sha256").update(Buffer.from(await existing.arrayBuffer())).digest("hex") !== sha256) {
      throw new Error("Existing FastFS artifact does not match the local worker");
    }
    indexed = true;
  } else if (existing.status === 404) {
    await existing.body?.cancel();
    const upload = cli(["upload", wasmPath]);
    const uploaded = upload.match(/FastFS URL: (https:\/\/test\.fastfs\.io\/\S+)/)?.[1];
    if (!uploaded) throw new Error("OutLayer upload did not return a testnet FastFS URL");
    url = uploaded;
  } else {
    throw new Error(`FastFS preflight failed: HTTP ${existing.status}`);
  }
  // Reuse an uploaded artifact when a later attestation step needs to be resumed.
  for (let attempt = 0; !indexed && attempt < 30; attempt++) {
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
  if (!process.argv.includes("--resume-version")) {
    cli(["deploy", project, url, "--hash", sha256, "--target", "wasm32-wasip2"]);
  }
  let attestationUrl = previous?.price_signer_attestation_url;
  if (previous?.price_signer) {
    cli(["secrets", "access", "--profile", "price-signing", "--project", `${owner}/${project}`, "--build", sha256]);
    try {
      const input = { command: "get_public_key" };
      const proofDirectory = join(root, "out/deployments");
      mkdirSync(proofDirectory, { recursive: true });
      const checkpoint = join(proofDirectory, `worker-${sha256}-signer.json`);
      let result: { status?: string; call_id?: string; output?: string | { public_key?: string } };
      if (existsSync(checkpoint)) {
        result = JSON.parse(readFileSync(checkpoint, "utf8"));
      } else {
        const response = await fetch(`https://testnet-api.outlayer.ai/call/${owner}/${project}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Payment-Key": paymentKey! },
          body: JSON.stringify({ async: true, input, version_key: sha256, secrets_ref: { profile: "price-signing", account_id: owner } }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`Signer verification call failed: HTTP ${response.status}`);
        result = await response.json();
        writeFileSync(checkpoint, JSON.stringify(result, null, 2), { mode: 0o600 });
      }
      const deadline = Date.now() + 180_000;
      while (result.status === "pending" && result.call_id && Date.now() < deadline) {
        const callId = result.call_id;
        await setTimeout(2_000);
        const response = await fetch(`https://testnet-api.outlayer.ai/calls/${encodeURIComponent(callId)}`, {
          headers: { "X-Payment-Key": paymentKey! }, signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`Signer result unavailable: HTTP ${response.status}; call ${callId}`);
        result = await response.json();
        if (result.call_id !== callId) throw new Error("Signer result identity mismatch");
        if (result.status !== "pending") writeFileSync(checkpoint, JSON.stringify(result, null, 2), { mode: 0o600 });
      }
      if (result.status !== "completed" || !result.call_id || !result.output) {
        throw new Error("Signer verification did not return a completed, attested output");
      }
      const output = typeof result.output === "string" ? JSON.parse(result.output) as { public_key?: string } : result.output;
      if (output.public_key !== previous.price_signer) throw new Error("Protected signer changed; refusing deployment promotion");
      attestationUrl = `https://testnet-api.outlayer.ai/attestations/by-call/${encodeURIComponent(result.call_id)}`;
      let attestationResponse = await fetch(attestationUrl, { signal: AbortSignal.timeout(15_000) });
      // Completed execution can precede quote indexing; never buy the execution again.
      for (let attempt = 0; attestationResponse.status === 404 && attempt < 15; attempt++) {
        await attestationResponse.body?.cancel();
        await setTimeout(2_000);
        attestationResponse = await fetch(attestationUrl, { signal: AbortSignal.timeout(15_000) });
      }
      if (!attestationResponse.ok) throw new Error(`Signer attestation unavailable: HTTP ${attestationResponse.status}; call ${result.call_id}`);
      const attestation = await attestationResponse.json() as { executed_wasm_sha256?: string; secrets_ref?: string };
      if (attestation.executed_wasm_sha256 !== sha256 || attestation.secrets_ref !== `${owner}/price-signing`) {
        throw new Error("Signer attestation does not bind the requested build and protected profile");
      }
      const verification = spawnSync(verifier, [
        "call", result.call_id, "--network", "testnet",
        "--api", "https://testnet-api.outlayer.ai", "--rpc", "https://near-testnet.drpc.org",
        "--input", JSON.stringify(input), "--output", typeof result.output === "string" ? result.output : JSON.stringify(result.output),
        "--bundle", join(proofDirectory, `worker-${sha256}.json`),
      ], { encoding: "utf8", timeout: 180_000 });
      process.stdout.write(verification.stdout ?? "");
      process.stderr.write(verification.stderr ?? "");
      if (verification.error || verification.status !== 0) throw new Error("Independent signer attestation verification failed");
    } catch (error) {
      // Existing clients remain pinned to the previous build until promotion.
      cli(["secrets", "access", "--profile", "price-signing", "--project", `${owner}/${project}`, "--build", previous.wasm_sha256]);
      throw error;
    }
  }
  const manifest = {
    project_id: `${owner}/${project}`,
    network: "testnet",
    contract: "outlayer.testnet",
    endpoint: `https://testnet-api.outlayer.ai/call/${owner}/${project}`,
    wasm_url: url,
    wasm_sha256: sha256,
    build_target: "wasm32-wasip2",
    ...(previous?.price_signer ? { price_signer: previous.price_signer, price_signer_attestation_url: attestationUrl } : {}),
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
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Deployed ${manifest.project_id} at version ${sha256}`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
