import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, actions, baseEncode, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { z } from "zod";
import { loadEnv, nearAccountId, requireEnv } from "./lib/env.ts";
import { KetosViews } from "../web/lib/near/views.ts";
import { signedPricesFor, signedPriceObservation } from "../web/lib/near/signed-prices.ts";
import { workerSignedPrices } from "../web/lib/near/signed-prices-server.ts";
import { executionArg, executionLimits } from "../web/lib/near/execution.ts";
import { settleOutcome } from "../web/lib/near/tx.ts";

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const directory = root("out/deployments/hedge-acceptance");
const reportPath = `${directory}/report.json`;
const stepSchema = z.object({ label: z.string(), hash: z.string(), status: z.enum(["prepared", "confirmed", "failed"]), value: z.unknown().optional() });
const reportSchema = z.object({ network: z.literal("testnet"), account: z.literal("ketos-dev.testnet"),
  steps: z.array(stepSchema), positionId: z.number().optional(), before: z.record(z.string(), z.unknown()).optional(),
  after: z.record(z.string(), z.unknown()).optional(), buy: z.record(z.string(), z.unknown()).optional(),
  sell: z.record(z.string(), z.unknown()).optional(), completedAt: z.string().optional(),
  recoveredReceiptLocators: z.record(z.string(), z.string()).optional() });
function saveJson(path: string, data: unknown) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(data, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
async function main() {
  loadEnv();
  const deployment = JSON.parse(readFileSync(root("deployments/testnet.json"), "utf8")) as { network: string; schema_version: number; rpc: string; ketos: string; usdc: string };
  assert.equal(deployment.network, "testnet"); assert.equal(deployment.schema_version, 6); assert.equal(nearAccountId(), "ketos-dev.testnet");
  const config = { network: "testnet" as const, rpcUrl: deployment.rpc, ketosContract: deployment.ketos, usdcContract: deployment.usdc };
  const views = new KetosViews(config.rpcUrl, config.ketosContract, config.usdcContract);
  const signerProvider = new JsonRpcProvider({ url: config.rpcUrl }, { retries: 1 });
  const trader = new Account(nearAccountId(), signerProvider, requireEnv("NEAR_PRIVATE_KEY") as KeyPairString);
  const report = existsSync(reportPath) ? reportSchema.parse(JSON.parse(readFileSync(reportPath, "utf8"))) : reportSchema.parse({
    network: "testnet", account: trader.accountId, steps: [],
  });
  const save = () => saveJson(reportPath, report);
  for (const argument of process.argv.filter((item) => item.startsWith("--receipt="))) {
    const match = /^--receipt=([0-9]+):([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(argument);
    assert(match, "Receipt recovery requires nonce:transactionHash");
    const state = await views.hedge();
    const record = (await views.hedgeFills(32)).find((item) => item.fill.nonce === Number(match[1]));
    assert(state && record, "Recovery must reference an actual ledger fill");
    const located = { ...record, reported_transaction_hash: match[2] };
    assert(await views.hedgeEvidence(located, state.config.custody_id), "Recovered locator must match the complete executed fill");
    saveJson(`${directory}/recovered-fill-${match[1]}-receipt.json`, await views.provider.viewTransactionStatusWithReceipts({
      txHash: match[2], accountId: (await views.config()).keeper_id, waitUntil: "FINAL",
    }));
    report.recoveredReceiptLocators = { ...report.recoveredReceiptLocators, [match[1]]: match[2] }; save();
  }
  const locate = (record: Awaited<ReturnType<typeof views.hedgeFills>>[number]) => ({
    ...record, reported_transaction_hash: record.reported_transaction_hash ?? report.recoveredReceiptLocators?.[record.fill.nonce] ?? null,
  });
  const view = (contractId: string, method: string, args: Record<string, unknown> = {}) => views.provider.callFunction({ contractId, method, args });
  const snapshot = async () => ({ at: new Date().toISOString(), hedge: await views.hedge(), fills: await views.hedgeFills(32),
    vault: await views.vault("core"), positions: await views.positions(trader.accountId), account: await views.account(trader.accountId),
    wallet: await view(config.usdcContract, "ft_balance_of", { account_id: trader.accountId }),
    tokenSupply: await view(config.usdcContract, "ft_total_supply"),
    custodyBalance: await view(config.usdcContract, "ft_balance_of", { account_id: config.ketosContract }) });
  async function confirm(step: z.infer<typeof stepSchema>) {
    const result = await views.provider.viewTransactionStatusWithReceipts({ txHash: step.hash, accountId: trader.accountId, waitUntil: "FINAL" });
    saveJson(`${directory}/${step.label}-receipt.json`, result);
    try {
      const settled = settleOutcome(result);
      assert(!settled.refundReason, settled.refundReason);
      step.value = settled.value; step.status = "confirmed";
    } catch (error) { step.status = "failed"; save(); throw error; }
    save(); console.log(`${step.label}: ${step.hash}`);
    return step.value;
  }
  async function send(label: string, receiver: string, method: string, args: Record<string, unknown>, deposit: bigint) {
    const previous = report.steps.find((step) => step.label === label);
    if (previous) { assert.equal(previous.status, "confirmed", "Reconcile original transaction before continuing"); return previous.value; }
    assert(report.steps.every((step) => step.status === "confirmed"), "Resolve previous submission before another transaction");
    const account = await signerProvider.viewAccount({ accountId: trader.accountId });
    assert(account.amount - BigInt(account.storage_usage) * 10n ** 19n - deposit > nearToYocto("2.1"), "Native reserve floor");
    const signed = await trader.createSignedTransaction({ receiverId: receiver, actions: [actions.functionCall(method, args, teraToGas(300), deposit)] });
    const hash = baseEncode(createHash("sha256").update(signed.transaction.encode()).digest());
    const step: z.infer<typeof stepSchema> = { label, hash, status: "prepared" };
    report.steps.push(step); save();
    await signerProvider.sendTransactionUntil(signed, "INCLUDED");
    return confirm(step);
  }
  if (process.argv.includes("--reconcile")) {
    for (const step of report.steps.filter((item) => item.status === "prepared")) await confirm(step);
    return;
  }
  if (report.completedAt) { console.log(`Acceptance already completed ${report.completedAt}; no new trade`); return; }
  if (!report.before) {
    assert.equal((await views.positions(trader.accountId)).length, 0, "Do not touch an existing operator position");
    const initial = await views.hedge();
    assert(initial?.confirmed && !initial.pending && initial.confirmed.total_funded === 0n && initial.confirmed.inventory === 0n);
    report.before = await snapshot(); save();
  }
  if (!report.steps.some((step) => step.label === "open-near")) {
    const market = await views.market("NEAR");
    assert(market && market.is_open && Date.now() - market.depth_measured_at_ms < 30 * 60_000, "Need actual admissible depth");
    const budget = BigInt(z.string().parse(await view(config.ketosContract, "get_open_price_request_deposit", {
      market: "NEAR", account_id: trader.accountId, margin_mode: "isolated",
    })));
    const prices = await signedPricesFor(config, { kind: "open", market: "NEAR", accountId: trader.accountId, marginMode: "isolated" }, workerSignedPrices);
    assert(prices, "No fresh verified price; no trade submitted");
    const observation = signedPriceObservation(prices, "NEAR");
    saveJson(`${directory}/entry-price.json`, prices);
    const request = { market_id: "NEAR", side: "long", margin: "2000000", leverage: 1,
      margin_mode: "isolated", brackets: null, bracket_bounds: null, signed_prices: prices,
      execution: executionArg(executionLimits(observation.price, "long", false, 100, Date.now() + 60_000)) };
    const used = await send("open-near", config.usdcContract, "ft_transfer_call", {
      receiver_id: config.ketosContract, amount: "2000000", msg: `open:${JSON.stringify(request)}`,
    }, budget + 1n);
    assert.equal(used, "2000000", "Wallet entry was refunded; do not repeat it automatically");
  }
  if (report.positionId === undefined) {
    const positions = await views.positions(trader.accountId);
    assert.equal(positions.length, 1); assert.equal(positions[0].market_id, "NEAR");
    report.positionId = positions[0].id; save();
  }
  const deadline = Date.now() + 8 * 60_000;
  while (!report.buy && Date.now() < deadline) {
    const state = await views.hedge();
    const buy = (await views.hedgeFills(32)).find((record) => record.fill.side === "Buy");
    if (buy && state?.confirmed && !state.pending && state.confirmed.inventory > 0n) {
      const evidence = await views.hedgeEvidence(locate(buy), state.config.custody_id);
      assert(evidence, "A live receipt, not a dry quote, is required");
      report.buy = { record: buy, evidence, snapshot: await snapshot() }; save();
      console.log(`Verified integrated buy: ${evidence.transactionHash}`); break;
    }
    await delay(5_000);
  }
  assert(report.buy, "No confirmed hedge before the deadline; position retained for explicit close/reconciliation");
  if (!report.steps.some((step) => step.label === "close-near")) {
    const position = (await views.positions(trader.accountId)).find((item) => item.id === report.positionId);
    assert(position, "Scenario position missing; reconcile actual settlement");
    const budget = BigInt(z.string().parse(await view(config.ketosContract, "get_position_price_request_deposit", { position_id: report.positionId })));
    const prices = await signedPricesFor(config, { kind: "position", positionId: report.positionId }, workerSignedPrices);
    assert(prices, "No fresh verified exit price; no close submitted");
    const observation = signedPriceObservation(prices, "NEAR"); saveJson(`${directory}/exit-price.json`, prices);
    await send("close-near", config.ketosContract, "close_position", { position_id: report.positionId, to_wallet: true,
      signed_prices: prices, execution: executionArg(executionLimits(observation.price, "long", true, 100, Date.now() + 60_000)) }, budget);
  }
  assert.equal((await views.positions(trader.accountId)).length, 0, "Close did not settle");
  while (Date.now() < deadline) {
    const state = await views.hedge();
    const sells = (await views.hedgeFills(32)).filter((record) => record.fill.side === "Sell");
    if (state?.confirmed && !state.pending && state.confirmed.inventory * (await views.market("NEAR"))!.price / (10n ** 26n) < 10_000n && state.confirmed.cash === 0n && sells.length) {
      const evidence = await Promise.all(sells.map((record) => views.hedgeEvidence(locate(record), state.config.custody_id)));
      assert(evidence.every(Boolean));
      report.sell = { records: sells, evidence }; report.after = await snapshot();
      const book = state.confirmed;
      assert.equal(book.cash + book.cost_basis + book.total_returned, book.total_funded + book.realized_pnl);
      assert.equal(await view(config.usdcContract, "ft_balance_of", { account_id: state.config.custody_id }), "0");
      assert.equal(await view(state.config.wrapped_near_id, "ft_balance_of", { account_id: state.config.custody_id }), book.inventory.toString());
      assert(Object.values(z.record(z.string(), z.string()).parse(await view(state.config.exchange_id, "get_deposits", { account_id: state.config.custody_id }))).every((value) => value === "0"));
      assert.equal(report.after.tokenSupply, report.before.tokenSupply, "No faucet or mint belongs in integrated acceptance");
      report.completedAt = new Date().toISOString(); save();
      console.log(`Integrated hedge reconciled; realized ${book.realized_pnl} micro-USDC, residual ${book.inventory} yoctoNEAR.`); return;
    }
    await delay(5_000);
  }
  throw new Error("Unwind remains pending; no replacement transaction was submitted");
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Integrated hedge acceptance failed"); process.exitCode = 1; });
