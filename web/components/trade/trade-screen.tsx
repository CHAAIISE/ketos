"use client";

import { useState } from "react";
import { ErrorState, Skeleton } from "@/components/app/states";
import { OnboardingSteps } from "@/components/ui/onboarding-steps";
import { useAccountId } from "@/hooks/near-provider";
import { useAccount, useMarkets, usePositions } from "@/hooks/use-ketos-queries";
import { networkName } from "@/lib/near/config";
import type { MarketId } from "@/lib/near/types";
import { AccountPanel } from "./account-panel";
import { ExitLiquidityBook } from "./exit-liquidity-book";
import { MarketHeader } from "./market-header";
import { onboardingSteps, tradeStep } from "./onboarding";
import { OrderTicket } from "./order-ticket";
import { PriceChart } from "./price-chart";

// Desktop: market bar, chart and exit-liquidity ladder side by side, account tabs below, order
// panel down the right edge. Phones stack bar, chart, order panel, ladder, then account tabs.
const GRID =
  "grid flex-1 gap-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_17rem_19rem] lg:grid-rows-[auto_minmax(28rem,1fr)_13rem] xl:grid-cols-[minmax(0,1fr)_19rem_20rem]";
const AREA = {
  bar: "lg:col-span-2 lg:col-start-1 lg:row-start-1",
  chart: "h-[22rem] lg:h-auto lg:col-start-1 lg:row-start-2",
  book: "order-4 h-[26rem] lg:order-none lg:h-auto lg:col-start-2 lg:row-start-2",
  order: "order-3 lg:order-none lg:col-start-3 lg:row-span-3 lg:row-start-1",
  account: "order-5 min-h-60 lg:order-none lg:min-h-0 lg:col-span-2 lg:col-start-1 lg:row-start-3",
};

function TradeSkeleton() {
  return (
    <div aria-busy className={GRID}>
      <Skeleton className={`h-14 rounded-md ${AREA.bar}`} />
      <Skeleton className={`rounded-md ${AREA.chart}`} />
      <Skeleton className={`rounded-md ${AREA.book}`} />
      <Skeleton className={`h-[34rem] rounded-md lg:h-auto ${AREA.order}`} />
      <Skeleton className={`rounded-md ${AREA.account}`} />
    </div>
  );
}

export function TradeScreen() {
  const accountId = useAccountId();
  const markets = useMarkets();
  const account = useAccount();
  const positions = usePositions();
  const [marketId, setMarketId] = useState<MarketId>("NEAR");

  const openPositions = positions.data?.length ?? 0;
  const step = tradeStep(accountId, account.data, openPositions);
  const market = markets.data?.find((m) => m.id === marketId) ?? markets.data?.[0];

  return (
    <>
      {openPositions === 0 ? <OnboardingSteps steps={onboardingSteps(step, openPositions)} /> : null}

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
          <section aria-label="Price chart" className={`flex min-h-0 min-w-0 flex-col rounded-md border border-border bg-card ${AREA.chart}`}>
            <div className="flex h-9 shrink-0 items-stretch border-b border-border">
              <span className="relative flex items-center px-3 text-ui text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-foreground">
                Chart
              </span>
            </div>
            <PriceChart market={market} className="flex-1" />
          </section>
          <ExitLiquidityBook market={market} className={AREA.book} />
          <OrderTicket key={market.id} market={market} step={step} account={account.data} className={AREA.order} />
          <AccountPanel className={AREA.account} />
        </div>
      )}
    </>
  );
}
