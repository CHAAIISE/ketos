import type { Metadata } from "next";
import { LaunchScreen } from "@/components/markets/launch-screen";

export const metadata: Metadata = {
  title: "Launch",
  description: "Create a supported perpetual market with dedicated LP capital on NEAR testnet.",
};

export default function LaunchPage() {
  return <LaunchScreen />;
}
