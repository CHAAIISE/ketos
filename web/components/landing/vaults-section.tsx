"use client";

import Link from "next/link";
import { ArrowRight, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Container, Eyebrow } from "@/components/ui/page-shell";
import { totalRevenue } from "@/components/vault/vault-history";
import { useMarkets, useVaults } from "@/hooks/use-ketos-queries";
import { networkName } from "@/lib/near/config";
import { formatBps, formatUsd } from "@/lib/near/format";
import type { Market, Vault } from "@/lib/near/types";
import { cn } from "@/lib/utils";

const ABOUT: Record<Vault["id"], { name: string; role: string }> = {
  core: { name: "Core", role: "Counterparty to the majors." },
  "long-tail": { name: "Long-tail", role: "Counterparty to extended and newly listed markets; earns listing fees." },
};

function Stat({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-label text-tertiary">{label}</dt>
      <dd className={cn("text-subtitle tabular-nums text-foreground", className)}>{children}</dd>
    </div>
  );
}

function VaultRow({ vault, markets }: { vault: Vault; markets: Market[] | undefined }) {
  const about = ABOUT[vault.id];
  const pnl = totalRevenue(vault.revenue);
  const assigned = markets?.filter((m) => m.vault_id === vault.id).map((m) => m.id);
  return (
    <article data-testid={`landing-vault-${vault.id}`} className="flex flex-col gap-5 border-t border-border py-8 first:border-t-0 first:pt-0">
      <div className="flex flex-col gap-1">
        <h3 className="text-heading text-foreground">
          <Link
            href={`/vaults/${vault.id}`}
            className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {about.name}
          </Link>
        </h3>
        <p className="text-ui text-muted-foreground">{about.role}</p>
      </div>
      <dl className="grid grid-cols-2 gap-6 md:grid-cols-4">
        <Stat label="TVL">{formatUsd(vault.nav, { maxFractionDigits: 0 })}</Stat>
        <Stat label="Share price">{formatUsd(vault.share_price, { maxFractionDigits: 4 })}</Stat>
        <Stat label="Fee APR, 7 days">{formatBps(vault.fee_apr_bps)}</Stat>
        <Stat
          label="Booked result, all-time"
          className={pnl > 0n ? "text-success" : pnl < 0n ? "text-destructive" : undefined}
        >
          {formatUsd(pnl, { signed: true, maxFractionDigits: 0 })}
        </Stat>
      </dl>
      <p className="text-label text-tertiary">
        {assigned ? (assigned.length ? `Markets: ${assigned.join(" · ")}` : "No market assigned yet") : "\u00a0"}
      </p>
    </article>
  );
}

function Body() {
  const vaults = useVaults();
  const markets = useMarkets();
  if (vaults.isPending) {
    return (
      <div aria-busy className="flex flex-col gap-8">
        {[0, 1].map((i) => (
          <div key={i} aria-hidden className="h-36 rounded-sm bg-muted" />
        ))}
      </div>
    );
  }
  if (vaults.isError) {
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 p-4 text-sm md:flex-row md:items-center md:justify-between"
      >
        <span className="text-foreground">
          Vaults unavailable. <span className="text-muted-foreground">The {networkName()} RPC did not answer get_vaults.</span>
        </span>
        <Button variant="outline" size="sm" onClick={() => void vaults.refetch()}>
          <RotateCw />
          Retry
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      {vaults.data.map((vault) => (
        <VaultRow key={vault.id} vault={vault} markets={markets.data} />
      ))}
    </div>
  );
}

export function VaultsSection() {
  return (
    <section id="vaults" aria-labelledby="vaults-title" className="scroll-mt-8">
      <Container className="grid gap-12 md:grid-cols-12">
        <div className="order-2 min-w-0 md:order-1 md:col-span-7">
          <Body />
        </div>
        <div className="order-1 flex flex-col items-start gap-4 md:order-2 md:col-span-4 md:col-start-9">
          <Eyebrow>Vaults</Eyebrow>
          <h2 id="vaults-title" className="font-display text-title text-foreground">
            Two pools, two risk profiles.
          </h2>
          <p className="text-body text-muted-foreground">
            LPs take the other side of every trade and earn trading fees, borrow fees, funding and liquidation
            penalties. A long-tail blow-up stays in the Long-tail vault: each pool only backs its own markets, and
            withdrawals stop at the amount reserved for open positions.
          </p>
          <Link
            href="/vaults"
            className="mt-2 inline-flex items-center gap-1 rounded-sm text-ui text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Compare vaults
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      </Container>
    </section>
  );
}
