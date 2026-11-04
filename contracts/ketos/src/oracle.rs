//! Prices from the OutLayer oracle and pinned multisource worker.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Gas, GasWeight, NearToken, Promise};

use crate::market::{MarketId, PriceSource, MAX_PRICE_AGE_MS};
use crate::{Ketos, KetosExt};
use crate::worker_prices::{WORKER_BATCH_SIZE, WORKER_DEPOSIT};

/// Guarantee attached to `oracle_call`; OutLayer sends it back in the same transaction.
pub const ORACLE_CALL_DEPOSIT: NearToken = NearToken::from_millinear(20);

/// Gas kept for `oracle_call` itself on top of the share of unused gas it receives.
const ORACLE_CALL_GAS: Gas = Gas::from_tgas(20);

/// Decimals of the prices stored in markets.
pub const PRICE_DECIMALS: u8 = 8;

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OraclePrice {
    pub multiplier: U128,
    pub decimals: u8,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetOptionalPrice {
    pub asset_id: String,
    pub price: Option<OraclePrice>,
}

/// Payload of the OutLayer oracle (`get_price_data` and `oracle_on_call`).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceData {
    /// Nanoseconds.
    pub timestamp: U64,
    pub recency_duration_sec: u32,
    pub prices: Vec<AssetOptionalPrice>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceView {
    pub market_id: MarketId,
    pub oracle_asset_id: String,
    /// USD per asset unit, 8 decimals; zero before the first update.
    pub price: U128,
    pub timestamp_ms: u64,
    /// True when the price is recent enough to open or close positions.
    pub is_fresh: bool,
}

/// `multiplier / 10^decimals` USD expressed with 8 decimals, rounded down.
/// `None` when the value does not fit.
pub fn to_price8(price: &OraclePrice) -> Option<u128> {
    let m = price.multiplier.0;
    if price.decimals >= PRICE_DECIMALS {
        10u128
            .checked_pow(u32::from(price.decimals - PRICE_DECIMALS))
            .map_or(Some(0), |div| Some(m / div))
    } else {
        10u128
            .checked_pow(u32::from(PRICE_DECIMALS - price.decimals))
            .and_then(|mul| m.checked_mul(mul))
    }
}

#[near]
impl Ketos {
    /// Anyone can request fresh prices; attach 300 Tgas for both adapters and their callbacks.
    pub fn refresh_prices(&mut self) -> Promise {
        let worker_assets: Vec<String> = self
            .markets
            .values()
            .filter(|m| m.price_source == PriceSource::OutlayerWorker)
            .map(|m| m.oracle_asset_id.clone())
            .collect();
        let batches = worker_assets.len().div_ceil(WORKER_BATCH_SIZE);
        let required = ORACLE_CALL_DEPOSIT
            .saturating_add(WORKER_DEPOSIT.saturating_mul(batches as u128));
        let locked = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage()));
        require!(
            env::account_balance().saturating_sub(locked) >= required,
            "ERR_ORACLE_FUNDS_LOW"
        );
        let asset_ids: Vec<String> = self
            .markets
            .values()
            .filter(|m| m.price_source == PriceSource::Tee)
            .map(|m| m.oracle_asset_id.clone())
            .collect();
        let args = json!({
            "receiver_id": env::current_account_id(),
            "asset_ids": asset_ids,
            "msg": "",
        });
        let mut request = Promise::new(self.oracle_id.clone()).function_call_weight(
            "oracle_call".to_string(),
            args.to_string().into_bytes(),
            ORACLE_CALL_DEPOSIT,
            ORACLE_CALL_GAS,
            // The TEE oracle has an extra request/callback layer before our callback.
            GasWeight(3),
        );
        for assets in worker_assets.chunks(WORKER_BATCH_SIZE) {
            request = request.and(self.request_worker_prices(assets));
        }
        // NEAR cannot return a joint promise. The final receipt waits for both adapters.
        request.then(
            Self::ext(env::current_account_id())
                .with_static_gas(Gas::from_tgas(5))
                .with_unused_gas_weight(0)
                .on_prices_refreshed(),
        )
    }

    /// Fresh market count after every requested adapter callback has completed.
    #[private]
    pub fn on_prices_refreshed(&self) -> u32 {
        let now_ms = env::block_timestamp_ms();
        self.markets.values().filter(|market| {
            market.price.0 > 0
                && now_ms.saturating_sub(market.price_timestamp_ms) <= MAX_PRICE_AGE_MS
        }).count() as u32
    }

    /// Price push from the oracle. Only the configured oracle is trusted; `sender_id` (who
    /// requested the push) does not matter since the data comes from the oracle itself.
    pub fn oracle_on_call(&mut self, sender_id: AccountId, data: PriceData, msg: String) {
        let _ = (sender_id, msg);
        require!(
            env::predecessor_account_id() == self.oracle_id,
            "ERR_NOT_ORACLE"
        );
        let now_ms = env::block_timestamp_ms();
        let timestamp_ms = (data.timestamp.0 / 1_000_000).min(now_ms);
        for asset in data.prices {
            let Some(id) = self.oracle_markets.get(&asset.asset_id) else {
                continue;
            };
            let market = self.markets.get_mut(id).expect("indexed market");
            if market.price_source != PriceSource::Tee {
                continue;
            }
            let Some(price) = asset.price.as_ref().and_then(to_price8) else {
                continue;
            };
            if price == 0 || timestamp_ms < market.price_timestamp_ms {
                continue;
            }
            market.price = U128(price);
            market.price_timestamp_ms = timestamp_ms;
        }
    }

    pub fn get_prices(&self) -> Vec<PriceView> {
        let now_ms = env::block_timestamp_ms();
        self.markets
            .values()
            .map(|m| PriceView {
                market_id: m.id.clone(),
                oracle_asset_id: m.oracle_asset_id.clone(),
                price: m.price,
                timestamp_ms: m.price_timestamp_ms,
                is_fresh: m.price.0 > 0
                    && now_ms.saturating_sub(m.price_timestamp_ms) <= MAX_PRICE_AGE_MS,
            })
            .collect()
    }
}
