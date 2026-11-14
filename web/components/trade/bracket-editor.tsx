"use client";

import { useState } from "react";
import { useTxToast } from "@/components/app/tx-toast";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useAccount } from "@/hooks/use-ketos-queries";
import { useAmendBrackets, useDepositMargin } from "@/hooks/use-ketos-mutations";
import { executionLimits } from "@/lib/near/execution";
import { formatPrice, formatUnits, formatUsd, parseUnits, PRICE_DECIMALS } from "@/lib/near/format";
import { executionReward } from "@/lib/near/order-funding";
import type { Order, Position } from "@/lib/near/types";

export interface BracketProposal { kind: "takeProfit" | "stopLoss"; price: bigint }

/** The reviewed order IDs stay fixed while the user edits; the contract rejects races. */
export function BracketEditor({ position, orders, proposal, onClose }: {
  position: Position; orders: readonly Order[]; proposal?: BracketProposal; onClose: () => void;
}) {
  const account = useAccount();
  const amend = useAmendBrackets();
  const deposit = useDepositMargin();
  const { track } = useTxToast();
  const existing = (id: number | null) => orders.find((order) => order.id === id);
  const initial = (kind: BracketProposal["kind"], id: number | null) => {
    const price = proposal?.kind === kind ? proposal.price : existing(id)?.request.trigger_price;
    return price == null ? "" : formatUnits(price, PRICE_DECIMALS, { maxFractionDigits: PRICE_DECIMALS });
  };
  const [takeProfit, setTakeProfit] = useState(() => initial("takeProfit", position.take_profit));
  const [stopLoss, setStopLoss] = useState(() => initial("stopLoss", position.stop_loss));
  const [tolerance, setTolerance] = useState(50);
  const [days, setDays] = useState(7);
  const [toWallet, setToWallet] = useState(true);
  const pending = amend.isPending || deposit.isPending;
  const tp = takeProfit.trim() ? parseUnits(takeProfit, PRICE_DECIMALS) : null;
  const sl = stopLoss.trim() ? parseUnits(stopLoss, PRICE_DECIMALS) : null;
  const oldSlots = Number(position.take_profit !== null) + Number(position.stop_loss !== null);
  const newSlots = Number(tp !== null) + Number(sl !== null);
  const reserved = executionReward(position.size) * BigInt(oldSlots);
  const required = executionReward(position.size) * BigInt(newSlots);
  const additional = required > reserved ? required - reserved : 0n;
  const shortfall = additional > (account.data?.margin ?? 0n) ? additional - (account.data?.margin ?? 0n) : 0n;
  const released = reserved > required ? reserved - required : 0n;
  const missingOrders = (position.take_profit !== null && !existing(position.take_profit)) ||
    (position.stop_loss !== null && !existing(position.stop_loss));
  const error = missingOrders ? "Existing orders are unavailable. Close and reopen after they refresh."
    : (takeProfit.trim() && (tp === null || tp <= 0n)) || (stopLoss.trim() && (sl === null || sl <= 0n))
      ? "Enter positive prices with at most 8 decimal places."
      : newSlots > 0 && (!Number.isInteger(days) || days < 1 || days > 30) ? "Choose an expiry from 1 to 30 days."
      : tp !== null && (position.side === "long" ? tp <= position.mark_price : tp >= position.mark_price)
        ? "Take profit must be beyond the current mark in the profitable direction."
        : sl !== null && (position.side === "long" ? sl >= position.mark_price : sl <= position.mark_price)
          ? "Stop loss must be beyond the current mark in the loss direction."
          : shortfall > (account.data?.usdcBalance ?? 0n) ? "Insufficient wallet USDC for the additional keeper reward."
            : null;
  const submit = async () => {
    if (error || pending || !account.data) return;
    if (shortfall > 0n) {
      const funded = await track(() => deposit.mutateAsync(shortfall), {
        pending: "Reserving additional keeper reward…", success: "Reward funded. Confirm the TP/SL replacement next.",
      });
      if (!funded) return;
    }
    const expiresAtMs = Date.now() + days * 86_400_000;
    const result = await track(() => amend.mutateAsync({
      positionId: position.id,
      expected: { takeProfit: position.take_profit, stopLoss: position.stop_loss },
      brackets: { takeProfit: tp, stopLoss: sl },
      execution: {
        takeProfit: tp === null ? null : executionLimits(tp, position.side, true, tolerance, expiresAtMs),
        stopLoss: sl === null ? null : executionLimits(sl, position.side, true, tolerance, expiresAtMs),
      },
      toWallet,
    }), { pending: "Replacing TP/SL atomically…", success: newSlots === 0 ? "TP/SL removed; position remains open." : "TP/SL replaced onchain." });
    if (result) onClose();
  };
  const inputClass = "mt-1 h-10 w-full rounded-md border border-border bg-input px-3 text-ui text-foreground";
  return <Modal open onOpenChange={(open) => { if (!open && !pending) onClose(); }} title={`${position.market_id} · Edit TP/SL`}>
    <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <p className="text-label text-muted-foreground">{position.side === "long" ? "Long" : "Short"} · Mark {formatPrice(position.mark_price)}. Leave a price blank to remove that exit.</p>
      <label className="text-label text-success">Take profit price
        <input aria-label="Take profit price" inputMode="decimal" value={takeProfit} disabled={pending} onChange={(event) => setTakeProfit(event.target.value)} className={inputClass} />
      </label>
      <label className="text-label text-destructive">Stop loss price
        <input aria-label="Stop loss price" inputMode="decimal" value={stopLoss} disabled={pending} onChange={(event) => setStopLoss(event.target.value)} className={inputClass} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-label">Trigger price tolerance
          <select aria-label="Bracket price tolerance" value={tolerance} disabled={pending} onChange={(event) => setTolerance(Number(event.target.value))} className={inputClass}>
            {[10, 50, 100, 200].map((bps) => <option key={bps} value={bps}>{bps / 100}%</option>)}
          </select>
        </label>
        <label className="text-label">Expiry (days)
          <input aria-label="Bracket expiry days" type="number" min={1} max={30} value={days} disabled={pending} onChange={(event) => setDays(Number(event.target.value))} className={inputClass} />
        </label>
      </div>
      <p className="text-label text-muted-foreground">Keeper reserve: {formatUsd(reserved)} → {formatUsd(required)}. {shortfall > 0n ? `${formatUsd(shortfall)} from your wallet; two confirmations. If the second is cancelled, those funds remain withdrawable as free margin.` : "Existing rewards are reused; one confirmation."}</p>
      {released > 0n ? <label className="flex gap-2 text-label"><input type="checkbox" checked={toWallet} disabled={pending} onChange={(event) => setToWallet(event.target.checked)} />Return {formatUsd(released)} released reward to wallet</label> : null}
      <p className="text-label text-muted-foreground">Both exits change together. Execution outside your price bound is refused; gaps can leave a stop unfilled. Fees are additional. A changed position or order can invalidate this review.</p>
      {error ? <p role="alert" className="text-label text-destructive">{error}</p> : null}
      <Button type="submit" disabled={pending || !!error || !account.data}>{pending ? "Confirming…" : newSlots === 0 ? "Confirm removal" : "Confirm TP/SL"}</Button>
    </form>
  </Modal>;
}
