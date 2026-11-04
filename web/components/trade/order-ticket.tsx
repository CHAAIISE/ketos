"use client";

import { useState, type ReactNode } from "react";
import { useNow } from "@/components/landing/live-time";
import { FundButton, useFundingDialog } from "@/components/app/funding";
import { Skeleton } from "@/components/app/states";
import { useTxToast } from "@/components/app/tx-toast";
import { Term } from "@/components/vault/term";
import { Button } from "@/components/ui/button";
import { FieldMessage } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PanelTabs } from "@/components/ui/panel-tabs";
import { useWallet } from "@/hooks/near-provider";
import { usePositions, type AccountSummary } from "@/hooks/use-ketos-queries";
import { useOpenPosition, usePlaceOrder } from "@/hooks/use-ketos-mutations";
import { toNearActionError } from "@/lib/near/errors";
import { formatPrice, formatUnits, formatUsd, formatUsdc, parseUnits, parseUsdc, PRICE_DECIMALS } from "@/lib/near/format";
import type { MarginMode, Market, Side } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { marketStatus } from "./market-status";
import type { TradeStep } from "./onboarding";
import { borrowRatePercent, entryTriggered, MIN_POSITION_MARGIN, previewOrder, type EntryKind } from "./order-math";
import { BracketFields, EMPTY_BRACKET, MarginModeControl, readBracket, TicketInput, type BracketDraft } from "./ticket-controls";

const PERCENT_MARKS = [0, 25, 50, 75, 100];

/** One line under the ticket's main action telling a new user what it does for them. */
const STEP_HINT: Record<Exclude<TradeStep, "trade">, string> = {
  connect: "Connect a NEAR wallet to start. Markets stay readable without one.",
  fund: "You need USDC to trade. It's free: 1,000 USDC once an hour.",
  deposit: "Move USDC from your wallet into your margin account to back positions.",
};

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

const ENTRY_TABS = [
  { id: "market", label: "Market", testId: "order-type-market" },
  { id: "limit", label: "Limit", testId: "order-type-limit" },
  { id: "stop_market", label: "Stop", testId: "order-type-stop" },
] as const satisfies readonly { id: EntryKind; label: string; testId: string }[];

const KIND_LABEL: Record<Exclude<EntryKind, "market">, string> = { limit: "Limit", stop_market: "Stop Market" };

/** Order panel for one market: type, side, size in USDC, leverage, margin mode, TP/SL, preview. */
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
  const place = usePlaceOrder();
  const positions = usePositions();
  const { track } = useTxToast();
  const nowMs = useNow();
  const [kind, setKind] = useState<EntryKind>("market");
  const [side, setSide] = useState<Side>("long");
  const [sizeInput, setSizeInput] = useState("");
  const [triggerInput, setTriggerInput] = useState("");
  const [leverageChoice, setLeverageChoice] = useState(5);
  const [marginMode, setMarginMode] = useState<MarginMode>("isolated");
  const [bracketsOn, setBracketsOn] = useState(false);
  const [takeProfit, setTakeProfit] = useState<BracketDraft>(EMPTY_BRACKET);
  const [stopLoss, setStopLoss] = useState<BracketDraft>(EMPTY_BRACKET);
  const [connectError, setConnectError] = useState<string | null>(null);

  const isMarket = kind === "market";
  const mutation = isMarket ? open : place;
  const leverage = Math.min(Math.max(1, leverageChoice), market.max_leverage);
  const lev = BigInt(leverage);
  const sizeUnits = parseUsdc(sizeInput);
  // The contract takes margin and leverage; the order value is margin × leverage.
  const margin = sizeUnits === null ? null : sizeUnits / lev;
  const trigger = isMarket ? null : parseUnits(triggerInput, PRICE_DECIMALS);
  // Brackets and the liquidation preview refer to where the position will be entered.
  const entryPrice = isMarket ? market.price : (trigger ?? 0n);
  const preview = previewOrder(market, side, margin ?? 0n, leverage, entryPrice);
  const status = marketStatus(market, nowMs);
  const freeMargin = account?.margin ?? 0n;
  const maxSize = freeMargin * lev;
  const trading = step === "trade";
  const percent = maxSize > 0n && sizeUnits !== null ? Math.min(100, Number((sizeUnits * 100n) / maxSize)) : 0;
  const held = (positions.data ?? []).filter((p) => p.market_id === market.id);
  const heldLong = held.filter((p) => p.side === "long").reduce((sum, p) => sum + p.size, 0n);
  const heldShort = held.filter((p) => p.side === "short").reduce((sum, p) => sum + p.size, 0n);

  const tp = bracketsOn ? readBracket(takeProfit, side, "take_profit", entryPrice) : { price: null, error: null };
  const sl = bracketsOn ? readBracket(stopLoss, side, "stop_loss", entryPrice) : { price: null, error: null };
  const bracketsInvalid = Boolean(tp.error ?? sl.error);

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
  const triggerError =
    isMarket || triggerInput.trim() === ""
      ? null
      : trigger === null || trigger === 0n
        ? "Enter a price like 3.95."
        : null;
  const firesNow =
    !isMarket && trigger !== null && trigger > 0n && market.price > 0n && entryTriggered(kind, side, trigger, market.price);

  const refusal = mutation.error;
  const capUsdc = refusal?.capUsdc;

  function resetResult() {
    open.reset();
    place.reset();
  }

  function setSize(units: bigint) {
    setSizeInput(units > 0n ? formatUsdc(units, { grouping: false }) : "");
    resetResult();
  }

  function applyMaxSize(capUnits: bigint) {
    // Largest whole multiple of the leverage that fits under the cap and the free margin.
    const fitted = (capUnits < maxSize || !trading ? capUnits : maxSize) / lev;
    setSize(fitted * lev);
  }

  const ready =
    Boolean(margin) && !sizeError && !bracketsInvalid && (isMarket ? status.open : trigger !== null && trigger > 0n);

  async function submit() {
    if (!margin || !ready) return;
    const brackets = tp.price !== null || sl.price !== null ? { takeProfit: tp.price, stopLoss: sl.price } : undefined;
    const sideLabel = side === "long" ? "Long" : "Short";
    const base = { marketId: market.id, side, margin, leverage, marginMode, brackets };
    const done =
      isMarket || trigger === null
        ? await track(() => open.mutateAsync(base), {
            pending: `Opening ${side} ${market.id} ${leverage}×…`,
            success: `${sideLabel} ${market.id} ${leverage}× opened · ${formatUsd(preview.size)}`,
            errorInline: true,
          })
        : await track(() => place.mutateAsync({ ...base, kind, triggerPrice: trigger }), {
            pending: `Placing ${KIND_LABEL[kind].toLowerCase()} ${side} ${market.id} at ${formatPrice(trigger)}…`,
            success: `${KIND_LABEL[kind]} ${sideLabel.toLowerCase()} ${market.id} placed at ${formatPrice(trigger)}`,
            successDescription: () => `${formatUsd(margin)} of margin reserved until it fills or you cancel it.`,
            errorInline: true,
          });
    if (done) {
      setSizeInput("");
      setTakeProfit(EMPTY_BRACKET);
      setStopLoss(EMPTY_BRACKET);
    }
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
  } else if (step === "fund" && account) {
    action = <FundButton account={account} prominent className="h-10 w-full" />;
  } else if (!trading) {
    action = (
      <Button data-primary="" className="h-10 w-full" onClick={() => funding.open("deposit")}>
        Deposit margin
      </Button>
    );
  } else {
    const verb = side === "long" ? "Buy / Long" : "Sell / Short";
    action = (
      <Button
        data-primary=""
        data-testid="open-position"
        variant={side}
        className="h-10 w-full"
        disabled={!ready || mutation.isPending}
        onClick={submit}
      >
        {mutation.isPending ? "Placing order…" : isMarket ? verb : `Place ${KIND_LABEL[kind]} · ${verb}`}
      </Button>
    );
  }

  const keeperNote = (
    <p data-testid="keeper-note" className="text-label text-tertiary">
      Executed at oracle price by the keeper once the oracle {kind === "limit" ? "reaches" : "crosses"} your price. No
      price guarantee; the exit-liquidity cap is checked again at execution.
    </p>
  );

  return (
    <section
      aria-label="Open a position"
      className={cn("flex min-w-0 flex-col gap-3 rounded-md border border-border bg-card p-3", className)}
    >
      <div className="grid grid-cols-2 gap-2">
        <MarginModeControl
          mode={marginMode}
          onChange={(next) => {
            setMarginMode(next);
            resetResult();
          }}
        />
        <LeverageControl
          leverage={leverage}
          max={market.max_leverage}
          onChange={(next) => {
            setLeverageChoice(next);
            resetResult();
          }}
        />
      </div>

      <PanelTabs
        tabs={ENTRY_TABS}
        value={kind}
        onChange={(next) => {
          setKind(next);
          if (next !== "market" && triggerInput === "" && market.price > 0n) {
            setTriggerInput(formatUnits(market.price, PRICE_DECIMALS, { grouping: false, maxFractionDigits: 4 }));
          }
          resetResult();
        }}
        label="Order type"
        idPrefix="order-type"
        className="-mx-3"
      />

      <SideToggle
        side={side}
        onChange={(next) => {
          setSide(next);
          resetResult();
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

      <div id="order-type-panel" role="tabpanel" aria-labelledby={`order-type-tab-${kind}`} className="flex flex-col gap-2">
        {!isMarket ? (
          <>
            <TicketInput
              id="order-trigger"
              label={kind === "limit" ? "Limit Price" : "Stop Price"}
              value={triggerInput}
              suffix="USD"
              invalid={Boolean(triggerError)}
              onChange={(value) => {
                setTriggerInput(value);
                resetResult();
              }}
            />
            {triggerError ? (
              <FieldMessage tone="error">{triggerError}</FieldMessage>
            ) : firesNow ? (
              <p className="text-label text-warning">
                The oracle price {formatPrice(market.price)} is already past this price: the keeper fills it on its next run.
              </p>
            ) : null}
          </>
        ) : null}
        <TicketInput
          id="order-size"
          label="Size"
          value={sizeInput}
          suffix="USDC"
          invalid={Boolean(sizeError)}
          onChange={(value) => {
            setSizeInput(value);
            resetResult();
          }}
        />
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

        <BracketFields
          enabled={bracketsOn}
          onToggle={(next) => {
            setBracketsOn(next);
            resetResult();
          }}
          side={side}
          reference={entryPrice}
          size={preview.size}
          takeProfit={takeProfit}
          stopLoss={stopLoss}
          onTakeProfit={(draft) => {
            setTakeProfit(draft);
            resetResult();
          }}
          onStopLoss={(draft) => {
            setStopLoss(draft);
            resetResult();
          }}
        />
      </div>

      {action}
      {step !== null && step !== "trade" ? (
        <p data-testid="step-hint" className="text-label text-muted-foreground">
          {STEP_HINT[step]}
        </p>
      ) : null}
      {!isMarket || bracketsOn ? keeperNote : null}

      {isMarket && !status.open ? (
        <FieldMessage tone="error">{status.label}: this market takes no new positions right now.</FieldMessage>
      ) : null}
      {!isMarket && !status.open ? (
        <p className="text-label text-warning">
          {status.label}: the order waits onchain, but it is refused at execution while the market stays closed.
        </p>
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
          This size is above what NEAR Intents can absorb on exit right now; the contract will refuse it
          {isMarket ? "" : " unless the cap grows before the order fills"}.
        </p>
      ) : null}

      <dl className="flex flex-col gap-1.5 border-t border-border pt-3">
        <Row
          label={
            <Term
              hint={
                marginMode === "cross"
                  ? "Cross positions have no price of their own: the whole cross pool is liquidated when its equity falls to its maintenance margin."
                  : "Oracle price at which this position would be liquidated, from its margin after fees."
              }
            >
              Liquidation Price
            </Term>
          }
        >
          {marginMode === "cross"
            ? "Shared (cross)"
            : preview.size > 0n && preview.liquidationPrice > 0n
              ? formatPrice(preview.liquidationPrice)
              : "N/A"}
        </Row>
        <Row label="Order Value">{preview.size > 0n ? formatUsd(preview.size) : "N/A"}</Row>
        <Row label={isMarket ? "Margin Required" : "Margin Reserved"}>{margin ? formatUsd(margin) : "N/A"}</Row>
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
