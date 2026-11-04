//! Paid market registration through the configured USDC receiver. Listing never supplies
//! a price or depth: those still have to come from the oracle and keeper.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::market::{MarketConfig, MarketId, PriceSource, VaultId, DEFAULT_HARD_CAP, USD};
use crate::{emit_event, Ketos};

pub const MSG_LIST_MARKET: &str = "list_market:";
pub const LISTING_FEE: u128 = 5 * USD;

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
        require!(amount == LISTING_FEE, "ERR_LISTING_FEE: exactly 5 USDC");
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
                && request.intents_asset_id.strip_prefix("nep141:")
                    .is_some_and(|id| id.parse::<AccountId>().is_ok()),
            "ERR_INVALID_ASSET"
        );
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
