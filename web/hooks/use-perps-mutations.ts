"use client";

import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import {
  closePositionTx,
  depositMarginTx,
  depositVaultTx,
  faucetTx,
  openPositionTx,
  withdrawMarginTx,
  withdrawVaultTx,
  type OpenPositionArgs,
} from "@/lib/near/calls";
import type { NearConfig } from "@/lib/near/config";
import { NearActionError } from "@/lib/near/errors";
import type { NearTransaction, TxResult } from "@/lib/near/tx";
import { positionSchema, type Position } from "@/lib/near/types";
import { useNear } from "./near-provider";
import { perpsKeys } from "./use-perps-queries";

export interface TxReceipt {
  /** Null when the wallet did not report the outcome. */
  txHash: string | null;
}

const toAmount = (value: unknown): bigint | null =>
  typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;

/**
 * Sends a transaction built from the mutation variables and refreshes `invalidate` once it
 * settles, success or not: a failed receipt can still have moved funds (e.g. a refund).
 */
function useTxMutation<TVars, TData extends TxReceipt>(options: {
  build: (config: NearConfig, vars: TVars) => NearTransaction;
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
      return options.parse(await wallet.signAndSendTransaction(options.build(config, vars)));
    },
    onSettled: () =>
      Promise.all(
        options.invalidate(wallet?.accountId ?? null).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ),
  });
}

const receipt = ({ txHash }: TxResult): TxReceipt => ({ txHash });

const tradingKeys = (accountId: string | null): QueryKey[] => [
  perpsKeys.account(accountId),
  perpsKeys.positions(accountId),
  perpsKeys.markets(),
  perpsKeys.vault(),
];

const vaultKeys = (accountId: string | null): QueryKey[] => [
  perpsKeys.account(accountId),
  perpsKeys.vault(),
  perpsKeys.vaultAccount(accountId),
];

/** Claims 1,000 tUSDC; `amount` is the minted amount in USDC units. */
export function useFaucet() {
  return useTxMutation<void, TxReceipt & { amount: bigint | null }>({
    build: (config) => faucetTx(config),
    parse: (result) => ({ txHash: result.txHash, amount: toAmount(result.value) }),
    invalidate: (accountId) => [perpsKeys.account(accountId)],
  });
}

/** Variables: amount in USDC units, moved from the tUSDC wallet into free margin. */
export function useDepositMargin() {
  return useTxMutation<bigint, TxReceipt>({
    build: depositMarginTx,
    parse: receipt,
    invalidate: (accountId) => [perpsKeys.account(accountId)],
  });
}

/** Variables: amount of free margin in USDC units, sent back to the tUSDC wallet. */
export function useWithdrawMargin() {
  return useTxMutation<bigint, TxReceipt>({
    build: withdrawMarginTx,
    parse: receipt,
    invalidate: (accountId) => [perpsKeys.account(accountId)],
  });
}

/** `position` is the opened position as returned by the contract. */
export function useOpenPosition() {
  return useTxMutation<OpenPositionArgs, TxReceipt & { position: Position | null }>({
    build: openPositionTx,
    parse: (result) => {
      const parsed = positionSchema.safeParse(result.value);
      return { txHash: result.txHash, position: parsed.success ? parsed.data : null };
    },
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

/** Variables: amount in USDC units, moved from the tUSDC wallet into the vault. */
export function useDepositVault() {
  return useTxMutation<bigint, TxReceipt>({
    build: depositVaultTx,
    parse: receipt,
    invalidate: vaultKeys,
  });
}

/** Variables: vault shares to burn. */
export function useWithdrawVault() {
  return useTxMutation<bigint, TxReceipt>({
    build: withdrawVaultTx,
    parse: receipt,
    invalidate: vaultKeys,
  });
}
