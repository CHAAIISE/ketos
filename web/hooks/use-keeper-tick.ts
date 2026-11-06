"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { errorMessage } from "@/lib/utils";
import { ketosKeys } from "./use-ketos-queries";

/** The server runs at most one tick a minute, whoever asks. */
const INTERVAL_MS = 60_000;

const tickResponseSchema = z.object({
  ok: z.boolean(),
  state: z.literal("throttled").optional(),
  reason: z.string().optional(),
  liquidations: z.array(z.object({ tx: z.string().optional() })).optional(),
});

export type KeeperStatus = (
  | { state: "waiting" }
  | { state: "running" }
  | { state: "ran"; atMs: number; liquidated: number }
  | { state: "unavailable"; reason: string }
) & { lastPassMs?: number };

/**
 * Asks the server keeper for a pass (depth, prices, liquidations) while the page is open and
 * visible. Ticks requested by other visitors return a successful throttled state.
 */
export function useKeeperTick(): KeeperStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<KeeperStatus>({ state: "waiting" });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const controller = new AbortController();
    const schedule = (ms: number) => {
      if (!stopped) timer = setTimeout(run, ms);
    };

    async function run() {
      if (document.visibilityState !== "visible") return schedule(INTERVAL_MS);
      setStatus((s) => ({ state: "running", lastPassMs: s.state === "ran" ? s.atMs : s.lastPassMs }));
      try {
        const res = await fetch("/api/keeper/tick", { method: "POST", signal: controller.signal });
        const body = tickResponseSchema.safeParse(await res.json().catch(() => null));
        if (body.success && body.data.state === "throttled") {
          setStatus((s) => ({ state: "waiting", lastPassMs: s.lastPassMs }));
          const retryAfter = Number(res.headers.get("Retry-After"));
          return schedule(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 + 1_000 : INTERVAL_MS);
        }
        if (body.success && body.data.ok) {
          const liquidated = (body.data.liquidations ?? []).filter((l) => l.tx).length;
          const atMs = Date.now();
          setStatus({ state: "ran", atMs, lastPassMs: atMs, liquidated });
          void queryClient.invalidateQueries({ queryKey: ketosKeys.all });
        } else {
          const reason = body.success ? body.data.reason : undefined;
          setStatus((s) => ({ state: "unavailable", reason: reason ?? `keeper answered HTTP ${res.status}`, lastPassMs: s.lastPassMs }));
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        setStatus((s) => ({ state: "unavailable", reason: errorMessage(e), lastPassMs: s.lastPassMs }));
      }
      schedule(INTERVAL_MS);
    }

    void run();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [queryClient]);

  return status;
}
