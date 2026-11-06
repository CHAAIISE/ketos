import { setTimeout as sleep } from "node:timers/promises";
import { Account, JsonRpcProvider, teraToGas } from "near-api-js";
import { KetosViews } from "../lib/near/views";

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

export function sandboxViews(): KetosViews {
  return new KetosViews(env("NEXT_PUBLIC_RPC_URL"), env("NEXT_PUBLIC_KETOS_CONTRACT"), env("NEXT_PUBLIC_USDC_CONTRACT"));
}

function account(variable: string): Account {
  const { accountId, privateKey } = signer(variable);
  // near-api-js types the key as a template literal ("ed25519:…").
  return new Account(accountId, provider(), privateKey as `ed25519:${string}`);
}

async function priceRequestDeposit(from: Account, methodName: string, args: Record<string, unknown>): Promise<bigint> {
  const request = args.request as Record<string, unknown> | undefined;
  let quote: { method: string; args: Record<string, unknown> } | undefined;
  if (methodName === "open_position") {
    quote = { method: "get_price_request_deposit", args: { market: args.market_id } };
  } else if (methodName === "place_order") {
    quote = request?.market_id
      ? { method: "get_price_request_deposit", args: { market: request.market_id } }
      : { method: "get_position_price_request_deposit", args: { position_id: request?.position_id } };
  } else if (methodName === "close_position" || methodName === "liquidate") {
    quote = { method: "get_position_price_request_deposit", args: { position_id: args.position_id } };
  } else if (methodName === "execute_orders") {
    quote = { method: "get_orders_price_request_deposit", args: { ids: args.ids } };
  } else if (methodName === "liquidate_cross") {
    quote = { method: "get_cross_price_request_deposit", args: { account_id: args.account_id } };
  } else if (methodName === "withdraw_vault") {
    quote = { method: "get_vault_price_request_deposit", args: { vault_id: args.vault_id } };
  }
  let cost = 0n;
  if (quote) {
    const rpc = provider();
    const contractId = env("NEXT_PUBLIC_KETOS_CONTRACT");
    const config = await rpc.callFunction({ contractId, method: "get_config", args: {} }) as { keeper_id: string };
    if (from.accountId !== config.keeper_id) {
      cost = BigInt(await rpc.callFunction({ contractId, ...quote }) as string);
    }
  }
  return cost + (methodName === "withdraw_vault" ? 1n : 0n);
}

async function call(from: Account, contractId: string, methodName: string, args: Record<string, unknown>, deposit?: bigint): Promise<void> {
  const ketos = env("NEXT_PUBLIC_KETOS_CONTRACT");
  if (methodName === "ft_transfer_call" && args.receiver_id === ketos && typeof args.msg === "string" && args.msg.startsWith("deposit_vault:")) {
    const cost = BigInt(await provider().callFunction({
      contractId: ketos,
      method: "get_vault_price_request_deposit",
      args: { vault_id: args.msg.slice("deposit_vault:".length) },
    }) as string);
    if (cost > 0n) await call(from, ketos, "fund_price_requests", {}, cost);
  }
  const attached = deposit ?? (contractId === ketos ? await priceRequestDeposit(from, methodName, args) : 0n);
  await from.callFunction({ contractId, methodName, args, deposit: attached, gas: teraToGas("300"), waitUntil: "FINAL" });
}

export interface MarketView {
  id: string;
  max_leverage: number;
  max_oi_per_side: string;
  effective_max_oi_per_side: string;
  is_open: boolean;
  oi_long: string;
  oi_short: string;
}

export async function getMarket(marketId: string): Promise<MarketView> {
  return provider().callFunction({
    contractId: env("NEXT_PUBLIC_KETOS_CONTRACT"),
    method: "get_market",
    args: { market_id: marketId },
  }) as Promise<MarketView>;
}

export const traderAccountId = (): string => signer("NEXT_PUBLIC_E2E_SIGNER").accountId;

/** Mints tUSDC into the test trader's wallet, beyond the faucet's hourly 1,000. */
export async function mintTraderUsdc(units: bigint): Promise<void> {
  const usdc = env("NEXT_PUBLIC_USDC_CONTRACT");
  await call(account("E2E_ROOT_SIGNER"), usdc, "mint", { account_id: traderAccountId(), amount: units.toString() });
}

/** Mints tUSDC to the test trader and moves it into their margin account. */
export async function fundTraderMargin(units: bigint): Promise<void> {
  const usdc = env("NEXT_PUBLIC_USDC_CONTRACT");
  const trader = account("NEXT_PUBLIC_E2E_SIGNER");
  await mintTraderUsdc(units);
  await call(
    trader,
    usdc,
    "ft_transfer_call",
    { receiver_id: env("NEXT_PUBLIC_KETOS_CONTRACT"), amount: units.toString(), msg: "deposit_margin" },
    1n,
  );
}

/** Clears the scenario account through public methods, without resetting the contract. */
export async function clearTraderTrading(): Promise<void> {
  const views = sandboxViews();
  const trader = account("NEXT_PUBLIC_E2E_SIGNER");
  const ketos = env("NEXT_PUBLIC_KETOS_CONTRACT");
  for (const order of await views.orders(trader.accountId)) {
    await call(trader, ketos, "cancel_order", { order_id: order.id, to_wallet: true });
  }
  for (const position of await views.positions(trader.accountId)) {
    await call(trader, ketos, "close_position", { position_id: position.id, to_wallet: true });
  }
  const margin = (await views.account(trader.accountId))?.margin ?? 0n;
  if (margin > 0n) await call(trader, ketos, "withdraw_margin", { amount: margin.toString() }, 1n);
}

/** Sets the mock oracle price (8 decimals); the next stale-cache action pulls it on demand. */
export async function setOraclePrice(assetId: string, usd: number): Promise<void> {
  const multiplier = BigInt(Math.round(usd * 1e8));
  await call(account("E2E_ROOT_SIGNER"), env("E2E_ORACLE_CONTRACT"), "set_price", {
    asset_id: assetId,
    multiplier: multiplier.toString(),
    decimals: 8,
  });
}

/** Runs the local keeper's real oracle refresh before checking fresh-price admission. */
export async function refreshSandboxPrices(): Promise<void> {
  const rpc = provider();
  const contractId = env("NEXT_PUBLIC_KETOS_CONTRACT");
  const lastRequest = await rpc.callFunction({ contractId, method: "get_last_price_request_ms", args: {} }) as number | null;
  if (lastRequest !== null) {
    const block = await rpc.viewBlock({ finality: "final" });
    const nowMs = Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
    const waitMs = lastRequest + 30_000 - nowMs;
    if (waitMs > 0) await sleep(waitMs + 500);
  }
  const config = await rpc.callFunction({ contractId, method: "get_config", args: {} }) as { keeper_id: string };
  const keeper = new Account(config.keeper_id, rpc, env("KEEPER_PRIVATE_KEY") as `ed25519:${string}`);
  await call(keeper, contractId, "refresh_prices", {}, 0n);
}
