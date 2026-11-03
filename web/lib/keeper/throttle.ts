/** Minimum time between two keeper ticks: each one costs oracle requests and gas. */
export const MIN_TICK_INTERVAL_MS = 60_000;

/** Milliseconds to wait before a tick is allowed, 0 if allowed now. */
export function retryAfterMs(lastTickMs: number | null, nowMs: number, intervalMs = MIN_TICK_INTERVAL_MS): number {
  if (lastTickMs === null) return 0;
  return Math.max(0, lastTickMs + intervalMs - nowMs);
}

export type GateResult = { ok: true; release: () => void } | { ok: false; retryAfterMs: number };

/**
 * In-process guard: one tick at a time and at most one start per interval. Serverless
 * instances do not share memory, so callers also check the last on-chain depth timestamp.
 */
export class TickGate {
  private lastStartMs: number | null = null;
  private running = false;

  constructor(private readonly intervalMs = MIN_TICK_INTERVAL_MS) {}

  enter(nowMs: number, lastOnChainTickMs: number | null = null): GateResult {
    if (this.running) return { ok: false, retryAfterMs: this.intervalMs };
    const wait = Math.max(
      retryAfterMs(this.lastStartMs, nowMs, this.intervalMs),
      retryAfterMs(lastOnChainTickMs, nowMs, this.intervalMs),
    );
    if (wait > 0) return { ok: false, retryAfterMs: wait };
    this.running = true;
    this.lastStartMs = nowMs;
    return {
      ok: true,
      release: () => {
        this.running = false;
      },
    };
  }
}
