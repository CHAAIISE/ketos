import { z } from "zod";

/** `U128`/`I128` JSON strings from the contract, parsed to bigint. */
const u128 = z.string().regex(/^\d+$/).transform(BigInt);
const i128 = z.string().regex(/^-?\d+$/).transform(BigInt);

/** Markets with a Binance candle feed; the registry itself is open-ended. */
export const MARKET_IDS = ["BTC", "ETH", "NEAR", "ZEC"] as const;
export const marketIdSchema = z.string().min(1);
export type MarketId = z.infer<typeof marketIdSchema>;

export const sideSchema = z.enum(["long", "short"]);
export type Side = z.infer<typeof sideSchema>;

export const marginModeSchema = z.enum(["isolated", "cross"]);
export type MarginMode = z.infer<typeof marginModeSchema>;

export const VAULT_IDS = ["core", "long-tail"] as const;
export const vaultIdSchema = z.enum(VAULT_IDS);
export type VaultId = z.infer<typeof vaultIdSchema>;

/** `tee`: OutLayer price oracle; `outlayer_worker`: our pinned OutLayer worker; `signed`: signed price feed. */
export const priceSourceSchema = z.enum(["tee", "signed", "outlayer_worker"]);
export type PriceSource = z.infer<typeof priceSourceSchema>;

/** Scale of borrow and funding rates and indices: 1e12 = 100%. */
export const RATE_PRECISION = 1_000_000_000_000n;

export const configSchema = z.object({
  usdc_id: z.string(),
  oracle_id: z.string(),
  outlayer_id: z.string(),
  keeper_id: z.string(),
});
export type KetosConfig = z.infer<typeof configSchema>;

export const fundingSchema = z.object({
  /** Cumulative rates per side (long, short), RATE_PRECISION scale. */
  paid_index: z.tuple([u128, u128]),
  received_index: z.tuple([u128, u128]),
  last_accrual_ms: z.number(),
});

export const marketSchema = z.object({
  id: marketIdSchema,
  oracle_asset_id: z.string(),
  intents_asset_id: z.string(),
  price_source: priceSourceSchema,
  vault_id: vaultIdSchema,
  fee_bps: z.number(),
  max_leverage_cap: z.number(),
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
  funding: fundingSchema,
  max_oi_per_side: u128,
  is_open: z.boolean(),
  /** Signed hourly rate, RATE_PRECISION scale: positive means longs pay shorts. */
  funding_rate_per_hour: i128,
});
export type Market = z.infer<typeof marketSchema>;

/** A market waits for its first depth sample before it can open ("measuring"). */
export function isMeasuring(market: Pick<Market, "depth_measured_at_ms">): boolean {
  return market.depth_measured_at_ms === 0;
}

export const accountSchema = z.object({
  account_id: z.string(),
  /** Free margin, USDC units (6 decimals). */
  margin: u128,
  /** Margin locked by pending entry orders. */
  reserved_margin: u128,
});
export type MarginAccount = z.infer<typeof accountSchema>;

export const positionSchema = z.object({
  id: z.number(),
  account_id: z.string(),
  market_id: marketIdSchema,
  side: sideSchema,
  margin_mode: marginModeSchema,
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
  funding_paid: u128,
  funding_received: u128,
  /** Positive = paid by this position, negative = received. */
  funding_payment: i128,
  equity: i128,
  maintenance_margin: u128,
  /** Zero for cross positions: the account health decides instead. */
  liquidation_price: u128,
  take_profit: z.number().nullable(),
  stop_loss: z.number().nullable(),
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
  funding_paid: u128,
  funding_received: u128,
  funding_payment: i128,
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

/** `get_price_data` of the price oracle; without `asset_ids` it lists every asset it supports. */
export const oraclePriceDataSchema = z.looseObject({
  prices: z.array(z.looseObject({ asset_id: z.string() })),
});

export const revenueSchema = z.object({
  fees: u128,
  funding: i128,
  trader_pnl: i128,
  liquidations: u128,
  listing: u128,
});
export type Revenue = z.infer<typeof revenueSchema>;

export const vaultSchema = z.object({
  id: vaultIdSchema,
  balance: u128,
  nav: u128,
  total_shares: u128,
  share_price: u128,
  reserved: u128,
  available: u128,
  cross_receivable: u128,
  traders_unrealized_pnl: i128,
  borrow_fees_due: u128,
  funding_net_due: i128,
  fees_7d: u128,
  fee_apr_bps: z.number(),
  revenue: revenueSchema,
});
export type Vault = z.infer<typeof vaultSchema>;

export const vaultAccountSchema = z.object({
  vault_id: vaultIdSchema,
  account_id: z.string(),
  shares: u128,
  value: u128,
});
export type VaultAccount = z.infer<typeof vaultAccountSchema>;

/** A position can be liquidated once its equity falls to its maintenance margin. */
export function isLiquidatable(position: Pick<Position, "equity" | "maintenance_margin">): boolean {
  return position.equity <= position.maintenance_margin;
}

export const bracketsSchema = z.object({ take_profit: u128.nullable(), stop_loss: u128.nullable() });

export const entryOrderSchema = z.object({
  market_id: marketIdSchema,
  side: sideSchema,
  margin: u128,
  leverage: z.number(),
  trigger_price: u128,
  margin_mode: marginModeSchema,
  brackets: bracketsSchema.nullable(),
});

export const orderSchema = z.object({
  id: z.number(),
  account_id: z.string(),
  created_at_ms: z.number(),
  request: z.discriminatedUnion("kind", [
    entryOrderSchema.extend({ kind: z.literal("limit") }),
    entryOrderSchema.extend({ kind: z.literal("stop_market") }),
    z.object({ kind: z.literal("take_profit"), position_id: z.number(), trigger_price: u128 }),
    z.object({ kind: z.literal("stop_loss"), position_id: z.number(), trigger_price: u128 }),
  ]),
});
export type Order = z.infer<typeof orderSchema>;
export type OrderKind = Order["request"]["kind"];

export const orderExecutionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("skipped"), order_id: z.number() }),
  z.object({ status: z.literal("filled"), order_id: z.number(), position_id: z.number(), price: u128 }),
  z.object({ status: z.literal("rejected"), order_id: z.number(), reason: z.string() }),
]);
export type OrderExecution = z.infer<typeof orderExecutionSchema>;

export const crossAccountSchema = z.object({
  account_id: z.string(),
  cash: i128,
  equity: i128,
  maintenance_margin: u128,
  /** Null without cross positions; 10,000 is the maintenance threshold. */
  health_bps: i128.nullable(),
  position_count: z.number(),
  prices_fresh: z.boolean(),
  liquidatable: z.boolean(),
  debt_by_vault: z.tuple([u128, u128]),
});
export type CrossAccount = z.infer<typeof crossAccountSchema>;

export const vaultSnapshotSchema = z.object({
  timestamp_ms: z.number(),
  nav: u128,
  share_price: u128,
  tvl: u128,
  revenue: revenueSchema,
});
export type VaultSnapshot = z.infer<typeof vaultSnapshotSchema>;

export const historyKindSchema = z.enum(["open", "close", "liquidation", "order_fill", "funding"]);
export type HistoryKind = z.infer<typeof historyKindSchema>;

export const historyEventSchema = z.object({
  sequence: z.number(),
  kind: historyKindSchema,
  position_id: z.number(),
  order_id: z.number().nullable(),
  market_id: marketIdSchema,
  side: sideSchema,
  price: u128,
  size: u128,
  /** Oracle price PnL before costs. */
  pnl: i128,
  /** Settlement delta actually booked, after fees, funding and payout caps. */
  realized_pnl: i128,
  fees: u128,
  funding_paid: u128,
  funding_received: u128,
  /** Net funding booked at settlement (negative = credit). */
  funding_payment: i128,
  timestamp_ms: z.number(),
});
export type HistoryEvent = z.infer<typeof historyEventSchema>;

export const accountStatsSchema = z.object({
  realized_pnl: i128,
  volume: u128,
  trades: z.number(),
  committed_margin: u128,
  event_count: z.number(),
});
export type AccountStats = z.infer<typeof accountStatsSchema>;

export const leaderboardSortSchema = z.enum(["pnl", "volume"]);
export type LeaderboardSort = z.infer<typeof leaderboardSortSchema>;

export const leaderboardEntrySchema = z.object({
  account_id: z.string(),
  realized_pnl: i128,
  volume: u128,
  trades: z.number(),
  committed_margin: u128,
  roi_bps: i128,
});
export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;
