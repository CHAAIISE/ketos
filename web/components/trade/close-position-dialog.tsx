"use client";

import { useState } from "react";
import { useTxToast } from "@/components/app/tx-toast";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useClosePosition, useReducePosition } from "@/hooks/use-ketos-mutations";
import { useDepth, useMarkets } from "@/hooks/use-ketos-queries";
import { executionLimits, IMMEDIATE_EXECUTION_MS } from "@/lib/near/execution";
import { formatPrice, formatUsd, formatUsdc, parseUsdc } from "@/lib/near/format";
import { executionReward } from "@/lib/near/order-funding";
import type { Position } from "@/lib/near/types";
import { measuredImpactFee, MIN_POSITION_MARGIN, tradeFee } from "./order-math";

/** The reviewed position size stays fixed until the contract accepts or rejects the authorization. */
export function ClosePositionDialog({ position, onClose }: { position: Position; onClose: () => void }) {
  const close = useClosePosition();
  const reduce = useReducePosition();
  const { track } = useTxToast();
  const markets = useMarkets();
  const depth = useDepth(position.market_id);
  const market = markets.data?.find((candidate) => candidate.id === position.market_id);
  const [amount, setAmount] = useState(() => formatUsdc(position.size, { maxFractionDigits: 6, grouping: false }));
  const [tolerance, setTolerance] = useState(50);
  const [keepOnKetos, setKeepOnKetos] = useState(false);
  const pending = close.isPending || reduce.isPending;
  const parsed = parseUsdc(amount);
  const size = parsed !== null && parsed > 0n && parsed <= position.size ? parsed : 0n;
  const full = size === position.size;
  const remaining = position.size - size;
  const collateral = position.margin * size / position.size;
  const cross = position.margin_mode === "cross";
  const dust = size > 0n && !full && (cross ? remaining : position.margin - collateral) < MIN_POSITION_MARGIN;
  const error = size === 0n ? "Enter a positive size no larger than this position."
    : dust ? "This leaves less than the minimum. Close less, or select 100%." : null;
  const ceilShare = (value: bigint) => (value * size + position.size - 1n) / position.size;
  const pnl = position.unrealized_pnl >= 0n ? position.unrealized_pnl * size / position.size : -ceilShare(-position.unrealized_pnl);
  const accrued = ceilShare(position.borrow_fee) + ceilShare(position.funding_paid) - position.funding_received * size / position.size;
  const fee = market ? tradeFee(size, market.fee_bps) + measuredImpactFee(size, depth.data?.history.at(-1)?.samples ?? []) : null;
  const settlement = fee === null ? null : collateral + pnl - accrued - fee;
  const slots = BigInt(Number(position.take_profit !== null) + Number(position.stop_loss !== null));
  const rewardRefund = slots * (executionReward(position.size) - (full ? 0n : executionReward(remaining)));
  const estimate = settlement === null ? null : (settlement > 0n ? settlement : 0n) + rewardRefund;
  const submit = async () => {
    if (error || pending || !market || !depth.isSuccess) return;
    const common = { positionId: position.id, toWallet: !keepOnKetos,
      execution: executionLimits(position.mark_price, position.side, true, tolerance, Date.now() + IMMEDIATE_EXECUTION_MS) };
    const result = await track(() => full ? close.mutateAsync(common) : reduce.mutateAsync({
      ...common, expectedSize: position.size, size, marginMode: position.margin_mode,
    }), {
      pending: `${full ? "Closing" : "Reducing"} ${position.side} ${position.market_id}…`,
      success: (receipt) => `${position.side === "long" ? "Long" : "Short"} ${position.market_id} ${full ? "closed" : "reduced"} · ${receipt.payout === null
        ? "settled; check your balances" : `${formatUsd(receipt.payout)} ${keepOnKetos ? "kept on Ketos" : "returned to wallet"}`}`,
    });
    if (result) onClose();
  };
  return <Modal open onOpenChange={(open) => { if (!open && !pending) onClose(); }} title={`${position.market_id} · Close position`}>
    <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <p className="text-label text-muted-foreground">{position.side === "long" ? "Long" : "Short"} · {position.margin_mode} · reviewed mark {formatPrice(position.mark_price)}</p>
      <label className="text-label text-muted-foreground">Close size (USDC notional)
        <input aria-label="Close size (USDC notional)" inputMode="decimal" value={amount} disabled={pending}
          onChange={(event) => setAmount(event.target.value)} className="mt-1 h-10 w-full rounded-md border border-border bg-input px-3 text-ui text-foreground" />
      </label>
      <div className="grid grid-cols-4 gap-2">{[25, 50, 75, 100].map((percent) => <Button key={percent} type="button" variant="outline" size="sm" disabled={pending}
        onClick={() => setAmount(formatUsdc(position.size * BigInt(percent) / 100n, { maxFractionDigits: 6, grouping: false }))}>{percent}%</Button>)}</div>
      <dl className="grid grid-cols-2 gap-2 text-label tabular-nums">
        <dt className="text-muted-foreground">Remaining notional</dt><dd className="text-right">{formatUsd(remaining)}</dd>
        <dt className="text-muted-foreground">Collateral released from leg</dt><dd className="text-right">{formatUsd(collateral)}</dd>
        <dt className="text-muted-foreground">Estimated closing fee</dt><dd className="text-right">{fee === null ? "—" : formatUsd(fee)}</dd>
        <dt className="text-muted-foreground">Accrued borrow / net funding</dt><dd className="text-right">{formatUsd(accrued)}</dd>
        <dt className="text-muted-foreground">Keeper reward refund</dt><dd className="text-right">{formatUsd(rewardRefund)}</dd>
        {!cross ? <><dt className="text-muted-foreground">Estimated proceeds</dt><dd className="text-right">{estimate === null ? "—" : formatUsd(estimate)}</dd></> : null}
      </dl>
      <label className="flex items-center justify-between text-label text-muted-foreground">Close price tolerance
        <select aria-label="Close price tolerance" value={tolerance} disabled={pending} onChange={(event) => setTolerance(Number(event.target.value))}
          className="rounded-md border border-border bg-input px-2 py-1 text-foreground">{[10, 50, 100, 200].map((bps) => <option key={bps} value={bps}>{bps / 100}%</option>)}</select>
      </label>
      <label className="flex items-center gap-2 text-label text-muted-foreground"><input type="checkbox" checked={keepOnKetos} disabled={pending}
        onChange={(event) => setKeepOnKetos(event.target.checked)} />Keep on Ketos</label>
      <p className="text-label text-muted-foreground">{cross ? "Cross settlement stays behind surviving cross positions; only free funds can return to your wallet. " : ""}
        {full ? "Both exits are cancelled." : "TP/SL prices and expiry stay unchanged; their rewards resize with the remaining position."} Estimates use the reviewed mark. Execution requires a fresh price within your limit and expires after five minutes.</p>
      {error ? <p role="alert" className="text-label text-destructive">{error}</p> : null}
      <Button type="submit" disabled={!!error || pending || !market || !depth.isSuccess}>{pending ? "Confirming…" : full ? "Confirm close" : "Confirm reduction"}</Button>
    </form>
  </Modal>;
}
