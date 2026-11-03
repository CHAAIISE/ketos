import type { Metadata } from "next";
import { TradeScreen } from "@/components/trade/trade-screen";

export const metadata: Metadata = {
  title: "Trade",
  description: "Trade BTC, ETH, NEAR and ZEC perps on NEAR testnet with sizes capped by measured exit liquidity.",
};

export default function TradePage() {
  return <TradeScreen />;
}
