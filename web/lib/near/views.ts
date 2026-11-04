import { JsonRpcProvider } from "near-api-js";
import { z } from "zod";
import {
  accountSchema,
  configSchema,
  depthViewSchema,
  liquidationSchema,
  marketSchema,
  positionSchema,
  priceSchema,
  vaultAccountSchema,
  vaultSchema,
  type MarketId,
} from "./types";

/** Largest page `get_open_positions` returns. */
export const OPEN_POSITIONS_PAGE = 100;
export const MARKETS_PAGE = 100;

/** Typed read-only calls to the perps and tUSDC contracts over JSON-RPC. */
export class PerpsViews {
  readonly provider: JsonRpcProvider;

  constructor(
    rpcUrl: string,
    readonly perpsContract: string,
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
    return this.view(configSchema, this.perpsContract, "get_config");
  }

  marketPage(fromIndex: number, limit = MARKETS_PAGE) {
    return this.view(z.array(marketSchema), this.perpsContract, "get_markets", {
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
    return this.view(accountSchema.nullable(), this.perpsContract, "get_account", { account_id: accountId });
  }

  positions(accountId: string) {
    return this.view(z.array(positionSchema), this.perpsContract, "get_positions", { account_id: accountId });
  }

  openPositions(fromIndex: number, limit = OPEN_POSITIONS_PAGE) {
    return this.view(z.array(positionSchema), this.perpsContract, "get_open_positions", {
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

  depth(marketId: MarketId) {
    return this.view(depthViewSchema.nullable(), this.perpsContract, "get_depth", { market_id: marketId });
  }

  liquidations(limit = 20) {
    return this.view(z.array(liquidationSchema), this.perpsContract, "get_liquidations", { limit });
  }

  prices() {
    return this.view(z.array(priceSchema), this.perpsContract, "get_prices");
  }

  vault() {
    return this.view(vaultSchema, this.perpsContract, "get_vault");
  }

  vaultAccount(accountId: string) {
    return this.view(vaultAccountSchema, this.perpsContract, "get_vault_account", { account_id: accountId });
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
