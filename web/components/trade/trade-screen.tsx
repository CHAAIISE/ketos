"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { ErrorState, Skeleton } from "@/components/app/states";
import { OnboardingSteps } from "@/components/ui/onboarding-steps";
import { Button } from "@/components/ui/button";
import { PanelTabs } from "@/components/ui/panel-tabs";
import { useAccountId } from "@/hooks/near-provider";
import { useAccount, useMarkets, usePositions } from "@/hooks/use-ketos-queries";
import { networkName } from "@/lib/near/config";
import { formatPrice } from "@/lib/near/format";
import type { MarketId, Side } from "@/lib/near/types";
import { AccountPanel } from "./account-panel";
import { ExitLiquidityBook } from "./exit-liquidity-book";
import { MarketHeader } from "./market-header";
import { onboardingSteps, tradeStep } from "./onboarding";
import { OrderTicket } from "./order-ticket";
import { PriceChart } from "./price-chart";

const GRID =
  "grid min-w-0 grid-cols-1 gap-2 lg:h-[calc(100dvh-8rem)] lg:min-h-[42rem] lg:grid-cols-[minmax(0,1fr)_16rem_18rem] xl:grid-cols-[minmax(0,1fr)_17rem_18rem] lg:grid-rows-[auto_minmax(0,1fr)_12rem]";
const AREA = {
  bar: "lg:col-span-2 lg:col-start-1 lg:row-start-1",
  chart: "h-[min(60dvh,32rem)] min-h-80 lg:h-auto lg:min-h-0 lg:col-start-1 lg:row-start-2",
  book: "h-[32rem] lg:h-auto lg:min-h-0 lg:col-start-2 lg:row-start-2",
  order: "contents lg:block lg:min-h-0 lg:col-start-3 lg:row-span-3 lg:row-start-1",
  account: "min-h-48 lg:min-h-0 lg:col-span-2 lg:col-start-1 lg:row-start-3",
};

function subscribeToDesktop(onChange: () => void) {
  const query = window.matchMedia("(min-width: 1024px)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function TradeSkeleton() {
  return (
    <div aria-busy className={GRID}>
      <Skeleton className={`h-14 rounded-md ${AREA.bar}`} />
      <Skeleton className={`rounded-md ${AREA.chart}`} />
      <Skeleton className={`rounded-md ${AREA.book}`} />
      <Skeleton className="hidden rounded-lg lg:col-start-3 lg:row-span-3 lg:row-start-1 lg:block" />
      <Skeleton className={`rounded-md ${AREA.account}`} />
    </div>
  );
}

function subscribeToHistory(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

export function TradeScreen() {
  const accountId = useAccountId();
  const markets = useMarkets();
  const account = useAccount();
  const positions = usePositions();
  // `?market=` is read on the client only (null while hydrating), so the page stays static.
  const urlMarket = useSyncExternalStore(
    subscribeToHistory,
    () => new URLSearchParams(window.location.search).get("market"),
    () => null,
  );
  const [picked, setPicked] = useState<MarketId | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [side, setSide] = useState<Side>("long");
  const [ticketOpen, setTicketOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<"chart" | "liquidity">("chart");
  const [ticketContainer, setTicketContainer] = useState<HTMLDivElement | null>(null);
  const desktop = useSyncExternalStore(subscribeToDesktop, () => window.matchMedia("(min-width: 1024px)").matches, () => false);
  const marketId = picked ?? urlMarket ?? "NEAR";
  // Mirrors the choice into the URL so a reload or a shared link opens the same market.
  const setMarketId = (id: MarketId) => {
    setPicked(id);
    window.history.replaceState(null, "", `?market=${encodeURIComponent(id)}`);
  };

  const openPositions = positions.data?.length ?? 0;
  const step = tradeStep(accountId, account.data, openPositions);
  const market = markets.data?.find((m) => m.id === marketId) ?? markets.data?.[0];
  const titleMarket = market?.id ?? marketId;
  const markPrice = market?.price;

  useEffect(() => {
    document.title = `${titleMarket}-USD · Mark ${markPrice !== undefined && markPrice > 0n ? formatPrice(markPrice) : "unavailable"} — Ketos`;
  }, [titleMarket, markPrice]);

  return (
    <Dialog.Root open={desktop || ticketOpen} modal={!desktop} onOpenChange={(next) => { if (!desktop) setTicketOpen(next); }}>
      {openPositions === 0 || showGuide ? (
        <div className="flex min-w-0 items-center gap-2">
          <OnboardingSteps steps={onboardingSteps(step, openPositions)} className="min-w-0 flex-1" />
          {openPositions > 0 && (
            <Button variant="ghost" size="sm" className="h-6 px-1" aria-label="Hide getting started" onClick={() => setShowGuide(false)}>
              <X className="size-3" />
            </Button>
          )}
        </div>
      ) : (
        <Button variant="ghost" size="sm" className="h-6 w-fit text-label" aria-expanded={showGuide} onClick={() => setShowGuide(true)}>
          Getting started
        </Button>
      )}

      {markets.isPending ? (
        <TradeSkeleton />
      ) : markets.isError || !market ? (
        <ErrorState
          title={`Markets are unavailable: the ${networkName()} RPC did not answer.`}
          error={markets.error}
          onRetry={() => void markets.refetch()}
        />
      ) : (
        <div className={GRID}>
          <MarketHeader markets={markets.data} market={market} onSelect={setMarketId} className={AREA.bar} />
          <div className="lg:hidden">
            <PanelTabs tabs={[{ id: "chart", label: "Chart" }, { id: "liquidity", label: "Liquidity / Trades" }]} value={mobilePane} onChange={setMobilePane} label="Market view" idPrefix="market-view" />
          </div>
          <section aria-label="Price chart" className={`${mobilePane === "chart" ? "flex" : "hidden lg:flex"} min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card ${AREA.chart}`}>
            <div className="hidden h-9 shrink-0 items-center border-b border-border px-3 text-ui lg:flex">Chart</div>
            <PriceChart market={market} className="min-h-0 flex-1" />
          </section>
          <ExitLiquidityBook market={market} className={`${mobilePane === "liquidity" ? "" : "hidden lg:flex"} ${AREA.book}`} />
          <div ref={setTicketContainer} className={AREA.order}>
            {ticketContainer ? <Dialog.Portal container={ticketContainer} keepMounted className="contents">
              <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/70 lg:hidden" />
              <Dialog.Popup initialFocus={desktop ? false : undefined} className="fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col overflow-hidden overscroll-contain rounded-t-xl border border-border bg-card pb-[env(safe-area-inset-bottom)] text-foreground outline-none lg:static lg:z-auto lg:h-full lg:max-h-none lg:overflow-y-auto lg:rounded-lg lg:pb-0">
                <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between border-b border-border bg-card px-3 lg:sr-only">
                  <Dialog.Title className="text-ui font-medium">{market.id}-USD · {side === "long" ? "Long" : "Short"}</Dialog.Title>
                  <Dialog.Close aria-label="Close order ticket" className="flex size-11 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-ring lg:hidden">
                    <X className="size-5" />
                  </Dialog.Close>
                </div>
                <OrderTicket key={market.id} market={market} step={step} account={account.data} side={side} onSideChange={setSide} className="border-0 bg-transparent" />
              </Dialog.Popup>
            </Dialog.Portal> : null}
          </div>
          <AccountPanel className={`${AREA.account} mb-20 lg:mb-0`} />
        </div>
      )}
      {market ? (
        <div className="fixed inset-x-0 bottom-0 z-30 flex gap-2 border-t border-border bg-background p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden">
          <Dialog.Trigger render={<Button variant="long" className="h-11 flex-1" />} onClick={() => setSide("long")}>Long</Dialog.Trigger>
          <Dialog.Trigger render={<Button variant="short" className="h-11 flex-1" />} onClick={() => setSide("short")}>Short</Dialog.Trigger>
        </div>
      ) : null}
    </Dialog.Root>
  );
}
