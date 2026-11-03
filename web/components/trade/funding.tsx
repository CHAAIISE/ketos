"use client";

import { useState } from "react";
import { useNow } from "@/components/landing/live-time";
import { useTxToast } from "@/components/app/tx-toast";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldMessage, Input } from "@/components/ui/input";
import type { AccountSummary } from "@/hooks/use-perps-queries";
import { useDepositMargin, useFaucet } from "@/hooks/use-perps-mutations";
import { formatUsd, formatUsdc, parseUsdc } from "@/lib/near/format";

/** Wait in whole minutes, rounded up, e.g. "42 min". */
function waitLabel(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 60_000))} min`;
}

/** Claims 1,000 tUSDC; shows when the hourly faucet opens again. */
export function FaucetButton({
  account,
  primary,
}: {
  account: AccountSummary;
  /** Main action of the screen (no test USDC yet) or a recessed shortcut. */
  primary: boolean;
}) {
  const faucet = useFaucet();
  const { track } = useTxToast();
  const nowMs = useNow();
  const waitMs = nowMs > 0 ? account.faucetAvailableAtMs - nowMs : 0;
  const coolingDown = account.faucetAvailableAtMs > 0 && waitMs > 0;

  if (!primary && coolingDown) {
    return <span className="px-3 text-label text-tertiary">Faucet again in {waitLabel(waitMs)}</span>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        data-primary={primary ? "" : undefined}
        variant={primary ? "default" : "ghost"}
        size={primary ? "lg" : "sm"}
        className={primary ? "w-full" : "w-fit"}
        disabled={faucet.isPending || coolingDown}
        onClick={() =>
          track(() => faucet.mutateAsync(), {
            pending: "Claiming 1,000 test USDC…",
            success: "1,000 test USDC added to your wallet",
          })
        }
      >
        {faucet.isPending ? "Claiming…" : primary ? "Get 1,000 test USDC" : "Get test USDC"}
      </Button>
      {coolingDown ? (
        <FieldMessage>Faucet used, try again in {waitLabel(waitMs)}.</FieldMessage>
      ) : null}
    </div>
  );
}

/** Moves tUSDC from the wallet into free margin on the perps contract. */
export function DepositMarginForm({ account, primary }: { account: AccountSummary; primary: boolean }) {
  const deposit = useDepositMargin();
  const { track } = useTxToast();
  const [input, setInput] = useState("");
  const amount = parseUsdc(input);
  const error =
    input.trim() === ""
      ? null
      : amount === null
        ? "Enter an amount like 200 or 12.50."
        : amount === 0n
          ? "Enter an amount above zero."
          : amount > account.usdcBalance
            ? `Your wallet holds ${formatUsd(account.usdcBalance)}. Lower the amount or claim from the faucet.`
            : null;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!amount || error) return;
        const done = await track(() => deposit.mutateAsync(amount), {
          pending: `Depositing ${formatUsd(amount)} of margin…`,
          success: `${formatUsd(amount)} margin deposited`,
        });
        if (done) setInput("");
      }}
    >
      <Field>
        <div className="flex items-baseline justify-between">
          <FieldLabel htmlFor="deposit-margin">Amount (tUSDC)</FieldLabel>
          <button
            type="button"
            onClick={() => setInput(formatUsdc(account.usdcBalance, { grouping: false }))}
            className="rounded-sm text-label text-tertiary tabular-nums hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            Wallet {formatUsd(account.usdcBalance)} · Max
          </button>
        </div>
        <Input
          id="deposit-margin"
          name="deposit-margin"
          inputMode="decimal"
          autoComplete="off"
          placeholder="200"
          value={input}
          aria-invalid={error ? true : undefined}
          onChange={(event) => setInput(event.target.value)}
        />
        {error ? <FieldMessage tone="error">{error}</FieldMessage> : null}
      </Field>
      <Button
        type="submit"
        data-primary={primary ? "" : undefined}
        variant={primary ? "default" : "secondary"}
        size={primary ? "lg" : "default"}
        className="w-full"
        disabled={!amount || Boolean(error) || deposit.isPending}
      >
        {deposit.isPending ? "Depositing…" : "Deposit margin"}
      </Button>
    </form>
  );
}
