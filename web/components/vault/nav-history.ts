"use client";

import { useSyncExternalStore } from "react";
import { z } from "zod";

/** One `get_vault` read, timestamped when the browser received it. */
export interface NavPoint {
  t: number;
  nav: bigint;
  sharePrice: bigint;
}

/** Two hours at one read every 10 s. */
const MAX_POINTS = 720;
const EMPTY: NavPoint[] = [];

const storedSchema = z.array(z.tuple([z.number(), z.string().regex(/^\d+$/), z.string().regex(/^\d+$/)]));

const cache = new Map<string, NavPoint[]>();
const listeners = new Set<() => void>();

const storageKey = (contractId: string) => `ketos:vault-nav:${contractId}`;

function load(contractId: string): NavPoint[] {
  const cached = cache.get(contractId);
  if (cached) return cached;
  let points: NavPoint[] = [];
  try {
    const parsed = storedSchema.safeParse(JSON.parse(sessionStorage.getItem(storageKey(contractId)) ?? "[]"));
    if (parsed.success) points = parsed.data.map(([t, nav, sharePrice]) => ({ t, nav: BigInt(nav), sharePrice: BigInt(sharePrice) }));
  } catch {
    // Unreadable or blocked storage: the chart starts from this read.
  }
  cache.set(contractId, points);
  return points;
}

/** Appends a read; ignores the same read seen twice (cached query on remount). */
export function recordNavPoint(contractId: string, point: NavPoint) {
  const points = load(contractId);
  const last = points.at(-1);
  if (last && point.t <= last.t) return;
  const next = [...points, point].slice(-MAX_POINTS);
  cache.set(contractId, next);
  try {
    sessionStorage.setItem(
      storageKey(contractId),
      JSON.stringify(next.map((p) => [p.t, p.nav.toString(), p.sharePrice.toString()])),
    );
  } catch {
    // Storage full or blocked: keep the in-memory series.
  }
  for (const notify of listeners) notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** NAV reads collected in this browser tab, oldest first; empty while prerendering. */
export function useNavHistory(contractId: string): NavPoint[] {
  return useSyncExternalStore(
    subscribe,
    () => load(contractId),
    () => EMPTY,
  );
}
