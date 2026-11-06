"use client";

import { formatUsd, usdcToNumber } from "@/lib/near/format";
import type { Revenue } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { PanelHeading } from "./panel-heading";
import { Term } from "./term";
import {
  formatHistoryTime,
  REVENUE_KEYS,
  rangeOf,
  sumBuckets,
  totalRevenue,
  type HistoryRange,
  type RevenueBucket,
  type RevenueKey,
} from "./vault-history";

const lines: Record<RevenueKey, { label: string; color: string }> = {
  fees: { label: "Trading + borrow fees", color: "bg-foreground" },
  funding: { label: "Net funding", color: "bg-warning" },
  trader_pnl: { label: "Counterparty PnL", color: "bg-success" },
  liquidations: { label: "Liquidation penalties", color: "bg-destructive" },
  listing: { label: "Listing fees", color: "bg-tertiary" },
};

export function RevenueChart({
  buckets,
  range,
  allTime,
}: {
  buckets: RevenueBucket[];
  range: HistoryRange;
  allTime: Revenue;
}) {
  const sums = sumBuckets(buckets);
  const observed = buckets.some((bucket) => bucket.observations > 0);
  const booked = buckets.some((bucket) => REVENUE_KEYS.some((key) => bucket.amounts[key] !== 0n));
  const extents = buckets.flatMap((b) => [
    REVENUE_KEYS.reduce(
      (sum, key) =>
        sum + (b.amounts[key] > 0n ? usdcToNumber(b.amounts[key]) : 0),
      0,
    ),
    REVENUE_KEYS.reduce(
      (sum, key) =>
        sum + (b.amounts[key] < 0n ? -usdcToNumber(b.amounts[key]) : 0),
      0,
    ),
  ]);
  const max = Math.max(...extents, 0.000001);
  return (
    <section
      aria-label="Revenue breakdown"
      className="rounded-md border border-border bg-card"
    >
      <PanelHeading
        aside={
          <span className="text-label text-tertiary">
            {rangeOf(range).bucketLabel} · USD
          </span>
        }
      >
        Revenue breakdown
      </PanelHeading>
      <div className="p-3">
        <div
          role="img"
          aria-label={`Signed revenue stacks ${rangeOf(range).bucketLabel}; positive above zero, negative below. Full values in the table below.`}
          className="relative flex h-40 items-stretch gap-1 border-b border-border"
        >
          <span className="pointer-events-none absolute top-1/2 right-0 left-0 border-t border-border" />
          <span className="pointer-events-none absolute top-1/2 left-0 -translate-y-full text-label text-tertiary">
            0
          </span>
          {observed && !booked ? (
            <span className="pointer-events-none absolute inset-x-0 top-1/2 mt-2 text-center text-label text-tertiary">
              No realized revenue in this window yet
            </span>
          ) : null}
          {buckets.map((bucket) => (
            <div
              key={bucket.start}
              className="z-10 flex min-w-0 flex-1 flex-col"
              title={`${formatHistoryTime(bucket.start)} · ${bucket.observations ? REVENUE_KEYS.map((key) => `${lines[key].label}: ${formatUsd(bucket.amounts[key], { signed: true })}`).join(" · ") : "No observed revenue interval"}`}
            >
              {[1, -1].map((sign) => (
                <div
                  key={sign}
                  className={cn(
                    "flex h-1/2",
                    sign === 1 ? "flex-col justify-end" : "flex-col",
                  )}
                >
                  {REVENUE_KEYS.filter((key) =>
                    sign === 1
                      ? bucket.amounts[key] > 0n
                      : bucket.amounts[key] < 0n,
                  ).map((key) => (
                    <span
                      key={key}
                      className={cn("block w-full", lines[key].color)}
                      style={{
                        height: `${(Math.abs(usdcToNumber(bucket.amounts[key])) / max) * 100}%`,
                      }}
                    />
                  ))}
                  {bucket.observations &&
                  REVENUE_KEYS.every((key) => bucket.amounts[key] === 0n) &&
                  sign === 1 ? (
                    <span className="h-px bg-tertiary" />
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between gap-2 text-label text-tertiary">
          <span>{formatHistoryTime(buckets[0].start)}</span>
          <span className="text-right">
            {formatHistoryTime(buckets[buckets.length - 1].start)}
          </span>
        </div>
        <p className="mt-3 text-label text-tertiary">
          {observed
            ? "Changes in cumulative onchain revenue, recorded in the hour or UTC day of the later observation. Gaps are not backfilled; an interval can span missed hours."
            : "Not enough observations to measure revenue changes in this window. All-time totals remain available below."}
        </p>
      </div>
      <table className="w-full text-ui tabular-nums">
        <thead className="bg-muted text-label text-tertiary">
          <tr>
            <th className="px-3 py-2 text-left font-normal">Source</th>
            <th className="px-3 py-2 text-right font-normal">
              Observed · {rangeOf(range).label}
            </th>
            <th className="px-3 py-2 text-right font-normal">All-time</th>
          </tr>
        </thead>
        <tbody>
          {REVENUE_KEYS.map((key) => (
            <tr key={key} className="h-9 border-t border-border">
              <th
                scope="row"
                className="px-3 py-2 text-left font-normal text-muted-foreground"
              >
                <span
                  className={cn(
                    "mr-2 inline-block size-2 rounded-sm",
                    lines[key].color,
                  )}
                />
                {lines[key].label}
              </th>
              <td className="px-3 text-right">
                {observed ? formatUsd(sums[key], { signed: true }) : "—"}
              </td>
              <td
                className={cn(
                  "px-3 text-right",
                  allTime[key] < 0n ? "text-destructive" : "text-foreground",
                )}
              >
                {formatUsd(allTime[key], { signed: true })}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-border font-medium">
          <tr className="h-9">
            <th scope="row" className="px-3 text-left">
              <Term hint="Realized profit or loss after fees, settled funding and the vault's gains or losses against traders. Excludes deposits, withdrawals and unrealized results.">Realized PnL</Term>
            </th>
            <td className="px-3 text-right">
              {observed ? formatUsd(totalRevenue(sums), { signed: true }) : "—"}
            </td>
            <td className="px-3 text-right">
              {formatUsd(totalRevenue(allTime), { signed: true })}
            </td>
          </tr>
        </tfoot>
      </table>
      <p className="p-3 text-label text-tertiary">
        Counterparty PnL is signed from the vault&apos;s side: trader gains are
        vault losses. These realized amounts exclude LP deposits, withdrawals and
        unrealized PnL. Cross-margin settlements can include money still owed
        to the vault, not only collected cash.
      </p>
    </section>
  );
}
