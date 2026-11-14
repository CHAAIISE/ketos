import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, actions, baseEncode, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { z } from "zod";
import { loadEnv, nearAccountId, requireEnv } from "./lib/env.ts";
import { custodySchema } from "../web/lib/near/types.ts";
import { settleOutcome } from "../web/lib/near/tx.ts";

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const directory = root("out/deployments/hedge-custody");
const reportPath = `${directory}/report.json`;
const atomic = z.string().regex(/^[0-9]+$/).transform(BigInt);
const manifestSchema = z.object({ network: z.literal("testnet"), controller: z.literal("ketos.testnet"),
  usdc: z.literal("usdc.ketos.testnet"), expected_custody_code_hash: z.string(),
  exchange_code_hash: z.string(), wrapped_near_code_hash: z.string(), config: z.object({
    custody_id: z.literal("ketos-hedge-2951de72.testnet"), exchange_id: z.literal("ref-finance-101.testnet"),
    wrapped_near_id: z.literal("wrap.testnet"), pool_id: z.literal(2954),
  }),
});
const stepSchema = z.object({ label: z.string(), signer: z.string(), receiver: z.string(), hash: z.string(),
  status: z.enum(["prepared", "confirmed", "failed"]), gasBurned: z.string().optional() });
const reportSchema = z.object({ network: z.literal("testnet"), custody: z.string(), operator: z.string(),
  codeHash: z.string(), steps: z.array(stepSchema), before: z.record(z.string(), z.unknown()).optional(),
  after: z.record(z.string(), z.unknown()).optional(), completedAt: z.string().optional() });
function saveJson(path: string, value: unknown) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
async function main() {
  loadEnv();
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(root("deployments/hedge-testnet.json"), "utf8")));
  const deployment = z.object({ network: z.literal("testnet"), rpc: z.url() }).parse(JSON.parse(readFileSync(root("deployments/testnet.json"), "utf8")));
  const secretPath = root(".env.hedge-near-testnet.local");
  assert.equal(statSync(secretPath).mode & 0o777, 0o600);
  process.loadEnvFile(secretPath);
  assert.equal(process.env.HEDGE_NEAR_NETWORK, "testnet");
  assert.equal(process.env.HEDGE_NEAR_ACCOUNT_ID, manifest.config.custody_id);
  const custodyKey = KeyPair.fromString(requireEnv("HEDGE_NEAR_PRIVATE_KEY") as KeyPairString);
  assert.equal(custodyKey.getPublicKey().toString(), "ed25519:3nJ81jcuNtYLLoAPXBXtAjGSesgFUH1yYSfUdU8ze8FV");
  const operatorId = nearAccountId();
  assert.equal(operatorId, "ketos-dev.testnet", "Only the existing project operator receives experiment assets");
  const provider = new JsonRpcProvider({ url: deployment.rpc }, { retries: 1 });
  const reader = new JsonRpcProvider({ url: deployment.rpc }, { retries: 4, wait: 500, backoff: 2 });
  assert.equal(await provider.getNetworkId(), "testnet");
  const custody = new Account(manifest.config.custody_id, provider, custodyKey.toString());
  const operator = new Account(operatorId, provider, requireEnv("NEAR_PRIVATE_KEY") as KeyPairString);
  const code = readFileSync(root("contracts/res/hedge_custody.wasm"));
  const codeHash = baseEncode(createHash("sha256").update(code).digest());
  assert.equal(codeHash, manifest.expected_custody_code_hash, "Rebuild and review the pinned custody artifact");
  const report = existsSync(reportPath) ? reportSchema.parse(JSON.parse(readFileSync(reportPath, "utf8"))) : reportSchema.parse({
    network: "testnet", custody: custody.accountId, operator: operatorId, codeHash, steps: [],
  });
  assert.equal(report.custody, custody.accountId); assert.equal(report.operator, operatorId); assert.equal(report.codeHash, codeHash);
  const save = () => saveJson(reportPath, report);
  const view = (contractId: string, method: string, args: Record<string, unknown> = {}) => reader.callFunction({ contractId, method, args });
  const amount = async (contractId: string, method: string, args: Record<string, unknown>) => atomic.parse(await view(contractId, method, args));
  const shares = (account: string) => amount(manifest.config.exchange_id, "mft_balance_of", { token_id: `:${manifest.config.pool_id}`, account_id: account });
  const balance = (token: string, account: string) => amount(token, "ft_balance_of", { account_id: account });
  const snapshot = async () => {
    const [account, usdc, wnear, lp, operatorCash, operatorShares, deposits] = await Promise.all([
      reader.viewAccount({ accountId: custody.accountId }), balance(manifest.usdc, custody.accountId),
      balance(manifest.config.wrapped_near_id, custody.accountId), shares(custody.accountId),
      balance(manifest.usdc, operatorId), shares(operatorId), view(manifest.config.exchange_id, "get_deposits", { account_id: custody.accountId }),
    ]);
    return { block: await reader.viewBlock({ finality: "final" }), account, usdc: usdc.toString(), wnear: wnear.toString(),
      lp: lp.toString(), operatorCash: operatorCash.toString(), operatorShares: operatorShares.toString(), deposits };
  };
  async function confirm(step: z.infer<typeof stepSchema>) {
    const outcome = await reader.viewTransactionStatusWithReceipts({ txHash: step.hash, accountId: step.signer, waitUntil: "FINAL" });
    saveJson(`${directory}/${step.label}-receipt.json`, outcome);
    try {
      settleOutcome(outcome);
      assert.equal(outcome.final_execution_status, "FINAL");
      assert([outcome.transaction_outcome, ...outcome.receipts_outcome].every(({ outcome: item }) =>
        typeof item.status === "object" && !("Failure" in item.status)), "A deployment receipt failed");
      step.gasBurned = [outcome.transaction_outcome, ...outcome.receipts_outcome].reduce((total, item) => total + BigInt(item.outcome.tokens_burnt), 0n).toString();
      step.status = "confirmed";
    } catch (error) { step.status = "failed"; save(); throw error; }
    save(); console.log(`${step.label}: ${step.hash}`);
  }
  async function send(label: string, signer: Account, receiver: string, transactionActions: Parameters<Account["createSignedTransaction"]>[0]["actions"], storageGrowth = 0n, attached = 0n) {
    const previous = report.steps.find((step) => step.label === label);
    if (previous) { assert.equal(previous.status, "confirmed", `Reconcile ${previous.hash}; do not resend`); return; }
    assert(report.steps.every((step) => step.status === "confirmed"), "Resolve all previous transactions before another mutation");
    const account = await provider.viewAccount({ accountId: signer.accountId });
    assert(account.amount - BigInt(account.storage_usage) * 10n ** 19n - storageGrowth - attached >= nearToYocto("2.1"), "Preserve native gas/storage reserve");
    const signed = await signer.createSignedTransaction({ receiverId: receiver, actions: transactionActions });
    const hash = baseEncode(createHash("sha256").update(signed.transaction.encode()).digest());
    const step: z.infer<typeof stepSchema> = { label, signer: signer.accountId, receiver, hash, status: "prepared" };
    report.steps.push(step); save();
    await provider.sendTransactionUntil(signed, "INCLUDED");
    await confirm(step);
  }
  const mode = process.argv[2] ?? "status";
  assert(["status", "apply", "reconcile"].includes(mode), "Use status, apply or reconcile");
  if (mode === "reconcile") {
    for (const step of report.steps.filter((entry) => entry.status === "prepared")) await confirm(step);
    return;
  }
  const before = await snapshot();
  if (mode === "status") { console.log(JSON.stringify(before, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2)); return; }
  if (report.completedAt) { console.log(`Custody deployment already reconciled ${report.completedAt}`); return; }
  assert.equal(await view(manifest.controller, "get_schema_version"), 5, "Never separate experiment assets after the controller migration");
  if (before.account.code_hash === codeHash) {
    const book = custodySchema.parse(await view(custody.accountId, "get_state"));
    assert.equal(book.nonce, 0, "Custody has already been used");
    assert.equal(book.pending, null);
    for (const value of [book.cash, book.inventory, book.cost_basis, book.total_funded, book.total_returned]) assert.equal(value, 0n);
  }
  for (const [accountId, expected] of [[manifest.config.exchange_id, manifest.exchange_code_hash], [manifest.config.wrapped_near_id, manifest.wrapped_near_code_hash]]) {
    assert.equal((await reader.viewAccount({ accountId })).code_hash, expected, "Venue code changed");
  }
  assert(["11111111111111111111111111111111", codeHash].includes(before.account.code_hash), "Unexpected existing custody code");
  assert.equal(before.wnear, "0", "Unwind experiment inventory before deployment");
  assert(Object.values(z.record(z.string(), atomic).parse(before.deposits)).every((value) => value === 0n), "Withdraw all experiment venue deposits first");
  report.before ??= before; save();
  if (!await view(manifest.usdc, "storage_balance_of", { account_id: operatorId })) {
    await send("register-operator-usdc", operator, manifest.usdc, [actions.functionCall("storage_deposit", { account_id: operatorId, registration_only: true }, teraToGas(30), nearToYocto("0.01"))], 0n, nearToYocto("0.01"));
  }
  if (!await view(manifest.config.exchange_id, "mft_has_registered", { token_id: `:${manifest.config.pool_id}`, account_id: operatorId })) {
    await send("register-operator-lp", operator, manifest.config.exchange_id, [actions.functionCall("mft_register", { token_id: `:${manifest.config.pool_id}`, account_id: operatorId }, teraToGas(30), nearToYocto("0.01"))], 0n, nearToYocto("0.01"));
  }
  const lp = await shares(custody.accountId);
  if (lp > 0n) await send("separate-experiment-lp", custody, manifest.config.exchange_id, [actions.functionCall("mft_transfer", {
    token_id: `:${manifest.config.pool_id}`, receiver_id: operatorId, amount: lp.toString(), memo: "Separate project demo LP from vault custody",
  }, teraToGas(30), 1n)]);
  const cash = await balance(manifest.usdc, custody.accountId);
  if (cash > 0n) await send("separate-experiment-cash", custody, manifest.usdc, [actions.functionCall("ft_transfer", {
    receiver_id: operatorId, amount: cash.toString(), memo: "Return independent faucet capital; not vault assets",
  }, teraToGas(30), 1n)]);
  const clean = await snapshot();
  assert.equal(clean.usdc, "0"); assert.equal(clean.wnear, "0"); assert.equal(clean.lp, "0");
  const initial = report.before!;
  assert.equal(BigInt(clean.operatorCash), BigInt(String(initial.operatorCash)) + BigInt(String(initial.usdc)), "Experiment cash conservation failed");
  assert.equal(BigInt(clean.operatorShares), BigInt(String(initial.operatorShares)) + BigInt(String(initial.lp)), "Experiment LP conservation failed");
  const custodyConfig = { controller: manifest.controller, usdc: manifest.usdc,
    wrapped_near: manifest.config.wrapped_near_id, exchange: manifest.config.exchange_id, pool_id: manifest.config.pool_id };
  if (clean.account.code_hash !== codeHash) {
    await send("deploy-custody", custody, custody.accountId, [actions.deployContract(code),
      actions.functionCall("new", { config: custodyConfig }, teraToGas(100))], BigInt(code.length + 4096) * 10n ** 19n);
  }
  assert.equal((await reader.viewAccount({ accountId: custody.accountId })).code_hash, codeHash);
  const book = custodySchema.parse(await view(custody.accountId, "get_state"));
  assert.deepEqual(book.config, custodyConfig);
  assert.equal(book.nonce, 0); assert.equal(book.pending, null);
  for (const value of [book.cash, book.inventory, book.cost_basis, book.total_funded, book.total_returned, book.realized_pnl, book.execution_cost]) assert.equal(value, 0n);
  report.after = { ...await snapshot(), book }; report.completedAt = new Date().toISOString(); save();
  console.log("Custody deployed empty; controller migration and live vault hedge are not yet performed.");
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Custody deployment failed"); process.exitCode = 1; });
