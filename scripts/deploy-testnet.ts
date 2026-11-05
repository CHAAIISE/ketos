// Deploys Ketos V2 to the dedicated testnet accounts. Unchanged V2 deployments issue no transactions.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, PublicKey, actions, nearToYocto, teraToGas } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { loadEnv, nearAccountId, optionalEnv, requireEnv } from "./lib/env.ts";

const ORACLE_ID = "price-oracle.testnet";
const OUTLAYER_ID = "outlayer.testnet";
const KEEPER_METHODS = [
  "refresh_prices", "set_depth", "liquidate", "liquidate_cross",
  "execute_orders", "settle_funding", "snapshot_vaults",
];
const USD = 1_000_000n;
const VAULT_SEED = 10_000n * USD;
const BALANCES = { usdc: 3, keeper: 3 };
const PREFLIGHT_MIN_AVAILABLE = nearToYocto("10");
const KETOS_MIN_AVAILABLE = nearToYocto("2");
const BURNER_HEADROOM = nearToYocto("2");
const TRANSFER_GAS_HEADROOM = nearToYocto("0.01");
const DEPLOY_HEADROOM = nearToYocto("0.5");
const STORAGE_PRICE_PER_BYTE = 10n ** 19n;
const CORE_MARKETS = ["BTC", "ETH", "NEAR", "SOL"];
const TEE_MARKETS = [...CORE_MARKETS, "ZEC", "AURORA", "RHEA"];
const WORKER_MARKETS = ["DOGE", "XRP", "LTC", "ADA", "SUI", "TRX", "BNB", "AVAX", "LINK"];
const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

type AccountView = { amount: string; code_hash: string; storage_usage: number };
type RpcResult<T> = { result?: T; error?: { cause?: { name?: string } } };
type ContractState = { account: AccountView | null; initialized: boolean };
type Vault = { balance: string; nav: string; total_shares: string; cross_receivable: string };
type VaultAccount = { shares: string };
type Market = { id: string; price_source: string; vault_id: string; max_leverage_cap: number };

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
  chmodSync(file, 0o600);
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

function near(amount: bigint): string {
  const unit = 10n ** 24n;
  const fraction = (amount % unit).toString().padStart(24, "0").replace(/0+$/, "");
  return `${amount / unit}${fraction ? `.${fraction}` : ""} NEAR`;
}

async function main(): Promise<void> {
  loadEnv();
  const parentId = "ketos.testnet";
  const parentKey = requireEnv("KETOS_PRIVATE_KEY") as KeyPairString;
  const parentPublicKey = KeyPair.fromString(parentKey).getPublicKey();
  const rpcUrl = optionalEnv("NEAR_RPC_URL") ?? "https://test.rpc.fastnear.com";
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const ids = { usdc: `usdc.${parentId}`, ketos: parentId, keeper: `keeper.${parentId}` };
  const config = { usdc_id: ids.usdc, oracle_id: ORACLE_ID, outlayer_id: OUTLAYER_ID, keeper_id: ids.keeper };
  // Subaccounts retain the deployment key locally; only the restricted keeper key is propagated.
  const signer = (accountId: string) => new Account(accountId, provider, parentKey);
  const parent = signer(parentId);
  const artifacts = { usdc: wasm("mock_usdc"), ketos: wasm("ketos") };
  const fundingAccountId = nearAccountId();
  if (fundingAccountId === parentId) {
    throw new Error("Vault seeding requires a separate NEAR_ACCOUNT_ID LP account and its NEAR_PRIVATE_KEY; NEP-141 forbids transfers to the sender itself.");
  }
  const seedAccountId = fundingAccountId;
  const seedPrivateKey = requireEnv("NEAR_PRIVATE_KEY") as KeyPairString;
  const seedAccount = new Account(seedAccountId, provider, seedPrivateKey);

  async function rpc<T>(method: string, params: object): Promise<T | null> {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
    const r = (await res.json()) as RpcResult<T>;
    if (r.error?.cause?.name === "UNKNOWN_ACCOUNT") return null;
    if (!r.result) throw new Error(`RPC ${method}: ${r.error?.cause?.name ?? "missing result"}`);
    return r.result;
  }

  async function viewAccount(accountId: string): Promise<AccountView | null> {
    return rpc<AccountView>("query", { request_type: "view_account", finality: "final", account_id: accountId });
  }

  async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await provider.callFunction({ contractId, method, args })) as T;
  }

  async function inspectContract(accountId: string, hash: string): Promise<ContractState> {
    const account = await viewAccount(accountId);
    if (!account) return { account, initialized: false };
    const state = await rpc<{ values: unknown[] }>("query", {
      request_type: "view_state", finality: "final", account_id: accountId,
      prefix_base64: "U1RBVEU=", // near-sdk's root STATE key
    });
    if (!state) throw new Error(`${accountId}: account disappeared during preflight`);
    const initialized = state.values.length > 0;
    if (initialized && account.code_hash !== hash) {
      throw new Error(`${accountId}: initialized state and changed wasm; deployment refused. Use a fresh account or a separately reviewed state-compatible upgrade. No automatic migration is provided.`);
    }
    return { account, initialized };
  }

  async function validateKetos(): Promise<void> {
    const actual = await view<Record<string, unknown>>(ids.ketos, "get_config");
    for (const [name, expected] of Object.entries(config)) {
      if (actual[name] !== expected) throw new Error(`${ids.ketos}: incompatible ${name}; expected ${expected}`);
    }
    const markets = await view<Market[]>(ids.ketos, "get_markets");
    const expectedIds = [...TEE_MARKETS, ...WORKER_MARKETS];
    if (markets.length < 16 || new Set(markets.map((m) => m.id)).size !== markets.length) {
      throw new Error(`${ids.ketos}: expected all 16 unique default V2 markets`);
    }
    for (const id of expectedIds) {
      const market = markets.find((m) => m.id === id);
      const worker = WORKER_MARKETS.includes(id);
      if (!market || market.price_source !== (worker ? "outlayer_worker" : "tee") ||
          market.vault_id !== (CORE_MARKETS.includes(id) ? "core" : "long-tail") ||
          market.max_leverage_cap !== (worker ? 5 : 20)) {
        throw new Error(`${ids.ketos}: incompatible default V2 market ${id}`);
      }
    }
    for (const vaultId of ["core", "long-tail"] as const) {
      const vault = await view<Vault>(ids.ketos, "get_vault", { vault_id: vaultId });
      if (typeof vault.cross_receivable !== "string" || typeof vault.total_shares !== "string") {
        throw new Error(`${ids.ketos}: incompatible V2 ${vaultId} vault state`);
      }
      await view<VaultAccount>(ids.ketos, "get_vault_account", { vault_id: vaultId, account_id: seedAccountId });
    }
  }

  async function assertDeploymentKey(accountId: string): Promise<void> {
    const { keys } = await signer(accountId).getAccessKeyList();
    if (!keys.some((key) => key.public_key === parentPublicKey.toString() && key.access_key.permission === "FullAccess")) {
      throw new Error(`${accountId}: KETOS_PRIVATE_KEY must match an existing full-access deployment key`);
    }
  }

  // Complete read-only compatibility checks before funding, account creation or code changes.
  const ketosState = await inspectContract(ids.ketos, artifacts.ketos.hash);
  if (!ketosState.account) throw new Error(`${ids.ketos}: create the dedicated testnet account and set KETOS_PRIVATE_KEY first`);
  const usdcState = await inspectContract(ids.usdc, artifacts.usdc.hash);
  const keeperState = await viewAccount(ids.keeper);
  await assertDeploymentKey(parentId);
  if (usdcState.account) await assertDeploymentKey(ids.usdc);
  if (keeperState) await assertDeploymentKey(ids.keeper);
  const seedPublicKey = KeyPair.fromString(seedPrivateKey).getPublicKey().toString();
  const seedKeys = await seedAccount.getAccessKeyList();
  if (!seedKeys.keys.some((key) => key.public_key === seedPublicKey && key.access_key.permission === "FullAccess")) {
    throw new Error(`${seedAccountId}: NEAR_PRIVATE_KEY must match a full-access LP key`);
  }
  if (ketosState.initialized) await validateKetos();
  if (usdcState.initialized) {
    const owner = await view<string>(ids.usdc, "owner_id");
    if (owner !== parentId) throw new Error(`${ids.usdc}: incompatible token owner; expected ${parentId}`);
  }

  async function topUpKetos(required: bigint): Promise<void> {
    const state = await parent.getState();
    const available = state.balance.available;
    console.log(`funding preflight: ${ids.ketos} available ${near(available)}, required ${near(required)}`);
    if (available >= required) return;
    const amount = required - available;
    const burnerId = fundingAccountId;
    const burnerBalance = (await seedAccount.getState()).balance.available;
    const requiredBurner = amount + BURNER_HEADROOM + TRANSFER_GAS_HEADROOM;
    const balances = `${ids.ketos} available ${near(available)}, required ${near(required)}, top-up ${near(amount)}; burner ${burnerId} available ${near(burnerBalance)}, needs ${near(requiredBurner)} including ${near(BURNER_HEADROOM)} reserve and ${near(TRANSFER_GAS_HEADROOM)} gas headroom`;
    if (burnerBalance < requiredBurner) throw new Error(`Funding unavailable: insufficient burner balance; ${balances}`);
    await seedAccount.signAndSendTransaction({ receiverId: ids.ketos, actions: [actions.transfer(amount)], waitUntil: "FINAL" });
    const funded = (await parent.getState()).balance.available;
    if (funded < required) throw new Error(`Funding incomplete: ${ids.ketos} available ${near(funded)}, required ${near(required)}`);
    console.log(`funded ${ids.ketos} from ${burnerId}: ${near(amount)}; available ${near(funded)}`);
  }

  const childTransfers = (usdcState.account ? 0n : nearToYocto(BALANCES.usdc)) +
    (keeperState ? 0n : nearToYocto(BALANCES.keeper));
  // A fresh Ketos wasm locks about 4.8 NEAR in storage. Reserve it BEFORE sending child funds.
  const codeStorage = ketosState.account.code_hash === artifacts.ketos.hash
    ? 0n : BigInt(artifacts.ketos.code.length) * STORAGE_PRICE_PER_BYTE;
  const deploymentRequired = !ketosState.initialized || !usdcState.initialized || !keeperState;
  const deploymentBudget = childTransfers + codeStorage +
    (deploymentRequired ? DEPLOY_HEADROOM : 0n) + KETOS_MIN_AVAILABLE;
  // The 10 NEAR bootstrap preflight is not a recurring balance target for a no-op rerun.
  const required = deploymentRequired && PREFLIGHT_MIN_AVAILABLE > deploymentBudget
    ? PREFLIGHT_MIN_AVAILABLE : deploymentBudget;
  await topUpKetos(required);

  async function ensureAccount(accountId: string, balance: number, existing: AccountView | null): Promise<void> {
    if (existing) return;
    await parent.signAndSendTransaction({
      receiverId: accountId,
      actions: [
        actions.createAccount(), actions.transfer(nearToYocto(balance)), actions.addFullAccessKey(parentPublicKey),
      ],
      waitUntil: "FINAL",
    });
    console.log(`created ${accountId} (${balance} NEAR)`);
  }

  async function ensureContract(
    accountId: string, artifact: { code: Uint8Array; hash: string }, state: ContractState,
    init: Record<string, unknown>,
  ): Promise<void> {
    const pending = [];
    if (state.account?.code_hash !== artifact.hash) pending.push(actions.deployContract(artifact.code));
    if (!state.initialized) pending.push(actions.functionCall("new", init, teraToGas("100")));
    if (pending.length === 0) {
      console.log(`${accountId}: initialized code up to date`);
      return;
    }
    // Code and initialization are atomic on fresh accounts; existing initialized code is never overwritten.
    await signer(accountId).signAndSendTransaction({ receiverId: accountId, actions: pending, waitUntil: "FINAL" });
    console.log(`${accountId}: deployed/initialized (${artifact.hash})`);
  }

  await ensureAccount(ids.usdc, BALANCES.usdc, usdcState.account);
  await ensureAccount(ids.keeper, BALANCES.keeper, keeperState);
  await ensureContract(ids.usdc, artifacts.usdc, usdcState, { owner_id: parentId });
  await ensureContract(ids.ketos, artifacts.ketos, ketosState, config);
  await validateKetos();

  async function ensureKeeperKey(): Promise<string> {
    const account = signer(ids.keeper);
    const { keys } = await account.getAccessKeyList();
    let secret = optionalEnv("KEEPER_PRIVATE_KEY") as KeyPairString | undefined;
    let keyPair = secret ? KeyPair.fromString(secret) : undefined;
    let current = keyPair ? keys.find((key) => key.public_key === keyPair!.getPublicKey().toString()) : undefined;
    // Never propagate a full-access key, even if it was accidentally configured as the keeper secret.
    if (!keyPair || current?.access_key.permission === "FullAccess" ||
        keyPair.getPublicKey().toString() === parentPublicKey.toString() ||
        secret === optionalEnv("NEAR_PRIVATE_KEY")) {
      keyPair = KeyPair.fromRandom("ed25519");
      secret = keyPair.toString();
      // Persist before ANY on-chain operation, including add-key, so later failures cannot lose it.
      upsertEnv(root(".env.local"), { KEEPER_PRIVATE_KEY: secret });
      current = undefined;
    } else {
      upsertEnv(root(".env.local"), { KEEPER_PRIVATE_KEY: secret! });
    }
    const publicKey = keyPair.getPublicKey();
    const permission = current?.access_key.permission;
    const functionCall = permission && typeof permission === "object" && "FunctionCall" in permission
      ? permission.FunctionCall : undefined;
    const valid = functionCall?.receiver_id === ids.ketos &&
      functionCall.method_names.length === KEEPER_METHODS.length &&
      new Set(functionCall.method_names).size === KEEPER_METHODS.length &&
      KEEPER_METHODS.every((method) => functionCall.method_names.includes(method));
    if (!valid) {
      // Replace outdated restrictions atomically, retaining the persisted secret and full-access recovery key.
      await account.signAndSendTransaction({
        receiverId: ids.keeper,
        actions: [
          ...(current ? [actions.deleteKey(publicKey)] : []),
          actions.addFunctionCallAccessKey(publicKey, ids.ketos, KEEPER_METHODS),
        ],
        waitUntil: "FINAL",
      });
      console.log(`${ids.keeper}: installed the seven-method restricted keeper key`);
    } else {
      console.log(`${ids.keeper}: seven-method restricted keeper key up to date`);
    }
    // Revoke lost restricted keys only AFTER the persisted replacement is usable.
    for (const key of keys) {
      if (key.public_key !== publicKey.toString() && typeof key.access_key.permission === "object" &&
          "FunctionCall" in key.access_key.permission) {
        await account.signAndSendTransaction({
          receiverId: ids.keeper,
          actions: [actions.deleteKey(PublicKey.fromString(key.public_key))],
          waitUntil: "FINAL",
        });
        console.log(`${ids.keeper}: revoked stale restricted keeper key`);
      }
    }
    return secret!;
  }

  const keeperKey = await ensureKeeperKey();

  async function ensureRegistered(accountId: string): Promise<void> {
    if (await view(ids.usdc, "storage_balance_of", { account_id: accountId })) return;
    await parent.callFunction({
      contractId: ids.usdc, methodName: "storage_deposit", args: { account_id: accountId },
      deposit: nearToYocto("0.0125"), waitUntil: "FINAL",
    });
    console.log(`registered ${accountId} on ${ids.usdc}`);
  }

  async function seedVault(vaultId: "core" | "long-tail"): Promise<void> {
    const args = { vault_id: vaultId };
    const accountArgs = { ...args, account_id: seedAccountId };
    const vault = await view<Vault>(ids.ketos, "get_vault", args);
    const held = await view<VaultAccount>(ids.ketos, "get_vault_account", accountArgs);
    if (BigInt(vault.total_shares) > 0n) {
      if (BigInt(held.shares) < VAULT_SEED) {
        throw new Error(`${vaultId}: nonempty vault without the full 10000 USDC deployment seed shares; refusing to report or repeat seeding`);
      }
      console.log(`${vaultId}: 10000 USDC deployment seed shares already present`);
      return;
    }
    const keeper = new Account(ids.keeper, provider, keeperKey as KeyPairString);
    await keeper.callFunction({
      contractId: ids.ketos, methodName: "refresh_prices", args: {},
      gas: teraToGas("300"), waitUntil: "FINAL",
    });
    const markets = await view<(Market & { price: string; price_timestamp_ms: number })[]>(ids.ketos, "get_markets");
    const block = await provider.viewBlock({ finality: "final" });
    const nowMs = Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
    if (markets.some((market) => market.vault_id === vaultId &&
        (BigInt(market.price) === 0n || nowMs - market.price_timestamp_ms > 120_000))) {
      throw new Error(`${vaultId}: every assigned market needs a fresh price before the LP seed; no seed transfer sent`);
    }
    const balance = BigInt(await view<string>(ids.usdc, "ft_balance_of", { account_id: seedAccountId }));
    if (balance < VAULT_SEED) {
      await parent.callFunction({
        contractId: ids.usdc, methodName: "mint",
        args: { account_id: seedAccountId, amount: (VAULT_SEED - balance).toString() }, waitUntil: "FINAL",
      });
    }
    const accepted = await seedAccount.callFunction<string>({
      contractId: ids.usdc, methodName: "ft_transfer_call",
      args: { receiver_id: ids.ketos, amount: VAULT_SEED.toString(), msg: `deposit_vault:${vaultId}` },
      deposit: 1n, gas: teraToGas("100"), waitUntil: "FINAL",
    });
    if (accepted !== VAULT_SEED.toString()) {
      throw new Error(`${vaultId}: seed transfer did not accept all 10000 USDC (refunded or partially accepted); no seed success recorded`);
    }
    const after = await view<Vault>(ids.ketos, "get_vault", args);
    const owned = await view<VaultAccount>(ids.ketos, "get_vault_account", accountArgs);
    if (BigInt(after.total_shares) - BigInt(vault.total_shares) !== VAULT_SEED + BigInt(vault.nav) ||
        BigInt(owned.shares) - BigInt(held.shares) !== VAULT_SEED ||
        BigInt(after.balance) - BigInt(vault.balance) !== VAULT_SEED) {
      throw new Error(`${vaultId}: accepted seed but vault balance/share deltas do not match 10000 USDC; inspect on-chain state before retrying`);
    }
    console.log(`seeded ${vaultId}: ${VAULT_SEED / USD} USDC accepted and matching LP shares verified`);
  }

  await ensureRegistered(ids.ketos);
  await seedVault("core");
  await seedVault("long-tail");
  const remaining = (await parent.getState()).balance.available;
  if (remaining < KETOS_MIN_AVAILABLE) {
    await topUpKetos(KETOS_MIN_AVAILABLE);
  }

  const deployment = {
    network: "testnet", owner: fundingAccountId, ketos: ids.ketos, usdc: ids.usdc,
    oracle: ORACLE_ID, outlayer: OUTLAYER_ID, keeper: ids.keeper, rpc: rpcUrl,
  };
  mkdirSync(root("deployments"), { recursive: true });
  writeFileSync(root("deployments/testnet.json"), `${JSON.stringify(deployment, null, 2)}\n`);
  const webEnv: Record<string, string> = {
    NEXT_PUBLIC_NEAR_NETWORK: "testnet", NEXT_PUBLIC_KETOS_CONTRACT: ids.ketos,
    NEXT_PUBLIC_USDC_CONTRACT: ids.usdc, NEXT_PUBLIC_RPC_URL: rpcUrl, KEEPER_PRIVATE_KEY: keeperKey,
  };
  for (const name of ["ONECLICK_JWT", "OUTLAYER_PAYMENT_KEY"]) {
    const value = optionalEnv(name);
    if (value) webEnv[name] = value;
  }
  upsertEnv(root("web/.env.local"), webEnv);
  const markets = await view<Market[]>(ids.ketos, "get_markets");
  console.log(`\n${ids.ketos}: ${markets.length} V2 markets, two verified vault seeds; deployment manifest and local env files updated`);
}

void main().catch((error: unknown) => {
  // SDK/RPC errors can contain transaction context; never emit raw errors or stacks containing credentials.
  let message = error instanceof Error ? error.message : "Deployment failed";
  for (const name of ["KETOS_PRIVATE_KEY", "NEAR_PRIVATE_KEY", "KEEPER_PRIVATE_KEY", "OUTLAYER_PAYMENT_KEY", "ONECLICK_JWT", "NEAR_RPC_URL"]) {
    const value = optionalEnv(name);
    if (value) message = message.replaceAll(value, "[REDACTED]");
  }
  message = message.replace(/ed25519:[1-9A-HJ-NP-Za-km-z]+/g, "[REDACTED]");
  console.error(`Deployment failed: ${message}`);
  process.exitCode = 1;
});
