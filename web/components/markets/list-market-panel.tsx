"use client";

import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ConnectButton } from "@/components/app/connect-button";
import { EmptyState, ErrorState, Skeleton } from "@/components/app/states";
import { useTxToast } from "@/components/app/tx-toast";
import { marketName } from "@/components/trade/market-header";
import { PanelHeading } from "@/components/vault/panel-heading";
import { Term } from "@/components/vault/term";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldMessage } from "@/components/ui/input";
import { useAccountId } from "@/hooks/near-provider";
import { useListMarket } from "@/hooks/use-ketos-mutations";
import { useAccount } from "@/hooks/use-ketos-queries";
import { listableMarketsKey, useListableMarkets } from "@/hooks/use-market-feeds";
import { LISTING_FEE } from "@/lib/near/calls";
import { formatUsdc } from "@/lib/near/format";
import { isMeasuring, type Market } from "@/lib/near/types";
import { cn } from "@/lib/utils";

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-ui">
      <span className="text-tertiary">{label}</span>
      <span className="text-right text-foreground tabular-nums">{children}</span>
    </div>
  );
}

const MEASURING_SHOWN = 6;

/**
 * Permissionless listing: pick an asset the price oracle and NEAR Intents both know, pay the
 * 25 USDC fee, and the market appears as "measuring" until the keeper's first depth sample.
 */
export function ListMarketPanel({ markets, className }: { markets: readonly Market[]; className?: string }) {
  const accountId = useAccountId();
  const account = useAccount();
  const listable = useListableMarkets();
  const list = useListMarket();
  const queryClient = useQueryClient();
  const { track } = useTxToast();
  const [picked, setPicked] = useState<string | null>(null);

  // The server list is cached for a minute; hide anything the live registry already has.
  const taken = new Set(markets.flatMap((m) => [m.id, m.oracle_asset_id, m.intents_asset_id]));
  const assets = (listable.data?.assets ?? []).filter(
    (a) => !taken.has(a.symbol) && !taken.has(a.oracleAssetId) && !taken.has(a.intentsAssetId),
  );
  const asset = assets.find((a) => a.symbol === picked) ?? assets[0];
  // Registry order is listing order: show the most recent first.
  const measuring = markets.filter(isMeasuring).reverse();
  const balance = account.data?.usdcBalance;
  const short = balance !== undefined && balance < LISTING_FEE;
  const fee = formatUsdc(LISTING_FEE, { maxFractionDigits: 0 });

  const submit = async () => {
    if (!asset) return;
    const result = await track(
      () =>
        list.mutateAsync({
          symbol: asset.symbol,
          oracleAssetId: asset.oracleAssetId,
          intentsAssetId: asset.intentsAssetId,
          priceSource: asset.priceSource,
        }),
      {
        pending: `Listing ${marketName(asset.symbol)}…`,
        success: `${marketName(asset.symbol)} listed · measuring`,
        successDescription: () => "It opens after at least $10,000 of measured exit liquidity, sufficient vault backing and a fresh execution price.",
      },
    );
    if (result) {
      setPicked(null);
      await queryClient.invalidateQueries({ queryKey: listableMarketsKey });
    }
  };

  return (
    <section
      aria-labelledby="list-market-title"
      data-testid="list-market-panel"
      className={cn("flex min-w-0 flex-col rounded-md border border-border bg-card", className)}
    >
      <PanelHeading id="list-market-title">List a market</PanelHeading>
      <div className="flex flex-col gap-4 p-3">
        <p className="text-ui text-muted-foreground">
          Anyone can add a market for {fee} USDC. Its effective size cap reflects exit liquidity measured on
          NEAR Intents and available vault backing, like every other market.
        </p>

        {listable.isPending ? (
          <div aria-busy className="flex flex-col gap-1">
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
          </div>
        ) : listable.isError ? (
          <ErrorState
            title="Could not load the assets available for listing."
            error={listable.error}
            onRetry={() => void listable.refetch()}
          />
        ) : !asset ? (
          <EmptyState className="px-0 py-2">
            Every asset with both an oracle price and a NEAR Intents route is already listed.
          </EmptyState>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-label text-tertiary">Asset</span>
              <div role="radiogroup" aria-label="Asset to list" className="flex flex-col gap-1">
                {assets.map((a) => (
                  <button
                    key={a.symbol}
                    type="button"
                    role="radio"
                    aria-checked={a.symbol === asset.symbol}
                    data-testid={`listable-${a.symbol}`}
                    onClick={() => setPicked(a.symbol)}
                    className="flex h-row items-center justify-between gap-3 rounded-md border border-border px-3 text-ui text-muted-foreground transition-colors outline-none hover:border-tertiary/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-checked:border-foreground aria-checked:text-foreground"
                  >
                    <span className="font-medium">{a.symbol}</span>
                    <span className="text-label text-tertiary tabular-nums">
                      ≈ {a.referencePriceUsd.toLocaleString("en-US", { style: "currency", currency: "USD", maximumSignificantDigits: 6 })}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Row label="Market">{marketName(asset.symbol)}</Row>
              <Row label={<Term hint="Price delivered onchain by an OutLayer TEE oracle or the pinned multisource worker.">Price source</Term>}>
                {asset.priceSource === "outlayer_worker" ? "OutLayer worker" : "OutLayer oracle"}
              </Row>
              <Row label={<Term hint="Newly listed markets are backed by the Long-tail vault, never by Core.">Vault</Term>}>
                Long-tail
              </Row>
              <Row label={<Term hint="Ceiling for this market; the live maximum depends on measured exit liquidity.">Max leverage</Term>}>
                up to 5×
              </Row>
              <Row label={<Term hint="Paid to the Long-tail vault. Refunded in full if the listing is refused.">Listing fee</Term>}>
                {fee} USDC
              </Row>
            </div>

            <details className="text-label text-tertiary">
              <summary className="cursor-pointer hover:text-foreground">Details</summary>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt>Oracle asset</dt>
                <dd className="truncate font-mono text-muted-foreground">{asset.oracleAssetId}</dd>
                <dt>Intents asset</dt>
                <dd className="truncate font-mono text-muted-foreground">{asset.intentsAssetId}</dd>
                <dt>Oracle</dt>
                <dd className="truncate font-mono text-muted-foreground">{listable.data?.oracleId}</dd>
              </dl>
              <p className="mt-2">Reference price from NEAR Intents 1Click; the market itself trades on the oracle price.</p>
            </details>

            {accountId ? (
              <div className="flex flex-col gap-2">
                <Button
                  data-primary
                  data-testid="list-market-submit"
                  className="w-full"
                  disabled={list.isPending || short || balance === undefined}
                  onClick={() => void submit()}
                >
                  {list.isPending ? "Confirm in your wallet…" : `List ${asset.symbol} · ${fee} USDC`}
                </Button>
                {short ? (
                  <FieldMessage tone="error">
                    You have {formatUsdc(balance)} USDC in your wallet. Use Fund in the top bar to get 1,000 USDC.
                  </FieldMessage>
                ) : null}
              </div>
            ) : (
              <ConnectButton />
            )}
          </>
        )}

        {measuring.length > 0 ? (
          <div className="flex flex-col gap-1.5 border-t border-border pt-3">
            <span className="text-label text-tertiary">Waiting for their first measurement</span>
            <ul className="flex flex-wrap gap-1.5">
              {measuring.slice(0, MEASURING_SHOWN).map((m) => (
                <li key={m.id}>
                  <Badge variant="warning">{marketName(m.id)} · measuring</Badge>
                </li>
              ))}
              {measuring.length > MEASURING_SHOWN ? (
                <li className="self-center text-label text-tertiary">+{measuring.length - MEASURING_SHOWN} more</li>
              ) : null}
            </ul>
            <p className="text-label text-tertiary">
              A new market starts closed. It needs at least $10,000 of measured exit liquidity within 1% price
              impact, sufficient vault backing and a fresh execution price before a position can open.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
