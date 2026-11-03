"use client";

import { useState } from "react";
import { LogOut, Wallet as WalletIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/hooks/near-provider";

/** "alice.testnet" stays whole; long implicit ids become "8f3a…91c2". */
function shortAccount(accountId: string): string {
  return accountId.length > 22 ? `${accountId.slice(0, 6)}…${accountId.slice(-4)}` : accountId;
}

/** Connect button in the app bar; shows the account and a disconnect action once signed in. */
export function WalletButton() {
  const wallet = useWallet();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (wallet.accountId) {
    return (
      <div className="flex items-center gap-1">
        <span
          data-testid="wallet-account"
          title={wallet.accountId}
          className="hidden h-8 items-center gap-2 rounded-md border border-border bg-card px-3 text-ui text-foreground sm:flex"
        >
          <span aria-hidden className="size-1.5 rounded-pill bg-success" />
          {shortAccount(wallet.accountId)}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Disconnect ${wallet.accountId}`}
          title="Disconnect"
          onClick={() => void wallet.signOut()}
        >
          <LogOut strokeWidth={1.5} />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {error ? (
        <span role="alert" className="hidden max-w-64 truncate text-label text-destructive md:block" title={error}>
          {error}
        </span>
      ) : null}
      <Button
        variant="secondary"
        size="sm"
        disabled={!wallet.isReady || pending}
        onClick={async () => {
          setError(null);
          setPending(true);
          try {
            await wallet.signIn();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Could not open the wallet. Try again.");
          } finally {
            setPending(false);
          }
        }}
      >
        <WalletIcon strokeWidth={1.5} />
        {wallet.isReady ? (
          <>
            <span className="sm:hidden">Connect</span>
            <span className="hidden sm:inline">Connect wallet</span>
          </>
        ) : (
          "Loading…"
        )}
      </Button>
    </div>
  );
}
