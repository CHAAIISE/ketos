import { z } from "zod";
import { nearConfig } from "./near/config";
import { marketDisplayStatus } from "./near/market-status";
import { historyKindSchema, VAULT_IDS, vaultIdSchema } from "./near/types";
import { ACCOUNT_HISTORY_LEN, KetosViews, LEADERBOARD_MAX } from "./near/views";
import { windowVolume } from "./near/volume";
import { statsResponseSchema, type StatsResponse } from "./stats";

export const STATS_CACHE_MS = 60_000;
const HISTORY_CONCURRENCY = 8;
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.bigint().nonnegative();
const marketsSchema = z.array(z.object({
  id: z.string().min(1),
  oi_long: amount,
  oi_short: amount,
  depth_measured_at_ms: timestamp,
  exit_capacity: amount,
  is_open: z.boolean(),
  price: amount,
  price_timestamp_ms: timestamp,
  close_only: z.boolean(),
}));
const vaultsSchema = z.array(z.object({ id: vaultIdSchema, nav: amount }));
const cohortSchema = z.array(z.object({ account_id: z.string().min(2) })).max(LEADERBOARD_MAX);
const historySchema = z.array(z.object({
  sequence: timestamp,
  kind: historyKindSchema,
  size: amount,
  timestamp_ms: timestamp,
})).max(ACCOUNT_HISTORY_LEN);

export type StatsViews = Pick<KetosViews, "markets" | "vaults" | "leaderboard" | "history">;

/**
 * The leaderboard indexes only the 500 most recently active accounts; each account
 * retains 200 history events. Full indexes/rings make 24h activity a lower bound.
 * Trades match the UI's entry/exit count: open, reduce, close and liquidation. order_fill
 * annotates an already recorded entry/exit and must not be counted a second time.
 */
export async function collectStats(views: StatsViews, now: () => number = Date.now): Promise<StatsResponse> {
  // Drain failures before releasing the cache's single-flight slot.
  const [marketResult, vaultResult, cohortResult] = await Promise.allSettled([
    views.markets(), views.vaults(), views.leaderboard("volume", LEADERBOARD_MAX),
  ]);
  if (marketResult.status === "rejected") throw marketResult.reason;
  if (vaultResult.status === "rejected") throw vaultResult.reason;
  if (cohortResult.status === "rejected") throw cohortResult.reason;
  const markets = marketResult.value;
  const vaults = vaultResult.value;
  const cohort = cohortResult.value;
  marketsSchema.parse(markets);
  vaultsSchema.parse(vaults);
  cohortSchema.parse(cohort);
  if (new Set(markets.map((market) => market.id)).size !== markets.length
    || new Set(cohort.map((entry) => entry.account_id)).size !== cohort.length
    || VAULT_IDS.some((id) => !vaults.some((vault) => vault.id === id))
    || new Set(vaults.map((vault) => vault.id)).size !== vaults.length) {
    throw new Error("Incomplete or duplicate onchain statistics sources");
  }

  const histories = [];
  // Batches bound RPC fanout even when the account index is full.
  for (let from = 0; from < cohort.length; from += HISTORY_CONCURRENCY) {
    const results = await Promise.allSettled(cohort.slice(from, from + HISTORY_CONCURRENCY)
      .map((entry) => views.history(entry.account_id)));
    const batch = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    for (const events of batch) {
      historySchema.parse(events);
      for (let index = 1; index < events.length; index += 1) {
        if (events[index].sequence <= events[index - 1].sequence
          || events[index].timestamp_ms < events[index - 1].timestamp_ms) {
          throw new Error("Unordered onchain account history");
        }
      }
    }
    histories.push(...batch);
  }

  const fetchedAtMs = now();
  let volume24h = 0n;
  let trades24h = 0;
  let traders24h = 0;
  let historyWindowIncomplete = false;
  for (const history of histories) {
    const activity = windowVolume([history], fetchedAtMs, ACCOUNT_HISTORY_LEN);
    volume24h += activity.volume;
    trades24h += activity.trades;
    if (activity.trades > 0) traders24h += 1;
    if (!activity.complete) historyWindowIncomplete = true;
  }
  const accountLimitReached = cohort.length === LEADERBOARD_MAX;
  return statsResponseSchema.parse({
    volume24h: volume24h.toString(),
    trades24h,
    traders24h,
    totalOi: markets.reduce((sum, market) => sum + market.oi_long + market.oi_short, 0n).toString(),
    vaultTvl: vaults.reduce((sum, vault) => sum + vault.nav, 0n).toString(),
    marketsCount: markets.length,
    openMarketsCount: markets.filter((market) => marketDisplayStatus(market, fetchedAtMs).open).length,
    fetchedAtMs,
    coverage: {
      complete: !accountLimitReached && !historyWindowIncomplete,
      accountsScanned: cohort.length,
      accountLimit: LEADERBOARD_MAX,
      eventsPerAccountLimit: ACCOUNT_HISTORY_LEN,
      accountLimitReached,
      historyWindowIncomplete,
    },
  });
}

/** One aggregate and one in-flight computation per server instance, never stale on failure. */
export class StatsCache {
  private cached: StatsResponse | null = null;
  private pending: Promise<StatsResponse> | null = null;

  constructor(
    private readonly load: () => Promise<StatsResponse>,
    private readonly now: () => number = Date.now,
  ) {}

  get(): Promise<StatsResponse> {
    const ageMs = this.cached ? this.now() - this.cached.fetchedAtMs : -1;
    if (this.cached && ageMs >= 0 && ageMs < STATS_CACHE_MS) return Promise.resolve(this.cached);
    if (this.pending) return this.pending;
    this.pending = this.refresh();
    return this.pending;
  }

  private async refresh(): Promise<StatsResponse> {
    try {
      const value = statsResponseSchema.parse(await Promise.resolve().then(() => this.load()));
      const ageMs = this.now() - value.fetchedAtMs;
      if (ageMs < 0 || ageMs >= STATS_CACHE_MS) throw new Error("Invalid statistics snapshot age");
      this.cached = value;
      return value;
    } finally {
      this.pending = null;
    }
  }
}

const cache = new StatsCache(async () => {
  const config = nearConfig();
  return collectStats(new KetosViews(config.rpcUrl, config.ketosContract, config.usdcContract));
});

export function getStats(): Promise<StatsResponse> {
  return cache.get();
}
