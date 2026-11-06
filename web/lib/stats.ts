import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const microUsdc = z.string().regex(/^(0|[1-9]\d*)$/);

export const statsResponseSchema = z.object({
  /** Entry and exit notional, in integer micro-USDC, including liquidations. */
  volume24h: microUsdc,
  trades24h: count,
  /** Accounts with at least one counted trade in the inclusive 24h window. */
  traders24h: count,
  totalOi: microUsdc,
  /** Sum of vault NAV, not deposited cash or available liquidity. */
  vaultTvl: microUsdc,
  marketsCount: count,
  openMarketsCount: count,
  fetchedAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  coverage: z.object({
    complete: z.boolean(),
    accountsScanned: count.max(500),
    accountLimit: z.literal(500),
    eventsPerAccountLimit: z.literal(200),
    accountLimitReached: z.boolean(),
    historyWindowIncomplete: z.boolean(),
  }),
}).refine((stats) => stats.openMarketsCount <= stats.marketsCount
  && stats.traders24h <= stats.coverage.accountsScanned
  && stats.traders24h <= stats.trades24h
  && stats.coverage.accountLimitReached === (stats.coverage.accountsScanned === stats.coverage.accountLimit)
  && stats.coverage.complete === !(stats.coverage.accountLimitReached || stats.coverage.historyWindowIncomplete),
{ message: "Inconsistent aggregate statistics" });

export type StatsResponse = z.infer<typeof statsResponseSchema>;

/** Fetches the shared onchain aggregate; unknown or unavailable data is never a zero. */
export async function fetchStats(signal?: AbortSignal): Promise<StatsResponse> {
  const response = await fetch("/api/stats", {
    headers: { Accept: "application/json" },
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Onchain statistics unavailable");
  return statsResponseSchema.parse(await response.json());
}
