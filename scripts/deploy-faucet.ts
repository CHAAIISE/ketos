// Explicit faucet-only upgrade/provisioning; never redeploys the exchange or reseeds vaults.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas } from "near-api-js";
import type { AccessKeyList, KeyPairString } from "near-api-js";
import { loadEnv, nearAccountId, optionalEnv, requireEnv } from "./lib/env.ts";

const PARENT = "ketos.testnet";
const TOKEN = `usdc.${PARENT}`;
const FAUCET = `faucet.${PARENT}`;
const PREVIOUS_HASHES = ["Haq6T2sMW2K58F3sGen8zEKJMpBiW5tHo14w39nZUSFr", "44Vnm1rH3LDCgMF4ZMA9Wunz2VwSwYvTL6igshLgJsvR"];
const EMPTY_HASH = "11111111111111111111111111111111";
const STORAGE_PRICE = 10n ** 19n;
const RESERVE = nearToYocto("2");
const HEADROOM = nearToYocto("0.5");
const TRANSFER_HEADROOM = nearToYocto("0.01");
const TARGET = nearToYocto("3");
const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
type AccountView = { amount: string; locked: string; code_hash: string; storage_usage: number };
type RawState = { values: { key: string; value: string }[] };
type FaucetConfig = { faucet_id: string; gas_day: number; gas_spent: string };

function base58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let result = "";
  while (value > 0n) {
    result = alphabet[Number(value % 58n)] + result;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = `1${result}`;
  }
  return result;
}

function available(account: AccountView): bigint {
  const balance = BigInt(account.amount);
  const stake = BigInt(account.storage_usage) * STORAGE_PRICE;
  return balance > stake ? balance - stake : 0n;
}

function near(amount: bigint): string {
  const unit = 10n ** 24n;
  const fraction = (amount % unit).toString().padStart(24, "0").replace(/0+$/, "");
  return `${amount / unit}${fraction ? `.${fraction}` : ""} NEAR`;
}

function persistSecret(file: string, secret: string): void {
  const previous = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = previous.split("\n");
  const retained = lines.filter((line) => !line.startsWith("FAUCET_PRIVATE_KEY="));
  while (retained.at(-1) === "") retained.pop();
  retained.push(`FAUCET_PRIVATE_KEY=${secret}`, "");
  // Tighten an existing file before writing, not just after creation.
  if (existsSync(file)) chmodSync(file, 0o600);
  const content = retained.join("\n");
  if (content !== previous) writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export async function deployFaucet(): Promise<void> {
  loadEnv();
  const rpcUrl = optionalEnv("NEAR_RPC_URL") ?? "https://test.rpc.fastnear.com";
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const parentSecret = requireEnv("KETOS_PRIVATE_KEY") as KeyPairString;
  const parentPublic = KeyPair.fromString(parentSecret).getPublicKey().toString();
  const burnerId = nearAccountId();
  const burnerSecret = requireEnv("NEAR_PRIVATE_KEY") as KeyPairString;
  if ([PARENT, TOKEN, FAUCET].includes(burnerId)) throw new Error("NEAR_ACCOUNT_ID must be a separate burner funding account");
  const parent = new Account(PARENT, provider, parentSecret);
  const burner = new Account(burnerId, provider, burnerSecret);
  const token = new Account(TOKEN, provider, parentSecret);
  const code = readFileSync(root("contracts/res/mock_usdc.wasm"));
  const targetHash = base58(createHash("sha256").update(code).digest());
  if (PREVIOUS_HASHES.includes(targetHash)) throw new Error("Build the sponsored mock-usdc artifact before faucet deployment");

  async function rpc<T>(method: string, params: object): Promise<T | null> {
    const response = await fetch(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) throw new Error(`RPC ${method}: HTTP ${response.status}`);
    const result = await response.json() as { result?: T; error?: { cause?: { name?: string } } };
    if (result.error?.cause?.name === "UNKNOWN_ACCOUNT") return null;
    if (result.error || !result.result) throw new Error(`RPC ${method}: ${result.error?.cause?.name ?? "missing result"}`);
    return result.result;
  }
  const block = await rpc<{ header: { hash: string } }>("block", { finality: "final" });
  if (!block) throw new Error("Cannot pin preflight block");
  const pinned = { block_id: block.header.hash };
  async function query<T>(accountId: string, request: object, at: object = pinned): Promise<T | null> {
    return rpc<T>("query", { account_id: accountId, ...at, ...request });
  }
  async function view<T>(method: string, args: object = {}, at: object = pinned): Promise<T> {
    const result = await query<{ result?: number[]; error?: string }>(TOKEN, {
      request_type: "call_function", method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    }, at);
    if (!result?.result || result.error) throw new Error(`${TOKEN}.${method}: incompatible contract view`);
    return JSON.parse(Buffer.from(result.result).toString("utf8")) as T;
  }
  async function assertKey(accountId: string, publicKey: string, dedicated = false): Promise<void> {
    const keys = await query<AccessKeyList>(accountId, { request_type: "view_access_key_list" });
    if (!keys?.keys.some((key) => key.public_key === publicKey && key.access_key.permission === "FullAccess") ||
        (dedicated && keys.keys.length !== 1)) {
      throw new Error(`${accountId}: expected ${dedicated ? "sole dedicated" : "matching"} full-access key is missing; refusing key replacement`);
    }
  }
  const accountRequest = { request_type: "view_account" };
  const stateRequest = { request_type: "view_state", prefix_base64: "", include_proof: false };
  const [parentState, tokenState, faucetState, burnerState, before] = await Promise.all([
    query<AccountView>(PARENT, accountRequest), query<AccountView>(TOKEN, accountRequest),
    query<AccountView>(FAUCET, accountRequest), query<AccountView>(burnerId, accountRequest),
    query<RawState>(TOKEN, stateRequest),
  ]);
  if (!parentState || !tokenState || !burnerState || !before) throw new Error("Parent, token, burner and token snapshot must exist before faucet provisioning");
  if (![targetHash, ...PREVIOUS_HASHES].includes(tokenState.code_hash)) throw new Error("Unknown token layout; refusing faucet migration");
  const stateKey = Buffer.from("STATE").toString("base64");
  const oldRoot = before.values.find((entry) => entry.key === stateKey);
  if (!oldRoot) throw new Error("Token is not initialized; refusing faucet migration");
  await Promise.all([
    assertKey(PARENT, parentPublic), assertKey(TOKEN, parentPublic),
    assertKey(burnerId, KeyPair.fromString(burnerSecret).getPublicKey().toString()),
  ]);
  if (await view<string>("owner_id") !== PARENT) throw new Error("Unexpected token owner");
  const metadata = await view<{ symbol: string; decimals: number }>("ft_metadata");
  if (metadata.symbol !== "tUSDC" || metadata.decimals !== 6) throw new Error("Unexpected token metadata");
  const supplyBefore = await view<string>("ft_total_supply");
  const custodyBefore = await view<string>("ft_balance_of", { account_id: PARENT });
  const upgrading = tokenState.code_hash !== targetHash;
  if (!upgrading && (await view<FaucetConfig>("faucet_config")).faucet_id !== FAUCET) {
    throw new Error("Token faucet is immutable and does not match faucet.ketos.testnet");
  }
  const existingSecret = optionalEnv("FAUCET_PRIVATE_KEY") as KeyPairString | undefined;
  if (faucetState) {
    if (!existingSecret) throw new Error("Existing faucet account requires its original FAUCET_PRIVATE_KEY; refusing key replacement");
    if (faucetState.code_hash !== EMPTY_HASH) throw new Error("Dedicated faucet account has unexpected contract code");
    await assertKey(FAUCET, KeyPair.fromString(existingSecret).getPublicKey().toString(), true);
    const raw = await query<RawState>(FAUCET, stateRequest);
    if (!raw || raw.values.length > 0) throw new Error("Dedicated faucet account has unexpected state");
  } else if (existingSecret) {
    KeyPair.fromString(existingSecret);
  }

  const codeBefore = await query<{ code_base64: string }>(TOKEN, { request_type: "view_code" });
  if (!codeBefore) throw new Error("Token code snapshot unavailable");
  const previousCode = Buffer.from(codeBefore.code_base64, "base64");
  if (base58(createHash("sha256").update(previousCode).digest()) !== tokenState.code_hash) throw new Error("Token code hash disagrees with preflight snapshot");
  const growth = BigInt(Math.max(0, code.length - previousCode.length)) * STORAGE_PRICE;
  const tokenRequired = RESERVE + (upgrading ? growth + HEADROOM + 4096n * STORAGE_PRICE : 0n);
  const tokenTopUp = available(tokenState) < tokenRequired ? tokenRequired - available(tokenState) : 0n;
  // Existing healthy faucet balances are not topped up on rerun. New/low accounts target 3 NEAR.
  const faucetTopUp = !faucetState ? TARGET : available(faucetState) < RESERVE ? TARGET - available(faucetState) : 0n;
  const mutating = upgrading || tokenTopUp > 0n || faucetTopUp > 0n;
  const parentRequired = RESERVE + tokenTopUp + faucetTopUp + (mutating ? HEADROOM : 0n);
  const parentTopUp = available(parentState) < parentRequired ? parentRequired - available(parentState) : 0n;
  const burnerRequired = RESERVE + (parentTopUp > 0n ? parentTopUp + TRANSFER_HEADROOM : 0n);
  console.log(`faucet preflight: parent available ${near(available(parentState))}, required ${near(parentRequired)}; burner ${burnerId} available ${near(available(burnerState))}, required ${near(burnerRequired)} including ${near(RESERVE)} reserve`);
  if (available(burnerState) < burnerRequired) {
    throw new Error(`Funding unavailable: insufficient burner funds before mutation; need ${near(burnerRequired)} including ${near(RESERVE)} reserve and transfer headroom`);
  }
  // All compatibility, key and funding checks precede even local key generation/persistence.
  const secret = existingSecret ?? KeyPair.fromRandom("ed25519").toString();
  const publicKey = KeyPair.fromString(secret as KeyPairString).getPublicKey();
  persistSecret(root(".env.local"), secret);
  persistSecret(root("web/.env.local"), secret);

  async function send(account: Account, receiverId: string, pending: Parameters<Account["signAndSendTransaction"]>[0]["actions"]): Promise<void> {
    const outcome = await account.signAndSendTransaction({ receiverId, actions: pending, waitUntil: "FINAL" });
    for (const receipt of [outcome.transaction_outcome, ...outcome.receipts_outcome]) {
      if (typeof receipt.outcome.status === "object" && "Failure" in receipt.outcome.status) throw new Error(`Transaction failed for ${receiverId}; inspect chain state before retrying`);
    }
    if (typeof outcome.status !== "object" || !("SuccessValue" in outcome.status)) throw new Error(`Transaction success not confirmed for ${receiverId}`);
    console.log(`${account.accountId} → ${receiverId}: ${outcome.transaction.hash}`);
  }
  const latest = { finality: "final" };
  const currentToken = await query<AccountView>(TOKEN, accountRequest, latest);
  const currentFaucet = await query<AccountView>(FAUCET, accountRequest, latest);
  if (currentToken?.code_hash !== tokenState.code_hash || Boolean(currentFaucet) !== Boolean(faucetState)) throw new Error("Token/faucet identity changed during preflight; rerun without sending transactions");
  if (parentTopUp > 0n) await send(burner, PARENT, [actions.transfer(parentTopUp)]);
  if (!faucetState) {
    await send(parent, FAUCET, [actions.createAccount(), actions.transfer(faucetTopUp), actions.addFullAccessKey(publicKey)]);
  } else if (faucetTopUp > 0n) {
    await send(parent, FAUCET, [actions.transfer(faucetTopUp)]);
  }
  if (tokenTopUp > 0n) await send(parent, TOKEN, [actions.transfer(tokenTopUp)]);
  if (upgrading) {
    // A private self-call in the same receipt rolls back code replacement if migration fails.
    await send(token, TOKEN, [actions.deployContract(code), actions.functionCall("migrate_faucet", { faucet_id: FAUCET }, teraToGas("100"))]);
  }
  const afterBlock = await rpc<{ header: { hash: string } }>("block", { finality: "final" });
  if (!afterBlock) throw new Error("Cannot pin final preservation block");
  const afterAt = { block_id: afterBlock.header.hash };
  const after = await query<RawState>(TOKEN, stateRequest, afterAt);
  if (!after) throw new Error("Token preservation snapshot unavailable");
  const records = new Map(after.values.map((entry) => [entry.key, entry.value]));
  for (const entry of before.values) {
    if (entry.key === stateKey && upgrading) {
      const previous = Buffer.from(entry.value, "base64");
      const current = Buffer.from(records.get(entry.key) ?? "", "base64");
      if (!current.subarray(0, previous.length).equals(previous)) throw new Error("Migration changed legacy root fields, supply or collection handles");
    } else if (records.get(entry.key) !== entry.value) {
      throw new Error("Token raw record changed: balances/claim timestamps not preserved (possible concurrent activity)");
    }
  }
  if (after.values.length !== before.values.length) throw new Error("Unexpected added/removed token records during migration");
  if (await view<string>("ft_total_supply", {}, afterAt) !== supplyBefore ||
      await view<string>("ft_balance_of", { account_id: PARENT }, afterAt) !== custodyBefore) {
    throw new Error("Token supply/custody changed during migration (possible concurrent activity)");
  }
  const finalToken = await query<AccountView>(TOKEN, accountRequest, afterAt);
  const finalFaucet = await query<AccountView>(FAUCET, accountRequest, afterAt);
  const finalParent = await query<AccountView>(PARENT, accountRequest, afterAt);
  if (finalToken?.code_hash !== targetHash || (await view<FaucetConfig>("faucet_config", {}, afterAt)).faucet_id !== FAUCET ||
      !finalFaucet || available(finalFaucet) < RESERVE || !finalParent || available(finalParent) < RESERVE) {
    throw new Error("Final faucet code/config/reserve verification failed");
  }
  const manifestPath = root("deployments/testnet.json");
  const previousManifest = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(previousManifest) as Record<string, unknown> & { code_hashes?: Record<string, string> };
  manifest.faucet = FAUCET;
  manifest.code_hashes = { ...manifest.code_hashes, usdc: targetHash };
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  if (manifestContent !== previousManifest) writeFileSync(manifestPath, manifestContent);
  console.log(`${FAUCET}: dedicated full-access key saved privately in root/web env; ${upgrading ? "token migrated" : "token unchanged"}; ${before.values.length} existing raw records and supply/custody preserved; available ${near(available(finalFaucet))}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], `file://${process.cwd()}/`))) {
  void deployFaucet().catch((error: unknown) => {
    let message = error instanceof Error ? error.message : "Faucet deployment failed";
    for (const name of ["FAUCET_PRIVATE_KEY", "KETOS_PRIVATE_KEY", "NEAR_PRIVATE_KEY", "NEAR_RPC_URL"]) {
      const value = optionalEnv(name);
      if (value) message = message.replaceAll(value, "[REDACTED]");
    }
    console.error(`Faucet deployment failed: ${message.replace(/ed25519:[1-9A-HJ-NP-Za-km-z]+/g, "[REDACTED]")}`);
    process.exitCode = 1;
  });
}
