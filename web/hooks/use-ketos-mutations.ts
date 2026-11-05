"use client";

import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import {
  addCrossMarginTx,
  cancelOrderTx,
  closePositionTx,
  depositMarginTx,
  depositVaultTx,
  faucetTx,
  listMarketTx,
  openPositionTx,
  placeOrderTx,
  removeCrossMarginTx,
  switchToCrossTx,
  withdrawMarginTx,
  withdrawVaultTx,
  type ListMarketArgs,
  type OpenPositionArgs,
  type PlaceOrderArgs,
} from "@/lib/near/calls";
import type { NearConfig } from "@/lib/near/config";
import { NearActionError } from "@/lib/near/errors";
import type { NearTransaction, TxResult } from "@/lib/near/tx";
import { orderSchema, positionSchema, type Order, type Position, type VaultId } from "@/lib/near/types";
import { useNear } from "./near-provider";
import { ketosKeys } from "./use-ketos-queries";

export interface TxReceipt {
  /** Null when the wallet did not report the outcome. */
  txHash: string | null;
}

const toAmount = (value: unknown): bigint | null =>
  typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;

const PRICED_ACTION_METHODS: Record<string, true> = {
  open_position: true, close_position: true, place_order: true, execute_orders: true,
  liquidate: true, liquidate_cross: true, withdraw_vault: true, pull_market_price: true,
};

/**
 * Prepares and sends wallet transactions serially, observing prerequisite funding/listing results
 * before the next prompt. Refreshes `invalidate` on success or failure because funds may have moved.
 */
function useTxMutation<TVars, TData extends TxReceipt>(options: {
  build: (config: NearConfig, vars: TVars, accountId: string) =>
    NearTransaction | NearTransaction[] | Promise<NearTransaction | NearTransaction[]>;
  parse: (result: TxResult) => TData;
  invalidate: (accountId: string | null) => QueryKey[];
}) {
  const { config, wallet } = useNear();
  const queryClient = useQueryClient();
  return useMutation<TData, NearActionError, TVars>({
    mutationFn: async (vars) => {
      if (!wallet?.accountId) {
        throw new NearActionError({ code: "NOT_SIGNED_IN", message: "Connect a wallet first." });
      }
      const built = await options.build(config, vars, wallet.accountId);
      const transactions = Array.isArray(built) ? built : [built];
      let result: TxResult | undefined;
      for (const [index, transaction] of transactions.entries()) {
        result = await wallet.signAndSendTransaction(transaction);
        const pricedAction = transaction.actions.some((action) => PRICED_ACTION_METHODS[action.methodName]);
        const transfer = transaction.actions.find((action) => action.methodName === "ft_transfer_call");
        if ((pricedAction || transfer || index < transactions.length - 1) &&
            (!result.txHash || result.value === undefined)) {
          throw new NearActionError({
            code: "UNCONFIRMED_TRANSACTION",
            message: "The wallet did not report a confirmed result. Check the transaction status before retrying.",
          });
        }
        if (pricedAction && result.value === null) {
          throw new NearActionError({
            code: "ACTION_CANCELLED",
            message: "The action was cancelled because a fresh price was unavailable or its conditions changed. No trade or vault withdrawal was applied.",
          });
        }
        if (transfer && result.value !== transfer.args.amount) {
          throw new NearActionError({
            code: "TRANSFER_REFUNDED",
            message: "The token transfer was not fully accepted. Unused USDC was refunded; any unspent oracle deposit remains withdrawable.",
          });
        }
      }
      if (!result) throw new NearActionError({ code: "EMPTY_TRANSACTION", message: "No transaction was prepared." });
      return options.parse(result);
    },
    onSettled: () =>
      Promise.all(
        options.invalidate(wallet?.accountId ?? null).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ),
  });
}

const receipt = ({ txHash }: TxResult): TxReceipt => ({ txHash });

function toPosition(value: unknown): Position | null {
  const result = positionSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Everything a trade, order or margin-mode change can move. */
const tradingKeys = (accountId: string | null): QueryKey[] => [
  ketosKeys.account(accountId),
  ketosKeys.positions(accountId),
  ketosKeys.orders(accountId),
  ketosKeys.crossAccount(accountId),
  ketosKeys.history(accountId),
  ketosKeys.accountStats(accountId),
  ketosKeys.markets(),
  ketosKeys.vaults(),
  ketosKeys.anyVault(),
  ketosKeys.openPositions(),
];

const vaultKeys = (accountId: string | null): QueryKey[] => [
  ketosKeys.account(accountId),
  ketosKeys.vaults(),
  ketosKeys.anyVault(),
  ketosKeys.vaultAccounts(),
];

/** Claims 1,000 tUSDC; `amount` is the minted amount in USDC units. */
export function useFaucet() {
  return useTxMutation<void, TxReceipt & { amount: bigint | null }>({
    build: (config) => faucetTx(config),
    parse: (result) => ({ txHash: result.txHash, amount: toAmount(result.value) }),
    invalidate: (accountId) => [ketosKeys.account(accountId)],
  });
}

/** Variables: amount in USDC units, moved from the tUSDC wallet into free margin. */
export function useDepositMargin() {
  return useTxMutation<bigint, TxReceipt>({
    build: depositMarginTx,
    parse: receipt,
    invalidate: (accountId) => [
      ketosKeys.account(accountId),
      ketosKeys.history(accountId),
      ketosKeys.accountStats(accountId),
    ],
  });
}

/** Variables: amount of free margin in USDC units, sent back to the tUSDC wallet. */
export function useWithdrawMargin() {
  return useTxMutation<bigint, TxReceipt>({
    build: withdrawMarginTx,
    parse: receipt,
    invalidate: (accountId) => [
      ketosKeys.account(accountId),
      ketosKeys.history(accountId),
      ketosKeys.accountStats(accountId),
    ],
  });
}

/** Market order at the oracle price, with optional TP/SL. `position` is the opened position. */
export function useOpenPosition() {
  return useTxMutation<OpenPositionArgs, TxReceipt & { position: Position | null }>({
    build: openPositionTx,
    parse: (result) => ({ txHash: result.txHash, position: toPosition(result.value) }),
    invalidate: tradingKeys,
  });
}

/** Variables: position id. `payout` is what returned to free margin, in USDC units. */
export function useClosePosition() {
  return useTxMutation<number, TxReceipt & { payout: bigint | null }>({
    build: closePositionTx,
    parse: (result) => ({ txHash: result.txHash, payout: toAmount(result.value) }),
    invalidate: tradingKeys,
  });
}

/** Limit, Stop Market, Take Profit or Stop Loss order; `order` is the stored order. */
export function usePlaceOrder() {
  return useTxMutation<PlaceOrderArgs, TxReceipt & { order: Order | null }>({
    build: placeOrderTx,
    parse: (result) => {
      const order = orderSchema.safeParse(result.value);
      return { txHash: result.txHash, order: order.success ? order.data : null };
    },
    invalidate: tradingKeys,
  });
}

/** Variables: order id. */
export function useCancelOrder() {
  return useTxMutation<number, TxReceipt>({
    build: cancelOrderTx,
    parse: receipt,
    invalidate: tradingKeys,
  });
}

/** Variables: USDC units moved from free margin into the cross-margin pool. */
export function useAddCrossMargin() {
  return useTxMutation<bigint, TxReceipt>({
    build: addCrossMarginTx,
    parse: receipt,
    invalidate: tradingKeys,
  });
}

/** Variables: USDC units moved from cross cash back to free margin. */
export function useRemoveCrossMargin() {
  return useTxMutation<bigint, TxReceipt>({
    build: removeCrossMarginTx,
    parse: receipt,
    invalidate: tradingKeys,
  });
}

/** Variables: id of an isolated position to move into the cross-margin pool. */
export function useSwitchToCross() {
  return useTxMutation<number, TxReceipt & { position: Position | null }>({
    build: switchToCrossTx,
    parse: (result) => ({ txHash: result.txHash, position: toPosition(result.value) }),
    invalidate: tradingKeys,
  });
}

/** Pays the 25 USDC listing fee; the new market shows as measuring until its first depth sample. */
export function useListMarket() {
  return useTxMutation<ListMarketArgs, TxReceipt>({
    build: listMarketTx,
    parse: receipt,
    invalidate: (accountId) => [ketosKeys.account(accountId), ketosKeys.markets(), ketosKeys.vaults(), ketosKeys.anyVault()],
  });
}

export interface VaultDepositArgs {
  vaultId: VaultId;
  /** USDC units moved from the tUSDC wallet into the vault. */
  amount: bigint;
}

export function useDepositVault() {
  return useTxMutation<VaultDepositArgs, TxReceipt>({
    build: (config, { vaultId, amount }) => depositVaultTx(config, vaultId, amount),
    parse: receipt,
    invalidate: vaultKeys,
  });
}

export interface VaultWithdrawArgs {
  vaultId: VaultId;
  /** Vault shares to burn. */
  shares: bigint;
}

export function useWithdrawVault() {
  return useTxMutation<VaultWithdrawArgs, TxReceipt>({
    build: (config, { vaultId, shares }) => withdrawVaultTx(config, vaultId, shares),
    parse: receipt,
    invalidate: vaultKeys,
  });
}
