import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Account, KeyPair, actions, nearToYocto, type KeyPairString } from "near-api-js";
import { z } from "zod";
import { loadEnv, nearAccountId, optionalEnv, requireEnv } from "./lib/env.ts";
import { sampleAsset, exitCapacityUsd } from "../web/lib/intents/depth.ts";
import { getTokens } from "../web/lib/intents/oneclick.ts";
import { WORKER_LISTING_ROUTES } from "../web/lib/intents/listing.ts";
import { depositMarginTx, depositVaultTx, placeOrderTx, listMarketTx } from "../web/lib/near/calls.ts";
import { signedPricesFor, type SignedPriceRequest } from "../web/lib/near/signed-prices.ts";
import { workerSignedPrices } from "../web/lib/near/signed-prices-server.ts";
import { settleOutcome, type NearTransaction } from "../web/lib/near/tx.ts";
import { KetosViews } from "../web/lib/near/views.ts";
import type { Market, Position } from "../web/lib/near/types.ts";

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const USD = 1_000_000n;
const GAS = 300n * 10n ** 12n;
const stepSchema = z.object({
  label: z.string(), account_id: z.string(), receiver_id: z.string(), method: z.string(),
  status: z.enum(["sending", "confirmed", "refunded", "failed"]), hash: z.string().optional(),
  value: z.unknown().optional(), logs: z.array(z.string()).optional(),
});
type Step = z.infer<typeof stepSchema>;
const reportSchema = z.object({
  network: z.literal("testnet"), contract: z.string(), started_at: z.string(), accounts: z.array(z.string()),
  steps: z.array(stepSchema), measurements: z.array(z.object({
    market: z.string(), measured_at_ms: z.number(), curve: z.unknown(),
  })),
  observations: z.array(z.unknown()), listing: z.string().optional(),
  profitable_close: z.unknown().optional(), liquidation: z.unknown().optional(),
  after: z.unknown().optional(), completed_at: z.string().optional(),
});
type Report = z.infer<typeof reportSchema>;
const payloadSchema = z.object({ prices: z.record(z.string(), z.object({
  price: z.string().regex(/^[1-9]\d*$/).transform(BigInt), publish_time: z.number(),
})) });

async function main(): Promise<void> {
  loadEnv();
  const deployment = z.object({
    network: z.literal("testnet"), rpc: z.url(), ketos: z.literal("ketos.testnet"),
    usdc: z.literal("usdc.ketos.testnet"), keeper: z.literal("keeper.ketos.testnet"),
  }).parse(JSON.parse(readFileSync(root("deployments/testnet.json"), "utf8")));
  assert.equal(deployment.network, "testnet");
  assert.equal(deployment.ketos, "ketos.testnet");
  assert.equal(nearAccountId(), "ketos-dev.testnet");
  const config = { network: "testnet" as const, rpcUrl: deployment.rpc, ketosContract: deployment.ketos, usdcContract: deployment.usdc };
  const views = new KetosViews(config.rpcUrl, config.ketosContract, config.usdcContract);
  const burner = new Account(nearAccountId(), views.provider, requireEnv("NEAR_PRIVATE_KEY") as KeyPairString);
  const keeper = new Account(deployment.keeper, views.provider, requireEnv("KEEPER_PRIVATE_KEY") as KeyPairString);
  const reportPath = root(".hack/audit/demo-session.json");
  const report: Report = existsSync(reportPath) ? reportSchema.parse(JSON.parse(readFileSync(reportPath, "utf8"))) : {
    network: "testnet", contract: config.ketosContract, started_at: new Date().toISOString(),
    accounts: [], steps: [], measurements: [], observations: [],
  };
  assert.equal(report.network, "testnet");
  assert.equal(report.contract, config.ketosContract);
  function save(): void {
    mkdirSync(root(".hack/audit"), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, (_key, v: unknown) => typeof v === "bigint" ? v.toString() : v, 2)}\n`, { mode: 0o600 });
  }
  // Never replay an ambiguous broadcast: reconcile its public transaction before resuming.
  assert(!report.steps.some((step) => step.status === "sending" || step.status === "failed"), "Resolve the unfinished transaction in demo-session.json before resuming");

  let keys: Record<string, KeyPairString>;
  const existingKeys = optionalEnv("DEMO_TRADER_KEYS");
  if (existingKeys) {
    const parsedKeys = z.record(z.string(), z.string()).parse(JSON.parse(existingKeys));
    keys = Object.fromEntries(Object.entries(parsedKeys).map(([id, key]) => [id, KeyPair.fromString(key as KeyPairString).toString()]));
  } else {
    assert.equal(report.steps.length, 0, "Existing session requires its original DEMO_TRADER_KEYS");
    keys = Object.fromEntries(["alpha", "beta", "gamma"].map((name) => [
      `demo-${name}.ketos-dev.testnet`, KeyPair.fromRandom("ed25519").toString(),
    ]));
    const envPath = root(".env.local");
    const previous = readFileSync(envPath, "utf8");
    const lines = previous.split("\n").filter((line) => !line.startsWith("DEMO_TRADER_KEYS="));
    while (lines.at(-1) === "") lines.pop();
    lines.push(`DEMO_TRADER_KEYS='${JSON.stringify(keys)}'`, "");
    chmodSync(envPath, 0o600);
    writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
  }
  const accountIds = Object.keys(keys);
  assert.deepEqual(accountIds, ["demo-alpha", "demo-beta", "demo-gamma"].map((name) => `${name}.ketos-dev.testnet`));
  for (const key of Object.values(keys)) KeyPair.fromString(key);
  report.accounts = accountIds;
  save();
  const traders = accountIds.map((id) => new Account(id, views.provider, keys[id]));

  async function broadcast(label: string, account: Account, receiverId: string, method: string, send: () => Promise<unknown>): Promise<unknown> {
    const previous = report.steps.findLast((step) => step.label === label);
    if (previous?.status === "confirmed") return previous.value;
    const step: Step = { label, account_id: account.accountId, receiver_id: receiverId, method, status: "sending" };
    report.steps.push(step);
    save();
    const outcome = await send();
    const evidence = z.object({
      transaction: z.object({ hash: z.string() }),
      receipts_outcome: z.array(z.object({ outcome: z.object({ logs: z.array(z.string()) }) })),
    }).parse(outcome);
    step.hash = evidence.transaction.hash;
    step.logs = evidence.receipts_outcome.flatMap((receipt) => receipt.outcome.logs);
    save();
    try {
      const result = settleOutcome(outcome);
      if (result.refundReason) {
        assert.equal(result.value, "0", "Receiver cancellation did not confirm a full token refund");
        step.value = result.value;
        step.status = "refunded";
        throw new Error(result.refundReason);
      }
      step.value = result.value;
      step.status = "confirmed";
      save();
      console.log(`${label}: ${step.hash}`);
      return result.value;
    } catch (error) {
      if (step.status !== "refunded") step.status = "failed";
      save();
      throw error;
    }
  }
  async function call(label: string, account: Account, method: string, args: Record<string, unknown>, deposit = 0n, receiver: string = config.ketosContract): Promise<unknown> {
    return broadcast(label, account, receiver, method, () => account.callFunctionRaw({
      contractId: receiver, methodName: method, args, deposit, gas: GAS, waitUntil: "FINAL",
    }));
  }
  async function sendTx(label: string, account: Account, tx: NearTransaction): Promise<unknown> {
    assert.equal(tx.actions.length, 1);
    const action = tx.actions[0];
    const value = await broadcast(label, account, tx.receiverId, action.methodName, () => account.callFunctionRaw({
      contractId: tx.receiverId, methodName: action.methodName, args: action.args,
      deposit: action.deposit, gas: action.gas, waitUntil: "FINAL",
    }));
    if (action.methodName === "ft_transfer_call" && value !== action.args.amount) {
      const step = report.steps.findLast((entry) => entry.label === label)!;
      step.status = value === "0" ? "refunded" : "failed";
      save();
      throw new Error(`${label}: token transfer was not consumed in full; inspect its final receipts`);
    }
    return value;
  }
  async function signed(request: SignedPriceRequest) {
    const prices = await signedPricesFor(config, request, workerSignedPrices);
    assert(prices, "Fresh enclave-signed prices unavailable; no synthetic price or timestamp is permitted");
    return prices;
  }
  async function market(id: string): Promise<Market> {
    const value = (await views.markets()).find((m) => m.id === id);
    assert(value, `${id} is not listed`);
    return value;
  }
  async function refreshDepth(ids: string[]): Promise<void> {
    const tokens = await getTokens({ jwt: optionalEnv("ONECLICK_JWT") });
    for (const id of ids) {
      const measuredAtMs = Date.now();
      const curve = await sampleAsset((await market(id)).intents_asset_id, {
        tokens, jwt: optionalEnv("ONECLICK_JWT"),
        fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
      });
      report.measurements.push({ market: id, measured_at_ms: measuredAtMs, curve });
      save();
      await call(`depth:${id}:${measuredAtMs}`, keeper, "set_depth", { market_id: id, samples: curve.samples, measured_at_ms: measuredAtMs });
      assert((await market(id)).is_open, `${id} is closed under the real measured depth/capital limits`);
    }
  }
  async function snapshot(): Promise<void> {
    report.after = {
      observed_at: new Date().toISOString(), leaderboard: await views.leaderboard("volume"), vaults: await views.vaults(),
      accounts: await Promise.all(accountIds.map(async (id) => ({
        account_id: id, margin: await views.account(id), positions: await views.positions(id), orders: await views.orders(id),
        history: await views.history(id), core: await views.vaultAccount("core", id), long_tail: await views.vaultAccount("long-tail", id),
      }))),
    };
    save();
  }
  async function verifySession(): Promise<void> {
    await snapshot();
    const leaders = await views.leaderboard("volume");
    assert(accountIds.every((id) => leaders.some((row) => row.account_id === id && row.trades > 0)));
    assert((await views.vaults()).every((vault) => vault.revenue.fees > 0n));
    assert(report.steps.filter((step) => step.status === "confirmed" && step.hash).length >= 8);
    let profitable = false;
    for (const id of accountIds) {
      const history = await views.history(id);
      profitable ||= history.some((event) => {
        if (event.kind !== "close") return false;
        const opened = history.find((entry) => entry.kind === "open" && entry.position_id === event.position_id);
        return opened !== undefined && event.realized_pnl > opened.fees;
      });
    }
    assert(profitable && report.profitable_close, "A confirmed net-profitable close is still missing");
    assert(report.listing, "A paid market listing is still missing");
    assert((await market(report.listing)).depth_measured_at_ms > 0, "Listed market has no real depth measurement");
    for (const vaultId of ["core", "long-tail"] as const) {
      assert((await views.vaultAccount(vaultId, traders[2].accountId)).shares > 0n, `${vaultId} demo LP deposit is missing`);
    }
    report.completed_at = new Date().toISOString();
    save();
    console.log("Verified: three trading accounts, both vaults earning fees, profitable close, listing and confirmed transaction hashes.");
  }
  if (process.argv.includes("--verify")) {
    await verifySession();
    return;
  }

  const balance = await views.provider.viewAccount({ accountId: burner.accountId });
  assert(BigInt(balance.amount) - BigInt(balance.storage_usage) * 10n ** 19n >= nearToYocto("5.1"), "Burner must retain 2 NEAR after creating three 1-NEAR accounts and gas");
  for (const trader of traders) {
    const label = `create:${trader.accountId}`;
    if (!report.steps.some((step) => step.label === label)) {
      const response = await fetch(config.rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: trader.accountId } }),
      });
      assert(response.ok, "Account preflight RPC failed");
      const result = z.object({ error: z.object({ cause: z.object({ name: z.string() }).optional() }).optional() }).parse(await response.json());
      assert.equal(result.error?.cause?.name, "UNKNOWN_ACCOUNT", `Refusing to replace existing account ${trader.accountId}`);
      await broadcast(label, burner, trader.accountId, "CreateAccount+Transfer+AddKey", () => burner.signAndSendTransaction({
        receiverId: trader.accountId, actions: [actions.createAccount(), actions.transfer(nearToYocto("1")), actions.addFullAccessKey(KeyPair.fromString(keys[trader.accountId]).getPublicKey())], waitUntil: "FINAL",
      }));
    }
    const accessKeys = await views.provider.viewAccessKeyList({ accountId: trader.accountId });
    assert(accessKeys.keys.some((key) => key.public_key === KeyPair.fromString(keys[trader.accountId]).getPublicKey().toString() && key.access_key.permission === "FullAccess"));
    await call(`faucet:${trader.accountId}`, trader, "faucet", {}, 0n, config.usdcContract);
    await sendTx(`margin:${trader.accountId}`, trader, depositMarginTx(config, 400n * USD));
  }
  await refreshDepth(["ETH", "BTC", "XRP"]);

  async function open(label: string, trader: Account, id: string, side: "long" | "short", brackets = false): Promise<void> {
    if (report.steps.some((step) => step.label === label)) return;
    const m = await market(id);
    const prices = await signed({ kind: "markets", markets: [id] });
    const spot = payloadSchema.parse(JSON.parse(prices.payload)).prices[id].price;
    const value = await call(label, trader, "open_position", {
      market_id: id, side, margin: (100n * USD).toString(), leverage: Math.min(5, m.max_leverage), margin_mode: "isolated",
      brackets: brackets ? { take_profit: (spot * 110n / 100n).toString(), stop_loss: (spot * 90n / 100n).toString() } : null,
      signed_prices: prices,
    });
    assert(value !== null && value !== undefined, `${label} was not applied`);
    assert((await views.positions(trader.accountId)).some((p) => p.market_id === id && p.side === side));
  }
  await open("eth-long-with-brackets", traders[0], "ETH", "long", true);
  await open("xrp-short", traders[1], "XRP", "short");
  await open("eth-short", traders[2], "ETH", "short");
  if (!report.steps.some((step) => step.label === "btc-limit")) {
    const prices = await signed({ kind: "markets", markets: ["BTC"] });
    const spot = payloadSchema.parse(JSON.parse(prices.payload)).prices.BTC.price;
    await sendTx("btc-limit", traders[2], await placeOrderTx(config, {
      kind: "limit", marketId: "BTC", side: "short", margin: 100n * USD, leverage: Math.min(3, (await market("BTC")).max_leverage),
      triggerPrice: spot * 1001n / 1000n, fundingSource: "margin",
    }));
    assert((await views.orders(traders[2].accountId)).some((order) => order.request.kind === "limit"));
  }
  for (const vaultId of ["core", "long-tail"] as const) {
    const label = `lp:${vaultId}`;
    if (!report.steps.some((step) => step.label === label && step.status === "confirmed")) {
      const prices = await signedPricesFor(config, { kind: "vault", vaultId }, workerSignedPrices);
      const txs = await depositVaultTx(config, vaultId, 200n * USD);
      const attempt = report.steps.filter((step) => step.label === label).length + 1;
      for (let i = 0; i < txs.length - 1; i++) await sendTx(`${label}:fund:${attempt}`, traders[2], txs[i]);
      const transfer = txs.at(-1)!;
      if (prices) transfer.actions[0].args.msg = `deposit_vault:${JSON.stringify({
        vault_id: vaultId, signed_prices: prices,
      })}`;
      try {
        await sendTx(label, traders[2], transfer);
      } catch (error) {
        if (report.steps.at(-1)?.status !== "refunded") throw error;
        report.observations.push({ vault: vaultId, observed_at: new Date().toISOString(), status: "unavailable", reason: "Funded oracle pull failed freshness checks; all LP tokens refunded." });
        save();
        console.error(`${vaultId} LP deposit unavailable; tokens refunded. Restore fresh prices for every assigned market.`);
        continue;
      }
    }
    assert((await views.vaultAccount(vaultId, traders[2].accountId)).shares > 0n);
  }
  if (!report.listing) {
    const listed = await views.markets();
    const tokens = await getTokens({ jwt: optionalEnv("ONECLICK_JWT") });
    for (const [symbol, intentsAssetId] of Object.entries(WORKER_LISTING_ROUTES)) {
      if (listed.some((m) => m.id === symbol)) continue;
      const at = Date.now();
      const curve = await sampleAsset(intentsAssetId, { tokens, jwt: optionalEnv("ONECLICK_JWT"), sizesUsd: [1000, 10_000], fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }) });
      report.measurements.push({ market: symbol, measured_at_ms: at, curve });
      save();
      if (exitCapacityUsd(curve.samples) < 10_000) continue;
      await signed({ kind: "markets", markets: [symbol] });
      const txs = await listMarketTx(config, { symbol, oracleAssetId: symbol, intentsAssetId, priceSource: "outlayer_worker" });
      await sendTx(`listing:${symbol}`, traders[2], txs[0]);
      assert((await market(symbol)).depth_measured_at_ms === 0, "New listing must start measuring");
      report.listing = symbol;
      save();
      await call(`listing-depth:${symbol}`, keeper, "set_depth", { market_id: symbol, samples: curve.samples, measured_at_ms: at });
      await call(`listing-price:${symbol}`, traders[2], "pull_market_price", { market_id: symbol, signed_prices: await signed({ kind: "markets", markets: [symbol] }) });
      assert((await market(symbol)).is_open);
      break;
    }
    assert(report.listing, "No unlisted supported asset currently has real exit capacity >= 10,000 USD");
  }

  const waitArg = process.argv.find((arg) => arg.startsWith("--wait-seconds="));
  const waitSeconds = waitArg ? Number(waitArg.split("=")[1]) : 1800;
  assert(Number.isFinite(waitSeconds) && waitSeconds >= 0 && waitSeconds <= 21_600, "--wait-seconds must be between 0 and 21600");
  const deadline = Date.now() + waitSeconds * 1000;
  do {
    const positions = (await Promise.all(accountIds.map((id) => views.positions(id)))).flat();
    if (!positions.length) break;
    const assets = [...new Set(positions.map((p) => p.market_id).concat("BTC"))];
    const prices = await signed({ kind: "markets", markets: assets });
    const quote = payloadSchema.parse(JSON.parse(prices.payload));
    report.observations.push({ observed_at: new Date().toISOString(), signed_prices: prices });
    save();
    for (const p of positions) {
      const spot = quote.prices[p.market_id].price;
      const pnl = p.size * (p.side === "long" ? spot - p.entry_price : p.entry_price - spot) / p.entry_price;
      const history = await views.history(p.account_id);
      const entryFee = history.find((e) => e.kind === "open" && e.position_id === p.id)?.fees ?? 0n;
      if (!report.profitable_close && pnl - p.borrow_fee - p.funding_payment - p.close_fee - entryFee > p.size / 10_000n + 10_000n) {
        const trader = traders.find((a) => a.accountId === p.account_id)!;
        await call(`profit-close:${p.id}`, trader, "close_position", { position_id: p.id, to_wallet: false, signed_prices: await signed({ kind: "position", positionId: p.id }) });
        const close = (await views.history(p.account_id)).find((e) => e.kind === "close" && e.position_id === p.id);
        assert(close && close.realized_pnl > entryFee, "Price moved before settlement; no net-profitable close confirmed");
        report.profitable_close = { account_id: p.account_id, event: close, entry_fee: entryFee, net_gain: close.realized_pnl - entryFee };
        save();
      } else if (!report.liquidation && p.margin + pnl - p.borrow_fee - p.funding_payment <= p.maintenance_margin) {
        const value = await call(`liquidate:${p.id}`, keeper, "liquidate", { position_id: p.id, signed_prices: await signed({ kind: "position", positionId: p.id }) });
        assert(value !== null && value !== undefined, "Liquidation was not applied");
        report.liquidation = (await views.liquidations()).find((event) => event.position_id === p.id);
        assert(report.liquidation);
        save();
      }
    }
    // Permissionless execution still uses the real oracle and rechecks every trigger onchain.
    const orders = (await Promise.all(accountIds.map((id) => views.orders(id)))).flat();
    const positionById = new Map<number, Position>(positions.map((p) => [p.id, p]));
    const triggered = orders.filter(({ request }) => {
      const id = "market_id" in request ? request.market_id : positionById.get(request.position_id)?.market_id;
      if (!id || !quote.prices[id]) return false;
      const price = quote.prices[id].price;
      const side = "side" in request ? request.side : positionById.get(request.position_id)?.side;
      const above = request.kind === "take_profit" ? side === "long" : request.kind === "stop_loss" ? side === "short" : request.kind === "limit" ? side === "short" : side === "long";
      return above ? price >= request.trigger_price : price <= request.trigger_price;
    });
    if (triggered.length) {
      const ids = triggered.map((order) => order.id);
      await call(`execute:${ids.join(",")}:${Date.now()}`, keeper, "execute_orders", { ids, signed_prices: await signed({ kind: "orders", ids }) });
    }
    console.log(`Observed ${positions.length} real positions; net-profitable close ${report.profitable_close ? "confirmed" : "not yet available"}; liquidation ${report.liquidation ? "confirmed" : "not eligible"}.`);
    if (report.profitable_close || Date.now() >= deadline) break;
    await sleep(Math.min(60_000, deadline - Date.now()));
  } while (Date.now() <= deadline);
  if (!report.liquidation) report.observations.push({ status: "not_eligible", reason: "No naturally liquidatable demo position observed; prices were never modified." });
  await verifySession();
  console.log(`Session complete: ${report.steps.filter((step) => step.status === "confirmed").length} confirmed transactions. Evidence: .hack/audit/demo-session.json`);
}

main().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : "Testnet session failed";
  // RPC errors must never turn local credentials into console output.
  for (const [name, value] of Object.entries(process.env)) {
    if (/(?:KEY|SECRET)/.test(name) && value) message = message.replaceAll(value, "[redacted]");
  }
  console.error(message.replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/g, "[redacted]"));
  process.exitCode = 1;
});
