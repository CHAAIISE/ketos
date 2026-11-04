import type { NearConfig } from "./config";
import type { NearTransaction } from "./tx";
import type { MarketId, Side } from "./types";

const TGAS = 10n ** 12n;
/** Enough for `ft_transfer_call` → `ft_on_transfer` → `ft_resolve_transfer` and for withdraw callbacks. */
const GAS = 100n * TGAS;
/** Methods guarded by `assert_one_yocto` require a full-access key confirmation. */
const ONE_YOCTO = 1n;

export const MSG_DEPOSIT_MARGIN = "deposit_margin";
export const MSG_DEPOSIT_VAULT = "deposit_vault";

type Contracts = Pick<NearConfig, "ketosContract" | "usdcContract">;

function call(
  receiverId: string,
  methodName: string,
  args: Record<string, unknown>,
  deposit = 0n,
): NearTransaction {
  return { receiverId, actions: [{ methodName, args, gas: GAS, deposit }] };
}

/** Claims 1,000 tUSDC (once per hour); registers the account on the token if needed. */
export function faucetTx(c: Contracts): NearTransaction {
  return call(c.usdcContract, "faucet", {});
}

function depositTx(c: Contracts, amount: bigint, msg: string): NearTransaction {
  return call(
    c.usdcContract,
    "ft_transfer_call",
    { receiver_id: c.ketosContract, amount: amount.toString(), msg },
    ONE_YOCTO,
  );
}

/** Moves `amount` USDC units from the tUSDC wallet into free margin. */
export function depositMarginTx(c: Contracts, amount: bigint): NearTransaction {
  return depositTx(c, amount, MSG_DEPOSIT_MARGIN);
}

/** Sends `amount` USDC units of free margin back to the tUSDC wallet. */
export function withdrawMarginTx(c: Contracts, amount: bigint): NearTransaction {
  return call(c.ketosContract, "withdraw_margin", { amount: amount.toString() }, ONE_YOCTO);
}

export interface OpenPositionArgs {
  marketId: MarketId;
  side: Side;
  /** Collateral taken from free margin, USDC units. */
  margin: bigint;
  leverage: number;
}

export function openPositionTx(c: Contracts, args: OpenPositionArgs): NearTransaction {
  return call(c.ketosContract, "open_position", {
    market_id: args.marketId,
    side: args.side,
    margin: args.margin.toString(),
    leverage: args.leverage,
  });
}

export function closePositionTx(c: Contracts, positionId: number): NearTransaction {
  return call(c.ketosContract, "close_position", { position_id: positionId });
}

/** Moves `amount` USDC units from the tUSDC wallet into the liquidity vault. */
export function depositVaultTx(c: Contracts, amount: bigint): NearTransaction {
  return depositTx(c, amount, MSG_DEPOSIT_VAULT);
}

/** Burns `shares` vault shares for USDC at the current NAV. */
export function withdrawVaultTx(c: Contracts, shares: bigint): NearTransaction {
  return call(c.ketosContract, "withdraw_vault", { shares: shares.toString() }, ONE_YOCTO);
}
