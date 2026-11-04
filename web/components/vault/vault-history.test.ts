import { describe, expect, it } from "vitest";
import type { Revenue, Vault, VaultSnapshot } from "@/lib/near/types";
import {
  historyPoints,
  pointsInRange,
  revenueBuckets,
  sumBuckets,
  totalRevenue,
  ZERO_REVENUE,
  type HistoryPoint,
} from "./vault-history";

const hour = 3_600_000;
const now = Date.UTC(2026, 10, 4, 14, 30);
const revenue = (changes: Partial<Revenue> = {}): Revenue => ({
  ...ZERO_REVENUE,
  ...changes,
});
const point = (t: number, changes: Partial<Revenue> = {}): HistoryPoint => ({
  t,
  nav: 10_000_000n,
  sharePrice: 1_000_000n,
  revenue: revenue(changes),
  live: false,
});

describe("vault onchain performance", () => {
  it("appends only a newer live read without mutating snapshots or duplicating a timestamp", () => {
    const snapshot: VaultSnapshot = {
      timestamp_ms: now - hour,
      nav: 10_000_000n,
      share_price: 1_000_000n,
      tvl: 10_000_000n,
      revenue: revenue({ fees: 5n }),
    };
    const vault = {
      nav: 11_000_000n,
      share_price: 1_100_000n,
      revenue: revenue({ fees: 7n }),
    } as Vault;
    const points = historyPoints([snapshot], { vault, at: now });
    expect(points).toEqual([
      point(now - hour, { fees: 5n }),
      {
        ...point(now, { fees: 7n }),
        nav: 11_000_000n,
        sharePrice: 1_100_000n,
        live: true,
      },
    ]);
    expect(
      historyPoints([snapshot], { vault, at: snapshot.timestamp_ms }),
    ).toEqual([point(now - hour, { fees: 5n })]);
    expect(snapshot.nav).toBe(10_000_000n);
  });

  it("excludes old and future observations without inventing missed snapshots at the window boundary", () => {
    const points = [
      point(now - 30 * hour),
      point(now - 25 * hour),
      point(now - 24 * hour),
      point(now),
      point(now + hour),
    ];
    expect(pointsInRange(points, "24h", now)).toEqual(points.slice(2, 4));
    expect(pointsInRange(points, "7d", now)).toEqual(points.slice(0, 4));
    expect(pointsInRange(points.slice(0, 2), "24h", now)).toEqual([]);
  });

  it("subtracts cumulative revenue, preserves losses and assigns a multi-hour interval to its later observation", () => {
    const points = [
      point(now - 3 * hour, { fees: 100n, trader_pnl: 30n }),
      point(now - hour, {
        fees: 120n,
        funding: -7n,
        trader_pnl: -50n,
        listing: 5n,
      }),
      point(now, {
        fees: 125n,
        funding: -2n,
        trader_pnl: -60n,
        listing: 5n,
        liquidations: 2n,
      }),
    ];
    const buckets = revenueBuckets(points, "24h", now);
    expect(sumBuckets(buckets)).toEqual({
      fees: 25n,
      funding: -2n,
      trader_pnl: -90n,
      listing: 5n,
      liquidations: 2n,
    });
    expect(totalRevenue(sumBuckets(buckets))).toBe(-60n);
    expect(buckets.filter((b) => b.observations).map((b) => b.start)).toEqual([
      Date.UTC(2026, 10, 4, 13),
      Date.UTC(2026, 10, 4, 14),
    ]);
    expect(
      buckets
        .filter((b) => !b.observations)
        .every((b) => totalRevenue(b.amounts) === 0n),
    ).toBe(true);
  });

  it("distinguishes missing history from an observed interval with zero revenue", () => {
    expect(
      revenueBuckets([point(now)], "24h", now).every(
        (b) => b.observations === 0,
      ),
    ).toBe(true);
    const buckets = revenueBuckets([point(now - hour), point(now)], "24h", now);
    expect(buckets.at(-1)).toMatchObject({
      observations: 1,
      amounts: ZERO_REVENUE,
    });
  });

  it("groups at UTC midnight and ignores observations outside the selected buckets", () => {
    const end = Date.UTC(2026, 10, 4, 0, 15);
    const points = [
      point(end - 9 * 24 * hour),
      point(Date.UTC(2026, 10, 3, 23, 59), { fees: 3n }),
      point(Date.UTC(2026, 10, 4), { fees: 8n }),
      point(end + 24 * hour, { fees: 100n }),
    ];
    const buckets = revenueBuckets(points, "7d", end);
    expect(buckets.at(-2)).toMatchObject({
      start: Date.UTC(2026, 10, 3),
      amounts: { fees: 3n },
    });
    expect(buckets.at(-1)).toMatchObject({
      start: Date.UTC(2026, 10, 4),
      amounts: { fees: 5n },
    });
    expect(sumBuckets(buckets).fees).toBe(8n);
  });
});
