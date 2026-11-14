import { createHash } from "node:crypto";
import { Account, actions, baseEncode, JsonRpcProvider, KeyPairSigner, teraToGas, type KeyPairString } from "near-api-js";
import { z } from "zod";
import { FaucetError, type FaucetChain, validAccountId } from "./service";

export interface FaucetServerConfig {
  network: "testnet" | "sandbox";
  rpcUrl: string;
  usdcContract: string;
  faucetId: string;
  privateKey: string;
}

/** This module is only imported by the Node route, never by a client component. */
export function faucetServerConfig(): FaucetServerConfig {
  const network = process.env.FAUCET_NETWORK ?? process.env.NEXT_PUBLIC_NEAR_NETWORK ?? "testnet";
  const rpcUrl = process.env.FAUCET_RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL
    ?? (network === "testnet" ? "https://near-testnet.drpc.org" : "");
  const usdcContract = process.env.FAUCET_USDC_CONTRACT ?? process.env.NEXT_PUBLIC_USDC_CONTRACT;
  const faucetId = network === "testnet" ? "faucet.ketos.testnet" : process.env.FAUCET_ACCOUNT_ID;
  const privateKey = process.env.FAUCET_PRIVATE_KEY?.trim();
  let url: URL | undefined;
  try { url = new URL(rpcUrl); } catch { /* Invalid configuration is reported without its values. */ }
  if ((network !== "testnet" && network !== "sandbox") || !validAccountId(usdcContract)
    || !validAccountId(faucetId) || !url || !["https:", "http:"].includes(url.protocol)
    || (network === "testnet" && url.protocol !== "https:")) {
    throw new FaucetError(503, "FAUCET_CONFIG", "The faucet is only available on a configured testnet or sandbox deployment.");
  }
  if (!privateKey) throw new FaucetError(503, "FAUCET_KEY_MISSING", "The faucet server signer is not configured. Funding is unavailable.");
  return { network, rpcUrl, usdcContract, faucetId, privateKey };
}

const configSchema = z.object({ faucet_id: z.string(), gas_day: z.number().int().nonnegative(), gas_spent: z.string().regex(/^\d+$/) });
const amountSchema = z.string().regex(/^\d+$/);

export function faucetChain(config: FaucetServerConfig): FaucetChain {
  let signer: KeyPairSigner;
  try { signer = KeyPairSigner.fromSecretKey(config.privateKey as KeyPairString); }
  catch { throw new FaucetError(503, "FAUCET_KEY_INVALID", "The faucet server signing key is invalid. Funding is unavailable."); }
  // One attempt, including send_tx: a timeout must never cause another automatic submission.
  const provider = new JsonRpcProvider({ url: config.rpcUrl }, { retries: 1 });
  const faucet = new Account(config.faucetId, provider, signer);
  return {
    async authorized() {
      const network = await provider.getNetworkId();
      if ((config.network === "testnet" && network !== "testnet")
        || (config.network === "sandbox" && (network === "mainnet" || network === "testnet"))) {
        throw new FaucetError(503, "FAUCET_CONFIG", "The faucet RPC network does not match this test deployment.");
      }
      try {
        const key = await provider.viewAccessKey({ accountId: config.faucetId, publicKey: (await signer.getPublicKey()).toString() });
        return key.permission === "FullAccess";
      } catch (error) {
        if (/AccessKeyDoesNotExist|UnknownAccessKey|does not exist/i.test(error instanceof Error ? error.message : "")) {
          throw new FaucetError(503, "FAUCET_KEY_INVALID", "The faucet key is not installed as a full-access key on its account.");
        }
        throw error;
      }
    },
    async availableBalance(accountId) {
      try {
        const state = await provider.viewAccount({ accountId, blockQuery: { finality: "final" } });
        // NEP-448: small, ordinary accounts are exempt from storage staking, including zero-balance recipients.
        const storage = state.storage_usage <= 770 ? 0n : BigInt(state.storage_usage) * 10n ** 19n;
        const available = state.amount - storage;
        return available > 0n ? available : 0n;
      } catch (error) {
        if (/UnknownAccount|AccountDoesNotExist|does not exist/i.test(error instanceof Error ? error.message : "")) {
          throw accountId === config.faucetId
            ? new FaucetError(503, "FAUCET_CONFIG", "The configured faucet account does not exist.")
            : new FaucetError(400, "ACCOUNT_NOT_FOUND", "This NEAR account does not exist. Create the account before requesting funds.");
        }
        throw error;
      }
    },
    async availableAt(accountId) {
      const result = await provider.callFunction({ contractId: config.usdcContract, method: "faucet_available_at", args: { account_id: accountId } });
      return BigInt(amountSchema.parse(result));
    },
    async config() {
      const parsed = configSchema.safeParse(await provider.callFunction({ contractId: config.usdcContract, method: "faucet_config", args: {} }));
      if (!parsed.success) throw new FaucetError(503, "FAUCET_CONFIG", "The token contract's sponsored faucet configuration is unavailable.");
      return parsed.data;
    },
    async claim(accountId, ipHash, deposit) {
      const signed = await faucet.createSignedTransaction({ receiverId: config.usdcContract,
        actions: [actions.functionCall("faucet_for", { account_id: accountId, ip_hash: ipHash }, teraToGas(50), deposit)] });
      const txHash = baseEncode(createHash("sha256").update(signed.transaction.encode()).digest());
      try {
        // FINAL includes detached transfer/refund receipts, unlike INCLUDED or EXECUTED_OPTIMISTIC.
        const outcome = await provider.sendTransactionUntil(signed, "FINAL");
        return { outcome, txHash };
      } catch (error) {
        const text = error instanceof Error ? `${error.name}: ${error.message}` : "";
        if (/LackBalance|NotEnoughBalance|InsufficientBalance/.test(text)) {
          throw new FaucetError(503, "FAUCET_LOW_RESERVE", "The faucet no longer has enough available NEAR. Funding is paused until its reserve is replenished.");
        }
        if (/AccessKeyDoesNotExist|InvalidAccessKey|SignerDoesNotExist|InvalidSignature/.test(text)) {
          throw new FaucetError(503, "FAUCET_KEY_INVALID", "The faucet signer is unavailable. Funding was not authorized.");
        }
        throw new FaucetError(502, "FAUCET_TX_UNCERTAIN",
          "The funding transaction was submitted but its result is unconfirmed. Check the transaction before retrying.",
          undefined, { tx_hash: txHash });
      }
    },
  };
}
