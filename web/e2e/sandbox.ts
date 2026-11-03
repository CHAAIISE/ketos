import { Account, JsonRpcProvider, teraToGas } from "near-api-js";

// Direct calls to the local sandbox for what the app deliberately cannot do: move the mock oracle
// price and mint test USDC beyond the faucet. Accounts and keys come from web/.env.e2e, loaded by
// global setup.

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing: run the tests through global setup (web/.env.e2e)`);
  return value;
}

function signer(variable: string): { accountId: string; privateKey: string } {
  const value = env(variable);
  const at = value.indexOf(":");
  return { accountId: value.slice(0, at), privateKey: value.slice(at + 1) };
}

const provider = () => new JsonRpcProvider({ url: env("NEXT_PUBLIC_RPC_URL") });

function account(variable: string): Account {
  const { accountId, privateKey } = signer(variable);
  // near-api-js types the key as a template literal ("ed25519:…").
  return new Account(accountId, provider(), privateKey as `ed25519:${string}`);
}

async function call(from: Account, contractId: string, methodName: string, args: object, deposit = 0n): Promise<void> {
  await from.callFunction({ contractId, methodName, args, deposit, gas: teraToGas("100"), waitUntil: "FINAL" });
}

export interface MarketView {
  id: string;
  max_leverage: number;
  max_oi_per_side: string;
  oi_long: string;
  oi_short: string;
}

export async function getMarket(marketId: string): Promise<MarketView> {
  return provider().callFunction({
    contractId: env("NEXT_PUBLIC_PERPS_CONTRACT"),
    method: "get_market",
    args: { market_id: marketId },
  }) as Promise<MarketView>;
}

/** Mints tUSDC to the test trader and moves it into their margin account. */
export async function fundTraderMargin(units: bigint): Promise<void> {
  const usdc = env("NEXT_PUBLIC_USDC_CONTRACT");
  const trader = account("NEXT_PUBLIC_E2E_SIGNER");
  await call(account("E2E_ROOT_SIGNER"), usdc, "mint", { account_id: trader.accountId, amount: units.toString() });
  await call(
    trader,
    usdc,
    "ft_transfer_call",
    { receiver_id: env("NEXT_PUBLIC_PERPS_CONTRACT"), amount: units.toString(), msg: "deposit_margin" },
    1n,
  );
}

/** Sets the mock oracle price (8 decimals); the keeper pulls it into perps on its next tick. */
export async function setOraclePrice(assetId: string, usd: number): Promise<void> {
  const multiplier = BigInt(Math.round(usd * 1e8));
  await call(account("E2E_ROOT_SIGNER"), env("E2E_ORACLE_CONTRACT"), "set_price", {
    asset_id: assetId,
    multiplier: multiplier.toString(),
    decimals: 8,
  });
}
