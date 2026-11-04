"use client";

import { useState, type ReactNode } from "react";
import { useNow } from "@/components/landing/live-time";
import { useFundingDialog } from "@/components/app/funding";
import { Skeleton } from "@/components/app/states";
import { useTxToast } from "@/components/app/tx-toast";
import { Term } from "@/components/vault/term";
import { Button } from "@/components/ui/button";
import { FieldMessage } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useWallet } from "@/hooks/near-provider";
import { usePositions, type AccountSummary } from "@/hooks/use-ketos-queries";
import { useOpenPosition } from "@/hooks/use-ketos-mutations";
import { toNearActionError } from "@/lib/near/errors";
import { formatPrice, formatUsd, formatUsdc, parseUsdc } from "@/lib/near/format";
import type { Market, Side } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { marketStatus } from "./market-status";
import type { TradeStep } from "./onboarding";
import { borrowRatePercent, MIN_POSITION_MARGIN, previewOrder } from "./order-math";

const PERCENT_MARKS = [0, 25, 50, 75, 100];

function Row({ label, children, tone }: { label: ReactNode; children: ReactNode; tone?: "warning" }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-label text-tertiary">{label}</dt>
      <dd className={cn("text-label tabular-nums text-foreground", tone === "warning" && "text-warning")}>{children}</dd>
    </div>
  );
}

function SideToggle({ side, onChange }: { side: Side; onChange: (side: Side) => void }) {
  return (
    <div role="radiogroup" aria-label="Side" className="grid grid-cols-2 rounded-md bg-muted p-0.5">
      {(["long", "short"] as const).map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={side === s}
          data-testid={`side-${s}`}
          onClick={() => onChange(s)}
          className={cn(
            "h-8 rounded-[5px] text-ui text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
            side === s && s === "long" && "bg-success text-success-foreground hover:text-success-foreground",
            side === s && s === "short" && "bg-destructive text-destructive-foreground hover:text-destructive-foreground",
          )}
        >
          {s === "long" ? "Buy / Long" : "Sell / Short"}
        </button>
      ))}
    </div>
  );
}

/** "5×" button; the modal bounds the choice by today's market maximum. */
function LeverageControl({
  leverage,
  max,
  onChange,
}: {
  leverage: number;
  max: number;
  onChange: (leverage: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(leverage);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDraft(leverage);
          setOpen(true);
        }}
        className="h-8 rounded-md bg-muted text-ui text-foreground transition-colors hover:bg-muted/70 focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={`Leverage ${leverage}×, adjust`}
      >
        <span data-testid="leverage-value">{leverage}×</span>
      </button>
      <Modal open={open} onOpenChange={setOpen} title="Adjust Leverage">
        <p className="text-label text-muted-foreground">
          Up to {max}× on this market today. The limit follows the exit liquidity measured on NEAR Intents.
        </p>
        <div className="flex items-center gap-3">
          <input
            id="order-leverage"
            type="range"
            min={1}
            max={max}
            step={1}
            value={Math.min(draft, max)}
            onChange={(event) => setDraft(Number(event.target.value))}
            className="h-5 flex-1 accent-foreground"
            aria-label="Leverage"
          />
          <span className="w-12 rounded-md border border-border bg-input py-1.5 text-center text-ui tabular-nums text-foreground">
            {Math.min(draft, max)}×
          </span>
        </div>
        <Button
          onClick={() => {
            onChange(Math.min(draft, max));
            setOpen(false);
          }}
        >
          Confirm
        </Button>
      </Modal>
    </>
  );
}

/** Market-order panel for one market: side, size in USDC, leverage, preview and the main action. */
export function OrderTicket({
  market,
  step,
  account,
  className,
}: {
  market: Market;
  step: TradeStep | null;
  account: AccountSummary | undefined;
  className?: string;
}) {
  const wallet = useWallet();
  const funding = useFundingDialog();
  const open = useOpenPosition();
  const positions = usePositions();
  const { track } = useTxToast();
  const nowMs = useNow();
  const [side, setSide] = useState<Side>("long");
  const [sizeInput, setSizeInput] = useState("");
  const [leverageChoice, setLeverageChoice] = useState(5);
  const [connectError, setConnectError] = useState<string | null>(null);

  const leverage = Math.min(Math.max(1, leverageChoice), market.max_leverage);
  const lev = BigInt(leverage);
  const sizeUnits = parseUsdc(sizeInput);
  // The contract takes margin and leverage; the order value is margin × leverage.
  const margin = sizeUnits === null ? null : sizeUnits / lev;
  const preview = previewOrder(market, side, margin ?? 0n, leverage);
  const status = marketStatus(market, nowMs);
  const freeMargin = account?.margin ?? 0n;
  const maxSize = freeMargin * lev;
  const trading = step === "trade";
  const percent = maxSize > 0n && sizeUnits !== null ? Math.min(100, Number((sizeUnits * 100n) / maxSize)) : 0;
  const held = (positions.data ?? []).filter((p) => p.market_id === market.id);
  const heldLong = held.filter((p) => p.side === "long").reduce((sum, p) => sum + p.size, 0n);
  const heldShort = held.filter((p) => p.side === "short").reduce((sum, p) => sum + p.size, 0n);

  const sizeError =
    sizeInput.trim() === ""
      ? null
      : sizeUnits === null
        ? "Enter a size like 500 or 125.50."
        : margin !== null && margin < MIN_POSITION_MARGIN
          ? `The smallest order uses 1 USDC of margin: ${leverage} USDC at ${leverage}×.`
          : trading && margin !== null && margin > freeMargin
            ? `Needs ${formatUsd(margin)} of margin; ${formatUsd(freeMargin)} is available. Deposit more or lower the size.`
            : null;

  const refusal = open.error;
  const capUsdc = refusal?.capUsdc;

  function setSize(units: bigint) {
    setSizeInput(units > 0n ? formatUsdc(units, { grouping: false }) : "");
    open.reset();
  }

  function applyMaxSize(capUnits: bigint) {
    // Largest whole multiple of the leverage that fits under the cap and the free margin.
    const fitted = (capUnits < maxSize || !trading ? capUnits : maxSize) / lev;
    setSize(fitted * lev);
  }

  async function submit() {
    if (!margin || sizeError) return;
    const result = await track(
      () => open.mutateAsync({ marketId: market.id, side, margin, leverage }),
      {
        pending: `Opening ${side} ${market.id} ${leverage}×…`,
        success: `${side === "long" ? "Long" : "Short"} ${market.id} ${leverage}× opened · ${formatUsd(preview.size)}`,
        errorInline: true,
      },
    );
    if (result) setSizeInput("");
  }

  let action: ReactNode;
  if (step === null || (step !== "connect" && !account)) {
    action = <Skeleton className="h-10 w-full" />;
  } else if (step === "connect") {
    action = (
      <>
        <Button
          data-primary=""
          className="h-10 w-full"
          disabled={!wallet.isReady}
          onClick={async () => {
            setConnectError(null);
            try {
              await wallet.signIn();
            } catch (e) {
              setConnectError(toNearActionError(e).message);
            }
          }}
        >
          {wallet.isReady ? "Connect" : "Loading wallet…"}
        </Button>
        {(connectError ?? wallet.error) ? (
          <FieldMessage tone="error">{connectError ?? wallet.error?.message}</FieldMessage>
        ) : null}
      </>
    );
  } else if (!trading) {
    action = (
      <Button data-primary="" className="h-10 w-full" onClick={() => funding.open("deposit")}>
        Enable trading
      </Button>
    );
  } else {
    action = (
      <Button
        data-primary=""
        data-testid="open-position"
        variant={side}
        className="h-10 w-full"
        disabled={!margin || Boolean(sizeError) || open.isPending || !status.open}
        onClick={submit}
      >
        {open.isPending ? "Placing order…" : side === "long" ? "Buy / Long" : "Sell / Short"}
      </Button>
    );
  }

  return (
    <section
      aria-label="Open a position"
      className={cn("flex min-w-0 flex-col gap-3 rounded-md border border-border bg-card p-3", className)}
    >
      <div className="grid grid-cols-2 gap-2">
        <span
          title="Isolated margin only: each position has its own margin, so a liquidation never touches your other positions or free margin."
          className="flex h-8 items-center justify-center rounded-md bg-muted text-ui text-foreground"
        >
          Isolated
        </span>
        <LeverageControl
          leverage={leverage}
          max={market.max_leverage}
          onChange={(next) => {
            setLeverageChoice(next);
            open.reset();
          }}
        />
      </div>

      <div className="flex border-b border-border">
        <span className="relative px-3 pb-2 text-ui text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-foreground">
          Market
        </span>
      </div>

      <SideToggle
        side={side}
        onChange={(next) => {
          setSide(next);
          open.reset();
        }}
      />

      <dl className="flex flex-col gap-1.5">
        <Row label="Available to Trade">
          <span data-testid="free-margin">{account ? formatUsd(freeMargin) : "—"}</span>
        </Row>
        <Row label="Current Position">
          {heldLong === 0n && heldShort === 0n ? (
            `0.00 ${market.id}`
          ) : (
            <>
              {heldLong > 0n ? <span className="text-success">Long {formatUsd(heldLong)}</span> : null}
              {heldLong > 0n && heldShort > 0n ? " · " : null}
              {heldShort > 0n ? <span className="text-destructive">Short {formatUsd(heldShort)}</span> : null}
            </>
          )}
        </Row>
      </dl>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="order-size"
          className="flex h-10 items-center gap-2 rounded-md border border-border bg-input px-3 focus-within:border-ring aria-invalid:border-destructive"
          aria-invalid={sizeError ? true : undefined}
        >
          <span className="text-ui text-tertiary">Size</span>
          <input
            id="order-size"
            name="order-size"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={sizeInput}
            aria-invalid={sizeError ? true : undefined}
            onChange={(event) => {
              setSizeInput(event.target.value);
              open.reset();
            }}
            className="min-w-0 flex-1 bg-transparent text-right text-ui text-foreground tabular-nums outline-none placeholder:text-tertiary"
          />
          <span className="text-ui text-foreground">USDC</span>
        </label>
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={percent}
              disabled={!trading || maxSize === 0n}
              aria-label="Size as a share of available margin × leverage"
              onChange={(event) => setSize((maxSize * BigInt(event.target.value)) / 100n / lev * lev)}
              className="h-5 w-full accent-foreground disabled:opacity-40"
            />
          </div>
          <div className="flex gap-1">
            {PERCENT_MARKS.slice(1).map((p) => (
              <button
                key={p}
                type="button"
                disabled={!trading || maxSize === 0n}
                onClick={() => setSize((maxSize * BigInt(p)) / 100n / lev * lev)}
                className="rounded-sm px-1 text-label text-tertiary tabular-nums transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              >
                {p}%
              </button>
            ))}
          </div>
        </div>
        {sizeError ? <FieldMessage tone="error">{sizeError}</FieldMessage> : null}
      </div>

      {action}

      {!status.open ? (
        <FieldMessage tone="error">{status.label}: this market takes no new positions right now.</FieldMessage>
      ) : null}
      {refusal ? (
        <div role="alert" data-testid="order-error" className="flex flex-col gap-2 rounded-md border border-destructive/50 p-3">
          <p className="text-ui text-destructive">{refusal.message}</p>
          {capUsdc !== undefined && capUsdc > 0n ? (
            <Button variant="outline" size="sm" className="w-fit" onClick={() => applyMaxSize(capUsdc)}>
              Use max size ({formatUsd(capUsdc, { maxFractionDigits: 0 })})
            </Button>
          ) : null}
        </div>
      ) : null}
      {preview.exceedsCap && preview.size > 0n ? (
        <p className="text-label text-warning">
          This size is above what NEAR Intents can absorb on exit right now; the contract will refuse it.
        </p>
      ) : null}

      <dl className="flex flex-col gap-1.5 border-t border-border pt-3">
        <Row label={<Term hint="Oracle price at which this position would be liquidated, from its margin after fees.">Liquidation Price</Term>}>
          {preview.size > 0n && preview.liquidationPrice > 0n ? formatPrice(preview.liquidationPrice) : "N/A"}
        </Row>
        <Row label="Order Value">{preview.size > 0n ? formatUsd(preview.size) : "N/A"}</Row>
        <Row label="Margin Required">{margin ? formatUsd(margin) : "N/A"}</Row>
        <Row label={<Term hint="Opening fee, paid to the vault. Closing charges the same rate.">Fees</Term>}>
          {preview.size > 0n ? `${formatUsd(preview.openFee)} · 0.10%` : "0.10%"}
        </Row>
        <Row label={<Term hint="Hourly borrow fee on the position size; it rises as this side's open interest nears its cap.">Borrow fee / h</Term>}>
          {borrowRatePercent(preview.borrowRatePerHour)}
        </Row>
        <Row
          label={<Term hint="Open interest this side can still take before the exit-liquidity cap.">Cap left ({side === "long" ? "longs" : "shorts"})</Term>}
          tone={preview.exceedsCap ? "warning" : undefined}
        >
          {formatUsd(preview.capRoom, { maxFractionDigits: 0 })}
        </Row>
      </dl>
    </section>
  );
}
