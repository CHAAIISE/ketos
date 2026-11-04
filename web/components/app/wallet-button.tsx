"use client";

import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, Copy, LogOut, Wallet as WalletIcon } from "lucide-react";
import { Skeleton } from "@/components/app/states";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/hooks/near-provider";
import { useAccount, usePositions, useVaultAccount } from "@/hooks/use-ketos-queries";
import { toNearActionError } from "@/lib/near/errors";
import { formatUsd } from "@/lib/near/format";
import type { WalletOption } from "@/lib/near/wallet";
import { FundButton, useFundingDialog } from "./funding";

/** "alice.testnet" style ids keep their start and end: "ketos…testnet", "8f3a…91c2". */
export function shortAccount(accountId: string): string {
  if (accountId.length <= 16) return accountId;
  const dot = accountId.lastIndexOf(".");
  if (dot > 0 && accountId.length - dot <= 10) return `${accountId.slice(0, 5)}…${accountId.slice(dot + 1)}`;
  return `${accountId.slice(0, 4)}…${accountId.slice(-4)}`;
}

const popupClass =
  "z-50 flex w-72 max-w-[calc(100vw-1rem)] flex-col rounded-lg border border-border bg-popover text-popover-foreground outline-none transition-[opacity] duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0";

function WalletRowIcon({ option }: { option: WalletOption }) {
  if (!option.icon) {
    return (
      <span aria-hidden className="flex size-6 items-center justify-center rounded-md bg-muted text-tertiary">
        <WalletIcon className="size-3.5" />
      </span>
    );
  }
  // Wallet icons come from the near-connect manifest (remote URLs or data URIs).
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={option.icon} alt="" className="size-6 rounded-md" />;
}

/** "Connect" opens a short list of the NEAR wallets near-connect can use here. */
function ConnectMenu() {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<WalletOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setOptions(await wallet.listWallets());
    } catch (e) {
      setOptions([]);
      setError(toNearActionError(e).message);
    }
  }

  async function connect(walletId?: string) {
    setError(null);
    setConnecting(walletId ?? "selector");
    try {
      await wallet.signIn(walletId);
      setOpen(false);
    } catch (e) {
      setError(toNearActionError(e).message);
    } finally {
      setConnecting(null);
    }
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load();
      }}
    >
      <Popover.Trigger
        disabled={!wallet.isReady}
        data-testid="connect-button"
        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-4 text-ui font-medium text-primary-foreground transition-colors hover:bg-primary/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40"
      >
        {wallet.isReady ? "Connect" : "Loading…"}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
          <Popover.Popup className={popupClass}>
            <Popover.Title className="border-b border-border px-4 py-3 text-ui font-medium text-foreground">
              Connect a wallet
            </Popover.Title>
            <div className="flex flex-col p-1.5">
              {options === null ? (
                <div className="flex flex-col gap-1.5 p-1.5">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : options.length === 0 ? (
                <button
                  type="button"
                  onClick={() => void connect()}
                  disabled={connecting !== null}
                  className="flex h-10 items-center gap-3 rounded-md px-2.5 text-left text-ui text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
                >
                  <WalletRowIcon option={{ id: "selector", name: "NEAR wallets", icon: null }} />
                  {connecting ? "Opening…" : "Choose a NEAR wallet"}
                </button>
              ) : (
                options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    data-testid={`wallet-option-${option.id}`}
                    onClick={() => void connect(option.id)}
                    disabled={connecting !== null}
                    className="flex h-10 items-center gap-3 rounded-md px-2.5 text-left text-ui text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
                  >
                    <WalletRowIcon option={option} />
                    <span className="min-w-0 flex-1 truncate">{option.name}</span>
                    {connecting === option.id ? <span className="text-label text-tertiary">Opening…</span> : null}
                  </button>
                ))
              )}
            </div>
            {error ? (
              <p role="alert" className="border-t border-border px-4 py-2.5 text-label text-destructive">
                {error}
              </p>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Account id copied" : "Copy account id"}
      title="Copy account id"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1_500);
      }}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-tertiary transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function BalanceRow({ label, value }: { label: string; value: bigint | undefined }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-ui">
      <dt className="text-tertiary">{label}</dt>
      <dd className="tabular-nums text-foreground">{value === undefined ? <Skeleton className="h-4 w-16" /> : formatUsd(value)}</dd>
    </div>
  );
}

/** Account pill: id, balances, margin moves and disconnect. */
function AccountMenu({ accountId }: { accountId: string }) {
  const wallet = useWallet();
  const account = useAccount();
  const positions = usePositions();
  const vault = useVaultAccount("core");
  const funding = useFundingDialog();
  const [open, setOpen] = useState(false);
  const locked = positions.data?.reduce((sum, p) => sum + p.margin, 0n);

  const openFunding = (mode: "deposit" | "withdraw") => {
    setOpen(false);
    funding.open(mode);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        data-testid="wallet-account"
        title={accountId}
        className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-muted px-3 text-ui text-foreground transition-colors hover:border-tertiary/40 focus-visible:outline-2 focus-visible:outline-ring aria-expanded:border-tertiary/40"
      >
        <span aria-hidden className="size-1.5 rounded-pill bg-success" />
        <span className="max-w-28 truncate sm:max-w-none">{shortAccount(accountId)}</span>
        <ChevronDown aria-hidden className="size-3.5 text-tertiary" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
          <Popover.Popup className={popupClass} aria-label="Account">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <span aria-hidden className="size-1.5 shrink-0 rounded-pill bg-success" />
              <span className="min-w-0 flex-1 truncate font-mono text-label text-foreground" title={accountId}>
                {accountId}
              </span>
              <CopyButton text={accountId} />
            </div>
            <dl className="flex flex-col gap-2 px-4 py-3">
              <BalanceRow label="Wallet USDC" value={account.data?.usdcBalance} />
              <BalanceRow
                label="Margin"
                value={account.data && locked !== undefined ? account.data.margin + locked : account.data?.margin}
              />
              <BalanceRow label="Vault" value={vault.data?.value} />
            </dl>
            <div className="grid grid-cols-2 gap-2 px-4 pb-3">
              <Button size="sm" onClick={() => openFunding("deposit")}>
                Deposit
              </Button>
              <Button size="sm" variant="secondary" onClick={() => openFunding("withdraw")}>
                Withdraw
              </Button>
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void wallet.signOut();
              }}
              className="flex h-10 items-center gap-2 border-t border-border px-4 text-left text-ui text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              <LogOut className="size-3.5" />
              Disconnect
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Right side of the app bar: Connect, or Fund plus the account menu once signed in. */
export function WalletControls() {
  const wallet = useWallet();
  const account = useAccount();

  if (!wallet.accountId) return <ConnectMenu />;
  return (
    <div className="flex items-center gap-2">
      {account.data ? <FundButton account={account.data} /> : <Skeleton className="h-8 w-14" />}
      <AccountMenu accountId={wallet.accountId} />
    </div>
  );
}
