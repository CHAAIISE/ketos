import { USDC_DECIMALS, formatUnits } from "@/lib/near/format";
import type { Vault } from "@/lib/near/types";

/** Vault shares use 6 decimals, like USDC; 1 share is worth $1 before the first deposit. */
export const SHARE_DECIMALS = 6;

/** Shares minted for a deposit, rounded down as the contract does. */
export function sharesForDeposit(amount: bigint, vault: Vault): bigint {
  if (vault.total_shares === 0n) return amount;
  if (vault.nav === 0n) return 0n;
  return (amount * vault.total_shares) / vault.nav;
}

/** Shares to burn to receive at most `value` USDC units, rounded down. */
export function sharesForValue(value: bigint, vault: Vault): bigint {
  if (vault.nav === 0n) return 0n;
  return (value * vault.total_shares) / vault.nav;
}

/** USDC units paid out for burning `shares`, rounded down as the contract does. */
export function valueOfShares(shares: bigint, vault: Vault): bigint {
  if (vault.total_shares === 0n) return 0n;
  return (shares * vault.nav) / vault.total_shares;
}

export function formatShares(shares: bigint): string {
  return formatUnits(shares, SHARE_DECIMALS, { maxFractionDigits: 4, minFractionDigits: 2 });
}

/** Full-precision USDC amount for an input field: "1234.5", no grouping. */
export function toInputAmount(units: bigint): string {
  return formatUnits(units, USDC_DECIMALS, { maxFractionDigits: USDC_DECIMALS, minFractionDigits: 0, grouping: false });
}
