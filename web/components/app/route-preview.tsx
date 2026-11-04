"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { formatAge, formatUtc, useNow } from "@/components/landing/live-time";
import { ErrorState, Skeleton } from "@/components/app/states";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldMessage, Input } from "@/components/ui/input";
import { formatUnits, formatUsdc, parseUnits } from "@/lib/near/format";
import { ROUTE_ASSET_KEYS, ROUTE_ASSETS, routePreviewSchema, type RouteAsset, type RoutePreview } from "@/lib/intents/route-preview";

const DEBOUNCE_MS = 400;
const AMOUNT_EXAMPLE: Record<RouteAsset, string> = { ETH_BASE: "0.1", SOL: "1", BTC: "0.01" };

async function fetchRoutePreview(asset: RouteAsset, amount: string, signal: AbortSignal): Promise<RoutePreview> {
  const res = await fetch(`/api/route-preview?asset=${asset}&amount=${encodeURIComponent(amount)}`, { signal });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = typeof body === "object" && body && "error" in body ? String(body.error) : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return routePreviewSchema.parse(body);
}

function usd(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 1Click time estimate in seconds to "≈ 20 s", "≈ 14 min" or "≈ 2 h". */
function durationLabel(seconds: number): string {
  if (seconds < 90) return `≈ ${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `≈ ${minutes} min`;
  return `≈ ${Math.round(minutes / 60)} h`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-label text-tertiary">{label}</dt>
      <dd className="text-right text-label text-foreground tabular-nums">{children}</dd>
    </div>
  );
}

function QuoteResult({ preview, nowMs }: { preview: Extract<RoutePreview, { status: "ok" }>; nowMs: number }) {
  const origin = ROUTE_ASSETS[preview.asset];
  return (
    <div className="flex flex-col gap-3" data-testid="route-preview-quote">
      <div className="flex flex-col gap-0.5">
        <span className="text-label text-tertiary">You would receive</span>
        <span className="text-heading text-foreground tabular-nums">{formatUsdc(BigInt(preview.amountOut))} USDC</span>
        <span className="text-label text-tertiary tabular-nums">
          on NEAR · ≈ {usd(preview.amountOutUsd)} · at least {preview.minAmountOutFormatted} USDC after 1% slippage
        </span>
      </div>
      <dl className="flex flex-col gap-1.5">
        <Row label="You send">
          {preview.amountInFormatted} {origin.symbol} on {origin.chain} · ≈ {usd(preview.amountInUsd)}
        </Row>
        <Row label="Route cost">
          {usd(Math.max(0, preview.routeCostUsd))} · {Math.max(0, preview.routeCostBps)} bps
        </Row>
        <Row label="Estimated time">{durationLabel(preview.timeEstimateSec)}</Row>
        <Row label="Quoted">
          {formatUtc(preview.quotedAtMs, true)}
          {nowMs ? ` · ${formatAge(preview.quotedAtMs, nowMs)}` : null}
        </Row>
      </dl>
      <p className="text-label text-tertiary">
        Route cost includes the {preview.platformFeeBps} bps 1Click platform fee, the swap spread and network fees, at 1Click&apos;s
        prices.
      </p>
      <details className="text-label text-tertiary">
        <summary className="cursor-pointer hover:text-foreground">Details</summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>From</dt>
          <dd className="truncate font-mono text-muted-foreground">{preview.originAssetId}</dd>
          <dt>To</dt>
          <dd className="truncate font-mono text-muted-foreground">{preview.destinationAssetId}</dd>
          <dt>Source</dt>
          <dd className="text-muted-foreground">NEAR Intents 1Click dry quote (EXACT_INPUT, origin-chain deposit)</dd>
        </dl>
      </details>
    </div>
  );
}

/**
 * Read-only preview of bringing ETH (Base), SOL or BTC in as USDC on NEAR through NEAR Intents. It
 * never asks for a deposit address; margin on this app is funded from NEAR.
 */
export function RoutePreviewForm({ onUseNear }: { onUseNear: () => void }) {
  const inputId = useId();
  const nowMs = useNow();
  const [asset, setAsset] = useState<RouteAsset>("SOL");
  const [input, setInput] = useState("");
  const origin = ROUTE_ASSETS[asset];
  const amountIn = parseUnits(input, origin.decimals);
  const error =
    input.trim() === ""
      ? null
      : amountIn === null
        ? `Enter an amount like ${AMOUNT_EXAMPLE[asset]} (up to ${origin.decimals} decimals).`
        : amountIn === 0n
          ? "Enter an amount above zero."
          : null;
  const requested = amountIn && !error ? { asset, amount: formatUnits(amountIn, origin.decimals, { grouping: false, minFractionDigits: 0 }) } : null;
  const requestedKey = requested ? `${requested.asset}:${requested.amount}` : null;

  const [debouncedKey, setDebouncedKey] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKey(requestedKey), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [requestedKey]);
  const settling = requestedKey !== debouncedKey;

  const preview = useQuery({
    queryKey: ["route-preview", requested?.asset, requested?.amount] as const,
    queryFn: requested && !settling ? ({ signal }) => fetchRoutePreview(requested.asset, requested.amount, signal) : skipToken,
    staleTime: 20_000,
    refetchInterval: 30_000,
    retry: 1,
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-label text-tertiary">From</span>
        <div role="radiogroup" aria-label="Origin asset" className="grid grid-cols-3 gap-1">
          {ROUTE_ASSET_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={key === asset}
              data-testid={`route-asset-${key}`}
              onClick={() => setAsset(key)}
              className="flex flex-col items-start justify-center rounded-md border border-border px-3 py-2 text-ui text-muted-foreground transition-colors outline-none hover:border-tertiary/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-checked:border-foreground aria-checked:text-foreground"
            >
              <span className="font-medium">{ROUTE_ASSETS[key].symbol}</span>
              <span className="text-label text-tertiary">{ROUTE_ASSETS[key].chain}</span>
            </button>
          ))}
        </div>
      </div>

      <Field>
        <FieldLabel htmlFor={inputId}>Amount ({origin.symbol})</FieldLabel>
        <Input
          id={inputId}
          name="route-preview-amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder={AMOUNT_EXAMPLE[asset]}
          value={input}
          aria-invalid={error ? true : undefined}
          onChange={(event) => setInput(event.target.value)}
        />
        {error ? <FieldMessage tone="error">{error}</FieldMessage> : null}
      </Field>

      <section aria-live="polite" className="flex flex-col gap-2 rounded-md border border-border px-3 py-3">
        <h3 className="text-label text-tertiary">Route preview · settles on NEAR mainnet via NEAR Intents</h3>
        {!requested ? (
          <p className="text-ui text-muted-foreground">
            Enter an amount of {origin.symbol} on {origin.chain} to see the USDC on NEAR it would become.
          </p>
        ) : settling || preview.isPending ? (
          <Skeleton className="h-36 w-full" />
        ) : preview.isError ? (
          <ErrorState title="Route quote unavailable. Retry in a moment." error={preview.error} onRetry={() => void preview.refetch()} />
        ) : preview.data.status === "no_liquidity" ? (
          <ErrorState
            title={`No liquidity available for ${preview.data.amountInFormatted} ${origin.symbol} right now. Try a smaller amount.`}
          />
        ) : (
          <QuoteResult preview={preview.data} nowMs={nowMs} />
        )}
      </section>

      <p className="text-label text-tertiary">
        Preview only: nothing is deposited from here. Margin on this app comes from the Fund button, then a deposit from NEAR.
      </p>
      <Button type="button" className="w-full" onClick={onUseNear}>
        Deposit from NEAR
      </Button>
    </div>
  );
}
