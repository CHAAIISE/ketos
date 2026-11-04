import type { Metadata } from "next";
import { LeaderboardScreen } from "@/components/leaderboard/leaderboard-screen";

export const metadata: Metadata = {
  title: "Leaderboard",
  description: "All-time Ketos trader ranking by realized PnL, ROI and volume, read from onchain account history.",
};

export default function LeaderboardPage() {
  return <LeaderboardScreen />;
}
