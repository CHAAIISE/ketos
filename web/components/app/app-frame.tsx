"use client";

import type { ReactNode } from "react";
import { TxToastProvider } from "@/components/app/tx-toast";
import { WalletButton } from "@/components/app/wallet-button";
import { AppShell } from "@/components/ui/page-shell";
import { NearProvider } from "@/hooks/near-provider";

/** Wallet, query cache and transaction toasts shared by every app page. */
export function AppFrame({ children }: { children: ReactNode }) {
  return (
    <NearProvider>
      <TxToastProvider>
        <AppShell navActions={<WalletButton />}>{children}</AppShell>
      </TxToastProvider>
    </NearProvider>
  );
}
