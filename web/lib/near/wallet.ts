import type { ConnectorAction } from "@hot-labs/near-connect";
import { Account, JsonRpcProvider, KeyPairSigner, actions, type KeyPairString } from "near-api-js";
import type { NearConfig } from "./config";
import { NearActionError, toNearActionError } from "./errors";
import { settleOutcome, type NearTransaction, type TxResult } from "./tx";

export type WalletKind = "near-connect" | "e2e";

/** One entry of the connect menu. */
export interface WalletOption {
  id: string;
  name: string;
  /** Image URL from the wallet manifest; null when the wallet has none. */
  icon: string | null;
}

export interface Wallet {
  readonly kind: WalletKind;
  /** Signed-in account, null when signed out. */
  readonly accountId: string | null;
  /** Wallets the user can connect with, in the order near-connect lists them. */
  listWallets(): Promise<WalletOption[]>;
  /** Connects `walletId`, or opens the near-connect selector without one (the E2E signer signs in immediately). */
  signIn(walletId?: string): Promise<void>;
  signOut(): Promise<void>;
  /** Signs and sends one transaction; rejects with a NearActionError, including for failed receipts. */
  signAndSendTransaction(tx: NearTransaction): Promise<TxResult>;
  /** Called whenever `accountId` changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

function accountStore() {
  let accountId: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => accountId,
    set(next: string | null) {
      if (next === accountId) return;
      accountId = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

function notSignedIn() {
  return new NearActionError({ code: "NOT_SIGNED_IN", message: "Connect a wallet first." });
}

/** Wallet selector backed by near-connect. Loaded with a dynamic import: it touches `window`. */
async function createNearConnectWallet(config: NearConfig): Promise<Wallet> {
  if (config.network !== "testnet") {
    throw new Error("Browser wallets only support testnet; the sandbox network needs NEXT_PUBLIC_E2E=1");
  }
  const { NearConnector } = await import("@hot-labs/near-connect");
  const connector = new NearConnector({
    network: "testnet",
    providers: { testnet: [config.rpcUrl] },
    features: { signAndSendTransaction: true, testnet: true },
  });
  const store = accountStore();
  connector.on("wallet:signIn", (event) => store.set(event.accounts[0]?.accountId ?? null));
  connector.on("wallet:signOut", () => store.set(null));
  connector
    .getConnectedWallet()
    .then(({ accounts }) => store.set(accounts[0]?.accountId ?? null))
    .catch(() => store.set(null));

  return {
    kind: "near-connect",
    get accountId() {
      return store.get();
    },
    async listWallets() {
      await connector.whenManifestLoaded.catch(() => undefined);
      return connector.availableWallets.map(({ manifest }) => ({
        id: manifest.id,
        name: manifest.name,
        icon: manifest.icon || null,
      }));
    },
    async signIn(walletId) {
      try {
        await connector.connect(walletId ? { walletId } : undefined);
      } catch (error) {
        throw toNearActionError(error);
      }
    },
    async signOut() {
      await connector.disconnect().catch(() => undefined);
      store.set(null);
    },
    async signAndSendTransaction(tx) {
      const signerId = store.get();
      if (!signerId) throw notSignedIn();
      try {
        const wallet = await connector.wallet();
        const connectorActions: ConnectorAction[] = tx.actions.map((a) => ({
          type: "FunctionCall",
          params: { methodName: a.methodName, args: a.args, gas: a.gas.toString(), deposit: a.deposit.toString() },
        }));
        const outcome: unknown = await wallet.signAndSendTransaction({
          signerId,
          receiverId: tx.receiverId,
          actions: connectorActions,
        });
        return settleOutcome(outcome);
      } catch (error) {
        throw toNearActionError(error);
      }
    },
    subscribe: store.subscribe,
  };
}

export interface E2ESigner {
  accountId: string;
  secretKey: KeyPairString;
}

/**
 * Parses `NEXT_PUBLIC_E2E_SIGNER`, formatted `<accountId>:<curve>:<base58 secret key>`,
 * e.g. `alice.test.near:ed25519:3D4YudUahN1nawWogh…`.
 */
export function parseE2ESigner(value: string | undefined): E2ESigner {
  const match = /^([a-z0-9._-]+):((?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+)$/.exec(value?.trim() ?? "");
  if (!match) {
    throw new Error("NEXT_PUBLIC_E2E_SIGNER must be formatted <accountId>:ed25519:<base58 secret key>");
  }
  return { accountId: match[1], secretKey: match[2] as KeyPairString };
}

const E2E_SESSION_KEY = "ketos:e2e-signed-in";

/** Signs locally with a key from the environment, for end-to-end tests against a sandbox node. */
export function createE2EWallet(config: NearConfig, signer: E2ESigner): Wallet {
  if (config.network !== "sandbox") throw new Error("The E2E signer only runs against the sandbox network");
  const account = new Account(
    signer.accountId,
    new JsonRpcProvider({ url: config.rpcUrl }),
    KeyPairSigner.fromSecretKey(signer.secretKey),
  );
  const storage = typeof localStorage === "undefined" ? null : localStorage;
  const store = accountStore();
  // Keeps the session across reloads, like a browser wallet does.
  if (storage?.getItem(E2E_SESSION_KEY) === signer.accountId) store.set(signer.accountId);

  return {
    kind: "e2e",
    get accountId() {
      return store.get();
    },
    async listWallets() {
      return [{ id: "e2e", name: signer.accountId, icon: null }];
    },
    async signIn() {
      storage?.setItem(E2E_SESSION_KEY, signer.accountId);
      store.set(signer.accountId);
    },
    async signOut() {
      storage?.removeItem(E2E_SESSION_KEY);
      store.set(null);
    },
    async signAndSendTransaction(tx) {
      if (!store.get()) throw notSignedIn();
      try {
        const outcome = await account.signAndSendTransaction({
          receiverId: tx.receiverId,
          actions: tx.actions.map((a) => actions.functionCall(a.methodName, a.args, a.gas, a.deposit)),
        });
        return settleOutcome(outcome);
      } catch (error) {
        throw toNearActionError(error);
      }
    },
    subscribe: store.subscribe,
  };
}

/**
 * The app's wallet. `NEXT_PUBLIC_E2E=1` swaps the browser wallet selector for a local signer
 * (`NEXT_PUBLIC_E2E_SIGNER`); that mode refuses to run unless `NEXT_PUBLIC_NEAR_NETWORK=sandbox`
 * so a key in the environment can never sign on a public network.
 */
export async function createWallet(config: NearConfig): Promise<Wallet> {
  if (process.env.NEXT_PUBLIC_E2E === "1") {
    if (process.env.NEXT_PUBLIC_NEAR_NETWORK !== "sandbox" || config.network !== "sandbox") {
      throw new Error("NEXT_PUBLIC_E2E=1 requires NEXT_PUBLIC_NEAR_NETWORK=sandbox");
    }
    return createE2EWallet(config, parseE2ESigner(process.env.NEXT_PUBLIC_E2E_SIGNER));
  }
  return createNearConnectWallet(config);
}
