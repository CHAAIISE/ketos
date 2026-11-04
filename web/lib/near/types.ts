import { z } from "zod";

/** `U128`/`I128` JSON strings from the contract, parsed to bigint. */
const u128 = z.string().regex(/^\d+$/).transform(BigInt);
const i128 = z.string().regex(/^-?\d+$/).transform(BigInt);

export const MARKET_IDS = ["BTC", "ETH", "NEAR", "ZEC"] as const;
export const marketIdSchema = z.string().min(1);
export type MarketId = z.infer<typeof marketIdSchema>;

export const sideSchema = z.enum(["long", "short"]);
export type Side = z.infer<typeof sideSchema>;

export const configSchema = z.object({
  usdc_id: z.string(),
  oracle_id: z.string(),
  keeper_id: z.string(),
});
export type PerpsConfig = z.infer<typeof configSchema>;

export const marketSchema = z.object({
  id: marketIdSchema,
  oracle_asset_id: z.string(),
  hard_cap: u128,
  exit_capacity: u128,
  depth_measured_at_ms: z.number(),
  oi_long: u128,
  oi_short: u128,
  max_leverage: z.number(),
  /** 8 decimals; zero before the first oracle update. */
  price: u128,
  price_timestamp_ms: z.number(),
  borrow_index_long: u128,
  borrow_index_short: u128,
  last_accrual_ms: z.number(),
  max_oi_per_side: u128,
  is_open: z.boolean(),
});
export type Market = z.infer<typeof marketSchema>;

export const accountSchema = z.object({
  account_id: z.string(),
  /** Free margin, USDC units (6 decimals). */
  margin: u128,
});
export type MarginAccount = z.infer<typeof accountSchema>;

export const positionSchema = z.object({
  id: z.number(),
  account_id: z.string(),
  market_id: marketIdSchema,
  side: sideSchema,
  margin: u128,
  size: u128,
  entry_price: u128,
  leverage: z.number(),
  max_leverage: z.number(),
  opened_at_ms: z.number(),
  mark_price: u128,
  mark_price_timestamp_ms: z.number(),
  unrealized_pnl: i128,
  borrow_fee: u128,
  close_fee: u128,
  equity: i128,
  maintenance_margin: u128,
  liquidation_price: u128,
});
export type Position = z.infer<typeof positionSchema>;

export const depthSampleSchema = z.object({
  size_usd: z.number(),
  impact_bps: z.number().nullable(),
});
export type DepthSample = z.infer<typeof depthSampleSchema>;

export const depthRecordSchema = z.object({
  measured_at_ms: z.number(),
  exit_capacity_usd: z.number(),
  max_leverage: z.number(),
  samples: z.array(depthSampleSchema),
});
export type DepthRecord = z.infer<typeof depthRecordSchema>;

export const depthViewSchema = z.object({
  market: marketSchema,
  /** Oldest first, at most 48 entries. */
  history: z.array(depthRecordSchema),
});
export type DepthView = z.infer<typeof depthViewSchema>;

export const liquidationSchema = z.object({
  position_id: z.number(),
  account_id: z.string(),
  market_id: marketIdSchema,
  side: sideSchema,
  size: u128,
  entry_price: u128,
  price: u128,
  equity: i128,
  penalty: u128,
  reward: u128,
  returned: u128,
  liquidator: z.string(),
  timestamp_ms: z.number(),
});
export type Liquidation = z.infer<typeof liquidationSchema>;

export const priceSchema = z.object({
  market_id: marketIdSchema,
  oracle_asset_id: z.string(),
  price: u128,
  timestamp_ms: z.number(),
  is_fresh: z.boolean(),
});
export type OraclePriceView = z.infer<typeof priceSchema>;

export const vaultSchema = z.object({
  balance: u128,
  nav: u128,
  total_shares: u128,
  share_price: u128,
  reserved: u128,
  available: u128,
  traders_unrealized_pnl: i128,
  borrow_fees_due: u128,
  fees_7d: u128,
  fee_apr_bps: z.number(),
});
export type Vault = z.infer<typeof vaultSchema>;

export const vaultAccountSchema = z.object({
  account_id: z.string(),
  shares: u128,
  value: u128,
});
export type VaultAccount = z.infer<typeof vaultAccountSchema>;

/** A position can be liquidated once its equity falls to its maintenance margin. */
export function isLiquidatable(position: Pick<Position, "equity" | "maintenance_margin">): boolean {
  return position.equity <= position.maintenance_margin;
}
