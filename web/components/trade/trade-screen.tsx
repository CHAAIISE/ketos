"use client";

import { useState } from "react";
import { ErrorState, Skeleton } from "@/components/app/states";
import { Button } from "@/components/ui/button";
import { OnboardingSteps } from "@/components/ui/onboarding-steps";
import { useAccountId } from "@/hooks/near-provider";
import { useKeeperTick } from "@/hooks/use-keeper-tick";
import { useAccount, useMarkets, usePositions } from "@/hooks/use-perps-queries";
import { networkName } from "@/lib/near/config";
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
          title={`Markets are unavailable: the ${networkName()} RPC did not answer.`}
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
          {/* Below lg the two columns dissolve so positions sit right under the ticket that creates them. */}
          <div className="grid items-start gap-1 lg:grid-cols-12">
            <div className="contents lg:order-1 lg:col-span-8 lg:flex lg:min-w-0 lg:flex-col lg:gap-1 lg:self-stretch">
              <div className="order-4 min-w-0 lg:order-none">
                <MarketsTable markets={markets.data} selected={market.id} onSelect={setMarketId} />
              </div>
              <div className="order-2 min-w-0 lg:order-none lg:flex lg:flex-1 lg:flex-col lg:*:flex-1">
                <AccountPanel keeper={keeper} />
              </div>
            </div>
            <div className="contents lg:order-2 lg:col-span-4 lg:flex lg:min-w-0 lg:flex-col lg:gap-1">
              <div className="order-1 min-w-0 lg:order-none">
                <OrderTicket key={market.id} market={market} step={step} account={account.data} />
              </div>
              <div className="order-3 min-w-0 lg:order-none">
                <LiquidityCapCard market={market} />
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
