import { describe, expect, it } from "vitest";
import type { LeaderboardEntry } from "@/lib/near/types";
import { rankLeaderboard } from "./leaderboard-math";

const entry = (account_id: string, pnl: bigint, roi: bigint, volume: bigint, trades: number): LeaderboardEntry => ({
  account_id,
  realized_pnl: pnl,
  roi_bps: roi,
  volume,
  trades,
  committed_margin: 1_000_000n,
});

const rows = [
  entry("alice.testnet", -5_000_000n, -500n, 900_000_000n, 4),
  entry("bob.testnet", 12_000_000n, 120n, 100_000_000n, 2),
  entry("carol.testnet", 12_000_000n, 2_400n, 50_000_000n, 9),
  entry("dave.testnet", 0n, 0n, 0n, 0),
];

const order = (key: Parameters<typeof rankLeaderboard>[1]) => rankLeaderboard(rows, key).map((r) => `${r.rank}:${r.account_id}`);

describe("rankLeaderboard", () => {
  it("puts losses below flat accounts and breaks PnL ties on descending account id like the contract", () => {
    expect(order("pnl")).toEqual(["1:carol.testnet", "2:bob.testnet", "3:dave.testnet", "4:alice.testnet"]);
  });

  it("ranks each column on its own score", () => {
    expect(order("roi")[0]).toBe("1:carol.testnet");
    expect(order("volume")[0]).toBe("1:alice.testnet");
    expect(order("trades")).toEqual(["1:carol.testnet", "2:alice.testnet", "3:bob.testnet", "4:dave.testnet"]);
  });

  it("does not mutate the view response", () => {
    rankLeaderboard(rows, "volume");
    expect(rows[0]!.account_id).toBe("alice.testnet");
  });
});
