import type { LeaderboardEntry } from "@/lib/near/types";

export type LeaderboardKey = "pnl" | "roi" | "volume" | "trades";

export interface RankedEntry extends LeaderboardEntry {
  /** 1 = best under the selected key, whatever the display direction. */
  rank: number;
}

function score(entry: LeaderboardEntry, key: LeaderboardKey): bigint {
  switch (key) {
    case "pnl":
      return entry.realized_pnl;
    case "roi":
      return entry.roi_bps;
    case "volume":
      return entry.volume;
    case "trades":
      return BigInt(entry.trades);
  }
}

/**
 * Ranks by descending score; ties break on descending account id, the order the contract
 * uses for its PnL and volume indexes, so the client and `get_leaderboard` agree.
 */
export function rankLeaderboard(entries: readonly LeaderboardEntry[], key: LeaderboardKey): RankedEntry[] {
  return [...entries]
    .sort((a, b) => {
      const sa = score(a, key);
      const sb = score(b, key);
      if (sa !== sb) return sa > sb ? -1 : 1;
      return a.account_id < b.account_id ? 1 : a.account_id > b.account_id ? -1 : 0;
    })
    .map((entry, i) => ({ ...entry, rank: i + 1 }));
}
