"use client";

import Link from "next/link";
import { ArrowRight, RotateCw } from "lucide-react";
import { VAULT_LABEL } from "@/components/markets/markets-table";
import { marketName } from "@/components/trade/market-header";
import { formatExitCapacity, isPriceFresh, marketDisplayStatus, marketLimitLabel } from "@/lib/near/market-status";
import { OiBar } from "@/components/trade/oi-bar";
import { Button } from "@/components/ui/button";
import { Container, Eyebrow } from "@/components/ui/page-shell";
import { useMarkets } from "@/hooks/use-ketos-queries";
import { LISTING_FEE } from "@/lib/near/calls";
import { networkName } from "@/lib/near/config";
import { formatPrice, usd0, formatUsdc } from "@/lib/near/format";
import { isMeasuring, type Market } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { formatAge, formatUtc, useNow } from "./live-time";

const PREVIEW_ROWS = 8;

/** Most open interest first, then the deepest exits, so the busiest markets lead. */
function byActivity(a: Market, b: Market): number {
  const oiA = a.oi_long + a.oi_short;
  const oiB = b.oi_long + b.oi_short;
  if (oiA !== oiB) return oiA > oiB ? -1 : 1;
  if (a.exit_capacity !== b.exit_capacity) return a.exit_capacity > b.exit_capacity ? -1 : 1;
  return a.id.localeCompare(b.id);
}

function Status({ market, nowMs }: { market: Market; nowMs: number }) {
  const status = marketDisplayStatus(market, nowMs);
  return <span className={status.open ? "text-success" : "text-warning"}>{status.open ? "Open" : status.label}</span>;
}

function Rows({ markets }: { markets: Market[] }) {
  const nowMs = useNow();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-ui tabular-nums md:min-w-[40rem]">
        <caption className="sr-only">Onchain market registry; open interest is the total size of open positions.</caption>
        <thead>
          <tr className="border-b border-border text-label text-tertiary">
            <th scope="col" className="py-3 pr-4 text-left font-medium">Market</th>
            <th scope="col" className="py-3 pr-4 text-right font-medium">Price</th>
            <th scope="col" className="hidden md:table-cell py-3 pr-4 text-right font-medium">Admission exit limit</th>
            <th scope="col" className="py-3 pr-4 text-right font-medium"><span className="md:hidden">Largest side / cap</span><span className="hidden md:inline">Largest OI side / effective cap</span></th>
            <th scope="col" className="hidden md:table-cell py-3 pr-4 text-right font-medium">Max leverage</th>
            <th scope="col" className="hidden md:table-cell py-3 pr-4 text-left font-medium">Vault</th>
            <th scope="col" className="hidden sm:table-cell py-3 text-left font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((m) => {
            const maxSide = m.oi_long > m.oi_short ? m.oi_long : m.oi_short;
            return (
              <tr key={m.id} data-testid={`landing-market-${m.id}`} className="h-12 border-b border-border last:border-b-0">
                <th scope="row" className="pr-4 text-left font-medium">
                  <Link
                    href={`/trade?market=${encodeURIComponent(m.id)}`}
                    className="rounded-sm whitespace-nowrap text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {marketName(m.id)}
                  </Link>
                  <span className="block text-label font-normal sm:hidden">
                    <Status market={m} nowMs={nowMs} />
                  </span>
                </th>
                <td className={cn("pr-4 text-right text-foreground", !isPriceFresh(m, nowMs) && "text-tertiary")}>
                  {m.price > 0n ? formatPrice(m.price) : "—"}
                </td>
                <td className="hidden md:table-cell pr-4 text-right text-foreground" title={m.measured_cap_is_grid_max ? "Probe grid passed; admission depth may be ramp-limited. See the curve for the largest size probed." : undefined}>
                  {isMeasuring(m) ? "—" : formatExitCapacity(m)}
                  {m.measured_cap_is_grid_max ? <span className="block text-label text-tertiary">Probe grid passed</span> : null}
                  {m.depth_measured_at_ms > 0 ? (
                    <span className="block text-label text-tertiary">
                      {formatUtc(m.depth_measured_at_ms)} · {formatAge(m.depth_measured_at_ms, nowMs) || "measured"}
                    </span>
                  ) : null}
                </td>
                <td className="pr-4 text-right">
                  <span className="inline-flex flex-col items-end gap-1">
                    <span className="whitespace-nowrap text-foreground">
                      {usd0(maxSide)}
                      <span className="text-tertiary"> / {usd0(m.effective_max_oi_per_side)}</span>
                    </span>
                    <OiBar used={maxSide} cap={m.effective_max_oi_per_side} className="w-20 md:w-28" />
                    <span className="text-label text-tertiary">{marketLimitLabel(m)}</span>
                  </span>
                </td>
                <td className="hidden md:table-cell pr-4 text-right text-foreground">{m.max_leverage}×</td>
                <td className="hidden md:table-cell pr-4 text-muted-foreground">{VAULT_LABEL[m.vault_id]}</td>
                <td className="hidden sm:table-cell">
                  <Status market={m} nowMs={nowMs} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Body() {
  const markets = useMarkets();
  if (markets.isPending) {
    return (
      <div aria-busy className="flex flex-col gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} aria-hidden className="h-12 rounded-sm bg-muted" />
        ))}
      </div>
    );
  }
  if (markets.isError) {
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 p-4 text-sm md:flex-row md:items-center md:justify-between"
      >
        <span className="text-foreground">
          Markets unavailable. <span className="text-muted-foreground">The {networkName()} market registry could not be loaded.</span>
        </span>
        <Button variant="outline" size="sm" onClick={() => void markets.refetch()}>
          <RotateCw />
          Retry
        </Button>
      </div>
    );
  }
  const rows = [...markets.data].sort(byActivity).slice(0, PREVIEW_ROWS);
  return (
    <div className="flex flex-col gap-4">
      <Rows markets={rows} />
      <p className="text-label text-tertiary">
        {rows.length < markets.data.length
          ? `${rows.length} busiest of ${markets.data.length} markets. `
          : `All ${markets.data.length} markets. `}
        Open interest is the total size of open positions. The effective cap per side is the smallest of the
        market&apos;s hard cap, admission exit limit and vault-backed cap. A close-only cached price can be refreshed
        by a trading action; execution rechecks price freshness and limits.
      </p>
    </div>
  );
}

export function MarketsPreview() {
  const fee = formatUsdc(LISTING_FEE, { maxFractionDigits: 0 });
  return (
    <section id="markets" aria-labelledby="markets-title" className="scroll-mt-8">
      <Container className="grid gap-12 md:grid-cols-12 md:gap-12">
        <div className="flex flex-col items-start gap-4 md:col-span-4">
          <Eyebrow>Markets</Eyebrow>
          <h2 id="markets-title" className="font-display text-title text-foreground">
            Every market is sized by its exit.
          </h2>
          <p className="text-body text-muted-foreground">
            Majors and long-tail tokens side by side, each with its own cap and leverage. Anyone can list a new
            market for <span className="text-foreground">{fee} USDC</span>: it stays closed until it has a price,
            at least $10k of fresh admission exit capacity and vault capital. New Long-tail markets trade at up to
            5×, with leverage increasing gradually as depth allows.
          </p>
          <Link
            href="/markets"
            className="mt-2 inline-flex items-center gap-1 rounded-sm text-ui text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            All markets
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>
        <div className="min-w-0 md:col-span-8">
          <Body />
        </div>
      </Container>
    </section>
  );
}
