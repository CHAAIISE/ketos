"use client";

import type { ReactNode } from "react";
import { FundingDialogProvider } from "@/components/app/funding";
import { StatusBar } from "@/components/app/status-bar";
import { TxToastProvider } from "@/components/app/tx-toast";
import { WalletControls } from "@/components/app/wallet-button";
import { AppShell } from "@/components/ui/page-shell";
import { NearProvider } from "@/hooks/near-provider";

/** Wallet, query cache, transaction toasts and the margin modal shared by every app page. */
export function AppFrame({ children }: { children: ReactNode }) {
  return (
    <NearProvider>
      <TxToastProvider>
        <FundingDialogProvider>
          <AppShell navActions={<WalletControls />} footer={<StatusBar />}>
            {children}
          </AppShell>
        </FundingDialogProvider>
      </TxToastProvider>
    </NearProvider>
  );
}
