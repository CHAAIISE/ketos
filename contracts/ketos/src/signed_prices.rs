//! Exact-byte TEE feed verification. Invalid batches leave the pull path untouched.
use std::collections::BTreeMap;

use near_sdk::json_types::Base64VecU8;
use near_sdk::{env, near, require, CurveType, PublicKey};

use crate::market::{MarketId, PriceSource, VaultId, TEE_MARKETS};
use crate::{Ketos, KetosExt};

const MAX_PAYLOAD_BYTES: usize = 8_192;
const MAX_SIGNED_MARKETS: usize = 12;
const MAX_SIGNED_AGE_MS: u64 = 15_000;

#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SignedPrices {
    pub payload: String,
    pub signature: Base64VecU8,
    pub public_key: String,
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
pub struct VaultDepositRequest {
    pub vault_id: VaultId,
    pub signed_prices: Option<SignedPrices>,
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
struct Payload {
    domain: String,
    prices: BTreeMap<MarketId, SignedPrice>,
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
struct SignedPrice {
    price: String,
    publish_time: u64,
    sources: Vec<String>,
}

#[near]
impl Ketos {
    /// Pin only after checking the key-returning execution's attestation and binary.
    #[private]
    pub fn set_price_signer(&mut self, public_key: PublicKey) {
        require!(self.price_signer.is_none(), "ERR_PRICE_SIGNER_ALREADY_SET");
        require!(public_key.curve_type() == CurveType::ED25519, "ERR_PRICE_SIGNER_CURVE");
        self.price_signer = Some(public_key);
    }

    pub fn get_price_signer(&self) -> Option<PublicKey> {
        self.price_signer.clone()
    }
}

impl Ketos {
    pub(crate) fn apply_signed_prices(
        &mut self,
        signed: Option<&SignedPrices>,
        required: &[MarketId],
    ) -> bool {
        let Some(updates) = self.validate_signed_prices(signed, required) else {
            return false;
        };
        for (id, price, timestamp_ms) in updates {
            let market = self.markets.get_mut(&id).expect("validated market");
            market.price.0 = price;
            market.price_timestamp_ms = timestamp_ms;
        }
        true
    }

    fn validate_signed_prices(
        &self,
        signed: Option<&SignedPrices>,
        required: &[MarketId],
    ) -> Option<Vec<(MarketId, u128, u64)>> {
        let signed = signed?;
        let pinned = self.price_signer.as_ref()?;
        if signed.payload.len() > MAX_PAYLOAD_BYTES || required.is_empty() {
            return None;
        }
        let supplied: PublicKey = signed.public_key.parse().ok()?;
        if &supplied != pinned { return None; }
        let signature: &[u8; 64] = signed.signature.0.as_slice().try_into().ok()?;
        let public_key: &[u8; 32] = pinned.as_bytes().get(1..)?.try_into().ok()?;
        if !env::ed25519_verify(signature, signed.payload.as_bytes(), public_key) {
            return None;
        }
        let payload: Payload = near_sdk::serde_json::from_str(&signed.payload).ok()?;
        if payload.domain != "ketos:prices:v1" || payload.prices.is_empty()
            || payload.prices.len() > MAX_SIGNED_MARKETS {
            return None;
        }
        let now = env::block_timestamp_ms();
        let mut ids: Vec<_> = required.iter().collect();
        ids.sort_unstable();
        ids.dedup();
        let mut updates = Vec::with_capacity(ids.len());
        for id in ids {
            let market = self.markets.get(id)?;
            // A permissionless alias must not borrow another asset's signed ticker.
            let supported = match market.price_source {
                PriceSource::OutlayerWorker => market.oracle_asset_id == market.id
                    && crate::worker_prices::WORKER_ASSETS.contains(&market.id.as_str()),
                PriceSource::Tee => TEE_MARKETS.iter().any(|(symbol, asset, _, _)|
                    *symbol == market.id && *asset == market.oracle_asset_id),
                PriceSource::Signed => false,
            };
            if !supported { return None; }
            let price = payload.prices.get(id)?;
            let timestamp_ms = price.publish_time.checked_mul(1_000)?;
            if timestamp_ms == 0 || timestamp_ms > now || now - timestamp_ms > MAX_SIGNED_AGE_MS
                || timestamp_ms <= market.price_timestamp_ms {
                return None;
            }
            if price.price.is_empty() || !price.price.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let amount: u128 = price.price.parse().ok()?;
            if amount == 0 || !(2..=3).contains(&price.sources.len()) { return None; }
            let mut seen = 0u8;
            for source in &price.sources {
                let bit = match source.as_str() {
                    "coinbase" => 1,
                    "kraken" => 2,
                    "binance" => 4,
                    _ => return None,
                };
                if seen & bit != 0 { return None; }
                seen |= bit;
            }
            updates.push((id.clone(), amount, timestamp_ms));
        }
        Some(updates)
    }
}
