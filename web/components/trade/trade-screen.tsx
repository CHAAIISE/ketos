"use client";

import { useState } from "react";
import { ErrorState, Skeleton } from "@/components/app/states";
import { Button } from "@/components/ui/button";
import { OnboardingSteps } from "@/components/ui/onboarding-steps";
import { useAccountId } from "@/hooks/near-provider";
import { useKeeperTick } from "@/hooks/use-keeper-tick";
import { useAccount, useMarkets, usePositions } from "@/hooks/use-perps-queries";
import type { MarketId } from "@/lib/near/types";
import { AccountPanel } from "./account-panel";
import { LiquidityCapCard } from "./liquidity-cap-card";
import { MarketHeader } from "./market-header";
import { MarketsTable } from "./markets-table";
import { onboardingSteps, tradeStep } from "./onboarding";
import { OrderTicket } from "./order-ticket";

function TradeSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-1">
      <Skeleton className="h-36 rounded-lg xl:h-20" />
      <div className="grid gap-1 lg:grid-cols-12">
        <Skeleton className="h-80 rounded-lg lg:col-span-8" />
        <Skeleton className="h-[34rem] rounded-lg lg:col-span-4" />
      </div>
    </div>
  );
}

export function TradeScreen() {
  const accountId = useAccountId();
  const markets = useMarkets();
  const account = useAccount();
  const positions = usePositions();
  const [marketId, setMarketId] = useState<MarketId>("NEAR");
  const [guideOpen, setGuideOpen] = useState(false);
  const keeper = useKeeperTick();

  const openPositions = positions.data?.length ?? 0;
  const step = tradeStep(accountId, account.data, openPositions);
  const showGuide = openPositions === 0 || guideOpen;
  const market = markets.data?.find((m) => m.id === marketId) ?? markets.data?.[0];

  return (
    <>
      {showGuide ? <OnboardingSteps steps={onboardingSteps(step, openPositions)} /> : null}

      {markets.isPending ? (
        <TradeSkeleton />
      ) : markets.isError || !market ? (
        <ErrorState
          title="Markets are unavailable: the NEAR testnet RPC did not answer."
          error={markets.error}
          onRetry={() => void markets.refetch()}
        />
      ) : (
        <>
          <MarketHeader
            markets={markets.data}
            market={market}
            onSelect={setMarketId}
            aside={
              openPositions > 0 ? (
                <Button variant="ghost" size="sm" aria-expanded={guideOpen} onClick={() => setGuideOpen((v) => !v)}>
                  Getting started
                </Button>
              ) : null
            }
          />
          <div className="grid items-start gap-1 lg:grid-cols-12">
            <div className="order-2 flex min-w-0 flex-col gap-1 lg:order-1 lg:col-span-8">
              <MarketsTable markets={markets.data} selected={market.id} onSelect={setMarketId} />
              <AccountPanel keeper={keeper} />
            </div>
            <div className="order-1 flex min-w-0 flex-col gap-1 lg:order-2 lg:col-span-4">
              <OrderTicket key={market.id} market={market} step={step} account={account.data} />
              <LiquidityCapCard market={market} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
