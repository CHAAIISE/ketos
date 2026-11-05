import { z } from "zod";
import type { NearConfig } from "./config";
import type { NearTransaction } from "./tx";
import { signedPricesArg, signedPricesFor, type PriceContracts } from "./signed-prices";
import type { MarginMode, MarketId, PriceSource, Side, VaultId } from "./types";
import { KetosViews } from "./views";

const TGAS = 10n ** 12n;
/** Enough for `ft_transfer_call` → `ft_on_transfer` → `ft_resolve_transfer` and for withdraw callbacks. */
const GAS = 100n * TGAS;
const PULL_GAS = 300n * TGAS;
/** Methods guarded by `assert_one_yocto` require a full-access key confirmation. */
const ONE_YOCTO = 1n;

export const MSG_DEPOSIT_MARGIN = "deposit_margin";
export const MSG_LIST_MARKET = "list_market:";
/** Exact amount `list_market` accepts, USDC units; it goes to the Long-tail vault. */
export const LISTING_FEE = 5_000_000n;

export const depositVaultMsg = (vaultId: VaultId) => `deposit_vault:${vaultId}`;

type Contracts = Pick<NearConfig, "ketosContract" | "usdcContract">;

async function requestDeposit(c: PriceContracts, method: string, args: Record<string, unknown>): Promise<bigint> {
  const views = new KetosViews(c.rpcUrl, c.ketosContract, c.usdcContract);
  const value = await views.provider.callFunction({ contractId: c.ketosContract, method, args });
  return z.string().regex(/^\d+$/).transform(BigInt).parse(value);
}

/** Maximum oracle deposit in yoctoNEAR; unused funds are refunded if the cache stays fresh. */
export function priceRequestDeposit(c: PriceContracts, market: MarketId): Promise<bigint> {
  return requestDeposit(c, "get_price_request_deposit", { market });
}

export function vaultPriceRequestDeposit(c: PriceContracts, vaultId: VaultId): Promise<bigint> {
  return requestDeposit(c, "get_vault_price_request_deposit", { vault_id: vaultId });
}

function call(
  receiverId: string,
  methodName: string,
  args: Record<string, unknown>,
  deposit = 0n,
  gas = GAS,
): NearTransaction {
  return { receiverId, actions: [{ methodName, args, gas, deposit }] };
}

/** Claims 1,000 tUSDC (once per hour); registers the account on the token if needed. */
export function faucetTx(c: Contracts): NearTransaction {
  return call(c.usdcContract, "faucet", {});
}

function transferCallTx(c: Contracts, amount: bigint, msg: string, gas = GAS): NearTransaction {
  return call(
    c.usdcContract,
    "ft_transfer_call",
    { receiver_id: c.ketosContract, amount: amount.toString(), msg },
    ONE_YOCTO,
    gas,
  );
}

/** Moves `amount` USDC units from the tUSDC wallet into free margin. */
export function depositMarginTx(c: Contracts, amount: bigint): NearTransaction {
  return transferCallTx(c, amount, MSG_DEPOSIT_MARGIN);
}

/** Sends `amount` USDC units of free margin back to the tUSDC wallet. */
export function withdrawMarginTx(c: Contracts, amount: bigint): NearTransaction {
  return call(c.ketosContract, "withdraw_margin", { amount: amount.toString() }, ONE_YOCTO);
}

/** Trigger prices, 8 decimals; either may be omitted. */
export interface Brackets {
  takeProfit?: bigint | null;
  stopLoss?: bigint | null;
}

function bracketsArg(brackets: Brackets | undefined) {
  const takeProfit = brackets?.takeProfit ?? null;
  const stopLoss = brackets?.stopLoss ?? null;
  if (takeProfit === null && stopLoss === null) return null;
  return { take_profit: takeProfit?.toString() ?? null, stop_loss: stopLoss?.toString() ?? null };
}

export interface OpenPositionArgs {
  marketId: MarketId;
  side: Side;
  /** Collateral taken from free margin, USDC units. */
  margin: bigint;
  leverage: number;
  /** Defaults to isolated. */
  marginMode?: MarginMode;
  /** Take profit / stop loss placed with the position, executed by the keeper at the oracle price. */
  brackets?: Brackets;
}

export async function openPositionTx(c: PriceContracts, args: OpenPositionArgs, accountId: string): Promise<NearTransaction> {
  const prices = await signedPricesFor(c, {
    kind: "open", market: args.marketId, accountId, marginMode: args.marginMode ?? "isolated",
  });
  return call(c.ketosContract, "open_position", {
    market_id: args.marketId,
    side: args.side,
    margin: args.margin.toString(),
    leverage: args.leverage,
    brackets: bracketsArg(args.brackets),
    margin_mode: args.marginMode ?? "isolated",
    ...signedPricesArg(prices),
  }, await requestDeposit(c, "get_open_price_request_deposit", {
    market: args.marketId, account_id: accountId, margin_mode: args.marginMode ?? "isolated",
  }), PULL_GAS);
}

export async function closePositionTx(c: PriceContracts, positionId: number): Promise<NearTransaction> {
  return call(c.ketosContract, "close_position", {
    position_id: positionId, ...signedPricesArg(await signedPricesFor(c, { kind: "position", positionId })),
  }, await requestDeposit(c, "get_position_price_request_deposit", { position_id: positionId }), PULL_GAS);
}

/** Funds adapter batches for the order markets, including position-backed exits. */
export async function executeOrdersTx(c: PriceContracts, ids: number[]): Promise<NearTransaction> {
  return call(c.ketosContract, "execute_orders", {
    ids, ...signedPricesArg(await signedPricesFor(c, { kind: "orders", ids })),
  }, await requestDeposit(c, "get_orders_price_request_deposit", { ids }), PULL_GAS);
}

export async function liquidateTx(c: PriceContracts, positionId: number): Promise<NearTransaction> {
  return call(c.ketosContract, "liquidate", {
    position_id: positionId, ...signedPricesArg(await signedPricesFor(c, { kind: "position", positionId })),
  }, await requestDeposit(c, "get_position_price_request_deposit", { position_id: positionId }), PULL_GAS);
}

export async function liquidateCrossTx(c: PriceContracts, accountId: string): Promise<NearTransaction> {
  return call(c.ketosContract, "liquidate_cross", {
    account_id: accountId, ...signedPricesArg(await signedPricesFor(c, { kind: "cross", accountId })),
  }, await requestDeposit(c, "get_cross_price_request_deposit", { account_id: accountId }), PULL_GAS);
}

/**
 * Entry orders reserve `margin` from free margin until they fill or are cancelled. Limit fills
 * once the price reaches the trigger in the trader's favour (long: at or below), Stop Market once
 * it breaks through it (long: at or above). Exits attach to an open position.
 */
export type PlaceOrderArgs =
  | (OpenPositionArgs & { kind: "limit" | "stop_market"; triggerPrice: bigint })
  | { kind: "take_profit" | "stop_loss"; positionId: number; triggerPrice: bigint };

export async function placeOrderTx(c: PriceContracts, args: PlaceOrderArgs): Promise<NearTransaction> {
  const request =
    "positionId" in args
      ? { kind: args.kind, position_id: args.positionId, trigger_price: args.triggerPrice.toString() }
      : {
          kind: args.kind,
          market_id: args.marketId,
          side: args.side,
          margin: args.margin.toString(),
          leverage: args.leverage,
          trigger_price: args.triggerPrice.toString(),
          brackets: bracketsArg(args.brackets),
          margin_mode: args.marginMode ?? "isolated",
        };
  // Entry orders only reserve margin; position-backed exits validate the current price.
  const deposit = "positionId" in args
    ? await requestDeposit(c, "get_position_price_request_deposit", { position_id: args.positionId })
    : 0n;
  const prices = "positionId" in args
    ? await signedPricesFor(c, { kind: "position", positionId: args.positionId }) : null;
  return call(c.ketosContract, "place_order", { request, ...signedPricesArg(prices) }, deposit, "positionId" in args ? PULL_GAS : GAS);
}

/** Cancels a pending order; reserved margin returns to free margin. */
export function cancelOrderTx(c: Contracts, orderId: number): NearTransaction {
  return call(c.ketosContract, "cancel_order", { order_id: orderId });
}

/** Moves `amount` USDC units of free margin into the shared cross-margin pool. */
export function addCrossMarginTx(c: Contracts, amount: bigint): NearTransaction {
  return call(c.ketosContract, "add_cross_margin", { amount: amount.toString() });
}

/** Moves `amount` USDC units of cross cash back to free margin, if the account stays healthy. */
export function removeCrossMarginTx(c: Contracts, amount: bigint): NearTransaction {
  return call(c.ketosContract, "remove_cross_margin", { amount: amount.toString() });
}

/** Moves an isolated position into the cross-margin pool; there is no way back. */
export function switchToCrossTx(c: Contracts, positionId: number): NearTransaction {
  return call(c.ketosContract, "switch_to_cross", { position_id: positionId });
}

/** Fund the maximum oracle cost first, then transfer USDC; observe each result in order. */
export async function depositVaultTx(c: PriceContracts, vaultId: VaultId, amount: bigint): Promise<NearTransaction[]> {
  const deposit = await vaultPriceRequestDeposit(c, vaultId);
  const prices = await signedPricesFor(c, { kind: "vault", vaultId });
  const msg = prices ? `deposit_vault:${JSON.stringify({ vault_id: vaultId, signed_prices: prices })}` : depositVaultMsg(vaultId);
  const transfer = transferCallTx(c, amount, msg, PULL_GAS);
  return deposit > 0n ? [fundPriceRequestsTx(c, deposit), transfer] : [transfer];
}

/** Credits remain withdrawable if the subsequent USDC transfer is cancelled or fails. */
export function fundPriceRequestsTx(c: Contracts, deposit: bigint): NearTransaction {
  return call(c.ketosContract, "fund_price_requests", {}, deposit);
}

export function withdrawPriceDepositTx(c: Contracts): NearTransaction {
  return call(c.ketosContract, "withdraw_price_deposit", {}, ONE_YOCTO);
}

/** Burns `shares` vault shares for USDC at a freshly priced NAV. */
export async function withdrawVaultTx(c: PriceContracts, vaultId: VaultId, shares: bigint): Promise<NearTransaction> {
  return call(c.ketosContract, "withdraw_vault", {
    vault_id: vaultId, shares: shares.toString(),
    ...signedPricesArg(await signedPricesFor(c, { kind: "vault", vaultId })),
  }, (await vaultPriceRequestDeposit(c, vaultId)) + ONE_YOCTO, PULL_GAS);
}

export interface ListMarketArgs {
  /** Uppercase ticker, e.g. "PEPE". */
  symbol: string;
  oracleAssetId: string;
  /** `nep141:<token>` id on NEAR Intents, used to measure exit liquidity. */
  intentsAssetId: string;
  priceSource: PriceSource;
}

/**
 * Lists a market in the Long-tail vault by paying the 5 USDC fee from the tUSDC wallet. The
 * market stays closed ("measuring") until the keeper publishes its first depth sample. An
 * initial price request follows the observed successful listing, funded by its creator.
 */
export async function listMarketTx(c: PriceContracts, args: ListMarketArgs): Promise<NearTransaction[]> {
  const request = {
    symbol: args.symbol,
    oracle_asset_id: args.oracleAssetId,
    intents_asset_id: args.intentsAssetId,
    price_source: args.priceSource,
  };
  const prices = await signedPricesFor(c, { kind: "markets", markets: [args.symbol] });
  return [
    transferCallTx(c, LISTING_FEE, `${MSG_LIST_MARKET}${JSON.stringify(request)}`),
    call(c.ketosContract, "pull_market_price", {
      market_id: args.symbol, ...signedPricesArg(prices),
    }, 20_000_000_000_000_000_000_000n, PULL_GAS),
  ];
}
