//! Paid market registration through the configured USDC receiver. Listing never supplies
//! a price or depth: those still have to come from the oracle and keeper.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::market::{MarketConfig, MarketId, PriceSource, VaultId, DEFAULT_HARD_CAP, USD};
use crate::{emit_event, Ketos, KetosExt};

pub const MSG_LIST_MARKET: &str = "list_market:";
pub const LISTING_FEE: u128 = 25 * USD;
pub const DEAD_MARKET_AGE_MS: u64 = 7 * 86_400_000;

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
pub struct ListMarketRequest {
    pub symbol: MarketId,
    pub oracle_asset_id: String,
    pub intents_asset_id: String,
    pub price_source: PriceSource,
}

impl Ketos {
    // Not a public NEAR method: only ft_on_transfer can authorize a paid registration.
    pub(crate) fn list_market(&mut self, sender_id: &AccountId, amount: u128, payload: &str) {
        require!(amount == LISTING_FEE, "ERR_LISTING_FEE: exactly 25 USDC");
        require!(payload.len() <= 1024, "ERR_INVALID_LISTING");
        let request: ListMarketRequest = near_sdk::serde_json::from_str(payload)
            .unwrap_or_else(|_| env::panic_str("ERR_INVALID_LISTING"));
        let symbol = request.symbol.as_bytes();
        require!(
            !symbol.is_empty()
                && symbol.len() <= 16
                && symbol[0].is_ascii_uppercase()
                && symbol.iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()),
            "ERR_INVALID_SYMBOL"
        );
        require!(
            !request.oracle_asset_id.is_empty()
                && request.oracle_asset_id.len() <= 128
                && request.oracle_asset_id.bytes().all(|c| c.is_ascii_graphic())
                && !request.intents_asset_id.is_empty()
                && request.intents_asset_id.len() <= 160,
            "ERR_INVALID_ASSET"
        );
        match request.price_source {
            PriceSource::Tee => require!(
                request.oracle_asset_id.parse::<AccountId>().is_ok()
                    && request.intents_asset_id.strip_prefix("nep141:") == Some(request.oracle_asset_id.as_str()),
                "ERR_ASSET_MISMATCH"
            ),
            PriceSource::OutlayerWorker => require!(
                request.symbol == request.oracle_asset_id
                    && crate::worker_prices::WORKER_ASSETS.contains(&request.symbol.as_str())
                    && worker_intents_asset_id(&request.symbol) == Some(request.intents_asset_id.as_str()),
                "ERR_ASSET_MISMATCH"
            ),
            PriceSource::Signed => env::panic_str("ERR_UNSUPPORTED_PRICE_SOURCE"),
        }
        let config = MarketConfig {
            symbol: request.symbol,
            oracle_asset_id: request.oracle_asset_id,
            intents_asset_id: request.intents_asset_id,
            price_source: request.price_source,
            vault_id: VaultId::LongTail,
            hard_cap: U128(DEFAULT_HARD_CAP),
            fee_bps: 10,
            max_leverage_cap: 5,
        };
        let event = json!({
            "account_id": sender_id,
            "market": config,
            "fee": U128(amount),
            "timestamp_ms": env::block_timestamp_ms(),
        });
        self.register_market(config);
        let vault = &mut self.vaults[VaultId::LongTail.index()];
        vault.balance += amount;
        vault.revenue.listing.0 += amount;
        vault.fee_log.record(env::block_timestamp_ms(), amount);
        emit_event("market_listed", event);
    }
}

fn worker_intents_asset_id(symbol: &str) -> Option<&'static str> {
    Some(match symbol {
        "BTC" => "nep141:btc.omft.near",
        "ETH" => "nep141:eth.omft.near",
        "NEAR" => "nep141:wrap.near",
        "ZEC" => "nep141:zec.omft.near",
        "SOL" => "nep141:sol.omft.near",
        "DOGE" => "nep141:doge.omft.near",
        "XRP" => "nep141:xrp.omft.near",
        "LTC" => "nep141:ltc.omft.near",
        "ADA" => "nep141:cardano.omft.near",
        "SUI" => "nep141:sui.omft.near",
        "TRX" => "nep141:tron.omft.near",
        "BNB" => "nep245:v2_1.omni.hot.tg:56_11111111111111111111",
        "AVAX" => "nep245:v2_1.omni.hot.tg:43114_11111111111111111111",
        "LINK" => "nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near",
        "UNI" => "nep141:eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near",
        "AAVE" => "nep141:eth-0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9.omft.near",
        "BCH" => "nep141:bch.omft.near",
        "APT" => "nep141:aptos.omft.near",
        "ARB" => "nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near",
        _ => return None,
    })
}

#[near]
impl Ketos {
    /// Removes an inactive registry entry without refunding its listing fee.
    /// Existing entry orders remain cancellable and are rejected on execution.
    pub fn delist_dead_market(&mut self, market_id: MarketId) {
        let market = self.markets.get(&market_id)
            .unwrap_or_else(|| env::panic_str("ERR_UNKNOWN_MARKET"));
        require!(market.oi_long.0 == 0 && market.oi_short.0 == 0, "ERR_MARKET_HAS_OPEN_INTEREST");
        require!(
            env::block_timestamp_ms().saturating_sub(market.created_at_ms.max(market.depth_measured_at_ms))
                >= DEAD_MARKET_AGE_MS,
            "ERR_MARKET_NOT_DEAD: requires 7 days without depth"
        );
        self.oracle_markets.remove(&market.oracle_asset_id);
        self.markets.remove(&market_id);
        self.depth.remove(&market_id);
        emit_event("market_delisted", json!({
            "market_id": market_id,
            "account_id": env::predecessor_account_id(),
            "timestamp_ms": env::block_timestamp_ms(),
        }));
    }
}
