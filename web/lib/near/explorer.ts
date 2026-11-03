import type { NearNetwork } from "./config";

/** Public explorer page of a transaction; null on the local sandbox, which has no explorer. */
export function txExplorerUrl(network: NearNetwork, txHash: string | null): string | null {
  if (!txHash || network !== "testnet") return null;
  return `https://testnet.nearblocks.io/txns/${txHash}`;
}

/** Public explorer page of an account or contract; null on the local sandbox. */
export function accountExplorerUrl(network: NearNetwork, accountId: string): string | null {
  if (network !== "testnet") return null;
  return `https://testnet.nearblocks.io/address/${accountId}`;
}
