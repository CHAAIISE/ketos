use near_sdk::json_types::{I128, U128};
use near_sdk::{env, near, require};

use crate::depth::MAX_DEPTH_AGE_MS;
use crate::funding::{funding_rate, Funding};
use crate::math::{
    borrow_index_delta, borrow_rate_per_hour, mul_div_ceil, mul_div_floor, to_i128,
    BPS, RATE_PRECISION,
};
use crate::position::Side;
use crate::{Ketos, KetosExt};

/// USDC has 6 decimals: one dollar is 1_000_000 units.
pub const USD: u128 = 1_000_000;

/// Static per-side ceiling, applied on top of the live exit-liquidity cap.
pub const DEFAULT_HARD_CAP: u128 = 500_000 * USD;

/// Leverage allowed before any depth sample: the lowest tier.
pub const DEFAULT_MAX_LEVERAGE: u32 = 2;

/// Below this exit capacity a market takes no new positions.
pub const MIN_OPEN_CAPACITY: u128 = 10_000 * USD;

/// Normal closes, liquidations and LP valuation require prices within this age.
pub const MAX_PRICE_AGE_MS: u64 = 120_000;
pub const MAX_OPEN_PRICE_AGE_MS: u64 = 30_000;
pub const STALE_CLOSE_INTERVAL_MS: u64 = 10 * 60_000;

pub type MarketId = String;

#[near(serializers = [json, borsh])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PriceSource {
    Tee,
    Signed,
    #[serde(rename = "outlayer_worker")]
    OutlayerWorker,
}

#[near(serializers = [json, borsh])]
#[serde(rename_all = "kebab-case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultId {
    Core,
    LongTail,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MarketConfig {
    pub symbol: MarketId,
    pub oracle_asset_id: String,
    pub intents_asset_id: String,
    pub price_source: PriceSource,
    pub vault_id: VaultId,
    pub hard_cap: U128,
    pub fee_bps: u32,
    pub max_leverage_cap: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Market {
    /// Short ticker used as the market key.
    pub id: MarketId,
    /// Oracle asset id, or uppercase worker symbol for `outlayer_worker`.
    pub oracle_asset_id: String,
    pub intents_asset_id: String,
    pub price_source: PriceSource,
    pub vault_id: VaultId,
    /// Fee charged on notional at both entry and exit.
    pub fee_bps: u32,
    /// Listing ceiling, also applied when live depth allows a higher leverage tier.
    pub max_leverage_cap: u32,
    /// Maximum open interest per side in USDC units, before the exit-liquidity cap.
    pub hard_cap: U128,
    /// Largest size (USDC units) that exits to USDC on NEAR Intents within 100 bps of impact.
    pub exit_capacity: U128,
    /// When the depth behind `exit_capacity` was measured; zero before the first sample.
    pub depth_measured_at_ms: u64,
    pub oi_long: U128,
    pub oi_short: U128,
    pub max_leverage: u32,
    /// Last oracle price, 8 decimals (USD per asset unit). Zero until the first update.
    pub price: U128,
    pub price_timestamp_ms: u64,
    /// Cumulative borrow fee per unit of notional (RATE_PRECISION scale), one per side.
    pub borrow_index_long: U128,
    pub borrow_index_short: U128,
    pub last_accrual_ms: u64,
    pub funding: Funding,
    /// Per-side sums over open positions, so the vault can mark all of them in O(markets):
    /// Σ size × ENTRY_UNIT_SCALE / entry_price, and Σ size × entry borrow index.
    #[serde(skip)]
    pub entry_units: [u128; 2],
    #[serde(skip)]
    pub borrow_weight: [u128; 2],
}

/// Scale of `entry_units`: keeps precision for 8-decimal prices of any magnitude.
pub const ENTRY_UNIT_SCALE: u128 = 1_000_000_000_000_000_000;

fn side_index(side: Side) -> usize {
    match side {
        Side::Long => 0,
        Side::Short => 1,
    }
}

/// Market with the limits derived from its latest depth sample at the current block time.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketView {
    #[serde(flatten)]
    pub market: Market,
    pub max_oi_per_side: U128,
    /// Capital-backed total per-side ceiling, in micro-USDC like `exit_capacity`.
    pub vault_backed_cap_usd: U128,
    pub effective_max_oi_per_side: U128,
    /// The measured capacity reached the largest size in the latest sample grid.
    pub measured_cap_is_grid_max: bool,
    /// Depth and capital admit a price-pull request; execution still requires a fresh mark.
    pub is_open: bool,
    /// Signed hourly rate, RATE_PRECISION scale: positive means longs pay shorts.
    pub funding_rate_per_hour: I128,
    pub close_only: bool,
    pub stale_close_spread_bps: u32,
}

impl Market {
    pub fn new(config: MarketConfig) -> Self {
        let now_ms = env::block_timestamp_ms();
        Self {
            id: config.symbol,
            oracle_asset_id: config.oracle_asset_id,
            intents_asset_id: config.intents_asset_id,
            price_source: config.price_source,
            vault_id: config.vault_id,
            fee_bps: config.fee_bps,
            max_leverage_cap: config.max_leverage_cap,
            hard_cap: config.hard_cap,
            exit_capacity: U128(0),
            depth_measured_at_ms: 0,
            oi_long: U128(0),
            oi_short: U128(0),
            max_leverage: DEFAULT_MAX_LEVERAGE.min(config.max_leverage_cap),
            price: U128(0),
            price_timestamp_ms: 0,
            borrow_index_long: U128(0),
            borrow_index_short: U128(0),
            last_accrual_ms: now_ms,
            funding: Funding::new(now_ms),
            entry_units: [0; 2],
            borrow_weight: [0; 2],
        }
    }

    /// Adds (`open = true`) or removes a position from the per-side exposure sums.
    pub fn track(&mut self, side: Side, size: u128, entry: u128, entry_index: u128, open: bool) {
        let i = side_index(side);
        let units = mul_div_floor(size, ENTRY_UNIT_SCALE, entry);
        let weight = size * entry_index;
        if open {
            self.entry_units[i] += units;
            self.borrow_weight[i] += weight;
        } else {
            self.entry_units[i] = self.entry_units[i].saturating_sub(units);
            self.borrow_weight[i] = self.borrow_weight[i].saturating_sub(weight);
        }
    }

    /// Net unrealized PnL of all traders at the last oracle price (positive = traders win).
    pub fn traders_pnl(&self) -> i128 {
        let mark = self.price.0;
        let long_value = mul_div_floor(self.entry_units[0], mark, ENTRY_UNIT_SCALE);
        let short_value = mul_div_ceil(self.entry_units[1], mark, ENTRY_UNIT_SCALE);
        to_i128(long_value) - to_i128(self.oi_long.0) + to_i128(self.oi_short.0)
            - to_i128(short_value)
    }

    /// Borrow fees accrued by open positions and not yet paid, as of `now_ms`.
    pub fn borrow_fees_due(&self, now_ms: u64) -> u128 {
        [Side::Long, Side::Short]
            .into_iter()
            .map(|side| {
                let accrued = self.borrow_index_at(side, now_ms) * self.oi(side);
                accrued.saturating_sub(self.borrow_weight[side_index(side)]) / RATE_PRECISION
            })
            .sum()
    }

    pub fn max_oi_per_side(&self) -> u128 {
        self.hard_cap.0.min(self.exit_capacity.0)
    }

    /// Why the market refuses new positions at `now_ms`, if it does.
    pub fn closed_reason(&self, now_ms: u64) -> Option<&'static str> {
        if self.depth_measured_at_ms == 0
            || now_ms.saturating_sub(self.depth_measured_at_ms) > MAX_DEPTH_AGE_MS
        {
            Some("ERR_MARKET_CLOSED: depth sample older than 30 minutes")
        } else if self.exit_capacity.0 < MIN_OPEN_CAPACITY {
            Some("ERR_MARKET_CLOSED: exit liquidity below $10,000")
        } else {
            None
        }
    }

    fn view(
        &self,
        now_ms: u64,
        vault_backed_cap: u128,
        vault_within_limit: bool,
        measured_cap_is_grid_max: bool,
    ) -> MarketView {
        let effective_cap = self.max_oi_per_side().min(vault_backed_cap);
        MarketView {
            market: self.clone(),
            max_oi_per_side: U128(self.max_oi_per_side()),
            vault_backed_cap_usd: U128(vault_backed_cap),
            effective_max_oi_per_side: U128(effective_cap),
            measured_cap_is_grid_max,
            is_open: self.closed_reason(now_ms).is_none()
                && vault_within_limit
                && self.oi_long.0.min(self.oi_short.0) < effective_cap,
            funding_rate_per_hour: I128(funding_rate(self.oi_long.0, self.oi_short.0)),
            close_only: self.price.0 > 0
                && now_ms.saturating_sub(self.price_timestamp_ms) > MAX_OPEN_PRICE_AGE_MS,
            stale_close_spread_bps: self.stale_close_spread_bps(now_ms),
        }
    }

    pub fn oi(&self, side: Side) -> u128 {
        match side {
            Side::Long => self.oi_long.0,
            Side::Short => self.oi_short.0,
        }
    }

    pub fn oi_mut(&mut self, side: Side) -> &mut u128 {
        match side {
            Side::Long => &mut self.oi_long.0,
            Side::Short => &mut self.oi_short.0,
        }
    }

    /// Borrow index of `side` as of `now_ms`, including growth not yet written to state.
    pub fn borrow_index_at(&self, side: Side, now_ms: u64) -> u128 {
        let stored = match side {
            Side::Long => self.borrow_index_long.0,
            Side::Short => self.borrow_index_short.0,
        };
        let elapsed = now_ms.saturating_sub(self.last_accrual_ms);
        let rate = borrow_rate_per_hour(self.oi(side), self.max_oi_per_side());
        stored + borrow_index_delta(rate, elapsed)
    }

    /// Writes borrow and funding growth before any change of OI or cap, preserving the
    /// utilization and imbalance that were in force during the elapsed period.
    pub fn accrue(&mut self, now_ms: u64) {
        self.funding = self.funding_at(now_ms);
        self.borrow_index_long = U128(self.borrow_index_at(Side::Long, now_ms));
        self.borrow_index_short = U128(self.borrow_index_at(Side::Short, now_ms));
        self.last_accrual_ms = now_ms;
    }

    /// Oracle price if it is set and at most `MAX_PRICE_AGE_MS` old.
    pub fn fresh_price(&self, now_ms: u64) -> u128 {
        require!(self.price.0 > 0, "ERR_NO_PRICE");
        require!(
            now_ms.saturating_sub(self.price_timestamp_ms) <= MAX_PRICE_AGE_MS,
            "ERR_STALE_PRICE"
        );
        self.price.0
    }

    pub(crate) fn stale_close_spread_bps(&self, now_ms: u64) -> u32 {
        let age = now_ms.saturating_sub(self.price_timestamp_ms);
        if age <= crate::pull_prices::ACTION_CACHE_MAX_AGE_MS {
            return 0;
        }
        (age.div_ceil(STALE_CLOSE_INTERVAL_MS).min(6) * 50) as u32
    }

    /// A successful pull or cache hit uses the normal mark; fallback needs a failed pull.
    pub(crate) fn closing_price(&self, now_ms: u64) -> Result<u128, &'static str> {
        if self.price.0 == 0 {
            return Err("ERR_NO_PRICE");
        }
        let age = now_ms.saturating_sub(self.price_timestamp_ms);
        if age <= MAX_PRICE_AGE_MS {
            return Ok(self.price.0);
        }
        Err("ERR_STALE_PRICE")
    }

    pub(crate) fn failed_pull_close_price(&self, side: Side, now_ms: u64) -> u128 {
        let age = now_ms.saturating_sub(self.price_timestamp_ms);
        let spread = u128::from((age.div_ceil(STALE_CLOSE_INTERVAL_MS).clamp(1, 6) * 50) as u32);
        match side {
            Side::Long => mul_div_floor(self.price.0, BPS - spread, BPS),
            Side::Short => mul_div_ceil(self.price.0, BPS + spread, BPS),
        }
    }
}

/// Initial registry; new markets use the same configuration and risk machinery.
pub fn default_markets() -> impl Iterator<Item = MarketConfig> {
    [
        ("BTC", "nbtc.bridge.near", "btc.omft.near", VaultId::Core),
        ("ETH", "aurora", "eth.omft.near", VaultId::Core),
        ("NEAR", "wrap.near", "wrap.near", VaultId::Core),
        ("ZEC", "zec.omft.near", "zec.omft.near", VaultId::LongTail),
        ("SOL", "22.contract.portalbridge.near", "sol.omft.near", VaultId::Core),
        (
            "AURORA",
            "aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near",
            "aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near",
            VaultId::LongTail,
        ),
        ("RHEA", "token.rhealab.near", "token.rhealab.near", VaultId::LongTail),
    ]
    .into_iter()
    .map(|(symbol, oracle_asset_id, intents_asset_id, vault_id)| MarketConfig {
        symbol: symbol.into(),
        oracle_asset_id: oracle_asset_id.into(),
        intents_asset_id: format!("nep141:{intents_asset_id}"),
        price_source: PriceSource::Tee,
        vault_id,
        hard_cap: U128(DEFAULT_HARD_CAP),
        fee_bps: 10,
        max_leverage_cap: 20,
    })
    .chain(worker_markets())
}

fn worker_markets() -> impl Iterator<Item = MarketConfig> {
    [
        ("DOGE", "nep141:doge.omft.near"),
        ("XRP", "nep141:xrp.omft.near"),
        ("LTC", "nep141:ltc.omft.near"),
        ("ADA", "nep141:cardano.omft.near"),
        ("SUI", "nep141:sui.omft.near"),
        ("TRX", "nep141:tron.omft.near"),
        ("BNB", "nep245:v2_1.omni.hot.tg:56_11111111111111111111"),
        ("AVAX", "nep245:v2_1.omni.hot.tg:43114_11111111111111111111"),
        ("LINK", "nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near"),
    ]
    .into_iter()
    .map(|(symbol, intents_asset_id)| MarketConfig {
        symbol: symbol.into(),
        oracle_asset_id: symbol.into(),
        intents_asset_id: intents_asset_id.into(),
        price_source: PriceSource::OutlayerWorker,
        vault_id: VaultId::LongTail,
        hard_cap: U128(DEFAULT_HARD_CAP),
        fee_bps: 10,
        max_leverage_cap: 5,
    })
}

impl Ketos {
    /// Conservative cash-backed NAV budget and current largest-side vault exposure.
    pub(crate) fn vault_capital_limits(&self, vault_id: VaultId) -> (u128, u128) {
        (
            self.get_vault(vault_id).nav.0.saturating_mul(vault_id.oi_multiplier()),
            self.vault_exposure(vault_id),
        )
    }

    /// Total market ceiling, not additional room; other markets consume the shared budget.
    pub(crate) fn vault_backed_cap(
        market: &Market,
        (limit, exposure): (u128, u128),
    ) -> u128 {
        market.oi_long.0.max(market.oi_short.0)
            .saturating_add(limit.saturating_sub(exposure))
    }

    fn market_view(
        &self,
        market: &Market,
        now_ms: u64,
        (limit, exposure): (u128, u128),
    ) -> MarketView {
        let cap = Self::vault_backed_cap(market, (limit, exposure));
        let grid_max = self.depth.get(&market.id)
            .and_then(|history| history.last())
            .is_some_and(|record| {
                record.samples.last()
                    .is_some_and(|sample| sample.size_usd == record.exit_capacity_usd)
            });
        market.view(now_ms, cap, exposure <= limit, grid_max)
    }

    /// Shared insertion path; no privileged endpoint can change a live market's terms.
    pub(crate) fn register_market(&mut self, config: MarketConfig) {
        require!(
            !self.markets.contains_key(&config.symbol),
            "ERR_MARKET_EXISTS"
        );
        require!(
            !self.oracle_markets.contains_key(&config.oracle_asset_id)
                && !self.markets.values().any(|m| m.intents_asset_id == config.intents_asset_id),
            "ERR_ASSET_EXISTS"
        );
        require!(
            !config.symbol.is_empty()
                && !config.oracle_asset_id.is_empty()
                && !config.intents_asset_id.is_empty()
                && config.hard_cap.0 > 0
                && config.fee_bps <= 10
                && (1..=20).contains(&config.max_leverage_cap),
            "ERR_INVALID_MARKET_CONFIG"
        );
        if config.price_source == PriceSource::OutlayerWorker {
            require!(
                crate::worker_prices::WORKER_ASSETS.contains(&config.oracle_asset_id.as_str()),
                "ERR_UNSUPPORTED_WORKER_ASSET"
            );
        }
        self.oracle_markets.insert(config.oracle_asset_id.clone(), config.symbol.clone());
        self.markets.insert(config.symbol.clone(), Market::new(config));
    }
}

#[near]
impl Ketos {
    /// At most 100 markets per page, in listing order.
    pub fn get_markets(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<MarketView> {
        let now_ms = env::block_timestamp_ms();
        // NAV marks positions, so compute it once per vault rather than once per market.
        let limits = [
            self.vault_capital_limits(VaultId::Core),
            self.vault_capital_limits(VaultId::LongTail),
        ];
        self.markets
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|m| self.market_view(m, now_ms, limits[m.vault_id.index()]))
            .collect()
    }

    pub fn get_market(&self, market_id: MarketId) -> Option<MarketView> {
        self.markets
            .get(&market_id)
            .map(|m| self.market_view(m, env::block_timestamp_ms(), self.vault_capital_limits(m.vault_id)))
    }
}
