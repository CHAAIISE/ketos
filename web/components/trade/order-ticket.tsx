"use client";

import { useState, type ReactNode } from "react";
import { useNow } from "@/components/landing/live-time";
import { FundButton, useFundingDialog } from "@/components/app/funding";
import { Skeleton } from "@/components/app/states";
import { useTxToast } from "@/components/app/tx-toast";
import { Term } from "@/components/vault/term";
import { Button } from "@/components/ui/button";
import { FieldMessage } from "@/components/ui/input";
import { PanelTabs } from "@/components/ui/panel-tabs";
import { useNear, useWallet } from "@/hooks/near-provider";
import { useDepth, usePositions, type AccountSummary } from "@/hooks/use-ketos-queries";
import { useOpenPosition, usePlaceOrder } from "@/hooks/use-ketos-mutations";
import { toNearActionError } from "@/lib/near/errors";
import { formatPrice, formatUnits, formatUsd, formatUsdc, parseUnits, parseUsdc, PRICE_DECIMALS } from "@/lib/near/format";
import { entryFundingRequired, executionSlots, maxEntryMargin } from "@/lib/near/order-funding";
import { executionLimits } from "@/lib/near/execution";
import { signedPriceObservation, signedPricesFor } from "@/lib/near/signed-prices";
import type { MarginMode, Market, Side } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { isPriceFresh, marketDisplayStatus, marketLimitLabel, marketStatus } from "@/lib/near/market-status";
import type { TradeStep } from "./onboarding";
import { borrowRatePercent, entryTriggered, measuredImpactFee, MIN_POSITION_MARGIN, previewOrder, type EntryKind } from "./order-math";
import { BracketFields, EMPTY_BRACKET, readBracket, TicketInput, type BracketDraft } from "./ticket-controls";

function Row({ label, children, tone }: { label: ReactNode; children: ReactNode; tone?: "warning" }) {
  return <div className="flex items-baseline justify-between gap-3">
    <dt className="text-label text-tertiary">{label}</dt>
    <dd className={cn("text-right text-label tabular-nums text-foreground", tone === "warning" && "text-warning")}>{children}</dd>
  </div>;
}

const ENTRY_TABS = [
  { id: "market", label: "Market", testId: "order-type-market" },
  { id: "limit", label: "Limit", testId: "order-type-limit" },
] as const;
const KIND_LABEL = { limit: "Limit", stop_market: "Stop Market" } as const;

export function OrderTicket({ market, step, account, side, onSideChange, className }: {
  market: Market; step: TradeStep | null; account: AccountSummary | undefined; side: Side; onSideChange: (side: Side) => void; className?: string;
}) {
  const wallet = useWallet();
  const { config } = useNear();
  const funding = useFundingDialog();
  const open = useOpenPosition();
  const place = usePlaceOrder();
  const positions = usePositions();
  const depth = useDepth(market.id);
  const { track } = useTxToast();
  const nowMs = useNow();
  const [kind, setKind] = useState<EntryKind>("market");
  const [sizeInput, setSizeInput] = useState("");
  const [triggerInput, setTriggerInput] = useState("");
  const [leverageChoice, setLeverageChoice] = useState(5);
  const [marginModeChoice, setMarginMode] = useState<MarginMode>("isolated");
  const marginMode: MarginMode = market.isolated_only ? "isolated" : marginModeChoice;
  const [sourceChoice, setSourceChoice] = useState<"wallet" | "margin" | null>(null);
  const [bracketsOn, setBracketsOn] = useState(false);
  const [takeProfit, setTakeProfit] = useState<BracketDraft>(EMPTY_BRACKET);
  const [stopLoss, setStopLoss] = useState<BracketDraft>(EMPTY_BRACKET);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [toleranceBps, setToleranceBps] = useState(50);
  const [orderLifetimeMs, setOrderLifetimeMs] = useState(7 * 86_400_000);
  const [reviewedPrice, setReviewedPrice] = useState<Pick<Market, "id" | "price" | "price_timestamp_ms"> | null>(null);
  const [reviewingPrice, setReviewingPrice] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const reference = reviewedPrice?.id === market.id && reviewedPrice.price_timestamp_ms > market.price_timestamp_ms
    ? reviewedPrice : market;
  const referenceFresh = nowMs > 0 && isPriceFresh(reference, nowMs) && nowMs - reference.price_timestamp_ms <= 30_000;

  const isMarket = kind === "market";
  const mutation = isMarket ? open : place;
  const leverage = Math.min(Math.max(1, leverageChoice), market.max_leverage);
  const lev = BigInt(leverage);
  const sizeUnits = parseUsdc(sizeInput);
  const margin = sizeUnits === null ? null : sizeUnits / lev;
  const trigger = isMarket ? null : parseUnits(triggerInput, PRICE_DECIMALS);
  const entryPrice = isMarket ? (referenceFresh ? reference.price : 0n) : (trigger ?? 0n);
  const boundPreview = entryPrice > 0n
    ? executionLimits(entryPrice, side, false, kind === "limit" ? 0 : toleranceBps, nowMs + 120_000).limitPrice
    : null;
  const size = (margin ?? 0n) * lev;
  const samples = depth.data?.history.at(-1)?.samples;
  const impactFee = measuredImpactFee(size, samples ?? []);
  const preview = previewOrder(market, side, margin ?? 0n, leverage, entryPrice, impactFee);
  const status = marketStatus(market, nowMs);
  const displayStatus = marketDisplayStatus(market, nowMs);
  const freeMargin = account?.margin ?? 0n;
  const walletBalance = account?.usdcBalance ?? 0n;
  const available = freeMargin + walletBalance;
  const fundingSource = sourceChoice ?? (walletBalance > 0n ? "wallet" : "margin");
  const sourceBalance = fundingSource === "wallet" ? walletBalance : freeMargin;
  const trading = step === "trade";
  const tp = bracketsOn ? readBracket(takeProfit, side, "take_profit", entryPrice) : { price: null, error: null };
  const sl = bracketsOn ? readBracket(stopLoss, side, "stop_loss", entryPrice) : { price: null, error: null };
  const brackets = tp.price !== null || sl.price !== null ? { takeProfit: tp.price, stopLoss: sl.price } : undefined;
  const slots = executionSlots(!isMarket, brackets);
  const required = entryFundingRequired(margin ?? 0n, leverage, slots);
  const rewardReserve = required - (margin ?? 0n);
  const maxSize = maxEntryMargin(sourceBalance, leverage, slots) * lev;
  const percent = maxSize > 0n && sizeUnits !== null ? Math.min(100, Number((sizeUnits * 100n) / maxSize)) : 0;
  const heldAsset = positions.data?.filter((p) => p.market_id === market.id && p.side === side)
    .reduce((sum, p) => sum + p.size * 100_000_000n / p.entry_price, 0n);
  const sizeError = sizeInput.trim() === "" ? null
    : sizeUnits === null ? "Enter an amount like 500 or 125.50."
    : margin !== null && margin < MIN_POSITION_MARGIN ? `Minimum order: ${leverage} USDC at ${leverage}× (1 USDC margin).`
    : trading && required > sourceBalance ? `Needs ${formatUsd(required)} including keeper reservations; ${formatUsd(sourceBalance)} in ${fundingSource === "wallet" ? "your wallet" : "Ketos margin"}. Lower the amount or change the funding source.`
    : preview.openFee >= (margin ?? 0n) ? "Fees would consume this margin. Lower the leverage or choose a deeper market." : null;
  const triggerError = isMarket || triggerInput.trim() === "" ? null
    : trigger === null || trigger === 0n ? "Enter a price above zero." : null;
  const firesNow = !isMarket && trigger !== null && trigger > 0n && referenceFresh && entryTriggered(kind, side, trigger, reference.price);
  const refusal = mutation.error;
  const ready = status.open && entryPrice > 0n && Boolean(margin) && !sizeError && !tp.error && !sl.error && (isMarket || (trigger !== null && trigger > 0n));

  function resetResult() { open.reset(); place.reset(); setPriceError(null); }
  function setSize(units: bigint) {
    setSizeInput(units > 0n ? formatUsdc(units, { grouping: false, maxFractionDigits: 6, minFractionDigits: 0 }) : "");
    resetResult();
  }
  function applyMaxSize(capUnits: bigint) {
    setSize((trading && maxSize < capUnits ? maxSize : capUnits) / lev * lev);
  }
  async function refreshPrice() {
    if (reviewingPrice) return;
    setReviewingPrice(true);
    setPriceError(null);
    try {
      const signed = await signedPricesFor(config, { kind: "markets", markets: [market.id] });
      if (!signed) {
        setPriceError("Fresh price unavailable. No trade was submitted. Try again when the price service recovers.");
        return;
      }
      setReviewedPrice({ id: market.id, ...signedPriceObservation(signed, market.id) });
      resetResult();
    } catch {
      setPriceError("Price review failed. No trade was submitted. Try again.");
    } finally {
      setReviewingPrice(false);
    }
  }
  async function submit() {
    if (!margin || !ready) return;
    const submittedAt = Date.now();
    const restingExpiry = submittedAt + orderLifetimeMs;
    if (isMarket && (!isPriceFresh(reference, submittedAt) || submittedAt - reference.price_timestamp_ms > 30_000)) {
      await refreshPrice();
      return;
    }
    setPriceError(null);
    const execution = executionLimits(entryPrice, side, false, kind === "limit" ? 0 : toleranceBps,
      isMarket ? submittedAt + 120_000 : restingExpiry);
    const bracketBounds = brackets ? {
      takeProfit: tp.price ? executionLimits(tp.price, side, true, 0, restingExpiry) : null,
      stopLoss: sl.price ? executionLimits(sl.price, side, true, toleranceBps, restingExpiry) : null,
    } : undefined;
    const base = { marketId: market.id, side, margin, leverage, marginMode, brackets, fundingSource, execution, bracketBounds };
    const sideLabel = side === "long" ? "Long" : "Short";
    const done = isMarket || trigger === null
      ? await track(() => open.mutateAsync(base), {
          pending: `Opening ${side} ${market.id} ${leverage}×…`,
          success: `${sideLabel} ${market.id} ${leverage}× opened · ${formatUsd(preview.size)}`, errorInline: true,
        })
      : await track(() => place.mutateAsync({ ...base, kind, triggerPrice: trigger }), {
          pending: `Placing ${KIND_LABEL[kind].toLowerCase()} ${side} ${market.id}…`,
          success: `${KIND_LABEL[kind]} ${sideLabel.toLowerCase()} ${market.id} placed at ${formatPrice(trigger)}`,
          successDescription: () => fundingSource === "wallet"
            ? `${formatUsd(required)} reserved, including keeper rewards.`
            : `${formatUsd(entryFundingRequired(margin, leverage, 1))} reserved. Any TP/SL rewards need free margin at fill.`, errorInline: true,
        });
    if (done) { setSizeInput(""); setTakeProfit(EMPTY_BRACKET); setStopLoss(EMPTY_BRACKET); }
  }

  let action: ReactNode;
  if (step === null || (step !== "connect" && !account)) action = <Skeleton className="h-10 w-full" />;
  else if (step === "connect") action = <>
    <Button data-primary="" className="h-10 w-full" disabled={!wallet.isReady} onClick={async () => {
      setConnectError(null);
      try { await wallet.signIn(); } catch (e) { setConnectError(toNearActionError(e).message); }
    }}>{wallet.isReady ? "Sign in" : "Loading wallet…"}</Button>
    {(connectError ?? wallet.error) ? <FieldMessage tone="error">{connectError ?? wallet.error?.message}</FieldMessage> : null}
  </>;
  else if (step === "fund" && account) action = <FundButton account={account} prominent className="h-10 w-full" />;
  else if (isMarket && !referenceFresh) action = <Button data-primary="" data-testid="review-entry-price" className="h-10 w-full"
    disabled={!status.open || reviewingPrice || mutation.isPending} onClick={() => void refreshPrice()}>
    {reviewingPrice ? "Observing price… (up to 3 min)" : "Review fresh price"}
  </Button>;
  else action = <Button data-primary="" data-testid="open-position" variant={side} className="h-10 w-full"
    disabled={!ready || mutation.isPending} onClick={submit}>
    {mutation.isPending ? "Placing order…" : `${side === "long" ? "Long" : "Short"}${isMarket ? "" : ` · ${KIND_LABEL[kind]}`}`}
  </Button>;

  return <section id="order-ticket" tabIndex={-1} aria-label="Open a position" className={cn("flex min-h-0 min-w-0 scroll-mt-4 flex-col gap-2 rounded-lg border border-border bg-card p-3 focus-visible:outline-2 focus-visible:outline-ring lg:min-h-fit", className)}>
    <div className="flex min-h-0 flex-col gap-2 overflow-y-auto [&>*]:shrink-0 lg:contents">
    <fieldset disabled={!status.open || mutation.isPending || reviewingPrice} aria-describedby={!status.open ? "entry-unavailable" : undefined} className="contents">
      <div role="radiogroup" aria-label="Margin mode" className="grid grid-cols-2 gap-2">
        {(["isolated", "cross"] as const).map((mode) => <label key={mode}
          className={cn("flex h-8 cursor-pointer items-center justify-center rounded-md border border-border text-ui capitalize text-muted-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring", marginMode === mode && "bg-muted text-foreground", market.isolated_only && mode === "cross" && "cursor-not-allowed opacity-40")}>
          <input type="radio" name="entry-margin-mode" value={mode} checked={marginMode === mode} data-testid={`margin-mode-${mode}`} className="sr-only"
            disabled={market.isolated_only && mode === "cross"}
            onChange={() => { setMarginMode(mode); resetResult(); }} />{mode}
        </label>)}
      </div>
      {market.isolated_only ? <p className="text-label text-muted-foreground">Isolated margin only · this market has dedicated LP capital.</p> : null}
      <PanelTabs tabs={ENTRY_TABS} value={isMarket ? "market" : "limit"} onChange={(next) => {
        setKind(next);
        if (next !== "market" && triggerInput === "" && referenceFresh) setTriggerInput(formatUnits(reference.price, PRICE_DECIMALS, { grouping: false, maxFractionDigits: 6 }));
        resetResult();
      }} label="Order type" idPrefix="order-type" className="-mx-3" />
      <div role="radiogroup" aria-label="Side" className="grid grid-cols-2 rounded-md bg-muted p-1">
        {(["long", "short"] as const).map((s) => <label key={s} data-testid={`side-${s}`} className={cn("flex h-8 cursor-pointer items-center justify-center rounded-md text-ui text-muted-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring", side === s && (s === "long" ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"))}>
          <input type="radio" name="entry-side" value={s} checked={side === s} className="sr-only" onChange={() => { onSideChange(s); resetResult(); }} />
          {s === "long" ? "Long" : "Short"}
        </label>)}
      </div>
      <dl className="flex flex-col gap-1">
        <Row label={<Term hint="Wallet USDC plus free Ketos margin. Each order uses one source, selected below; reserved orders and cross collateral are excluded.">Available to Trade</Term>}>
          <span data-testid="free-margin">{account ? `${formatUsdc(available)} USDC` : "—"}</span>
        </Row>
        <Row label={side === "long" ? "Open Longs" : "Open Shorts"}>{heldAsset === undefined ? "—" : `${formatUnits(heldAsset, 6, { maxFractionDigits: 4 })} ${market.id}`}</Row>
        <Row label={<Term hint={market.price_timestamp_ms ? `Stored oracle mark. Updated ${new Date(market.price_timestamp_ms).toUTCString()}; this is not a current execution quote.` : "No oracle price stored yet."}>Stored Mark</Term>}>{market.price > 0n ? formatPrice(market.price) : "—"}</Row>
      </dl>
      <div className="flex flex-col gap-1">
        <label htmlFor="order-leverage" className="flex items-center justify-between text-label text-tertiary">
          <Term hint="Whole-number leverage, from 1× to this market's live maximum.">Leverage</Term>
          <span className="flex items-center rounded-md border border-border bg-input px-2 text-foreground">
            <input id="order-leverage" type="number" min={1} max={market.max_leverage} step={1} value={leverage} data-testid="leverage-value"
              onChange={(event) => { const value = Number(event.target.value); if (Number.isInteger(value)) setLeverageChoice(Math.min(market.max_leverage, Math.max(1, value))); resetResult(); }}
              className="h-7 w-10 bg-transparent text-right tabular-nums outline-none" />×
          </span>
        </label>
        <input type="range" min={1} max={market.max_leverage} step={1} value={leverage} aria-label="Leverage slider"
          onChange={(event) => { setLeverageChoice(Number(event.target.value)); resetResult(); }} className="h-5 w-full accent-foreground" />
        <div className="flex justify-between text-label text-tertiary">
          {[...new Set([1, ...[2, 5, 10].filter((n) => n < market.max_leverage), market.max_leverage])].map((n) => <button type="button" key={n} onClick={() => { setLeverageChoice(n); resetResult(); }} className="rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">{n}×</button>)}
        </div>
      </div>
      <dl><Row label={<Term hint="Estimated from the reviewed entry reference and opening fees. Cross liquidation depends on the whole pool, not one price.">Est. Liq. Price</Term>}>
        {marginMode === "cross" ? "Shared (cross)" : preview.size > 0n && preview.liquidationPrice > 0n ? formatPrice(preview.liquidationPrice) : "—"}
      </Row></dl>
      <div id="order-type-panel" role="tabpanel" aria-labelledby={`order-type-tab-${isMarket ? "market" : "limit"}`} className="flex flex-col gap-2">
        {!isMarket ? <>
          <label className="flex items-center justify-between text-label text-tertiary">Trigger
            <select aria-label="Entry trigger" value={kind} onChange={(event) => { setKind(event.target.value as EntryKind); resetResult(); }} className="rounded-md border border-border bg-input px-2 py-1 text-foreground">
              <option value="limit">Limit</option><option value="stop_market">Stop Market</option>
            </select>
          </label>
          <TicketInput id="order-trigger" label={kind === "limit" ? "Limit Price" : "Stop Price"} value={triggerInput} suffix="USD" invalid={Boolean(triggerError)} onChange={(v) => { setTriggerInput(v); resetResult(); }} />
          {triggerError ? <FieldMessage tone="error" role="status">{triggerError}</FieldMessage> : firesNow ? <p className="text-label text-warning">The stored mark is already past this trigger. It can fill on the next keeper run.</p> : null}
        </> : null}
        {freeMargin > 0n ? <label className="flex items-center justify-between text-label text-tertiary">Pay from
          <select aria-label="Order funding source" value={fundingSource} onChange={(event) => { setSourceChoice(event.target.value as "wallet" | "margin"); resetResult(); }} className="rounded-md border border-border bg-input px-2 py-1 text-foreground">
            <option value="wallet">Wallet · {formatUsd(walletBalance)}</option><option value="margin">Ketos margin · {formatUsd(freeMargin)}</option>
          </select>
        </label> : null}
        <div className="flex flex-col gap-1 rounded-md border border-border bg-input px-3 py-2 focus-within:border-ring">
          <div className="flex justify-between text-label text-tertiary"><label htmlFor="order-size">Position size</label>
            <button type="button" disabled={!trading || maxSize === 0n} onClick={() => setSize(maxSize)} className="text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40">Max</button>
          </div>
          <div className="flex items-center gap-2"><input id="order-size" name="order-size" inputMode="decimal" autoComplete="off" placeholder="0" value={sizeInput} aria-invalid={Boolean(sizeError)}
            onChange={(event) => { setSizeInput(event.target.value); resetResult(); }} className="min-w-0 flex-1 bg-transparent text-ui tabular-nums text-foreground outline-none placeholder:text-tertiary" /><span className="text-ui text-muted-foreground">USDC</span></div>
          <div className="flex items-center gap-3"><input type="range" min={0} max={100} step={1} value={percent} disabled={!trading || maxSize === 0n} aria-label="Amount percent"
            onChange={(event) => setSize(maxSize * BigInt(event.target.value) / 100n / lev * lev)} className="h-5 min-w-0 flex-1 accent-foreground disabled:opacity-40" />
            <span className="w-10 text-right text-label tabular-nums text-tertiary">{percent}%</span></div>
        </div>
        {sizeError ? <FieldMessage tone="error" role="status">{sizeError}</FieldMessage> : null}
        <BracketFields enabled={bracketsOn} onToggle={(v) => { setBracketsOn(v); resetResult(); }} side={side} reference={entryPrice} size={preview.size}
          takeProfit={takeProfit} stopLoss={stopLoss} onTakeProfit={(v) => { setTakeProfit(v); resetResult(); }} onStopLoss={(v) => { setStopLoss(v); resetResult(); }} />
        {kind !== "limit" || bracketsOn ? <label className="flex items-center justify-between text-label text-tertiary">Price tolerance
          <select aria-label="Price tolerance" value={toleranceBps} onChange={(event) => { setToleranceBps(Number(event.target.value)); resetResult(); }} className="rounded-md border border-border bg-input px-2 py-1 text-foreground">
            {[10, 50, 100, 200].map((bps) => <option key={bps} value={bps}>{bps / 100}%</option>)}
          </select>
        </label> : null}
        {!isMarket || bracketsOn ? <label className="flex items-center justify-between text-label text-tertiary">Order / TP/SL expiry
          <select aria-label="Order expiry" value={orderLifetimeMs} onChange={(event) => { setOrderLifetimeMs(Number(event.target.value)); resetResult(); }} className="rounded-md border border-border bg-input px-2 py-1 text-foreground">
            <option value={3_600_000}>1 hour</option><option value={86_400_000}>24 hours</option><option value={7 * 86_400_000}>7 days</option>
          </select>
        </label> : null}
      </div>
    </fieldset>
    <dl className="flex flex-col gap-1">
      <Row label={<Term hint="Onchain maximum for buys or minimum for sells, excluding fees. Limit orders never fill worse than their limit. A market authorization expires two minutes after submission.">Execution {side === "long" ? "ceiling" : "floor"}</Term>}>{boundPreview === null ? "—" : formatPrice(boundPreview)}</Row>
      <Row label="Order Value">{formatUsd(preview.size)}</Row>
      <Row label="Margin Required">{formatUsd(margin ?? 0n)}</Row>
      <Row label="Est. Entry Price">{entryPrice > 0n ? formatPrice(entryPrice) : "—"}</Row>
      <Row label={<Term hint="Trading fee plus measured impact fee, paid from margin. Based on the latest stored depth; execution rechecks it.">Fees</Term>}>{size > 0n ? formatUsd(preview.openFee) : "—"}</Row>
      {slots > 0 ? <Row label={<Term hint="Separate collateral: 5 bps of order value, minimum 0.10 USDC per entry/TP/SL. Wallet entries reserve all rewards now. A resting order using Ketos margin reserves its TP/SL rewards only at fill; keep that margin available. Unused reservations are refundable.">Keeper budget</Term>}>{formatUsd(rewardReserve)}</Row> : null}
    </dl>
    <div className="flex flex-col gap-2 lg:order-2">
    {step === "connect" ? <p data-testid="step-hint" className="text-label text-muted-foreground">Sign in, fund your wallet, then trade in one confirmation.</p>
      : step === "fund" ? <p data-testid="step-hint" className="text-label text-muted-foreground">Get 1,000 USDC plus gas if needed. Funding needs no wallet signature.</p>
      : <p className="text-label text-tertiary">{fundingSource === "wallet" ? "One confirmation · USDC moves directly from your wallet. Unused funds return automatically." : "One confirmation · uses your existing Ketos margin."}</p>}
    {!isMarket || bracketsOn ? <p data-testid="keeper-note" className="text-label text-tertiary">Bounded execution · finite expiry. Price gaps can reject TP/SL; a fill is never guaranteed.</p>
      : <p className="text-label text-tertiary">Expires in 2 minutes · fees excluded from price tolerance.</p>}
    {!status.open ? <FieldMessage tone="error" role="status"><span id="entry-unavailable" data-testid="entry-unavailable">{status.label}: order entry is disabled. Choose another market or wait for capacity to recover. Existing positions can still be closed.</span></FieldMessage>
      : isMarket && !referenceFresh ? <p role="status" data-testid="close-only-notice" className="text-label text-warning">Review a fresh signed price before placing this market order. The request is sponsored; it does not submit a trade.</p>
      : !displayStatus.open ? <p role="status" data-testid="close-only-notice" className="text-label text-warning">Execution requires a fresh observation no older than 30 seconds.</p> : null}
    {priceError && !referenceFresh ? <FieldMessage tone="error" role="status"><span data-testid="price-review-error">{priceError}</span></FieldMessage> : null}
    {refusal ? <div role="status" data-testid="order-error" className="flex flex-col gap-2 rounded-md border border-destructive/50 p-3">
      <p className="text-ui text-destructive">{refusal.message}</p>
      {refusal.capUsdc !== undefined && refusal.capUsdc > 0n ? <Button variant="outline" size="sm" className="w-fit" onClick={() => applyMaxSize(refusal.capUsdc!)}>Use max size ({formatUsd(refusal.capUsdc, { maxFractionDigits: 0 })})</Button> : null}
    </div> : null}
    {preview.exceedsCap && preview.size > 0n ? <p role="status" className="text-label text-warning">This size exceeds the effective cap ({marketLimitLabel(market).toLowerCase()}); the contract will refuse it{isMarket ? "." : " unless capacity recovers before execution."}</p> : null}
    <details className="border-t border-border pt-2 text-label text-tertiary"><summary className="cursor-pointer hover:text-foreground">Execution details</summary>
      <dl className="mt-2 flex flex-col gap-1"><Row label="Borrow fee / h">{borrowRatePercent(preview.borrowRatePerHour)}</Row><Row label={`Cap left · ${marketLimitLabel(market)}`} tone={preview.exceedsCap ? "warning" : undefined}>{formatUsd(preview.capRoom, { maxFractionDigits: 0 })}</Row></dl>
      <p className="mt-2">{samples ? "Impact fees follow the latest measured curve." : "Depth unavailable: fee estimate uses the conservative 1% fallback."} Amount is the position&apos;s USDC order value; margin is amount ÷ leverage. Wallet and Ketos margin cannot be combined in one order.</p>
      <button type="button" onClick={() => funding.open("deposit")} className="mt-2 underline underline-offset-4 hover:text-foreground">Advanced: move wallet USDC to Ketos margin</button>
    </details>
    </div>
    </div>
    <div className="shrink-0 border-t border-border pt-2 lg:order-1 lg:border-0 lg:pt-0">{action}</div>
  </section>;
}
