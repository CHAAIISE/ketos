import type { Metadata } from "next";
import { Suspense } from "react";
import { LiquidityView } from "@/components/liquidity/liquidity-view";
import { Skeleton } from "@/components/app/states";

export const metadata: Metadata = { title: "Liquidity" };

export default function LiquidityPage() {
  return (
    <Suspense fallback={<Skeleton className="h-24 rounded-lg" />}>
      <LiquidityView />
    </Suspense>
  );
}
