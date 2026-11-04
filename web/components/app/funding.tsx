"use client";

import { createContext, use, useId, useMemo, useState, type ReactNode } from "react";
import { useNow } from "@/components/landing/live-time";
import { useTxToast } from "@/components/app/tx-toast";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldMessage, Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PanelTabs } from "@/components/ui/panel-tabs";
import { Skeleton } from "@/components/app/states";
import { useAccount, type AccountSummary } from "@/hooks/use-ketos-queries";
import { useDepositMargin, useFaucet, useWithdrawMargin } from "@/hooks/use-ketos-mutations";
import { formatUsd, formatUsdc, parseUsdc } from "@/lib/near/format";

/** Wait in whole minutes, rounded up and capped at the faucet's one-hour cooldown, e.g. "42 min". */
function waitLabel(ms: number): string {
  return `${Math.min(60, Math.max(1, Math.ceil(ms / 60_000)))} min`;
}

/** Claims 1,000 USDC from the token faucet; disabled with the time left while it cools down. */
export function FundButton({ account, className }: { account: AccountSummary; className?: string }) {
  const faucet = useFaucet();
  const { track } = useTxToast();
  const nowMs = useNow();
  const waitMs = nowMs > 0 ? account.faucetAvailableAtMs - nowMs : 0;
  const coolingDown = account.faucetAvailableAtMs > 0 && waitMs > 0;

  return (
    <Button
      variant="secondary"
      size="sm"
      data-testid="fund-button"
      className={className}
      disabled={faucet.isPending || coolingDown}
      title={coolingDown ? "The faucet gives 1,000 USDC once an hour" : "Get 1,000 USDC in your wallet"}
      onClick={() =>
        track(() => faucet.mutateAsync(), {
          pending: "Claiming 1,000 USDC…",
          success: "1,000 USDC added to your wallet",
        })
      }
    >
      {faucet.isPending ? (
        "Funding…"
      ) : coolingDown ? (
        <>
          <span className="sm:hidden">{waitLabel(waitMs)}</span>
          <span className="hidden sm:inline">Available in {waitLabel(waitMs)}</span>
        </>
      ) : (
        "Fund"
      )}
    </Button>
  );
}

const maxButtonClass =
  "rounded-sm text-label text-tertiary tabular-nums hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

/** Moves USDC from the wallet into free margin on the perps contract. */
export function DepositMarginForm({ account, onDone }: { account: AccountSummary; onDone?: () => void }) {
  const deposit = useDepositMargin();
  const { track } = useTxToast();
  const inputId = useId();
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
            ? `Your wallet holds ${formatUsd(account.usdcBalance)}. Lower the amount or use Fund.`
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
        if (done) {
          setInput("");
          onDone?.();
        }
      }}
    >
      <Field>
        <div className="flex items-baseline justify-between">
          <FieldLabel htmlFor={inputId}>Amount (USDC)</FieldLabel>
          <button
            type="button"
            onClick={() => setInput(formatUsdc(account.usdcBalance, { grouping: false }))}
            className={maxButtonClass}
          >
            Wallet {formatUsd(account.usdcBalance)} · Max
          </button>
        </div>
        <Input
          id={inputId}
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
      <Button type="submit" className="w-full" disabled={!amount || Boolean(error) || deposit.isPending}>
        {deposit.isPending ? "Depositing…" : "Deposit margin"}
      </Button>
    </form>
  );
}

/** Sends free margin (not locked in a position) back to the wallet. */
export function WithdrawMarginForm({ account, onDone }: { account: AccountSummary; onDone?: () => void }) {
  const withdraw = useWithdrawMargin();
  const { track } = useTxToast();
  const inputId = useId();
  const [input, setInput] = useState("");
  const amount = parseUsdc(input);
  const error =
    input.trim() === ""
      ? null
      : amount === null
        ? "Enter an amount like 200 or 12.50."
        : amount === 0n
          ? "Enter an amount above zero."
          : amount > account.margin
            ? `Your free margin is ${formatUsd(account.margin)}. Close a position to free more.`
            : null;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!amount || error) return;
        const done = await track(() => withdraw.mutateAsync(amount), {
          pending: `Withdrawing ${formatUsd(amount)} to your wallet…`,
          success: `${formatUsd(amount)} sent back to your wallet`,
        });
        if (done) {
          setInput("");
          onDone?.();
        }
      }}
    >
      <Field>
        <div className="flex items-baseline justify-between">
          <FieldLabel htmlFor={inputId}>Amount (USDC)</FieldLabel>
          <button
            type="button"
            onClick={() => setInput(formatUsdc(account.margin, { grouping: false }))}
            className={maxButtonClass}
          >
            Free {formatUsd(account.margin)} · Max
          </button>
        </div>
        <Input
          id={inputId}
          name="withdraw-margin"
          inputMode="decimal"
          autoComplete="off"
          placeholder="100"
          value={input}
          aria-invalid={error ? true : undefined}
          onChange={(event) => setInput(event.target.value)}
        />
        {error ? <FieldMessage tone="error">{error}</FieldMessage> : null}
      </Field>
      <Button
        type="submit"
        variant="secondary"
        className="w-full"
        disabled={!amount || Boolean(error) || withdraw.isPending || account.margin === 0n}
      >
        {withdraw.isPending ? "Withdrawing…" : "Withdraw to wallet"}
      </Button>
    </form>
  );
}

export type FundingMode = "deposit" | "withdraw";

interface FundingDialogValue {
  open: (mode: FundingMode) => void;
}

const FundingDialogContext = createContext<FundingDialogValue | null>(null);

/** Opens the margin Deposit / Withdraw modal from anywhere in the app. */
export function useFundingDialog(): FundingDialogValue {
  const value = use(FundingDialogContext);
  if (!value) throw new Error("useFundingDialog must be used inside <FundingDialogProvider>");
  return value;
}

const FUNDING_TABS = [
  { id: "deposit", label: "Deposit" },
  { id: "withdraw", label: "Withdraw" },
] as const;

function FundingBody({ mode, onDone }: { mode: FundingMode; onDone: () => void }) {
  const account = useAccount();
  if (!account.data) {
    return account.isError ? (
      <p role="alert" className="text-ui text-destructive">
        Your balances could not be read. Close this and try again.
      </p>
    ) : (
      <Skeleton className="h-36 w-full" />
    );
  }
  const data = account.data;
  if (mode === "withdraw") return <WithdrawMarginForm account={data} onDone={onDone} />;
  return (
    <div className="flex flex-col gap-3">
      {data.usdcBalance === 0n ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
          <p className="text-label text-muted-foreground">Your wallet has no USDC yet.</p>
          <FundButton account={data} />
        </div>
      ) : null}
      <DepositMarginForm account={data} onDone={onDone} />
    </div>
  );
}

/** Margin moves between the wallet and the perps contract, in one modal shared by every screen. */
export function FundingDialogProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<FundingMode>("deposit");
  const [isOpen, setOpen] = useState(false);
  const value = useMemo<FundingDialogValue>(
    () => ({
      open: (next) => {
        setMode(next);
        setOpen(true);
      },
    }),
    [],
  );

  return (
    <FundingDialogContext value={value}>
      {children}
      <Modal open={isOpen} onOpenChange={setOpen} title="Margin">
        <div className="-mx-4 -mt-2">
          <PanelTabs tabs={FUNDING_TABS} value={mode} onChange={setMode} label="Margin action" idPrefix="funding" className="px-1" />
        </div>
        <div id="funding-panel" role="tabpanel" aria-labelledby={`funding-tab-${mode}`}>
          <FundingBody key={mode} mode={mode} onDone={() => setOpen(false)} />
        </div>
      </Modal>
    </FundingDialogContext>
  );
}
