// Deploys Ketos V3 and retires unsupported markets atomically, without resetting initialized state.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, PublicKey, actions, nearToYocto, teraToGas } from "near-api-js";
import type { AccessKeyList, KeyPairString } from "near-api-js";
import { loadEnv, nearAccountId, optionalEnv, requireEnv } from "./lib/env.ts";
import { deployFaucet } from "./deploy-faucet.ts";

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
const EMPTY_CODE_HASH = "11111111111111111111111111111111";
const LEGACY_KETOS_HASH = "FbrFuxkZHjKJEsUoorjrXe8vAdPi949EL6Dq3kRgaKq8";
const LEGACY_USDC_HASH = "44Vnm1rH3LDCgMF4ZMA9Wunz2VwSwYvTL6igshLgJsvR";
const PREVIOUS_USDC_HASH = "Haq6T2sMW2K58F3sGen8zEKJMpBiW5tHo14w39nZUSFr";
const CORE_MARKETS = ["BTC", "ETH", "NEAR", "SOL"];
const TEE_MARKETS = [...CORE_MARKETS, "ZEC"];
const RETIRED_MARKETS = ["AURORA", "RHEA"];
const WORKER_MARKETS = ["DOGE", "XRP", "LTC", "ADA", "SUI", "TRX", "BNB", "AVAX", "LINK"];
const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

type AccountView = { amount: string; code_hash: string; storage_usage: number };
type RpcResult<T> = { result?: T; error?: { cause?: { name?: string } } };
type RawState = { values: { key: string; value: string }[]; block_hash: string; block_height: number };
type ContractState = { account: AccountView | null; initialized: boolean; raw: RawState | null; codeBytes: number };
type Vault = {
  balance: string; nav: string; total_shares: string; cross_receivable: string;
  revenue: Record<string, string>;
};
type VaultAccount = { shares: string };
type Market = {
  id: string; oracle_asset_id: string; oi_long: string; oi_short: string;
  price_source: string; vault_id: string; max_leverage_cap: number; max_leverage: number;
  price: string; price_timestamp_ms: number; created_at_ms?: number; leverage_increased_at_ms?: number;
  measured_cap_is_grid_max?: boolean; vault_backed_cap_usd?: string; effective_max_oi_per_side?: string;
  close_only?: boolean; stale_close_spread_bps?: number;
};

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

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function readBorshBytes(bytes: Buffer, cursor: { offset: number }): Buffer {
  if (cursor.offset + 4 > bytes.length) throw new Error("Truncated Borsh length");
  const length = bytes.readUInt32LE(cursor.offset);
  cursor.offset += 4;
  if (cursor.offset + length > bytes.length) throw new Error("Truncated Borsh value");
  const value = bytes.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return value;
}

type IterableHandle = { length: number; lengthOffset: number; vector: Buffer; values: Buffer };

function ketosHandles(raw: RawState): { root: Buffer; markets: IterableHandle; positions: IterableHandle; orders: IterableHandle } {
  const entry = raw.values.find((item) => Buffer.from(item.key, "base64").equals(Buffer.from("STATE")));
  if (!entry) throw new Error("Ketos root state missing");
  const root = Buffer.from(entry.value, "base64");
  const cursor = { offset: 0 };
  for (let index = 0; index < 4; index++) readBorshBytes(root, cursor);
  function iterable(): IterableHandle {
    const lengthOffset = cursor.offset;
    const length = root.readUInt32LE(cursor.offset);
    cursor.offset += 4;
    return { length, lengthOffset, vector: readBorshBytes(root, cursor), values: readBorshBytes(root, cursor) };
  }
  const markets = iterable();
  readBorshBytes(root, cursor); // Oracle lookup map.
  readBorshBytes(root, cursor); // Accounts lookup map.
  const positions = iterable();
  cursor.offset += 8; // Next position id.
  const orders = iterable();
  if (![0, 15].some((prefix) => markets.vector.equals(Buffer.from([prefix, 118])) &&
      markets.values.equals(Buffer.from([prefix, 109]))) ||
      !positions.vector.equals(Buffer.from([2, 118])) ||
      !positions.values.equals(Buffer.from([2, 109])) ||
      ![7, 16].some((prefix) => orders.vector.equals(Buffer.from([prefix, 118])) &&
        orders.values.equals(Buffer.from([prefix, 109])))) {
    throw new Error("Unknown Ketos collection handles; refusing partial storage proof");
  }
  return { root, markets, positions, orders };
}

function vectorKey(handle: IterableHandle, index: number): string {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(index);
  return Buffer.concat([handle.vector, bytes]).toString("base64");
}

function mapKey(handle: IterableHandle, serializedKey: Buffer): string {
  return createHash("sha256").update(handle.values).update(serializedKey).digest("base64");
}

function iterableEntries(entries: Map<string, string>, handle: IterableHandle): { key: Buffer; value: Buffer }[] {
  const values: { key: Buffer; value: Buffer }[] = [];
  for (let index = 0; index < handle.length; index++) {
    const key = entries.get(vectorKey(handle, index));
    if (!key) throw new Error("Incomplete iterable key vector");
    const value = entries.get(mapKey(handle, Buffer.from(key, "base64")));
    if (!value) throw new Error("Incomplete iterable values");
    const bytes = Buffer.from(value, "base64");
    if (bytes.length < 4 || bytes.readUInt32LE(bytes.length - 4) !== index) {
      throw new Error("Iterable value index mismatch");
    }
    values.push({ key: Buffer.from(key, "base64"), value: bytes });
  }
  return values;
}

function retirementSnapshot(raw: RawState): { expected: Map<string, string>; retired: string[] } {
  const handles = ketosHandles(raw);
  const expected = new Map(raw.values.map((entry) => [entry.key, entry.value]));
  const positions = new Map<bigint, string>();
  for (const { key, value: bytes } of iterableEntries(expected, handles.positions)) {
    const cursor = { offset: 0 };
    readBorshBytes(bytes, cursor); // Owner.
    const market = readBorshBytes(bytes, cursor).toString("utf8");
    if (RETIRED_MARKETS.includes(market)) throw new Error(`Cannot retire ${market}: live position`);
    positions.set(key.readBigUInt64LE(), market);
  }
  for (const { value: bytes } of iterableEntries(expected, handles.orders)) {
    const cursor = { offset: 8 };
    readBorshBytes(bytes, cursor); // Owner.
    const kind = bytes[cursor.offset++];
    let market: string;
    if (kind === 0 || kind === 1) market = readBorshBytes(bytes, cursor).toString("utf8");
    else if (kind === 2 || kind === 3) {
      const position = positions.get(bytes.readBigUInt64LE(cursor.offset));
      if (!position) throw new Error("Orphan bracket order; refusing retirement");
      market = position;
    } else throw new Error("Unknown order variant; refusing retirement");
    if (RETIRED_MARKETS.includes(market)) throw new Error(`Cannot retire ${market}: live order`);
  }
  iterableEntries(expected, handles.markets);
  const retired: string[] = [];
  for (const id of RETIRED_MARKETS) {
    const serialized = borshString(id);
    const key = mapKey(handles.markets, serialized);
    const encoded = expected.get(key);
    if (!encoded) continue;
    const value = Buffer.from(encoded, "base64");
    const cursor = { offset: 0 };
    if (readBorshBytes(value, cursor).toString("utf8") !== id) throw new Error("Market key/value mismatch");
    const oracleAsset = readBorshBytes(value, cursor);
    const index = value.readUInt32LE(value.length - 4);
    const lastIndex = handles.markets.length - 1;
    if (expected.get(vectorKey(handles.markets, index)) !== serialized.toString("base64")) {
      throw new Error("Market vector/index mismatch");
    }
    if (index !== lastIndex) {
      const swapped = expected.get(vectorKey(handles.markets, lastIndex))!;
      expected.set(vectorKey(handles.markets, index), swapped);
      const swappedKey = mapKey(handles.markets, Buffer.from(swapped, "base64"));
      const swappedValue = Buffer.from(expected.get(swappedKey)!, "base64");
      swappedValue.writeUInt32LE(index, swappedValue.length - 4);
      expected.set(swappedKey, swappedValue.toString("base64"));
    }
    expected.delete(vectorKey(handles.markets, lastIndex));
    expected.delete(key);
    expected.delete(Buffer.concat([Buffer.from([3]), serialized]).toString("base64"));
    expected.delete(Buffer.concat([Buffer.from([6]), borshString(oracleAsset.toString("utf8"))]).toString("base64"));
    handles.markets.length--;
    retired.push(id);
  }
  handles.root.writeUInt32LE(handles.markets.length, handles.markets.lengthOffset);
  expected.set(Buffer.from("STATE").toString("base64"), handles.root.toString("base64"));
  return { expected, retired };
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
  const manifestPath = root("deployments/testnet.json");
  const previousDeployment = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")) as {
      network?: string; ketos?: string; usdc?: string; schema_version?: number;
      code_hashes?: { ketos?: string; usdc?: string };
    } : null;
  const previousKetosHash = previousDeployment?.network === "testnet" &&
    previousDeployment.ketos === ids.ketos && previousDeployment.usdc === ids.usdc &&
    previousDeployment.schema_version === 3 &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(previousDeployment.code_hashes?.ketos ?? "")
    ? previousDeployment.code_hashes!.ketos : undefined;
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

  const block = await rpc<{ header: { hash: string; height: number } }>("block", { finality: "final" });
  if (!block) throw new Error("Cannot pin a final preflight block");
  let preflight = true;
  const audit: {
    network: string; block_hash: string; block_height: number;
    accounts: Record<string, unknown>; views: { contract: string; method: string; args: object; result: unknown }[];
    share_holders: string[]; transactions: object[]; target_hashes: Record<string, string>; completed?: string;
    after?: Record<string, unknown>; preservation?: Record<string, unknown>;
  } = {
    network: "testnet", block_hash: block.header.hash, block_height: block.header.height,
    accounts: {}, views: [], share_holders: [], transactions: [],
    target_hashes: { ketos: artifacts.ketos.hash, usdc: artifacts.usdc.hash },
  };
  const auditPath = root(`out/deployments/deployment-${block.header.height}-${Date.now()}.json`);
  function saveAudit(): void {
    mkdirSync(root("out/deployments"), { recursive: true });
    writeFileSync(auditPath, `${JSON.stringify(audit, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value, 2)}\n`, { mode: 0o600 });
  }
  const queryBlock = () => preflight ? { block_id: block.header.hash } : { finality: "final" };
  const accessKeys = new Map<string, AccessKeyList>();

  async function viewAccount(accountId: string): Promise<AccountView | null> {
    return rpc<AccountView>("query", { request_type: "view_account", ...queryBlock(), account_id: accountId });
  }

  async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await rpc<{ result?: number[]; error?: string }>("query", {
      request_type: "call_function", ...queryBlock(), account_id: contractId, method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    if (!result?.result) throw new Error(`${contractId}.${method}: ${result?.error ?? "missing view result"}`);
    const value = JSON.parse(Buffer.from(result.result).toString("utf8")) as T;
    if (preflight) audit.views.push({ contract: contractId, method, args, result: value });
    return value;
  }

  async function inspectContract(accountId: string, targetHash: string, legacyHash: string, previousHash?: string): Promise<ContractState> {
    const account = await viewAccount(accountId);
    if (!account) {
      audit.accounts[accountId] = null;
      return { account, initialized: false, raw: null, codeBytes: 0 };
    }
    const raw = await rpc<RawState>("query", {
      request_type: "view_state", ...queryBlock(), account_id: accountId, prefix_base64: "", include_proof: false,
    });
    const code = await rpc<{ code_base64: string }>("query", {
      request_type: "view_code", ...queryBlock(), account_id: accountId,
    });
    const keys = await rpc<AccessKeyList>("query", {
      request_type: "view_access_key_list", ...queryBlock(), account_id: accountId,
    });
    if (!raw || !code || !keys) throw new Error(`${accountId}: incomplete preflight snapshot`);
    audit.accounts[accountId] = { account, raw_state: raw, code, access_keys: keys };
    accessKeys.set(accountId, keys);
    saveAudit();
    const bytes = Buffer.from(code.code_base64, "base64");
    const hash = base58(createHash("sha256").update(bytes).digest());
    if (bytes.length > 0 && hash !== account.code_hash) throw new Error(`${accountId}: code hash does not match snapshot`);
    const initialized = raw.values.some((entry) => Buffer.from(entry.key, "base64").equals(Buffer.from("STATE")));
    if (![EMPTY_CODE_HASH, targetHash, legacyHash, previousHash].includes(account.code_hash) ||
        (!initialized && raw.values.length > 0) ||
        (initialized && account.code_hash === EMPTY_CODE_HASH) ||
        (!initialized && (account.code_hash === legacyHash || account.code_hash === previousHash))) {
      throw new Error(`${accountId}: unknown code/state layout; refusing deployment`);
    }
    return { account, initialized, raw, codeBytes: bytes.length };
  }

  async function validateKetos(legacy = false, beforeRetirement = false): Promise<void> {
    const actual = await view<Record<string, unknown>>(ids.ketos, "get_config");
    for (const [name, expected] of Object.entries(config)) {
      if (actual[name] !== expected) throw new Error(`${ids.ketos}: incompatible ${name}; expected ${expected}`);
    }
    const markets = await view<Market[]>(ids.ketos, "get_markets");
    const expectedIds = [...TEE_MARKETS, ...WORKER_MARKETS];
    if (markets.length < expectedIds.length || new Set(markets.map((m) => m.id)).size !== markets.length) {
      throw new Error(`${ids.ketos}: expected all ${expectedIds.length} unique supported default markets`);
    }
    if (!beforeRetirement && markets.some((market) => RETIRED_MARKETS.includes(market.id))) {
      throw new Error(`${ids.ketos}: unsupported AURORA/RHEA markets remain registered`);
    }
    for (const id of expectedIds) {
      const market = markets.find((m) => m.id === id);
      const worker = WORKER_MARKETS.includes(id);
      if (!market || market.price_source !== (worker ? "outlayer_worker" : "tee") ||
          market.vault_id !== (CORE_MARKETS.includes(id) ? "core" : "long-tail") ||
          market.max_leverage_cap !== (legacy ? (worker ? 5 : 20) : (CORE_MARKETS.includes(id) ? 20 : 5))) {
        throw new Error(`${ids.ketos}: incompatible default ${legacy ? "V2" : "V3"} market ${id}`);
      }
    }
    if (!legacy) {
      for (const market of markets) {
        if (!Number.isSafeInteger(market.created_at_ms) || market.created_at_ms! <= 0 ||
            !Number.isSafeInteger(market.leverage_increased_at_ms) || market.leverage_increased_at_ms! < 0 ||
            typeof market.measured_cap_is_grid_max !== "boolean" ||
            !/^\d+$/.test(market.vault_backed_cap_usd ?? "") ||
            !/^\d+$/.test(market.effective_max_oi_per_side ?? "") ||
            typeof market.close_only !== "boolean" || !Number.isSafeInteger(market.stale_close_spread_bps) ||
            (market.vault_id === "long-tail" && (market.max_leverage_cap > 5 || market.max_leverage > 5))) {
          throw new Error(`${ids.ketos}: incompatible V3 fields or Long-tail leverage on ${market.id}`);
        }
      }
    }
    for (const vaultId of ["core", "long-tail"] as const) {
      const vault = await view<Vault>(ids.ketos, "get_vault", { vault_id: vaultId });
      if (typeof vault.cross_receivable !== "string" || typeof vault.total_shares !== "string") {
        throw new Error(`${ids.ketos}: incompatible ${vaultId} vault state`);
      }
      await view<VaultAccount>(ids.ketos, "get_vault_account", { vault_id: vaultId, account_id: seedAccountId });
    }
  }

  async function assertDeploymentKey(accountId: string): Promise<void> {
    const keys = await rpc<AccessKeyList>("query", {
      request_type: "view_access_key_list", ...queryBlock(), account_id: accountId,
    });
    if (!keys) throw new Error(`${accountId}: access-key snapshot unavailable`);
    accessKeys.set(accountId, keys);
    if (!keys.keys.some((key) => key.public_key === parentPublicKey.toString() && key.access_key.permission === "FullAccess")) {
      throw new Error(`${accountId}: KETOS_PRIVATE_KEY must match an existing full-access deployment key`);
    }
  }

  // Pin all compatibility, LP ownership, signer, token and key checks before ANY transaction.
  if (artifacts.ketos.hash === LEGACY_KETOS_HASH || [LEGACY_USDC_HASH, PREVIOUS_USDC_HASH].includes(artifacts.usdc.hash)) {
    throw new Error("Build the V3 Ketos and compatible mock-usdc artifacts before deployment");
  }
  const ketosState = await inspectContract(ids.ketos, artifacts.ketos.hash, LEGACY_KETOS_HASH, previousKetosHash);
  if (!ketosState.account) throw new Error(`${ids.ketos}: create the dedicated testnet account and set KETOS_PRIVATE_KEY first`);
  const usdcState = await inspectContract(ids.usdc, artifacts.usdc.hash, LEGACY_USDC_HASH, PREVIOUS_USDC_HASH);
  const keeperState = await viewAccount(ids.keeper);
  if (keeperState && keeperState.code_hash !== EMPTY_CODE_HASH) {
    throw new Error(`${ids.keeper}: unexpected contract code on the restricted keeper account`);
  }
  await assertDeploymentKey(parentId);
  if (usdcState.account) await assertDeploymentKey(ids.usdc);
  if (keeperState) await assertDeploymentKey(ids.keeper);
  audit.accounts[ids.keeper] = { account: keeperState, access_keys: accessKeys.get(ids.keeper) ?? null };
  const seedPublicKey = KeyPair.fromString(seedPrivateKey).getPublicKey().toString();
  const seedKeys = await rpc<AccessKeyList>("query", {
    request_type: "view_access_key_list", ...queryBlock(), account_id: seedAccountId,
  });
  audit.accounts[seedAccountId] = { account: await viewAccount(seedAccountId), access_keys: seedKeys };
  if (!seedKeys?.keys.some((key) => key.public_key === seedPublicKey && key.access_key.permission === "FullAccess")) {
    throw new Error(`${seedAccountId}: NEAR_PRIVATE_KEY must match a full-access LP key`);
  }
  const keeperSecret = optionalEnv("KEEPER_PRIVATE_KEY");
  if (keeperSecret) KeyPair.fromString(keeperSecret as KeyPairString);
  const migrating = ketosState.initialized && ketosState.account.code_hash === LEGACY_KETOS_HASH;
  const tokenUpgraded = usdcState.initialized && usdcState.account?.code_hash !== artifacts.usdc.hash;
  const retirement = ketosState.initialized ? retirementSnapshot(ketosState.raw!) : null;
  const upgradingKetos = ketosState.initialized && ketosState.account.code_hash !== artifacts.ketos.hash;
  const changingKetos = upgradingKetos || (retirement?.retired.length ?? 0) > 0;
  if (changingKetos && !process.argv.includes("--quiescent")) {
    throw new Error("Stop your keeper/submissions and rerun with --quiescent; stable snapshots cannot enumerate pending external receipts");
  }
  if (ketosState.initialized && !usdcState.initialized) {
    throw new Error("Initialized Ketos requires its existing token; refusing custody replacement");
  }
  if (tokenUpgraded && !ketosState.initialized) {
    throw new Error("An existing token upgrade requires preserved Ketos vaults; refusing simultaneous bootstrap/seeding");
  }
  const marketsBefore = ketosState.initialized ? await view<Market[]>(ids.ketos, "get_markets") : [];
  if (ketosState.initialized) {
    await validateKetos(migrating, true);
    for (const market of marketsBefore) {
      if (RETIRED_MARKETS.includes(market.id) && (BigInt(market.oi_long) !== 0n || BigInt(market.oi_short) !== 0n)) {
        throw new Error(`Cannot retire ${market.id}: nonzero open interest`);
      }
    }
  }
  const vaultsBefore = new Map<string, Vault>();
  let tokenSupplyBefore: string | undefined;
  let tokenCustodyBefore: string | undefined;
  if (usdcState.initialized) {
    const owner = await view<string>(ids.usdc, "owner_id");
    if (owner !== parentId) throw new Error(`${ids.usdc}: incompatible token owner; expected ${parentId}`);
    const metadata = await view<{ decimals: number; symbol: string }>(ids.usdc, "ft_metadata");
    if (metadata.decimals !== 6 || metadata.symbol !== "tUSDC") throw new Error("Incompatible testnet USDC metadata");
    if (usdcState.account?.code_hash === artifacts.usdc.hash) {
      const faucet = await view<{ faucet_id: string }>(ids.usdc, "faucet_config");
      if (faucet.faucet_id !== `faucet.${parentId}`) throw new Error("Token has an incompatible immutable faucet account");
    }
    tokenSupplyBefore = await view<string>(ids.usdc, "ft_total_supply");
    tokenCustodyBefore = await view<string>(ids.usdc, "ft_balance_of", { account_id: ids.ketos });
    await view<string>(ids.usdc, "ft_balance_of", { account_id: seedAccountId });
    const registration = await view(ids.usdc, "storage_balance_of", { account_id: ids.ketos });
    if (ketosState.initialized && !registration) {
      throw new Error("Ketos token registration missing; refusing a mutating token repair during upgrade");
    }
  }
  const shareHolders = new Set<string>();
  const legacyShares = [new Map<string, bigint>(), new Map<string, bigint>()];
  if (migrating) {
    for (const entry of ketosState.raw!.values) {
      const key = Buffer.from(entry.key, "base64");
      // V2 LookupMap uses Identity keys: StorageKey::VaultShares (5), VaultId, Borsh AccountId.
      if (key[0] !== 5 || (key[1] !== 0 && key[1] !== 1)) continue;
      const value = Buffer.from(entry.value, "base64");
      if (key.length < 6 || key.readUInt32LE(2) !== key.length - 6 || value.length !== 16) {
        throw new Error("Malformed V2 LP storage; refusing partial holder enumeration");
      }
      const accountId = key.subarray(6).toString("utf8");
      if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(accountId) || accountId.length < 2 || accountId.length > 64) {
        throw new Error("Malformed V2 LP account id");
      }
      const amount = value.readBigUInt64LE(0) + (value.readBigUInt64LE(8) << 64n);
      if (legacyShares[key[1]].has(accountId)) throw new Error("Duplicate V2 LP holder storage key");
      legacyShares[key[1]].set(accountId, amount);
      if (amount > 0n) shareHolders.add(accountId);
    }
  }
  if (ketosState.initialized) {
    for (const [index, vaultId] of ["core", "long-tail"].entries()) {
      const vault = await view<Vault>(ids.ketos, "get_vault", { vault_id: vaultId });
      vaultsBefore.set(vaultId, vault);
      const held = await view<VaultAccount>(ids.ketos, "get_vault_account", { vault_id: vaultId, account_id: seedAccountId });
      if (BigInt(vault.total_shares) > 0n && BigInt(held.shares) < VAULT_SEED) {
        throw new Error(`${vaultId}: nonempty vault without the full 10000 USDC deployment seed shares`);
      }
      if (BigInt(vault.total_shares) === 0n) {
        throw new Error(`${vaultId}: seed missing; state-preserving upgrades must not reseed`);
      }
      if (migrating) {
        let sum = 0n;
        for (const [accountId, amount] of legacyShares[index]) {
          const actual = await view<VaultAccount>(ids.ketos, "get_vault_account", { vault_id: vaultId, account_id: accountId });
          if (BigInt(actual.shares) !== amount) throw new Error(`${vaultId}: LP storage/view mismatch`);
          sum += amount;
        }
        if (sum !== BigInt(vault.total_shares)) throw new Error(`${vaultId}: incomplete LP holder enumeration`);
      }
    }
  }
  audit.share_holders = [...shareHolders].sort();
  const workerManifest = JSON.parse(readFileSync(root("deployments/worker-testnet.json"), "utf8")) as {
    price_signer?: string; price_signer_attestation_url?: string;
  };
  const priceSigner = workerManifest.price_signer;
  if (!priceSigner?.startsWith("ed25519:") || !workerManifest.price_signer_attestation_url?.startsWith(
    "https://testnet-api.outlayer.ai/attestations/",
  )) throw new Error("Worker manifest needs an attested TEE price signer before deployment");
  PublicKey.fromString(priceSigner);
  // The pinned V2 hash predates this view and has no signer field.
  const previousSigner = ketosState.initialized && !migrating
    ? await view<string | null>(ids.ketos, "get_price_signer") : null;
  if (previousSigner && previousSigner !== priceSigner) {
    throw new Error("Existing price signer differs from the attested worker; refusing rotation");
  }
  if (changingKetos && !migrating && previousSigner !== priceSigner) {
    throw new Error("State-preserving V3 upgrade requires the existing attested signer; refusing signer repair");
  }
  saveAudit();

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
  // Code replacement releases the old code's storage; charge only positive byte growth.
  const codeStorage = BigInt(Math.max(0, artifacts.ketos.code.length - ketosState.codeBytes)) * STORAGE_PRICE_PER_BYTE;
  const tokenCodeStorage = BigInt(Math.max(0, artifacts.usdc.code.length - usdcState.codeBytes)) * STORAGE_PRICE_PER_BYTE;
  const tokenAvailable = usdcState.account ? (await signer(ids.usdc).getState()).balance.available : nearToYocto(BALANCES.usdc);
  const tokenRequired = tokenCodeStorage + KETOS_MIN_AVAILABLE +
    (usdcState.account?.code_hash !== artifacts.usdc.hash ? DEPLOY_HEADROOM : 0n);
  const tokenTopUp = tokenAvailable < tokenRequired ? tokenRequired - tokenAvailable : 0n;
  // Migration writes new map prefixes before dropping the old maps. Bound that transient storage
  // with the full old key/value footprint plus per-entry overhead and the new fields.
  const migrationBytes = migrating ? ketosState.raw!.values.reduce((sum, entry) =>
    sum + Buffer.from(entry.key, "base64").length + Buffer.from(entry.value, "base64").length + 128, 4096) : 0;
  const migrationStorage = BigInt(migrationBytes) * STORAGE_PRICE_PER_BYTE;
  const bootstrap = !ketosState.initialized || !usdcState.initialized || !keeperState;
  const deploymentRequired = bootstrap || changingKetos || usdcState.account?.code_hash !== artifacts.usdc.hash;
  const deploymentBudget = childTransfers + tokenTopUp + codeStorage + migrationStorage +
    (deploymentRequired ? DEPLOY_HEADROOM : 0n) + KETOS_MIN_AVAILABLE;
  // The 10 NEAR bootstrap target is not charged again for an upgrade or a no-op rerun.
  const required = bootstrap && PREFLIGHT_MIN_AVAILABLE > deploymentBudget ? PREFLIGHT_MIN_AVAILABLE : deploymentBudget;
  saveAudit();
  preflight = false;
  // Recheck code identities after the potentially long snapshot; migration itself verifies LP sums
  // against transaction-time state, so a concurrent deposit cannot silently omit a holder.
  for (const [accountId, state] of [[ids.ketos, ketosState], [ids.usdc, usdcState]] as const) {
    const current = await viewAccount(accountId);
    if (current?.code_hash !== state.account?.code_hash) throw new Error(`${accountId}: code changed during preflight`);
  }
  if (changingKetos) {
    for (const [accountId, state] of [[ids.ketos, ketosState], [ids.usdc, usdcState]] as const) {
      const current = await rpc<RawState>("query", {
        request_type: "view_state", finality: "final", account_id: accountId,
        prefix_base64: "", include_proof: false,
      });
      const previous = new Map(state.raw!.values.map((entry) => [entry.key, entry.value]));
      if (!current || current.values.length !== previous.size ||
          current.values.some((entry) => previous.get(entry.key) !== entry.value)) {
        throw new Error(`${accountId}: storage changed during preflight; stop your submissions and retry`);
      }
      audit.accounts[`${accountId}:stable_predeploy`] = current;
    }
    saveAudit();
  }
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
    const changed = state.account?.code_hash !== artifact.hash;
    if (changed) pending.push(actions.deployContract(artifact.code));
    if (!state.initialized) pending.push(actions.functionCall("new", init, teraToGas("100")));
    else if (accountId === ids.ketos && (changed || (retirement?.retired.length ?? 0) > 0)) {
      // Every action is a self-call in the deploy batch; any migration/retirement failure rolls it all back.
      if (migrating) {
        pending.push(actions.functionCall("migrate", { share_holders: audit.share_holders }, teraToGas("250")));
      } else if (changed && state.account?.code_hash !== previousKetosHash) {
        throw new Error("Only the manifest-pinned V3 Ketos schema can upgrade without migration");
      }
      pending.push(actions.functionCall("retire_unsupported_markets", {}, teraToGas(migrating ? "40" : "250")));
    } else if (accountId === ids.usdc && changed) {
      if (![LEGACY_USDC_HASH, PREVIOUS_USDC_HASH].includes(state.account?.code_hash ?? "")) {
        throw new Error("Only a pinned previous mock-usdc layout can migrate");
      }
      pending.push(actions.functionCall("migrate_faucet", { faucet_id: `faucet.${parentId}` }, teraToGas("100")));
    }
    if (pending.length === 0) {
      console.log(`${accountId}: initialized code up to date`);
      return;
    }
    // Initialized roots are migrated atomically, never reinitialized.
    const outcome = await signer(accountId).signAndSendTransaction({
      receiverId: accountId, actions: pending, waitUntil: "FINAL",
    });
    audit.transactions.push({
      kind: accountId === ids.ketos && state.initialized
        ? (migrating ? "deploy_migrate_and_retire" : "upgrade_and_retire") : "deploy",
      account_id: accountId, old_code_hash: state.account?.code_hash ?? EMPTY_CODE_HASH,
      new_code_hash: artifact.hash, share_holders: accountId === ids.ketos && migrating ? audit.share_holders : undefined,
      retired_markets: accountId === ids.ketos ? retirement?.retired : undefined,
      outcome,
    });
    saveAudit();
    if ((await viewAccount(accountId))?.code_hash !== artifact.hash) throw new Error(`${accountId}: deployed hash not confirmed`);
    console.log(`${accountId}: deployed${accountId === ids.ketos && migrating ? "/migrated" : ""} (${artifact.hash})`);
  }

  await ensureAccount(ids.usdc, BALANCES.usdc, usdcState.account);
  await ensureAccount(ids.keeper, BALANCES.keeper, keeperState);
  if (tokenTopUp > 0n) {
    const outcome = await parent.signAndSendTransaction({
      receiverId: ids.usdc, actions: [actions.transfer(tokenTopUp)], waitUntil: "FINAL",
    });
    audit.transactions.push({ kind: "token_storage_top_up", account_id: ids.usdc, amount: tokenTopUp.toString(), outcome });
    saveAudit();
  }
  await ensureContract(ids.usdc, artifacts.usdc, usdcState, { owner_id: parentId, faucet_id: `faucet.${parentId}` });
  await ensureContract(ids.ketos, artifacts.ketos, ketosState, config);
  const pinnedSigner = await view<string | null>(ids.ketos, "get_price_signer");
  if (pinnedSigner && pinnedSigner !== priceSigner) {
    throw new Error("Existing price signer differs from the attested worker; refusing rotation");
  }
  if (!pinnedSigner) {
    const outcome = await parent.signAndSendTransaction({
      receiverId: ids.ketos,
      actions: [actions.functionCall("set_price_signer", { public_key: priceSigner }, teraToGas("20"))],
      waitUntil: "FINAL",
    });
    audit.transactions.push({ kind: "pin_price_signer", public_key: priceSigner, outcome });
    saveAudit();
    if (await view<string | null>(ids.ketos, "get_price_signer") !== priceSigner) {
      throw new Error("Price signer pin was not confirmed");
    }
  }
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
    const balance = BigInt(await view<string>(ids.usdc, "ft_balance_of", { account_id: seedAccountId }));
    if (balance < VAULT_SEED) {
      await parent.callFunction({
        contractId: ids.usdc, methodName: "mint",
        args: { account_id: seedAccountId, amount: (VAULT_SEED - balance).toString() }, waitUntil: "FINAL",
      });
    }
    const priceDeposit = BigInt(await view<string>(ids.ketos, "get_vault_price_request_deposit", args));
    if (priceDeposit > 0n) {
      await seedAccount.callFunction({
        contractId: ids.ketos, methodName: "fund_price_requests", args: {},
        deposit: priceDeposit, waitUntil: "FINAL",
      });
    }
    const accepted = await seedAccount.callFunction<string>({
      contractId: ids.usdc, methodName: "ft_transfer_call",
      args: { receiver_id: ids.ketos, amount: VAULT_SEED.toString(), msg: `deposit_vault:${vaultId}` },
      deposit: 1n, gas: teraToGas("300"), waitUntil: "FINAL",
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

  if (!ketosState.initialized && !tokenUpgraded) {
    await ensureRegistered(ids.ketos);
    await seedVault("core");
    await seedVault("long-tail");
  }
  const remaining = (await parent.getState()).balance.available;
  if (remaining < KETOS_MIN_AVAILABLE) {
    await topUpKetos(KETOS_MIN_AVAILABLE);
  }
  await validateKetos();
  if (await view<string | null>(ids.ketos, "get_price_signer") !== priceSigner) {
    throw new Error("Final price signer pin does not match the attested worker");
  }
  for (const vaultId of ["core", "long-tail"]) {
    const owned = await view<VaultAccount>(ids.ketos, "get_vault_account", { vault_id: vaultId, account_id: seedAccountId });
    if (BigInt(owned.shares) < VAULT_SEED) throw new Error(`${vaultId}: final deployment seed shares missing`);
  }
  const finalKetos = await viewAccount(ids.ketos);
  const finalUsdc = await viewAccount(ids.usdc);
  if (finalKetos?.code_hash !== artifacts.ketos.hash || finalUsdc?.code_hash !== artifacts.usdc.hash) {
    throw new Error("Final deployment code hash mismatch");
  }
  if (changingKetos || tokenUpgraded) {
    const afterBlock = await rpc<{ header: { hash: string; height: number } }>("block", { finality: "final" });
    if (!afterBlock) throw new Error("Cannot pin the preservation snapshot block");
    const after: Record<string, unknown> = {
      block_hash: afterBlock.header.hash, block_height: afterBlock.header.height,
    };
    const failures: string[] = [];
    const equality: Record<string, unknown> = {};
    audit.after = after;
    audit.preservation = { equality, failures };
    // Store the raw snapshots before comparing, including evidence for concurrent mutations.
    for (const [accountId, state] of [[ids.ketos, ketosState], [ids.usdc, usdcState]] as const) {
      if (accountId === ids.ketos && !changingKetos) continue;
      const raw = await rpc<RawState>("query", {
        request_type: "view_state", block_id: afterBlock.header.hash, account_id: accountId,
        prefix_base64: "", include_proof: false,
      });
      if (!raw || !state.raw) throw new Error(`${accountId}: preservation snapshot unavailable`);
      after[accountId] = { raw_state: raw };
      saveAudit();
      const beforeEntries = accountId === ids.ketos ? retirement!.expected
        : new Map(state.raw.values.map((entry) => [entry.key, entry.value]));
      const afterEntries = new Map(raw.values.map((entry) => [entry.key, entry.value]));
      const excluded = new Set<string>();
      if (accountId === ids.usdc && tokenUpgraded) {
        const stateKey = Buffer.from("STATE").toString("base64");
        const previousRoot = Buffer.from(beforeEntries.get(stateKey) ?? "", "base64");
        const currentRoot = Buffer.from(afterEntries.get(stateKey) ?? "", "base64");
        if (!currentRoot.subarray(0, previousRoot.length).equals(previousRoot)) {
          failures.push(`${accountId}: legacy token root fields, supply or collection handles changed`);
        }
        excluded.add(stateKey);
      }
      if (accountId === ids.ketos && migrating) {
        excluded.add(Buffer.from("STATE").toString("base64"));
        for (const entry of state.raw.values) {
          const key = Buffer.from(entry.key, "base64");
          // IterableMap values are SHA256(prefix + "m" + serialized key), not literal prefixes.
          if (key.length === 6 && (key[0] === 0 || key[0] === 7) && key[1] === 118) {
            excluded.add(entry.key);
            excluded.add(createHash("sha256").update(Buffer.concat([
              Buffer.from([key[0], 109]), Buffer.from(entry.value, "base64"),
            ])).digest("base64"));
          } else if (key.length >= 6 && key[0] === 5 && (key[1] === 0 || key[1] === 1) &&
                     key.readUInt32LE(2) === key.length - 6) {
            excluded.add(entry.key);
          }
        }
      }
      let unchanged = 0;
      let excludedCount = 0;
      const changedOrMissing: string[] = [];
      for (const [key, value] of beforeEntries) {
        if (excluded.has(key)) { excludedCount++; continue; }
        if (afterEntries.get(key) !== value) changedOrMissing.push(key);
        else unchanged++;
      }
      const addedKeys = [...afterEntries.keys()].filter((key) => !beforeEntries.has(key));
      const allowedAdded = new Set<string>();
      if (accountId === ids.ketos && migrating) {
        const handles = ketosHandles(raw);
        for (const handle of [handles.markets, handles.orders]) {
          for (let index = 0; index < handle.length; index++) {
            const key = vectorKey(handle, index);
            const value = afterEntries.get(key);
            if (!value) throw new Error("Incomplete migrated collection");
            allowedAdded.add(key);
            allowedAdded.add(mapKey(handle, Buffer.from(value, "base64")));
          }
        }
        for (const key of afterEntries.keys()) {
          const bytes = Buffer.from(key, "base64");
          if (bytes.length >= 6 && bytes[0] === 17 && (bytes[1] === 0 || bytes[1] === 1) &&
              bytes.readUInt32LE(2) === bytes.length - 6) allowedAdded.add(key);
        }
      }
      const unexpectedAddedKeys = addedKeys.filter((key) => !allowedAdded.has(key));
      equality[accountId] = {
        before_entries: state.raw.values.length, expected_entries: beforeEntries.size, after_entries: afterEntries.size,
        excluded_entries: excludedCount, unchanged_entries: unchanged,
        changed_or_missing_keys_base64: changedOrMissing, added_keys_base64: addedKeys,
        unexpected_added_keys_base64: unexpectedAddedKeys,
        retired_markets: accountId === ids.ketos ? retirement!.retired : undefined,
      };
      if (changedOrMissing.length > 0 || unexpectedAddedKeys.length > 0) {
        failures.push(`${accountId}: preserved raw storage changed (possible concurrent mutation)`);
      }
    }
    const finalViews: Record<string, unknown> = {};
    after.views = finalViews;
    if (changingKetos) {
      const result = await rpc<{ result?: number[] }>("query", {
        request_type: "call_function", block_id: afterBlock.header.hash, account_id: ids.ketos,
        method_name: "get_markets", args_base64: Buffer.from("{}").toString("base64"),
      });
      if (!result?.result) throw new Error("Final market registry preservation view failed");
      const actual = JSON.parse(Buffer.from(result.result).toString("utf8")) as Market[];
      const expectedIds = marketsBefore.map((market) => market.id).filter((id) => !RETIRED_MARKETS.includes(id)).sort();
      const actualIds = actual.map((market) => market.id).sort();
      finalViews.markets = actual;
      equality.market_registry = { before: marketsBefore.map((market) => market.id), expected: expectedIds, after: actualIds };
      if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
        failures.push("Market registry changed beyond AURORA/RHEA retirement");
      }
    }
    for (const [index, vaultId] of (changingKetos ? ["core", "long-tail"] : []).entries()) {
      const vault = await rpc<{ result?: number[]; error?: string }>("query", {
        request_type: "call_function", block_id: afterBlock.header.hash, account_id: ids.ketos,
        method_name: "get_vault", args_base64: Buffer.from(JSON.stringify({ vault_id: vaultId })).toString("base64"),
      });
      if (!vault?.result) throw new Error(`${vaultId}: final preservation view failed`);
      const actual = JSON.parse(Buffer.from(vault.result).toString("utf8")) as Vault;
      const claims: Record<string, string> = {};
      finalViews[vaultId] = { vault: actual, holders: claims };
      const previous = vaultsBefore.get(vaultId)!;
      const revenueMatches = Object.keys(previous.revenue).length === Object.keys(actual.revenue).length &&
        Object.entries(previous.revenue).every(([name, amount]) => actual.revenue[name] === amount);
      if (actual.balance !== previous.balance || actual.total_shares !== previous.total_shares ||
          actual.cross_receivable !== previous.cross_receivable || !revenueMatches) {
        failures.push(`${vaultId}: vault accounting changed (possible concurrent mutation)`);
      }
      for (const accountId of audit.share_holders) {
        const claim = await rpc<{ result?: number[] }>("query", {
          request_type: "call_function", block_id: afterBlock.header.hash, account_id: ids.ketos,
          method_name: "get_vault_account",
          args_base64: Buffer.from(JSON.stringify({ vault_id: vaultId, account_id: accountId })).toString("base64"),
        });
        if (!claim?.result) throw new Error(`${vaultId}: final LP preservation view failed`);
        const actualClaim = JSON.parse(Buffer.from(claim.result).toString("utf8")) as VaultAccount;
        claims[accountId] = actualClaim.shares;
        if (BigInt(actualClaim.shares) !== (legacyShares[index].get(accountId) ?? 0n)) {
          failures.push(`${vaultId}: LP claim changed for ${accountId}`);
        }
      }
      equality[vaultId] = { accounting_unchanged: actual.balance === previous.balance &&
        actual.total_shares === previous.total_shares && actual.cross_receivable === previous.cross_receivable &&
        revenueMatches, holder_claims_checked: audit.share_holders.length,
        holder_claims_unchanged: audit.share_holders.filter((accountId) =>
          BigInt(claims[accountId]) === (legacyShares[index].get(accountId) ?? 0n)).length };
    }
    for (const [method, args, previous] of [
      ["ft_total_supply", {}, tokenSupplyBefore],
      ["ft_balance_of", { account_id: ids.ketos }, tokenCustodyBefore],
    ] as const) {
      const result = await rpc<{ result?: number[] }>("query", {
        request_type: "call_function", block_id: afterBlock.header.hash, account_id: ids.usdc,
        method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      });
      if (!result?.result) throw new Error(`Token preservation view ${method} failed`);
      const actual = JSON.parse(Buffer.from(result.result).toString("utf8")) as string;
      finalViews[method] = actual;
      equality[method] = { before: previous, after: actual, unchanged: actual === previous };
      if (actual !== previous) failures.push(`${method}: token supply/custody changed (possible concurrent mutation)`);
    }
    saveAudit();
    if (failures.length > 0) throw new Error(`Preservation not confirmed: ${failures.join("; ")}; inspect ${auditPath}`);
  }
  audit.completed = new Date().toISOString();
  saveAudit();

  const deployment = {
    network: "testnet", owner: fundingAccountId, ketos: ids.ketos, usdc: ids.usdc,
    oracle: ORACLE_ID, outlayer: OUTLAYER_ID, keeper: ids.keeper, faucet: `faucet.${parentId}`, rpc: rpcUrl,
    schema_version: 3, code_hashes: { ketos: finalKetos.code_hash, usdc: finalUsdc.code_hash },
    price_signer: priceSigner, price_signer_attestation_url: workerManifest.price_signer_attestation_url,
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
  console.log(`\n${ids.ketos}: ${markets.length} V3 markets, two verified vault seeds and attested price signer; deployment manifest and local env files updated`);
}

void (process.argv.includes("--faucet") ? deployFaucet() : main()).catch((error: unknown) => {
  // SDK/RPC errors can contain transaction context; never emit raw errors or stacks containing credentials.
  let message = error instanceof Error ? error.message : "Deployment failed";
  for (const name of ["FAUCET_PRIVATE_KEY", "KETOS_PRIVATE_KEY", "NEAR_PRIVATE_KEY", "KEEPER_PRIVATE_KEY", "OUTLAYER_PAYMENT_KEY", "ONECLICK_JWT", "NEAR_RPC_URL"]) {
    const value = optionalEnv(name);
    if (value) message = message.replaceAll(value, "[REDACTED]");
  }
  message = message.replace(/ed25519:[1-9A-HJ-NP-Za-km-z]+/g, "[REDACTED]");
  console.error(`Deployment failed: ${message}`);
  process.exitCode = 1;
});
