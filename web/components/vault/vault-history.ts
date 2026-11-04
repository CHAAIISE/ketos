import type { Revenue, Vault, VaultSnapshot } from "@/lib/near/types";

export type HistoryRange = "24h" | "7d";

export const RANGES: readonly {
  id: HistoryRange;
  label: string;
  ms: number;
  bucketMs: number;
  bucketLabel: string;
}[] = [
  {
    id: "24h",
    label: "24H",
    ms: 24 * 3_600_000,
    bucketMs: 3_600_000,
    bucketLabel: "per hour",
  },
  {
    id: "7d",
    label: "7D",
    ms: 7 * 86_400_000,
    bucketMs: 86_400_000,
    bucketLabel: "per UTC day",
  },
];

const historyDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

export const formatHistoryTime = (ms: number): string =>
  `${historyDate.format(ms)} UTC`;

export const rangeOf = (id: HistoryRange) =>
  RANGES.find((r) => r.id === id) ?? RANGES[0];

/** A point of the vault's history: an hourly onchain snapshot, or the current read (`live`). */
export interface HistoryPoint {
  t: number;
  nav: bigint;
  sharePrice: bigint;
  revenue: Revenue;
  live: boolean;
}

export const REVENUE_KEYS = [
  "fees",
  "funding",
  "trader_pnl",
  "liquidations",
  "listing",
] as const;
export type RevenueKey = (typeof REVENUE_KEYS)[number];
export type RevenueAmounts = Record<RevenueKey, bigint>;

export const ZERO_REVENUE: RevenueAmounts = {
  fees: 0n,
  funding: 0n,
  trader_pnl: 0n,
  liquidations: 0n,
  listing: 0n,
};

/** Realized result of the vault since launch: every revenue line, trader PnL signed from the vault's side. */
export function totalRevenue(revenue: Revenue): bigint {
  return REVENUE_KEYS.reduce((sum, key) => sum + revenue[key], 0n);
}

/** Snapshots (oldest first) followed by the current read when it is newer than the last snapshot. */
export function historyPoints(
  snapshots: readonly VaultSnapshot[],
  live: { vault: Vault; at: number } | null,
): HistoryPoint[] {
  const points: HistoryPoint[] = snapshots.map((s) => ({
    t: s.timestamp_ms,
    nav: s.nav,
    sharePrice: s.share_price,
    revenue: s.revenue,
    live: false,
  }));
  const last = points.at(-1);
  if (live && live.at > 0 && (!last || live.at > last.t)) {
    points.push({
      t: live.at,
      nav: live.vault.nav,
      sharePrice: live.vault.share_price,
      revenue: live.vault.revenue,
      live: true,
    });
  }
  return points;
}

/** Actual observations inside the selected window; never stretch an old snapshot into a recent chart. */
export function pointsInRange(
  points: readonly HistoryPoint[],
  range: HistoryRange,
  nowMs: number,
): HistoryPoint[] {
  const start = nowMs - rangeOf(range).ms;
  return points.filter((point) => point.t >= start && point.t <= nowMs);
}

export interface RevenueBucket {
  start: number;
  amounts: RevenueAmounts;
  observations: number;
}

/**
 * Revenue booked in each hour (24H) or UTC day (7D) of the window ending at `nowMs`: the change of each
 * cumulative revenue line between consecutive points, counted in the bucket of the later point.
 */
export function revenueBuckets(
  points: readonly HistoryPoint[],
  range: HistoryRange,
  nowMs: number,
): RevenueBucket[] {
  const { ms, bucketMs } = rangeOf(range);
  const last = Math.floor(nowMs / bucketMs) * bucketMs;
  const count = Math.round(ms / bucketMs);
  const first = last - (count - 1) * bucketMs;
  const buckets: RevenueBucket[] = Array.from({ length: count }, (_, i) => ({
    start: first + i * bucketMs,
    amounts: { ...ZERO_REVENUE },
    observations: 0,
  }));
  for (let i = 1; i < points.length; i++) {
    const at = points[i].t;
    if (at < first || at >= last + bucketMs) continue;
    const bucket = buckets[Math.floor((at - first) / bucketMs)];
    bucket.observations++;
    for (const key of REVENUE_KEYS)
      bucket.amounts[key] +=
        points[i].revenue[key] - points[i - 1].revenue[key];
  }
  return buckets;
}

/** Sum of each revenue line over the buckets. */
export function sumBuckets(buckets: readonly RevenueBucket[]): RevenueAmounts {
  const total = { ...ZERO_REVENUE };
  for (const b of buckets)
    for (const key of REVENUE_KEYS) total[key] += b.amounts[key];
  return total;
}
