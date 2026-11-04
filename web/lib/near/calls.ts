import type { NearConfig } from "./config";
import type { NearTransaction } from "./tx";
import type { MarginMode, MarketId, PriceSource, Side, VaultId } from "./types";

const TGAS = 10n ** 12n;
/** Enough for `ft_transfer_call` → `ft_on_transfer` → `ft_resolve_transfer` and for withdraw callbacks. */
const GAS = 100n * TGAS;
/** Methods guarded by `assert_one_yocto` require a full-access key confirmation. */
const ONE_YOCTO = 1n;

export const MSG_DEPOSIT_MARGIN = "deposit_margin";
export const MSG_LIST_MARKET = "list_market:";
/** Exact amount `list_market` accepts, USDC units; it goes to the Long-tail vault. */
export const LISTING_FEE = 5_000_000n;

export const depositVaultMsg = (vaultId: VaultId) => `deposit_vault:${vaultId}`;

type Contracts = Pick<NearConfig, "ketosContract" | "usdcContract">;

function call(
  receiverId: string,
  methodName: string,
  args: Record<string, unknown>,
  deposit = 0n,
): NearTransaction {
  return { receiverId, actions: [{ methodName, args, gas: GAS, deposit }] };
}

/** Claims 1,000 tUSDC (once per hour); registers the account on the token if needed. */
export function faucetTx(c: Contracts): NearTransaction {
  return call(c.usdcContract, "faucet", {});
}

function transferCallTx(c: Contracts, amount: bigint, msg: string): NearTransaction {
  return call(
    c.usdcContract,
    "ft_transfer_call",
    { receiver_id: c.ketosContract, amount: amount.toString(), msg },
    ONE_YOCTO,
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

export function openPositionTx(c: Contracts, args: OpenPositionArgs): NearTransaction {
  return call(c.ketosContract, "open_position", {
    market_id: args.marketId,
    side: args.side,
    margin: args.margin.toString(),
    leverage: args.leverage,
    brackets: bracketsArg(args.brackets),
    margin_mode: args.marginMode ?? "isolated",
  });
}

export function closePositionTx(c: Contracts, positionId: number): NearTransaction {
  return call(c.ketosContract, "close_position", { position_id: positionId });
}

/**
 * Entry orders reserve `margin` from free margin until they fill or are cancelled. Limit fills
 * once the price reaches the trigger in the trader's favour (long: at or below), Stop Market once
 * it breaks through it (long: at or above). Exits attach to an open position.
 */
export type PlaceOrderArgs =
  | (OpenPositionArgs & { kind: "limit" | "stop_market"; triggerPrice: bigint })
  | { kind: "take_profit" | "stop_loss"; positionId: number; triggerPrice: bigint };

export function placeOrderTx(c: Contracts, args: PlaceOrderArgs): NearTransaction {
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
  return call(c.ketosContract, "place_order", { request });
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

/** Moves `amount` USDC units from the tUSDC wallet into a liquidity vault. */
export function depositVaultTx(c: Contracts, vaultId: VaultId, amount: bigint): NearTransaction {
  return transferCallTx(c, amount, depositVaultMsg(vaultId));
}

/** Burns `shares` vault shares for USDC at the current NAV. */
export function withdrawVaultTx(c: Contracts, vaultId: VaultId, shares: bigint): NearTransaction {
  return call(c.ketosContract, "withdraw_vault", { vault_id: vaultId, shares: shares.toString() }, ONE_YOCTO);
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
 * market stays closed ("measuring") until the keeper publishes its first depth sample.
 */
export function listMarketTx(c: Contracts, args: ListMarketArgs): NearTransaction {
  const request = {
    symbol: args.symbol,
    oracle_asset_id: args.oracleAssetId,
    intents_asset_id: args.intentsAssetId,
    price_source: args.priceSource,
  };
  return transferCallTx(c, LISTING_FEE, `${MSG_LIST_MARKET}${JSON.stringify(request)}`);
}
