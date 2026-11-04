// Proves the OutLayer price oracle on testnet: fetches fresh prices for the four
// Ketos markets, then sends an `oracle_call` to observe the exact callback payload.
import { Account, JsonRpcProvider, nearToYocto, teraToGas } from "near-api-js";
import { nearAccountId, requireEnv } from "./lib/env.ts";

const ORACLE = "price-oracle.testnet";
const ASSETS = {
  BTC: "nbtc.bridge.near",
  ETH: "aurora",
  NEAR: "wrap.near",
  ZEC: "zec.omft.near",
};
const assetIds = Object.values(ASSETS);

const accountId = nearAccountId();
const privateKey = requireEnv("NEAR_PRIVATE_KEY");
const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com" });
const account = new Account(accountId, provider, privateKey);

function formatPrice(price) {
  const scaled = Number(BigInt(price.multiplier)) / 10 ** price.decimals;
  return scaled.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

console.log(`request_price_data on ${ORACLE} for ${assetIds.join(", ")}`);
await account.callFunction({
  contractId: ORACLE,
  methodName: "request_price_data",
  args: { asset_ids: assetIds },
  deposit: nearToYocto("0.02"),
  gas: teraToGas("200"),
});

const data = await provider.callFunction({
  contractId: ORACLE,
  method: "get_price_data",
  args: { asset_ids: assetIds },
});
const ageSec = (Date.now() * 1e6 - Number(data.timestamp)) / 1e9;
console.log(`get_price_data timestamp=${data.timestamp} (age ${ageSec.toFixed(1)} s, recency ${data.recency_duration_sec} s)`);

let missing = 0;
for (const [symbol, assetId] of Object.entries(ASSETS)) {
  const entry = data.prices.find((p) => p.asset_id === assetId);
  if (!entry?.price || BigInt(entry.price.multiplier) === 0n) {
    missing += 1;
    console.log(`${symbol.padEnd(5)} ${assetId.padEnd(18)} no price`);
    continue;
  }
  console.log(
    `${symbol.padEnd(5)} ${assetId.padEnd(18)} $${formatPrice(entry.price).padStart(12)}  multiplier=${entry.price.multiplier} decimals=${entry.price.decimals}`,
  );
}

// The receiver has no contract, so the callback receipt fails, but its
// FunctionCall action shows the exact `oracle_on_call` arguments the Ketos contract will get.
console.log(`\noracle_call → receiver ${accountId}`);
let txHash;
try {
  const tx = await account.callFunctionRaw({
    contractId: ORACLE,
    methodName: "oracle_call",
    args: { receiver_id: accountId, asset_ids: assetIds, msg: "spike" },
    deposit: nearToYocto("0.02"),
    gas: teraToGas("200"),
  });
  txHash = tx.transaction.hash;
} catch (error) {
  if (!error.transactionResult) throw error;
  txHash = error.transactionResult.transaction.hash;
}
const full = await provider.viewTransactionStatusWithReceipts({
  txHash,
  accountId,
  waitUntil: "FINAL",
});
for (const receipt of full.receipts ?? []) {
  for (const action of receipt.receipt?.Action?.actions ?? []) {
    const call = action.FunctionCall;
    if (call?.method_name !== "oracle_on_call") continue;
    const args = JSON.parse(Buffer.from(call.args, "base64").toString("utf8"));
    console.log(`callback ${receipt.predecessor_id} → ${receipt.receiver_id}.oracle_on_call gas=${call.gas}`);
    console.log(JSON.stringify(args, null, 2));
  }
}
console.log(`tx ${txHash}`);

if (missing > 0) {
  console.error(`${missing} asset(s) without price`);
  process.exit(1);
}
