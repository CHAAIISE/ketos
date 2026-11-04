// Deploys or updates Ketos on NEAR testnet at ketos.testnet. Safe to run repeatedly:
// accounts, keys, registrations and the vault seed are only created when missing, and code is
// only redeployed when the local wasm differs from the deployed one.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { loadEnv, nearAccountId, optionalEnv, requireEnv } from "./lib/env.ts";

const ORACLE_ID = "price-oracle.testnet";
const KEEPER_METHODS = ["refresh_prices", "set_depth", "liquidate"];
const USD = 1_000_000n;
const VAULT_SEED = 10_000n * USD;
// Initial balances cover code storage (~1 NEAR per 100 kB) plus headroom; the keeper tick
// refuses to run when the Ketos contract holds less than 2 NEAR.
const BALANCES = { usdc: 3, ketos: 6, keeper: 3 };
const KETOS_MIN_AVAILABLE = nearToYocto("2");

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

loadEnv();
const parentId = "ketos.testnet";
const parentKey = requireEnv("KETOS_PRIVATE_KEY") as KeyPairString;
const rpcUrl = optionalEnv("NEAR_RPC_URL") ?? "https://test.rpc.fastnear.com";
const provider = new JsonRpcProvider({ url: rpcUrl });
const parentPublicKey = KeyPair.fromString(parentKey).getPublicKey();

const ids = {
  usdc: `usdc.${parentId}`,
  ketos: parentId,
  keeper: `keeper.${parentId}`,
};
// Sub-accounts share Ketos's full-access key so they never need a second secret.
const signer = (accountId: string) => new Account(accountId, provider, parentKey);
const parent = signer(parentId);

type RpcResult<T> = { result?: T; error?: { cause?: { name?: string }; message?: string } };

async function rpc<T>(method: string, params: object): Promise<RpcResult<T>> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
  return (await res.json()) as RpcResult<T>;
}

async function viewAccount(accountId: string) {
  const r = await rpc<{ amount: string; code_hash: string; storage_usage: number }>("query", {
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  });
  if (r.error?.cause?.name === "UNKNOWN_ACCOUNT") return null;
  if (!r.result) throw new Error(`view_account ${accountId}: ${r.error?.message ?? "no result"}`);
  return r.result;
}

async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

async function hasState(contractId: string): Promise<boolean> {
  const r = await rpc<{ values: unknown[] }>("query", {
    request_type: "view_state",
    finality: "final",
    account_id: contractId,
    prefix_base64: "U1RBVEU=", // "STATE": near-sdk's root key
  });
  return (r.result?.values.length ?? 0) > 0;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function wasm(name: string): { code: Uint8Array; hash: string } {
  const code = readFileSync(root(`contracts/res/${name}.wasm`));
  return { code, hash: base58(createHash("sha256").update(code).digest()) };
}

/** Creates the sub-account if needed; returns true when it was just created. */
async function ensureAccount(accountId: string, near: number): Promise<boolean> {
  if (await viewAccount(accountId)) return false;
  await parent.createAccount({
    newAccountId: accountId,
    publicKey: parentPublicKey,
    nearToTransfer: nearToYocto(near),
  });
  console.log(`created ${accountId} (${near} NEAR)`);
  return true;
}

async function ensureContract(
  accountId: string,
  near: number,
  name: string,
  init: Record<string, unknown>,
): Promise<void> {
  await ensureAccount(accountId, near);
  const { code, hash } = wasm(name);
  const account = signer(accountId);
  const state = await viewAccount(accountId);
  if (state?.code_hash !== hash) {
    await account.deployContract(code);
    console.log(`deployed ${name}.wasm to ${accountId} (${hash})`);
  } else {
    console.log(`${accountId}: code up to date`);
  }
  if (!(await hasState(accountId))) {
    await account.callFunction({ contractId: accountId, methodName: "new", args: init, gas: teraToGas("100") });
    console.log(`initialized ${accountId}`);
  }
}

function upsertEnv(file: string, values: Record<string, string>): void {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  for (const [name, value] of Object.entries(values)) {
    const line = `${name}=${value}`;
    const i = lines.findIndex((l) => l.startsWith(`${name}=`));
    if (i >= 0) lines[i] = line;
    else {
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      lines.push(line, "");
    }
  }
  writeFileSync(file, lines.join("\n"), { mode: 0o600 });
}

/** The keeper's function-call key: reused if it is still on the keeper account, else replaced. */
async function ensureKeeperKey(): Promise<string> {
  const existing = optionalEnv("KEEPER_PRIVATE_KEY") as KeyPairString | undefined;
  const { keys } = await signer(ids.keeper).getAccessKeyList();
  if (existing) {
    const publicKey = KeyPair.fromString(existing).getPublicKey().toString();
    const onChain = keys.find((k) => k.public_key === publicKey)?.access_key.permission;
    if (
      onChain &&
      typeof onChain === "object" &&
      "FunctionCall" in onChain &&
      onChain.FunctionCall.receiver_id === ids.ketos
    ) {
      console.log(`keeper key present on ${ids.keeper}`);
      return existing;
    }
  }
  // Revoke keys whose secret was lost, so only the key in .env.local can act as keeper.
  for (const k of keys) {
    const permission = k.access_key.permission;
    if (typeof permission === "object" && "FunctionCall" in permission) {
      await signer(ids.keeper).deleteKey(k.public_key);
      console.log(`revoked stale keeper key on ${ids.keeper}`);
    }
  }
  const keyPair = KeyPair.fromRandom("ed25519");
  await signer(ids.keeper).addFunctionCallAccessKey({
    publicKey: keyPair.getPublicKey(),
    contractId: ids.ketos,
    methodNames: KEEPER_METHODS,
  });
  console.log(`added keeper function-call key on ${ids.keeper} (${KEEPER_METHODS.join(", ")})`);
  return keyPair.toString();
}

async function ensureRegistered(accountId: string): Promise<void> {
  const balance = await view(ids.usdc, "storage_balance_of", { account_id: accountId });
  if (balance) return;
  await parent.callFunction({
    contractId: ids.usdc,
    methodName: "storage_deposit",
    args: { account_id: accountId },
    deposit: nearToYocto("0.0125"),
  });
  console.log(`registered ${accountId} on ${ids.usdc}`);
}

async function seedVault(): Promise<void> {
  const vault = await view<{ total_shares: string }>(ids.ketos, "get_vault");
  if (BigInt(vault.total_shares) > 0n) {
    console.log("vault already seeded");
    return;
  }
  await parent.callFunction({
    contractId: ids.usdc,
    methodName: "mint",
    args: { account_id: parentId, amount: VAULT_SEED.toString() },
  });
  await parent.callFunction({
    contractId: ids.usdc,
    methodName: "ft_transfer_call",
    args: { receiver_id: ids.ketos, amount: VAULT_SEED.toString(), msg: "deposit_vault" },
    deposit: 1n,
    gas: teraToGas("100"),
  });
  console.log(`seeded the vault with ${VAULT_SEED / USD} tUSDC`);
}

async function topUpKetos(): Promise<void> {
  const state = await signer(ids.ketos).getState();
  if (state.balance.available >= KETOS_MIN_AVAILABLE) return;
  const amount = KETOS_MIN_AVAILABLE - state.balance.available + nearToYocto("1");
  await parent.signAndSendTransaction({ receiverId: ids.ketos, actions: [actions.transfer(amount)] });
  console.log(`topped up ${ids.ketos} for oracle requests`);
}

await ensureContract(ids.usdc, BALANCES.usdc, "mock_usdc", { owner_id: parentId });
await ensureAccount(ids.keeper, BALANCES.keeper);
await ensureContract(ids.ketos, BALANCES.ketos, "ketos", {
  usdc_id: ids.usdc,
  oracle_id: ORACLE_ID,
  keeper_id: ids.keeper,
});
const keeperKey = await ensureKeeperKey();
await ensureRegistered(ids.ketos);
await ensureRegistered(parentId);
await seedVault();
await topUpKetos();

const deployment = {
  network: "testnet",
  owner: nearAccountId(),
  ketos: ids.ketos,
  usdc: ids.usdc,
  oracle: ORACLE_ID,
  keeper: ids.keeper,
  rpc: rpcUrl,
};
mkdirSync(root("deployments"), { recursive: true });
writeFileSync(root("deployments/testnet.json"), `${JSON.stringify(deployment, null, 2)}\n`);

upsertEnv(root(".env.local"), { KEEPER_PRIVATE_KEY: keeperKey });
const webEnv: Record<string, string> = {
  NEXT_PUBLIC_NEAR_NETWORK: "testnet",
  NEXT_PUBLIC_KETOS_CONTRACT: ids.ketos,
  NEXT_PUBLIC_USDC_CONTRACT: ids.usdc,
  NEXT_PUBLIC_RPC_URL: rpcUrl,
  KEEPER_PRIVATE_KEY: keeperKey,
};
const jwt = optionalEnv("ONECLICK_JWT");
if (jwt) webEnv.ONECLICK_JWT = jwt;
upsertEnv(root("web/.env.local"), webEnv);

const markets = await view<unknown[]>(ids.ketos, "get_markets");
console.log(`\n${ids.ketos}: ${markets.length} markets, deployments/testnet.json and .env.local files updated`);
