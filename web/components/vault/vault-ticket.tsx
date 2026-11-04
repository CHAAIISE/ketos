"use client";

import { useState, type ReactNode } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { Skeleton } from "@/components/app/states";
import { useTxToast } from "@/components/app/tx-toast";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldMessage, Input } from "@/components/ui/input";
import { useWallet } from "@/hooks/near-provider";
import { useDepositVault, useWithdrawVault } from "@/hooks/use-ketos-mutations";
import { useAccount, useVaultAccount } from "@/hooks/use-ketos-queries";
import { toNearActionError } from "@/lib/near/errors";
import { USDC_UNIT, formatUsd, formatUsdc, parseUsdc } from "@/lib/near/format";
import type { Vault, VaultAccount } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { formatShares, sharesForDeposit, sharesForValue, toInputAmount, valueOfShares } from "./vault-math";

type Mode = "deposit" | "withdraw";

const MIN_DEPOSIT = USDC_UNIT;

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-ui">
      <span className="text-tertiary">{label}</span>
      <span className="text-right text-foreground tabular-nums">{children}</span>
    </div>
  );
}

function AmountInput({
  id,
  value,
  onChange,
  unit,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  unit: string;
  invalid: boolean;
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        placeholder="0.00"
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 pr-16 text-right text-ui"
      />
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ui text-tertiary">
        {unit}
      </span>
    </div>
  );
}

/** Parse errors shared by both forms; null when the text is a usable positive amount. */
function amountError(text: string, amount: bigint | null): string | null {
  if (text.trim() === "") return null;
  if (amount === null) return "Enter an amount like 250 or 250.5, with up to 6 decimals.";
  if (amount === 0n) return "Enter an amount greater than zero.";
  return null;
}

function ConnectButton() {
  const wallet = useWallet();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <Button
        data-primary
        className="w-full"
        disabled={!wallet.isReady}
        onClick={async () => {
          setError(null);
          try {
            await wallet.signIn();
          } catch (e) {
            setError(toNearActionError(e).message);
          }
        }}
      >
        {wallet.isReady ? "Connect wallet" : "Loading wallet…"}
      </Button>
      {error ? <FieldMessage tone="error">{error}</FieldMessage> : null}
    </div>
  );
}

function DepositForm({ vault, signedIn }: { vault: Vault; signedIn: boolean }) {
  const account = useAccount();
  const deposit = useDepositVault();
  const { track } = useTxToast();
  const [text, setText] = useState("");

  const amount = parseUsdc(text);
  const balance = account.data?.usdcBalance;
  const shares = amount ? sharesForDeposit(amount, vault) : 0n;
  const error =
    amountError(text, amount) ??
    (amount === null || amount === 0n
      ? null
      : amount < MIN_DEPOSIT
        ? "Vault deposits must be at least 1 USDC."
        : balance !== undefined && amount > balance
          ? `You have ${formatUsdc(balance)} USDC in your wallet. Lower the amount or use Fund in the top bar.`
          : vault.total_shares > 0n && vault.nav === 0n
            ? "The vault has no net value right now, so deposits are paused. Try again later."
            : shares === 0n
              ? "The amount is too small to mint a vault share. Use a larger amount."
              : null);
  const ready = amount !== null && amount > 0n && error === null;

  const submit = async () => {
    if (!amount || !ready) return;
    const result = await track(() => deposit.mutateAsync({ vaultId: vault.id, amount }), {
      pending: `Depositing ${formatUsdc(amount)} USDC into the vault…`,
      success: `Deposited ${formatUsdc(amount)} USDC into the vault`,
      successDescription: () => `About ${formatShares(shares)} shares minted at ${formatUsd(vault.share_price, { maxFractionDigits: 4 })}.`,
    });
    if (result) setText("");
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Field>
        <div className="flex items-baseline justify-between gap-2">
          <FieldLabel htmlFor="vault-deposit">Amount</FieldLabel>
          {signedIn ? (
            <span className="flex items-center gap-2 text-label text-tertiary tabular-nums">
              {balance === undefined ? (
                <Skeleton className="h-4 w-24" />
              ) : (
                <span>Wallet {formatUsdc(balance)} USDC</span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={!balance}
                onClick={() => balance && setText(toInputAmount(balance))}
              >
                Max
              </Button>
            </span>
          ) : null}
        </div>
        <AmountInput id="vault-deposit" value={text} onChange={setText} unit="USDC" invalid={error !== null} />
        {error ? <FieldMessage tone="error">{error}</FieldMessage> : null}
        {signedIn && balance === 0n && !error ? (
          <FieldMessage>Your wallet has no USDC. Use Fund in the top bar to get 1,000 USDC.</FieldMessage>
        ) : null}
      </Field>
      <div className="flex flex-col gap-2">
        <Row label="You receive">{amount && ready ? `≈ ${formatShares(shares)} shares` : "—"}</Row>
        <Row label="Share price">{formatUsd(vault.share_price, { maxFractionDigits: 4 })}</Row>
      </div>
      {signedIn ? (
        <Button data-primary type="submit" className="w-full" disabled={!ready || deposit.isPending}>
          {deposit.isPending ? "Confirm in your wallet…" : "Deposit to vault"}
        </Button>
      ) : (
        <ConnectButton />
      )}
    </form>
  );
}

function WithdrawForm({
  vault,
  position,
  signedIn,
}: {
  vault: Vault;
  position: VaultAccount | undefined;
  signedIn: boolean;
}) {
  const withdraw = useWithdrawVault();
  const { track } = useTxToast();
  const [text, setText] = useState("");
  // Set when the contract refused a withdrawal as reserved; tighter than our last read of the vault.
  const [refusedAvailable, setRefusedAvailable] = useState<bigint | null>(null);

  const held = position?.shares ?? 0n;
  const heldValue = position?.value ?? 0n;
  const available = refusedAvailable !== null && refusedAvailable < vault.available ? refusedAvailable : vault.available;
  const maxValue = heldValue < available ? heldValue : available;

  const value = parseUsdc(text);
  // Asking for the whole position burns every share instead of leaving rounding dust behind.
  const shares = value === null ? 0n : value >= heldValue ? held : sharesForValue(value, vault);
  const receive = valueOfShares(shares, vault);
  const reservedMessage = `${formatUsd(vault.reserved)} reserved for open positions. You can withdraw up to ${formatUsd(maxValue)} now.`;
  const error =
    amountError(text, value) ??
    (value === null || value === 0n || !signedIn
      ? null
      : value > heldValue
        ? `You hold ${formatUsd(heldValue)} in the vault. Lower the amount or use Max.`
        : shares === 0n
          ? "The amount is too small to burn a vault share. Use a larger amount."
          : receive > available
            ? reservedMessage
            : null);
  const ready = value !== null && value > 0n && shares > 0n && error === null;

  const change = (next: string) => {
    setText(next);
    setRefusedAvailable(null);
  };

  const submit = async () => {
    if (!ready) return;
    const result = await track(
      async () => {
        try {
          return await withdraw.mutateAsync({ vaultId: vault.id, shares });
        } catch (e) {
          const refused = toNearActionError(e);
          if (refused.availableUsdc !== undefined) setRefusedAvailable(refused.availableUsdc);
          throw refused;
        }
      },
      {
        pending: `Withdrawing ${formatUsd(receive)} from the vault…`,
        success: `Withdrew ${formatUsd(receive)} from the vault`,
        successDescription: () => `${formatShares(shares)} shares burned.`,
      },
    );
    if (result) change("");
  };

  const noShares = signedIn && position !== undefined && held === 0n;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Field>
        <div className="flex items-baseline justify-between gap-2">
          <FieldLabel htmlFor="vault-withdraw">Value</FieldLabel>
          {signedIn ? (
            <span className="flex items-center gap-2 text-label text-tertiary tabular-nums">
              {position === undefined ? (
                <Skeleton className="h-4 w-24" />
              ) : (
                <span>Withdrawable {formatUsd(maxValue)}</span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={maxValue === 0n}
                onClick={() => change(toInputAmount(maxValue))}
              >
                Max
              </Button>
            </span>
          ) : null}
        </div>
        <AmountInput id="vault-withdraw" value={text} onChange={change} unit="USD" invalid={error !== null} />
        {error ? (
          <FieldMessage tone="error">{error}</FieldMessage>
        ) : noShares ? (
          <FieldMessage>You have no vault shares to withdraw. Deposit first.</FieldMessage>
        ) : heldValue > available && signedIn ? (
          <FieldMessage>{reservedMessage}</FieldMessage>
        ) : null}
      </Field>
      <div className="flex flex-col gap-2">
        <Row label="Shares burned">{ready ? formatShares(shares) : "—"}</Row>
        <Row label="You receive">{ready ? formatUsd(receive) : "—"}</Row>
        <Row label="Available in vault">{formatUsd(available)}</Row>
      </div>
      {signedIn ? (
        <Button data-primary type="submit" className="w-full" disabled={!ready || withdraw.isPending}>
          {withdraw.isPending ? "Confirm in your wallet…" : "Withdraw"}
        </Button>
      ) : (
        <ConnectButton />
      )}
    </form>
  );
}

function PositionSummary({ vault, signedIn }: { vault: Vault; signedIn: boolean }) {
  const position = useVaultAccount(vault.id);
  if (!signedIn) {
    return <p className="text-ui text-muted-foreground">Connect a wallet to see your vault shares.</p>;
  }
  if (position.isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  }
  if (position.isError) {
    return (
      <p role="alert" className="flex items-center justify-between gap-2 text-ui text-destructive">
        Could not read your vault shares.
        <Button variant="outline" size="xs" onClick={() => void position.refetch()}>
          Retry
        </Button>
      </p>
    );
  }
  const { shares, value } = position.data;
  if (shares === 0n) {
    return <p className="text-ui text-muted-foreground">You have no vault shares yet.</p>;
  }
  const ownership = vault.total_shares === 0n ? 0 : Number((shares * 1_000_000n) / vault.total_shares) / 10_000;
  return (
    <div className="flex flex-col gap-2">
      <Row label="Shares">{formatShares(shares)}</Row>
      <Row label="Value">{formatUsd(value)}</Row>
      <Row label="Share of vault">{ownership.toFixed(2)}%</Row>
    </div>
  );
}

const tabClass =
  "-mb-px h-9 border-b border-transparent text-ui text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-active:border-foreground data-active:text-foreground";

export function VaultTicket({
  vault,
  loading,
  className,
}: {
  vault: Vault | undefined;
  loading: boolean;
  className?: string;
}) {
  const wallet = useWallet();
  const position = useVaultAccount("core");
  const [mode, setMode] = useState<Mode>("deposit");
  const signedIn = wallet.accountId !== null;

  return (
    <section
      aria-label="Deposit or withdraw"
      className={cn("flex min-w-0 flex-col rounded-md border border-border bg-card", className)}
    >
      <Tabs.Root value={mode} onValueChange={(next: Mode) => setMode(next)} className="flex flex-col">
        <Tabs.List className="grid grid-cols-2 border-b border-border">
          <Tabs.Tab value="deposit" className={tabClass}>
            Deposit
          </Tabs.Tab>
          <Tabs.Tab value="withdraw" className={tabClass}>
            Withdraw
          </Tabs.Tab>
        </Tabs.List>
        <div className="p-3">
          {vault ? (
            <>
              <Tabs.Panel value="deposit">
                <DepositForm vault={vault} signedIn={signedIn} />
              </Tabs.Panel>
              <Tabs.Panel value="withdraw">
                <WithdrawForm vault={vault} position={position.data} signedIn={signedIn} />
              </Tabs.Panel>
            </>
          ) : loading ? (
            <div className="flex flex-col gap-3" aria-busy>
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-control w-full" />
            </div>
          ) : (
            <p className="text-ui text-muted-foreground">
              Deposits and withdrawals need a fresh read of the vault. Retry from the vault overview above.
            </p>
          )}
        </div>
      </Tabs.Root>
      <div className="flex flex-col gap-2 border-t border-border p-3">
        <h2 className="text-label text-tertiary">Your position</h2>
        {vault ? (
          <PositionSummary vault={vault} signedIn={signedIn} />
        ) : loading ? (
          <Skeleton className="h-4 w-full" />
        ) : (
          <p className="text-ui text-muted-foreground">Unavailable until the vault can be read.</p>
        )}
      </div>
      <p className="mt-auto border-t border-border p-3 text-label text-tertiary">
        LPs are the counterparty of every trade: the vault earns trading, borrow and liquidation fees and pays traders&apos;
        gains. Withdrawals are limited to USDC not reserved for open positions.
      </p>
    </section>
  );
}
