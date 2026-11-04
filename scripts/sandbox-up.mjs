// Starts a local NEAR sandbox node in the background, deploys Ketos (mock tUSDC, mock oracle,
// trading contract), seeds it like testnet and writes web/.env.e2e for the end-to-end tests.
// Stop it with `node scripts/sandbox-down.mjs`.
//
// The node runs in a detached helper process (`--node`) so it outlives this script; its pid,
// RPC URL and home directory are recorded in <tmpdir>/ketos-sandbox/state.json.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, nearToYocto, teraToGas } from "near-api-js";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from "near-sandbox";
import { LOG_FILE, STATE_DIR, STATE_FILE, readState, stopSandbox } from "./sandbox-down.mjs";

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const ENV_FILE = root("web/.env.e2e");
const DEPTH_FIXTURE = root("web/e2e/fixtures/depth-2026-11-03.json");

const USD = 1_000_000n;
const VAULT_SEED = 10_000n * USD;
const MARKETS = ["BTC", "ETH", "NEAR", "ZEC"];
const KEEPER_METHODS = ["refresh_prices", "set_depth", "liquidate"];
// Mock oracle values for sandbox trading; the first four match the 2026-11-03 feed.
const PRICES = [
  ["nbtc.bridge.near", 7_756_150_000_000n],
  ["aurora", 229_259_500_000n],
  ["wrap.near", 400_000_000n],
  ["zec.omft.near", 120_660_966_700n],
  ["22.contract.portalbridge.near", 15_000_000_000n],
  ["aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near", 10_000_000n],
  ["token.rhealab.near", 5_000_000n],
];

if (process.argv.includes("--node")) {
  await runNode();
} else {
  await up();
}

/** Helper process: owns the sandbox node until SIGTERM, then removes its data directory. */
async function runNode() {
  // Inherit stdio (the log file) instead of an unread pipe that would eventually block the node.
  process.env.NEAR_ENABLE_SANDBOX_LOG = "1";
  process.env.NEAR_RPC_TIMEOUT_SECS ??= "120";
  const sandbox = await Sandbox.start({});
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await sandbox.tearDown().catch((e) => console.error(`teardown: ${e}`));
    rmSync(STATE_FILE, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      pid: process.pid,
      // `childProcess` is private in the typings; its pid is the fallback if this helper dies.
      nodePid: sandbox.childProcess?.pid ?? null,
      rpcUrl: sandbox.rpcUrl,
      homeDir: sandbox.homeDir,
    }),
  );
  setInterval(() => {}, 1 << 30);
}

async function startNode() {
  mkdirSync(STATE_DIR, { recursive: true });
  const log = openSync(LOG_FILE, "w");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--node"], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  let exited = false;
  child.once("exit", () => (exited = true));
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const state = readState();
    if (state) return state;
    if (exited) break;
    await sleep(250);
  }
  const tail = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8").slice(-2000) : "";
  await stopSandbox();
  throw new Error(`sandbox node did not start (log: ${LOG_FILE})\n${tail}`);
}

async function up() {
  await stopSandbox();
  const started = Date.now();
  const state = await startNode();
  try {
    const env = await seed(state.rpcUrl);
    writeFileSync(
      ENV_FILE,
      `${Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")}\n`,
      { mode: 0o600 },
    );
    console.log(`sandbox ready at ${state.rpcUrl} in ${((Date.now() - started) / 1000).toFixed(1)} s, wrote web/.env.e2e`);
  } catch (e) {
    await stopSandbox();
    throw e;
  }
}

async function seed(rpcUrl) {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const rootAccount = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY);
  const rootPublicKey = KeyPair.fromString(DEFAULT_PRIVATE_KEY).getPublicKey();
  const id = (name) => `${name}.${DEFAULT_ACCOUNT_ID}`;
  const ids = { usdc: id("usdc"), oracle: id("oracle"), ketos: id("ketos"), lp: id("lp"), keeper: id("keeper"), trader: id("trader") };
  // Contract and helper accounts share the root key; the trader gets its own key for the browser signer.
  const as = (accountId) => new Account(accountId, provider, DEFAULT_PRIVATE_KEY);
  const traderKey = KeyPair.fromRandom("ed25519");
  const keeperKey = KeyPair.fromRandom("ed25519");

  const create = (accountId, near, publicKey = rootPublicKey) =>
    rootAccount.createAccount({ newAccountId: accountId, publicKey, nearToTransfer: nearToYocto(near) });
  const deploy = async (accountId, near, wasm, init) => {
    await create(accountId, near);
    const account = as(accountId);
    await account.deployContract(readFileSync(root(`contracts/res/${wasm}.wasm`)));
    await account.callFunction({ contractId: accountId, methodName: "new", args: init, gas: teraToGas("100") });
  };
  const call = (signer, contractId, methodName, args = {}, opts = {}) =>
    signer.callFunction({ contractId, methodName, args, waitUntil: "FINAL", gas: teraToGas("100"), ...opts });
  const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args });

  await deploy(ids.usdc, 10, "mock_usdc", { owner_id: DEFAULT_ACCOUNT_ID });
  await deploy(ids.oracle, 10, "mock_oracle", { owner_id: DEFAULT_ACCOUNT_ID });
  await create(ids.keeper, 10);
  // 20 NEAR: the keeper tick refuses to run below 2 NEAR on the Ketos contract.
  await deploy(ids.ketos, 20, "ketos", { usdc_id: ids.usdc, oracle_id: ids.oracle, keeper_id: ids.keeper });
  await create(ids.lp, 10);
  await create(ids.trader, 50, traderKey.getPublicKey());
  await as(ids.keeper).addFunctionCallAccessKey({
    publicKey: keeperKey.getPublicKey(),
    contractId: ids.ketos,
    methodNames: KEEPER_METHODS,
    allowance: nearToYocto("5"),
  });
  const keeper = new Account(ids.keeper, provider, keeperKey.toString());

  for (const [assetId, price] of PRICES) {
    await call(rootAccount, ids.oracle, "set_price", { asset_id: assetId, multiplier: price.toString(), decimals: 8 });
  }
  await call(keeper, ids.ketos, "refresh_prices");

  const fixture = JSON.parse(readFileSync(DEPTH_FIXTURE, "utf8"));
  const block = await provider.viewBlock({ finality: "final" });
  const measuredAtMs = Math.floor(Number(block.header.timestamp_nanosec) / 1e6);
  for (const market of MARKETS) {
    await call(keeper, ids.ketos, "set_depth", {
      market_id: market,
      samples: fixture.assets[market].samples,
      measured_at_ms: measuredAtMs,
    });
  }

  for (const accountId of [ids.ketos, ids.lp]) {
    await call(rootAccount, ids.usdc, "storage_deposit", { account_id: accountId }, { deposit: nearToYocto("0.0125") });
  }
  await call(rootAccount, ids.usdc, "mint", { account_id: ids.lp, amount: VAULT_SEED.toString() });
  await call(
    as(ids.lp),
    ids.usdc,
    "ft_transfer_call",
    { receiver_id: ids.ketos, amount: VAULT_SEED.toString(), msg: "deposit_vault" },
    { deposit: 1n },
  );

  const [markets, prices, vault] = await Promise.all([
    view(ids.ketos, "get_markets"),
    view(ids.ketos, "get_prices"),
    view(ids.ketos, "get_vault"),
  ]);
  const openMarkets = markets.filter((m) => m.is_open).map((m) => m.id);
  if (openMarkets.length !== MARKETS.length || MARKETS.some((m) => !openMarkets.includes(m))) {
    throw new Error(`expected only fixture markets to be open: ${JSON.stringify(markets)}`);
  }
  if (markets.length !== 7) throw new Error(`expected 7 listed markets, got ${markets.length}`);
  if (!prices.every((p) => p.is_fresh)) throw new Error(`prices not fresh: ${JSON.stringify(prices)}`);
  if (BigInt(vault.nav) !== VAULT_SEED) throw new Error(`vault NAV ${vault.nav}, expected ${VAULT_SEED}`);

  return {
    NEXT_PUBLIC_E2E: "1",
    NEXT_PUBLIC_NEAR_NETWORK: "sandbox",
    NEXT_PUBLIC_RPC_URL: rpcUrl,
    NEXT_PUBLIC_KETOS_CONTRACT: ids.ketos,
    NEXT_PUBLIC_USDC_CONTRACT: ids.usdc,
    NEXT_PUBLIC_E2E_SIGNER: `${ids.trader}:${traderKey.toString()}`,
    // Server side: the keeper route signs with the sandbox keeper's function-call key.
    KEEPER_PRIVATE_KEY: keeperKey.toString(),
    // Test helpers: the mock oracle owner moves prices during the liquidation scene.
    E2E_ORACLE_CONTRACT: ids.oracle,
    E2E_ROOT_SIGNER: `${DEFAULT_ACCOUNT_ID}:${DEFAULT_PRIVATE_KEY}`,
  };
}
