"use client";

import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FieldMessage } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { formatUnits, formatUsd, parseUnits, PRICE_DECIMALS } from "@/lib/near/format";
import type { MarginMode, Side } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import {
  bracketError,
  bracketPriceFromMove,
  moveBpsFromPrice,
  pnlAt,
  type BracketKind,
} from "./order-math";

const MODES: { id: MarginMode; label: string; text: string }[] = [
  {
    id: "isolated",
    label: "Isolated",
    text: "This position has its own margin. If it is liquidated, your other positions and free margin are untouched.",
  },
  {
    id: "cross",
    label: "Cross",
    text: "All your cross positions share one margin pool. Gains on one support the others; if the pool falls to its maintenance level, the riskiest positions are closed first.",
  },
];

/** "Isolated" / "Cross" button; the modal explains both before switching. */
export function MarginModeControl({ mode, onChange }: { mode: MarginMode; onChange: (mode: MarginMode) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(mode);
  return (
    <>
      <button
        type="button"
        data-testid="margin-mode"
        aria-label={`Margin mode ${mode}, change`}
        onClick={() => {
          setDraft(mode);
          setOpen(true);
        }}
        className="h-8 rounded-md bg-muted text-ui text-foreground capitalize transition-colors hover:bg-muted/70 focus-visible:outline-2 focus-visible:outline-ring"
      >
        {mode}
      </button>
      <Modal open={open} onOpenChange={setOpen} title="Margin Mode">
        <div role="radiogroup" aria-label="Margin mode" className="flex flex-col gap-2">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={draft === m.id}
              data-testid={`margin-mode-${m.id}`}
              onClick={() => setDraft(m.id)}
              className={cn(
                "flex flex-col gap-1 rounded-md border border-border p-3 text-left transition-colors hover:border-muted-foreground focus-visible:outline-2 focus-visible:outline-ring",
                draft === m.id && "border-foreground hover:border-foreground",
              )}
            >
              <span className="text-ui text-foreground">{m.label}</span>
              <span className="text-label text-muted-foreground">{m.text}</span>
            </button>
          ))}
        </div>
        <Button
          onClick={() => {
            onChange(draft);
            setOpen(false);
          }}
        >
          Use {draft}
        </Button>
      </Modal>
    </>
  );
}

/** Labelled input row in the ticket style: label left, value right-aligned, unit suffix. */
export function TicketInput({
  id,
  label,
  value,
  onChange,
  suffix,
  placeholder = "0.00",
  invalid,
  className,
}: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  suffix: ReactNode;
  placeholder?: string;
  invalid?: boolean;
  className?: string;
}) {
  return (
    <label
      htmlFor={id}
      aria-invalid={invalid ? true : undefined}
      className={cn(
        "flex h-10 min-w-0 items-center gap-2 rounded-md border border-border bg-input px-3 focus-within:border-ring aria-invalid:border-destructive",
        className,
      )}
    >
      <span className="shrink-0 text-ui text-tertiary">{label}</span>
      <input
        id={id}
        name={id}
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        aria-invalid={invalid ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 flex-1 bg-transparent text-right text-ui text-foreground tabular-nums outline-none placeholder:text-tertiary"
      />
      <span className="shrink-0 text-ui text-foreground">{suffix}</span>
    </label>
  );
}

export interface BracketDraft {
  price: string;
  move: string;
}

export const EMPTY_BRACKET: BracketDraft = { price: "", move: "" };

/** Parsed bracket: null price when the field is empty. */
export function readBracket(
  draft: BracketDraft,
  side: Side,
  kind: BracketKind,
  reference: bigint,
): { price: bigint | null; error: string | null } {
  if (draft.price.trim() === "") return { price: null, error: null };
  const price = parseUnits(draft.price, PRICE_DECIMALS);
  if (price === null) return { price: null, error: "Enter a price like 3.95." };
  if (reference === 0n) return { price, error: null };
  return { price, error: bracketError(side, kind, reference, price) };
}

/** Take profit / stop loss price with its distance from the entry in percent, both editable. */
function BracketField({
  kind,
  side,
  reference,
  size,
  draft,
  onChange,
}: {
  kind: BracketKind;
  side: Side;
  reference: bigint;
  size: bigint;
  draft: BracketDraft;
  onChange: (draft: BracketDraft) => void;
}) {
  const baseId = useId();
  const parsed = readBracket(draft, side, kind, reference);
  const label = kind === "take_profit" ? "TP Price" : "SL Price";
  const pnl =
    parsed.price !== null && parsed.error === null && size > 0n && reference > 0n
      ? pnlAt(side, size, reference, parsed.price)
      : null;

  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-2">
        <TicketInput
          id={`${baseId}-price`}
          label={label}
          value={draft.price}
          suffix="$"
          invalid={Boolean(parsed.error)}
          onChange={(price) => {
            const value = parseUnits(price, PRICE_DECIMALS);
            const move = value !== null && reference > 0n ? moveBpsFromPrice(reference, value) : null;
            onChange({ price, move: move === null || price.trim() === "" ? "" : formatUnits(move, 2, { grouping: false }) });
          }}
        />
        <TicketInput
          id={`${baseId}-move`}
          label={kind === "take_profit" ? "+" : "−"}
          value={draft.move}
          placeholder="0"
          suffix="%"
          onChange={(move) => {
            const bps = parseUnits(move, 2);
            const price = bps !== null && bps > 0n && reference > 0n ? bracketPriceFromMove(side, kind, reference, bps) : null;
            const text =
              price === null
                ? move.trim() === ""
                  ? ""
                  : draft.price
                : formatUnits(price, PRICE_DECIMALS, { grouping: false, maxFractionDigits: 6, minFractionDigits: 0 });
            onChange({ move, price: text });
          }}
        />
      </div>
      {parsed.error ? (
        <FieldMessage tone="error">{parsed.error}</FieldMessage>
      ) : pnl !== null ? (
        <p className="text-label text-tertiary tabular-nums">
          {kind === "take_profit" ? "Estimated gain" : "Estimated loss"} before fees:{" "}
          <span className={pnl >= 0n ? "text-success" : "text-destructive"}>{formatUsd(pnl, { signed: true })}</span>
        </p>
      ) : null}
    </div>
  );
}

/** Optional take profit and stop loss placed together with the entry. */
export function BracketFields({
  enabled,
  onToggle,
  side,
  reference,
  size,
  takeProfit,
  stopLoss,
  onTakeProfit,
  onStopLoss,
}: {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  side: Side;
  reference: bigint;
  size: bigint;
  takeProfit: BracketDraft;
  stopLoss: BracketDraft;
  onTakeProfit: (draft: BracketDraft) => void;
  onStopLoss: (draft: BracketDraft) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="flex w-fit cursor-pointer items-center gap-2 text-label text-muted-foreground">
        <input
          id={id}
          type="checkbox"
          data-testid="tpsl-toggle"
          checked={enabled}
          onChange={(event) => onToggle(event.target.checked)}
          className="size-3.5 accent-foreground"
        />
        Take Profit / Stop Loss
      </label>
      {enabled ? (
        <>
          <BracketField kind="take_profit" side={side} reference={reference} size={size} draft={takeProfit} onChange={onTakeProfit} />
          <BracketField kind="stop_loss" side={side} reference={reference} size={size} draft={stopLoss} onChange={onStopLoss} />
        </>
      ) : null}
    </div>
  );
}
