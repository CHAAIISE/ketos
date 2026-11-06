//! Pinned OutLayer execution; only the promise result can supply worker prices.
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, Gas, GasWeight, NearToken, Promise, PromiseError};

use crate::market::{PriceSource, MAX_PRICE_AGE_MS};
use crate::{Ketos, KetosExt};

pub const WORKER_PROJECT: &str = "ketos.testnet/ketos-prices";
pub const WORKER_WASM_HASH: &str =
    "5d9c5db362f2900c04cd7af58b68330153688e76a120195d96b22d0ef3790d92";
pub const WORKER_ASSETS: [&str; 19] = [
    "BTC", "ETH", "NEAR", "ZEC", "SOL", "DOGE", "XRP", "LTC", "ADA", "SUI",
    "TRX", "BNB", "AVAX", "LINK", "UNI", "AAVE", "BCH", "APT", "ARB",
];
pub const WORKER_BATCH_SIZE: usize = 12;
pub const WORKER_DEPOSIT: NearToken = NearToken::from_millinear(20);
const REQUEST_GAS: Gas = Gas::from_tgas(10);
const CALLBACK_GAS: Gas = Gas::from_tgas(30);

impl Ketos {
    pub(crate) fn request_worker_prices(&self, asset_ids: &[&str]) -> Promise {
        self.request_worker_prices_with_gas(asset_ids, REQUEST_GAS, CALLBACK_GAS, None)
    }

    pub(crate) fn request_worker_prices_with_gas(
        &self, asset_ids: &[&str], request_gas: Gas, callback_gas: Gas, requested_at_ms: Option<u64>,
    ) -> Promise {
        let args = json!({
            "source": { "Project": {
                "project_id": WORKER_PROJECT,
                "version_key": WORKER_WASM_HASH,
            }},
            "resource_limits": {
                "max_instructions": 10_000_000_000u64,
                "max_memory_mb": 128,
                "max_execution_seconds": 60,
            },
            "input_data": json!({ "assets": asset_ids }).to_string(),
            "secrets_ref": null,
            "response_format": "Json",
            "payer_account_id": env::current_account_id(),
            "params": null,
        });
        Promise::new(self.outlayer_id.clone())
            .function_call_weight(
                "request_execution",
                args.to_string().into_bytes(),
                WORKER_DEPOSIT,
                request_gas,
                GasWeight(1),
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "on_worker_prices",
                json!({ "asset_ids": asset_ids, "requested_at_ms": requested_at_ms }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                callback_gas,
            ))
    }
}

#[near]
impl Ketos {
    pub fn get_worker_assets(&self) -> &'static [&'static str] {
        &WORKER_ASSETS
    }

    /// A failed/invalid response never makes the previous price appear fresher.
    #[private]
    pub fn on_worker_prices(
        &mut self,
        asset_ids: Vec<String>,
        requested_at_ms: Option<u64>,
        #[callback_result] result: Result<Option<Value>, PromiseError>,
    ) -> u32 {
        let Ok(Some(Value::Object(response))) = result else {
            return 0;
        };
        if response.len() != 2 || asset_ids.len() > WORKER_BATCH_SIZE {
            return 0;
        }
        let Some(timestamp_ms) = response.get("timestamp_ms").and_then(Value::as_u64) else {
            return 0;
        };
        let now_ms = env::block_timestamp_ms();
        if timestamp_ms == 0 || timestamp_ms > now_ms || now_ms - timestamp_ms > MAX_PRICE_AGE_MS {
            return 0;
        }
        if requested_at_ms.is_some_and(|requested| {
            timestamp_ms < requested || now_ms - timestamp_ms > crate::market::MAX_OPEN_PRICE_AGE_MS
        }) {
            return 0;
        }
        let Some(prices) = response.get("prices").and_then(Value::as_object) else {
            return 0;
        };
        if prices.len() > WORKER_BATCH_SIZE {
            return 0;
        }
        let mut updated = 0;
        for (asset_id, entry) in prices {
            if !asset_ids.contains(asset_id) {
                continue;
            }
            let Some(price) = validated_price(entry) else {
                continue;
            };
            let Some(market_id) = self.oracle_markets.get(asset_id) else {
                continue;
            };
            let market = self.markets.get_mut(market_id).expect("indexed market");
            if market.price_source != PriceSource::OutlayerWorker
                || timestamp_ms <= market.price_timestamp_ms
            {
                continue;
            }
            market.price.0 = price;
            market.price_timestamp_ms = timestamp_ms;
            updated += 1;
        }
        updated
    }
}

fn validated_price(entry: &Value) -> Option<u128> {
    let entry = entry.as_array()?;
    if entry.len() != 2 {
        return None;
    }
    let price = entry[0].as_str()?;
    if price.is_empty() || !price.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let price: u128 = price.parse().ok()?;
    if price == 0 {
        return None;
    }
    let sources = entry[1].as_array()?;
    if !(2..=3).contains(&sources.len()) {
        return None;
    }
    let mut seen = 0u8;
    for source in sources {
        let bit = match source.as_str()? {
            "coinbase" => 1,
            "kraken" => 2,
            "binance" => 4,
            _ => return None,
        };
        if seen & bit != 0 {
            return None;
        }
        seen |= bit;
    }
    Some(price)
}
