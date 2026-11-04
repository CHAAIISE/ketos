import type { Metadata } from "next";
import { TradeScreen } from "@/components/trade/trade-screen";

export const metadata: Metadata = {
  title: "Trade",
  description: "Trade perps on NEAR with sizes capped by exit liquidity measured on NEAR Intents.",
};

export default function TradePage() {
  return <TradeScreen />;
}
