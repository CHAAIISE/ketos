"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
import type { MarketId } from "@/lib/near/types";
import { useAccountId, useNear } from "./near-provider";

/** Live data (prices, positions) polls every 5 s; slower-moving views every 10–15 s. */
const LIVE_MS = 5_000;
const SLOW_MS = 10_000;
const DEPTH_MS = 15_000;

export const ketosKeys = {
  all: ["ketos"] as const,
  config: () => ["ketos", "config"] as const,
  markets: () => ["ketos", "markets"] as const,
  prices: () => ["ketos", "prices"] as const,
  account: (accountId: string | null) => ["ketos", "account", accountId] as const,
  positions: (accountId: string | null) => ["ketos", "positions", accountId] as const,
  vault: () => ["ketos", "vault"] as const,
  vaultAccount: (accountId: string | null) => ["ketos", "vault-account", accountId] as const,
  depth: (marketId: MarketId | null) => ["ketos", "depth", marketId] as const,
  liquidations: (limit: number) => ["ketos", "liquidations", limit] as const,
  openPositions: () => ["ketos", "open-positions"] as const,
};

/** Token, oracle and keeper accounts; fixed at deployment. */
export function useConfig() {
  const { views } = useNear();
  return useQuery({ queryKey: ketosKeys.config(), queryFn: () => views.config(), staleTime: Infinity });
}

export function useMarkets() {
  const { views } = useNear();
  return useQuery({ queryKey: ketosKeys.markets(), queryFn: () => views.markets(), refetchInterval: LIVE_MS });
}

export function usePrices() {
  const { views } = useNear();
  return useQuery({ queryKey: ketosKeys.prices(), queryFn: () => views.prices(), refetchInterval: LIVE_MS });
}

export interface AccountSummary {
  accountId: string;
  /** Free margin on the perps contract, USDC units. */
  margin: bigint;
  /** False until the first margin deposit creates the account. */
  hasMarginAccount: boolean;
  /** tUSDC held in the wallet, USDC units. */
  usdcBalance: bigint;
  /** Next faucet claim time (ms since epoch), 0 when it can be claimed now. */
  faucetAvailableAtMs: number;
}

/** Margin and wallet balances of the signed-in account; idle while signed out. */
export function useAccount() {
  const { views } = useNear();
  const accountId = useAccountId();
  return useQuery({
    queryKey: ketosKeys.account(accountId),
    queryFn: accountId
      ? async (): Promise<AccountSummary> => {
          const [account, usdcBalance, faucetAvailableAtMs] = await Promise.all([
            views.account(accountId),
            views.usdcBalance(accountId),
            views.faucetAvailableAt(accountId),
          ]);
          return {
            accountId,
            margin: account?.margin ?? 0n,
            hasMarginAccount: account !== null,
            usdcBalance,
            faucetAvailableAtMs,
          };
        }
      : skipToken,
    refetchInterval: SLOW_MS,
  });
}

/** Open positions of the signed-in account, marked to the latest oracle price. */
export function usePositions() {
  const { views } = useNear();
  const accountId = useAccountId();
  return useQuery({
    queryKey: ketosKeys.positions(accountId),
    queryFn: accountId ? () => views.positions(accountId) : skipToken,
    refetchInterval: LIVE_MS,
  });
}

export function useVault() {
  const { views } = useNear();
  return useQuery({ queryKey: ketosKeys.vault(), queryFn: () => views.vault(), refetchInterval: SLOW_MS });
}

/** Vault shares of the signed-in account. */
export function useVaultAccount() {
  const { views } = useNear();
  const accountId = useAccountId();
  return useQuery({
    queryKey: ketosKeys.vaultAccount(accountId),
    queryFn: accountId ? () => views.vaultAccount(accountId) : skipToken,
    refetchInterval: SLOW_MS,
  });
}

/** Market with its depth history (oldest first); null data when the market has no depth yet. */
export function useDepth(marketId: MarketId | null) {
  const { views } = useNear();
  return useQuery({
    queryKey: ketosKeys.depth(marketId),
    queryFn: marketId ? () => views.depth(marketId) : skipToken,
    refetchInterval: DEPTH_MS,
  });
}

/** Most recent liquidations first (the contract keeps at most 20). */
export function useLiquidations(limit = 20) {
  const { views } = useNear();
  return useQuery({
    queryKey: ketosKeys.liquidations(limit),
    queryFn: () => views.liquidations(limit),
    refetchInterval: SLOW_MS,
  });
}

/** Every open position on every market (all accounts), newest last as the contract lists them. */
export function useAllOpenPositions() {
  const { views } = useNear();
  return useQuery({
    queryKey: ketosKeys.openPositions(),
    queryFn: () => views.allOpenPositions(),
    refetchInterval: SLOW_MS,
  });
}
