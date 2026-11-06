"use client";

import { skipToken, useQueries, useQuery } from "@tanstack/react-query";
import type { HistoryKind, LeaderboardSort, MarketId, VaultId } from "@/lib/near/types";
import { useAccountId, useNear } from "./near-provider";

/** Live data (prices, positions) polls every 5 s; slower-moving views every 10–15 s. */
const LIVE_MS = 5_000;
const SLOW_MS = 10_000;
const DEPTH_MS = 15_000;
/** Vault snapshots are hourly and the leaderboard only moves on trades. */
const HISTORY_MS = 60_000;

export const ketosKeys = {
  all: ["ketos"] as const,
  config: () => ["ketos", "config"] as const,
  markets: () => ["ketos", "markets"] as const,
  prices: () => ["ketos", "prices"] as const,
  account: (accountId: string | null) => ["ketos", "account", accountId] as const,
  positions: (accountId: string | null) => ["ketos", "positions", accountId] as const,
  orders: (accountId: string | null) => ["ketos", "orders", accountId] as const,
  crossAccount: (accountId: string | null) => ["ketos", "cross-account", accountId] as const,
  history: (accountId: string | null) => ["ketos", "history", accountId] as const,
  accountStats: (accountId: string | null) => ["ketos", "account-stats", accountId] as const,
  leaderboard: (sort: LeaderboardSort, limit: number) => ["ketos", "leaderboard", sort, limit] as const,
  vaults: () => ["ketos", "vaults"] as const,
  vault: (vaultId: VaultId) => ["ketos", "vault", vaultId] as const,
  vaultHistory: (vaultId: VaultId) => ["ketos", "vault-history", vaultId] as const,
  /** Prefix matching `vault(id)` of every vault. */
  anyVault: () => ["ketos", "vault"] as const,
  vaultAccount: (vaultId: VaultId, accountId: string | null) => ["ketos", "vault-account", vaultId, accountId] as const,
  /** Prefix matching every vault account query of every vault. */
  vaultAccounts: () => ["ketos", "vault-account"] as const,
  depth: (marketId: MarketId | null) => ["ketos", "depth", marketId] as const,
  liquidations: (limit: number) => ["ketos", "liquidations", limit] as const,
  openPositions: () => ["ketos", "open-positions"] as const,
};

/** Token, oracle and keeper accounts; fixed at deployment. */
export function useConfig() {
  const { views } = useNear();
  return useQuery({ queryKey: ketosKeys.config(), queryFn: () => views.config(), staleTime: Infinity });
}

/** Every market of the registry, permissionless listings included. */
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
  /** Margin locked by pending entry orders, USDC units. */
  reservedMargin: bigint;
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
            reservedMargin: account?.reserved_margin ?? 0n,
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

/** Pending entry and exit orders of the signed-in account. */
export function useOrders() {
  const { views } = useNear();
  const accountId = useAccountId();
  return useQuery({
    queryKey: ketosKeys.orders(accountId),
    queryFn: accountId ? () => views.orders(accountId) : skipToken,
    refetchInterval: LIVE_MS,
  });
}

/** Shared cross-margin pool of the signed-in account: cash, equity and health. */
export function useCrossAccount() {
  const { views } = useNear();
  const accountId = useAccountId();
  return useQuery({
    queryKey: ketosKeys.crossAccount(accountId),
    queryFn: accountId ? () => views.crossAccount(accountId) : skipToken,
    refetchInterval: LIVE_MS,
  });
}

/**
 * Trade, order fill, liquidation, funding and margin-transfer events (last 200), newest
 * first. `kinds` narrows the list, e.g. `["funding"]` for funding history.
 */
export function useHistory(kinds?: readonly HistoryKind[]) {
  const { views } = useNear();
  const accountId = useAccountId();
  return useQuery({
    queryKey: ketosKeys.history(accountId),
    queryFn: accountId ? () => views.history(accountId) : skipToken,
    select: (events) => {
      const kept = kinds ? events.filter((event) => kinds.includes(event.kind)) : [...events];
      return kept.reverse();
    },
    refetchInterval: SLOW_MS,
  });
}

/** All-time trading totals of the signed-in account; null before any recorded account event. */
export function useAccountStats() {
  const { views } = useNear();
  const accountId = useAccountId();
  return useQuery({
    queryKey: ketosKeys.accountStats(accountId),
    queryFn: accountId ? () => views.accountStats(accountId) : skipToken,
    refetchInterval: SLOW_MS,
  });
}

/** All-time ranking by realized PnL or by volume. */
export function useLeaderboard(sort: LeaderboardSort = "pnl", limit = 100) {
  const { views } = useNear();
  return useQuery({
    queryKey: ketosKeys.leaderboard(sort, limit),
    queryFn: () => views.leaderboard(sort, limit),
    refetchInterval: HISTORY_MS,
  });
}

/** Core and Long-tail vaults. */
export function useVaults() {
  const { views } = useNear();
  return useQuery({ queryKey: ketosKeys.vaults(), queryFn: () => views.vaults(), refetchInterval: SLOW_MS });
}

export function useVault(vaultId: VaultId) {
  const { views } = useNear();
  return useQuery({
    queryKey: ketosKeys.vault(vaultId),
    queryFn: () => views.vault(vaultId),
    refetchInterval: SLOW_MS,
  });
}

/** Hourly NAV, share price, TVL and cumulative revenue snapshots (last 7 days), oldest first. */
export function useVaultHistory(vaultId: VaultId) {
  const { views } = useNear();
  return useQuery({
    queryKey: ketosKeys.vaultHistory(vaultId),
    queryFn: () => views.vaultHistory(vaultId),
    refetchInterval: HISTORY_MS,
  });
}

/** Shares of the signed-in account in one vault. */
export function useVaultAccount(vaultId: VaultId) {
  const { views } = useNear();
  const accountId = useAccountId();
  return useQuery({
    queryKey: ketosKeys.vaultAccount(vaultId, accountId),
    queryFn: accountId ? () => views.vaultAccount(vaultId, accountId) : skipToken,
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

/** Depth of several markets at once, in the order given. */
export function useDepths(marketIds: readonly MarketId[]) {
  const { views } = useNear();
  return useQueries({
    queries: marketIds.map((marketId) => ({
      queryKey: ketosKeys.depth(marketId),
      queryFn: () => views.depth(marketId),
      refetchInterval: DEPTH_MS,
    })),
  });
}

