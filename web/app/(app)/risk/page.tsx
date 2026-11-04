import type { Metadata } from "next";
import { RiskScreen } from "@/components/risk/risk-screen";

export const metadata: Metadata = { title: "Risk" };

export default function RiskPage() {
  return <RiskScreen />;
}
