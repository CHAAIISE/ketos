"use client";

import { useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { ConnectButton } from "@/components/app/connect-button";
import { EmptyState, ErrorState, Skeleton } from "@/components/app/states";
import { useTxToast } from "@/components/app/tx-toast";
import { marketName } from "@/components/trade/market-header";
import { PanelHeading } from "@/components/vault/panel-heading";
import { Term } from "@/components/vault/term";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { FieldMessage, Input } from "@/components/ui/input";
import { useAccountId, useNear } from "@/hooks/near-provider";
import { useDepositVault, useListMarket } from "@/hooks/use-ketos-mutations";
import { useAccount, useVaults } from "@/hooks/use-ketos-queries";
import { listableMarketsKey, useListableMarkets } from "@/hooks/use-market-feeds";
import { LISTING_FEE } from "@/lib/near/calls";
import { formatUsdc, formatUsd, parseUsdc } from "@/lib/near/format";
import { txExplorerUrl } from "@/lib/near/explorer";
import { formatUtc } from "@/components/landing/live-time";
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
 * Create a source-bound market, then fund its separate LP vault in a second transaction.
 * Listing fees are protocol revenue, never initial market capital.
 */
export function ListMarketPanel({ markets, className }: { markets: readonly Market[]; className?: string }) {
  const accountId = useAccountId();
  const account = useAccount();
  const listable = useListableMarkets();
  const list = useListMarket();
  const fund = useDepositVault();
  const vaults = useVaults();
  const { config } = useNear();
  const queryClient = useQueryClient();
  const { track } = useTxToast();
  const [picked, setPicked] = useState<string | null>(null);
  const [launched, setLaunched] = useState<string | null>(null);
  const [capitalInput, setCapitalInput] = useState("100");
  const capital = parseUsdc(capitalInput);
  const created = markets.find((market) => market.id === launched);
  const createdVault = vaults.data?.find((vault) => vault.id === created?.vault_id);
  const creationReceipt = txExplorerUrl(config.network, list.data?.txHash ?? null);
  const fundingReceipt = txExplorerUrl(config.network, fund.data?.txHash ?? null);
  const assetGroupId = useId();

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
        success: `${marketName(asset.symbol)} created · isolated vault`,
        successDescription: () => "Listing confirmed. Fund the dedicated vault separately; price and measured depth still gate trading.",
      },
    );
    if (result) {
      setLaunched(asset.symbol);
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
      <PanelHeading id="list-market-title">Launch a market</PanelHeading>
      <div className="flex flex-col gap-4 p-3">
        <p className="text-ui text-muted-foreground">
          Create a market with its own LP capital. Pay {fee} USDC to register, then fund its
          vault separately. No capital is borrowed from Core or Long-tail.
        </p>

        {launched ? (
          <div className="flex flex-col gap-4" data-testid="launch-confirmed">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-subtitle">{launched}</h2>
              <Badge variant={created?.launch_state === "ready" ? "success" : "warning"}>
                {created?.launch_state ?? "Reading confirmed registry…"}
              </Badge>
            </div>
            {list.data?.txHash ? creationReceipt
              ? <a href={creationReceipt} target="_blank" rel="noreferrer" className="text-label underline">Creation receipt ↗</a>
              : <p className="break-all text-label text-muted-foreground">Sandbox creation receipt: {list.data.txHash}</p> : null}
            <dl className="flex flex-col gap-2">
              <Row label="Dedicated LP capital">{createdVault ? formatUsd(createdVault.nav) : "Reading…"}</Row>
              <Row label="Listing fee · not LP capital">{fee} USDC</Row>
              <Row label="Margin">Isolated only</Row>
            </dl>
            {fund.isSuccess && created ? <Link data-primary className={buttonVariants()} href={`/trade?market=${encodeURIComponent(created.id)}`}>
              {created.is_open ? `Trade ${created.id}` : `Inspect ${created.id} while depth is measured`}
            </Link> : <>
            <label className="flex flex-col gap-1 text-label" htmlFor={`${assetGroupId}-fund`}>Your LP deposit · USDC
              <Input id={`${assetGroupId}-fund`} inputMode="decimal" value={capitalInput} onChange={(event) => setCapitalInput(event.target.value)} />
            </label>
            <Button data-primary data-testid="launch-fund" disabled={!created || fund.isPending || !capital || capital < 1_000_000n || balance === undefined || capital > balance}
              onClick={() => {
                if (!created || !capital) return;
                void track(() => fund.mutateAsync({ vaultId: created.vault_id, amount: capital }), {
                  pending: `Funding ${created.id} isolated vault…`, success: `${created.id} LP deposit confirmed`,
                });
              }}>
              {fund.isPending ? "Confirm LP deposit…" : `Fund ${launched} vault`}
            </Button>
            {capital !== null && balance !== undefined && capital > balance ? <FieldMessage tone="error">Deposit exceeds your wallet balance of {formatUsdc(balance)} USDC.</FieldMessage> : null}
            </>}
            {fundingReceipt ? <a href={fundingReceipt} target="_blank" rel="noreferrer" className="text-label underline">LP funding receipt ↗</a>
              : fund.data?.txHash ? <p className="break-all text-label text-muted-foreground">Sandbox funding receipt: {fund.data.txHash}</p> : null}
            <p className="text-label text-muted-foreground">
              {created?.launch_state === "ready" ? "Capital, measured depth and a recent stored price are present. Each trade still checks a fresh execution price."
                : "Trading stays gated until there is dedicated capital, sufficient measured depth and a fresh execution price. Funding does not guarantee that a market will open."}
            </p>
            {created?.launch_state !== "ready" ? <p className="text-label text-muted-foreground">Depth runs on a ten-minute keeper schedule; quote processing adds time. Idle prices refresh when you submit a trade, not when you visit this page.</p> : null}
            {created ? <div className="flex flex-wrap gap-4 text-ui">
              <Link href={`/vaults/${created.vault_id}`} className="underline">Your shares &amp; withdrawals →</Link>
            </div> : null}
            <Button variant="secondary" onClick={() => { setLaunched(null); list.reset(); fund.reset(); }}>Create another market</Button>
          </div>
        ) : listable.isPending ? (
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
            Every currently eligible source-bound asset with an available Intents route is already listed.
          </EmptyState>
        ) : (
          <>
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-label text-tertiary">Asset</legend>
              <div className="flex flex-col gap-1">
                {assets.map((a) => (
                  <label
                    key={a.symbol}
                    data-testid={`listable-${a.symbol}`}
                    className="relative flex h-row cursor-pointer items-center justify-between gap-3 rounded-md border border-border px-3 text-ui text-muted-foreground transition-colors hover:border-tertiary/40 hover:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring has-checked:border-foreground has-checked:text-foreground"
                  >
                    <input
                      type="radio"
                      name={assetGroupId}
                      checked={a.symbol === asset.symbol}
                      value={a.symbol}
                      onChange={() => setPicked(a.symbol)}
                      className="sr-only"
                    />
                    <span className="font-medium">{a.symbol}</span>
                    <span className="text-label text-tertiary tabular-nums">
                      ≈ {a.referencePriceUsd.toLocaleString("en-US", { style: "currency", currency: "USD", maximumSignificantDigits: 6 })}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex flex-col gap-2">
              <Row label="Market">{marketName(asset.symbol)}</Row>
              <Row label={<Term hint="Price delivered onchain by an OutLayer TEE oracle or the pinned multisource worker.">Price source</Term>}>
                {asset.priceSource === "outlayer_worker" ? "OutLayer worker" : "OutLayer oracle"}
              </Row>
              <Row label={<Term hint="A new empty vault belongs only to this market. LP deposits are separate from the listing fee.">Vault</Term>}>
                {asset.symbol} isolated · starts at 0 USDC
              </Row>
              <Row label={<Term hint="Ceiling for this market; the live maximum depends on measured exit liquidity.">Max leverage</Term>}>
                up to 5×
              </Row>
              <Row label={<Term hint="Paid to the Long-tail vault. Refunded in full if the listing is refused.">Listing fee</Term>}>
                {fee} USDC
              </Row>
              <label className="flex flex-col gap-1 text-label" htmlFor={`${assetGroupId}-capital`}>Planned LP capital · separate signature
                <Input id={`${assetGroupId}-capital`} inputMode="decimal" value={capitalInput} onChange={(event) => setCapitalInput(event.target.value)} />
              </label>
              <p className="text-label text-muted-foreground">Only the {fee} USDC fee is charged now. You can fund the vault after creation, or leave it unfunded. LP capital is exposed to trader gains and losses.</p>
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
              <p className="mt-2">Reference price from NEAR Intents 1Click{listable.data ? ` · read ${formatUtc(listable.data.fetchedAtMs, true)}` : ""}; execution uses the authenticated oracle, not this reference.</p>
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
                  {list.isPending ? "Confirm in your wallet…" : `Create ${asset.symbol} · ${fee} USDC`}
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
                  <Link href={`/trade?market=${encodeURIComponent(m.id)}`}><Badge variant="warning">{marketName(m.id)} · measuring</Badge></Link>
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
