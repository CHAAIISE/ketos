"use client";

import { useSyncExternalStore } from "react";

/** A depth sample older than this closes its market to new positions. */
export const STALE_AFTER_MS = 30 * 60_000;

const TICK_MS = 15_000;

let now = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribeNow(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Wall clock in ms, refreshed every 15 s; 0 while prerendering and before hydration. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribeNow,
    () => now,
    () => 0,
  );
}

const utcTime = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

const utcTimeSeconds = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
});

/** "14:05 UTC". */
export function formatUtc(ms: number, withSeconds = false): string {
  return `${(withSeconds ? utcTimeSeconds : utcTime).format(ms)} UTC`;
}

/** "just now", "4 min ago", "2 h ago"; empty until the clock is known. */
export function formatAge(ms: number, nowMs: number): string {
  if (!nowMs) return "";
  const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** True on viewports at least 768 px wide; desktop layout while prerendering. */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia("(min-width: 768px)");
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    () => window.matchMedia("(min-width: 768px)").matches,
    () => true,
  );
}
