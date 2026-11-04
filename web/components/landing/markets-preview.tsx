"use client";

import Link from "next/link";
import { ArrowRight, RotateCw } from "lucide-react";
import { VAULT_LABEL } from "@/components/markets/markets-table";
import { marketName } from "@/components/trade/market-header";
import { isPriceFresh } from "@/components/trade/market-status";
import { OiBar } from "@/components/trade/oi-bar";
import { Button } from "@/components/ui/button";
import { Container, Eyebrow } from "@/components/ui/page-shell";
import { useMarkets } from "@/hooks/use-ketos-queries";
import { LISTING_FEE } from "@/lib/near/calls";
import { networkName } from "@/lib/near/config";
import { formatPrice, formatUsd, formatUsdc } from "@/lib/near/format";
import { isMeasuring, type Market } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { useNow } from "./live-time";

const PREVIEW_ROWS = 8;
const usd0 = (units: bigint) => formatUsd(units, { maxFractionDigits: 0 });

/** Most open interest first, then the deepest exits, so the busiest markets lead. */
function byActivity(a: Market, b: Market): number {
  const oiA = a.oi_long + a.oi_short;
  const oiB = b.oi_long + b.oi_short;
  if (oiA !== oiB) return oiA > oiB ? -1 : 1;
  if (a.exit_capacity !== b.exit_capacity) return a.exit_capacity > b.exit_capacity ? -1 : 1;
  return a.id.localeCompare(b.id);
}

function Status({ market }: { market: Market }) {
  if (isMeasuring(market)) return <span className="text-warning">Measuring</span>;
  if (!market.is_open) return <span className="text-tertiary">Paused</span>;
  return <span className="text-success">Open</span>;
}

function Rows({ markets }: { markets: Market[] }) {
  const nowMs = useNow();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-ui tabular-nums md:min-w-[40rem]">
        <caption className="sr-only">Markets read from get_markets</caption>
        <thead>
          <tr className="border-b border-border text-label text-tertiary">
            <th scope="col" className="py-3 pr-4 text-left font-medium">Market</th>
            <th scope="col" className="py-3 pr-4 text-right font-medium">Price</th>
            <th scope="col" className="hidden md:table-cell py-3 pr-4 text-right font-medium">Exit capacity</th>
            <th scope="col" className="py-3 pr-4 text-right font-medium"><span className="md:hidden">OI / cap</span><span className="hidden md:inline">Open interest / cap per side</span></th>
            <th scope="col" className="hidden md:table-cell py-3 pr-4 text-right font-medium">Max leverage</th>
            <th scope="col" className="hidden md:table-cell py-3 pr-4 text-left font-medium">Vault</th>
            <th scope="col" className="py-3 text-left font-medium">Status</th>
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
                </th>
                <td className={cn("pr-4 text-right text-foreground", !isPriceFresh(m, nowMs) && "text-tertiary")}>
                  {m.price > 0n ? formatPrice(m.price) : "—"}
                </td>
                <td className="hidden md:table-cell pr-4 text-right text-foreground">{isMeasuring(m) ? "—" : usd0(m.exit_capacity)}</td>
                <td className="pr-4 text-right">
                  <span className="inline-flex flex-col items-end gap-1">
                    <span className="whitespace-nowrap text-foreground">
                      {usd0(m.oi_long + m.oi_short)}
                      <span className="text-tertiary"> / {usd0(m.max_oi_per_side)}</span>
                    </span>
                    <OiBar used={maxSide} cap={m.max_oi_per_side} className="w-20 md:w-28" />
                  </span>
                </td>
                <td className="hidden md:table-cell pr-4 text-right text-foreground">{m.max_leverage}×</td>
                <td className="hidden md:table-cell pr-4 text-muted-foreground">{VAULT_LABEL[m.vault_id]}</td>
                <td>
                  <Status market={m} />
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
          Markets unavailable. <span className="text-muted-foreground">The {networkName()} RPC did not answer get_markets.</span>
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
        Cap per side = the smaller of the market&apos;s hard cap and its measured exit capacity.
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
            market for <span className="text-foreground">{fee} USDC</span>: it stays closed until its first depth
            measurement, then trades at up to 5×.
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
