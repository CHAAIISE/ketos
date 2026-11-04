"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createContext,
  use,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { nearConfig, type NearConfig } from "@/lib/near/config";
import { toNearActionError, type NearActionError } from "@/lib/near/errors";
import { PerpsViews } from "@/lib/near/views";
import { createWallet, type Wallet, type WalletOption } from "@/lib/near/wallet";

export interface NearContextValue {
  config: NearConfig;
  views: PerpsViews;
  /** Null during prerendering and until the wallet module has loaded in the browser. */
  wallet: Wallet | null;
  walletError: NearActionError | null;
}

const NearContext = createContext<NearContextValue | null>(null);

// One wallet per page load: React may mount the provider twice in development, and a second
// near-connect instance would register its window listeners again.
let walletPromise: Promise<Wallet> | null = null;

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 3_000, retry: 2, refetchOnWindowFocus: true },
    },
  });
}

/** Mounts TanStack Query and the NEAR wallet for everything below it. */
export function NearProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  const [base] = useState(() => {
    const config = nearConfig();
    return { config, views: new PerpsViews(config.rpcUrl, config.perpsContract, config.usdcContract) };
  });
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [walletError, setWalletError] = useState<NearActionError | null>(null);

  useEffect(() => {
    let active = true;
    walletPromise ??= createWallet(base.config);
    walletPromise.then(
      (loaded) => {
        if (active) setWallet(loaded);
      },
      (error: unknown) => {
        if (active) setWalletError(toNearActionError(error));
      },
    );
    return () => {
      active = false;
    };
  }, [base.config]);

  const value = useMemo(() => ({ ...base, wallet, walletError }), [base, wallet, walletError]);

  return (
    <QueryClientProvider client={queryClient}>
      <NearContext value={value}>{children}</NearContext>
    </QueryClientProvider>
  );
}

export function useNear(): NearContextValue {
  const value = use(NearContext);
  if (!value) throw new Error("useNear must be used inside <NearProvider>");
  return value;
}

const noop = () => () => {};

/** Signed-in account id, re-rendering on sign-in and sign-out. */
export function useAccountId(): string | null {
  const { wallet } = useNear();
  return useSyncExternalStore(
    wallet?.subscribe ?? noop,
    () => wallet?.accountId ?? null,
    () => null,
  );
}

export interface WalletState {
  accountId: string | null;
  /** False until the wallet has loaded in the browser. */
  isReady: boolean;
  kind: Wallet["kind"] | null;
  error: NearActionError | null;
  /** Connects `walletId`, or opens the wallet selector without one. */
  signIn: (walletId?: string) => Promise<void>;
  signOut: () => Promise<void>;
  listWallets: () => Promise<WalletOption[]>;
}

export function useWallet(): WalletState {
  const { wallet, walletError } = useNear();
  const accountId = useAccountId();
  return {
    accountId,
    isReady: wallet !== null,
    kind: wallet?.kind ?? null,
    error: walletError,
    signIn: async (walletId?: string) => {
      if (!wallet) throw walletError ?? toNearActionError(new Error("Wallet is still loading"));
      await wallet.signIn(walletId);
    },
    signOut: async () => {
      await wallet?.signOut();
    },
    listWallets: async () => {
      if (!wallet) throw walletError ?? toNearActionError(new Error("Wallet is still loading"));
      return wallet.listWallets();
    },
  };
}
