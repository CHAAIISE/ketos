import type { Metadata } from "next";
import { MarketsScreen } from "@/components/markets/markets-screen";

export const metadata: Metadata = {
  title: "Markets",
  description: "Every Ketos perps market with its price, funding, open interest and the cap set by exit liquidity measured on NEAR Intents.",
};

export default function MarketsPage() {
  return <MarketsScreen />;
}
