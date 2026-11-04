import { JsonRpcProvider } from "near-api-js";
import { z } from "zod";
import {
  accountSchema,
  accountStatsSchema,
  configSchema,
  crossAccountSchema,
  depthViewSchema,
  historyEventSchema,
  leaderboardEntrySchema,
  liquidationSchema,
  marketSchema,
  oraclePriceDataSchema,
  orderSchema,
  positionSchema,
  priceSchema,
  vaultAccountSchema,
  vaultSchema,
  vaultSnapshotSchema,
  type LeaderboardSort,
  type MarketId,
  type VaultId,
} from "./types";

/** The contract keeps the last 200 events per account and ranks at most 500 accounts. */
export const ACCOUNT_HISTORY_LEN = 200;
export const LEADERBOARD_MAX = 500;

/** Largest page `get_open_positions` returns. */
export const OPEN_POSITIONS_PAGE = 100;
export const MARKETS_PAGE = 100;

/** Typed read-only calls to the perps and tUSDC contracts over JSON-RPC. */
export class KetosViews {
  readonly provider: JsonRpcProvider;

  constructor(
    rpcUrl: string,
    readonly ketosContract: string,
    readonly usdcContract: string,
  ) {
    // near-api-js retries 12 times with backoff by default (minutes when the RPC is down);
    // callers already retry (TanStack Query, the keeper's next tick), so fail fast here.
    this.provider = new JsonRpcProvider({ url: rpcUrl }, { retries: 2, wait: 500, backoff: 1.5 });
  }

  private async view<S extends z.ZodType>(
    schema: S,
    contractId: string,
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<z.output<S>> {
    const raw = await this.provider.callFunction({ contractId, method, args });
    const parsed = schema.safeParse(raw ?? null);
    if (!parsed.success) {
      throw new Error(`Unexpected ${method} response from ${contractId}: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  }

  config() {
    return this.view(configSchema, this.ketosContract, "get_config");
  }

  /** Every asset id the price oracle supports, whether or not its last price is still fresh. */
  async oracleAssetIds(oracleId: string) {
    const data = await this.view(oraclePriceDataSchema, oracleId, "get_price_data", {});
    return data.prices.map((p) => p.asset_id);
  }

  marketPage(fromIndex: number, limit = MARKETS_PAGE) {
    return this.view(z.array(marketSchema), this.ketosContract, "get_markets", {
      from_index: fromIndex,
      limit,
    });
  }

  /** Every listed market, including permissionless listings beyond the first page. */
  async markets() {
    const all = [];
    for (let from = 0; ; from += MARKETS_PAGE) {
      const page = await this.marketPage(from);
      all.push(...page);
      if (page.length < MARKETS_PAGE) return all;
    }
  }

  account(accountId: string) {
    return this.view(accountSchema.nullable(), this.ketosContract, "get_account", { account_id: accountId });
  }

  positions(accountId: string) {
    return this.view(z.array(positionSchema), this.ketosContract, "get_positions", { account_id: accountId });
  }

  openPositions(fromIndex: number, limit = OPEN_POSITIONS_PAGE) {
    return this.view(z.array(positionSchema), this.ketosContract, "get_open_positions", {
      from_index: fromIndex,
      limit,
    });
  }

  /** Every open position, page by page. */
  async allOpenPositions() {
    const all = [];
    for (let from = 0; ; from += OPEN_POSITIONS_PAGE) {
      const page = await this.openPositions(from);
      all.push(...page);
      if (page.length < OPEN_POSITIONS_PAGE) return all;
    }
  }

  async allOpenOrders() {
    const all = [];
    for (let from = 0; ; from += OPEN_POSITIONS_PAGE) {
      const page = await this.view(z.array(orderSchema), this.ketosContract, "get_open_orders", {
        from_index: from,
        limit: OPEN_POSITIONS_PAGE,
      });
      all.push(...page);
      if (page.length < OPEN_POSITIONS_PAGE) return all;
    }
  }

  crossAccount(accountId: string) {
    return this.view(crossAccountSchema, this.ketosContract, "get_cross_account", { account_id: accountId });
  }

  /** Pending orders of one account: entries (limit, stop market) and exits (take profit, stop loss). */
  orders(accountId: string) {
    return this.view(z.array(orderSchema), this.ketosContract, "get_orders", { account_id: accountId });
  }

  /** Every event the contract still keeps for the account (last 200), oldest first. */
  history(accountId: string) {
    return this.view(z.array(historyEventSchema), this.ketosContract, "get_history", {
      account_id: accountId,
      limit: ACCOUNT_HISTORY_LEN,
    });
  }

  /** All-time trading totals; null before the account's first recorded event. */
  accountStats(accountId: string) {
    return this.view(accountStatsSchema.nullable(), this.ketosContract, "get_account_stats", {
      account_id: accountId,
    });
  }

  leaderboard(sort: LeaderboardSort, limit = 100) {
    return this.view(z.array(leaderboardEntrySchema), this.ketosContract, "get_leaderboard", {
      sort,
      limit: Math.min(limit, LEADERBOARD_MAX),
    });
  }

  /** Hourly snapshots, oldest first, at most 168 (7 days). */
  vaultHistory(vaultId: VaultId) {
    return this.view(z.array(vaultSnapshotSchema), this.ketosContract, "get_vault_history", { vault_id: vaultId });
  }

  depth(marketId: MarketId) {
    return this.view(depthViewSchema.nullable(), this.ketosContract, "get_depth", { market_id: marketId });
  }

  liquidations(limit = 20) {
    return this.view(z.array(liquidationSchema), this.ketosContract, "get_liquidations", { limit });
  }

  prices() {
    return this.view(z.array(priceSchema), this.ketosContract, "get_prices");
  }

  vault(vaultId: VaultId) {
    return this.view(vaultSchema, this.ketosContract, "get_vault", { vault_id: vaultId });
  }

  vaults() {
    return this.view(z.array(vaultSchema), this.ketosContract, "get_vaults");
  }

  vaultAccount(vaultId: VaultId, accountId: string) {
    return this.view(vaultAccountSchema, this.ketosContract, "get_vault_account", {
      vault_id: vaultId,
      account_id: accountId,
    });
  }

  /** tUSDC wallet balance (6 decimals). */
  usdcBalance(accountId: string) {
    return this.view(
      z.string().regex(/^\d+$/).transform(BigInt),
      this.usdcContract,
      "ft_balance_of",
      { account_id: accountId },
    );
  }

  /** Liquid NEAR balance of an account, in yocto. */
  async nearBalance(accountId: string): Promise<bigint> {
    const state = await this.provider.viewAccount({ accountId });
    return BigInt(state.amount);
  }

  /** When the tUSDC faucet can next be claimed (ms since epoch), 0 if it can be claimed now. */
  async faucetAvailableAt(accountId: string): Promise<number> {
    return Number(
      await this.view(z.string().regex(/^\d+$/), this.usdcContract, "faucet_available_at", {
        account_id: accountId,
      }),
    );
  }
}
