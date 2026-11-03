//! Local stand-in for OutLayer's `price-oracle.testnet`, used in sandbox and end-to-end runs.
//! Exposes the same read and push interface (`get_price_data`, `request_price_data`,
//! `oracle_call` → `receiver.oracle_on_call`), plus an owner-only `set_price` to move markets.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::IterableMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault,
    Promise,
};

/// Same minimum as the OutLayer oracle for a pushed price request.
pub const MIN_ORACLE_CALL_DEPOSIT: NearToken = NearToken::from_millinear(10);
const RECENCY_DURATION_SEC: u32 = 300;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Price {
    pub multiplier: U128,
    pub decimals: u8,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetOptionalPrice {
    pub asset_id: String,
    pub price: Option<Price>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceData {
    /// Nanoseconds, serialized as a string like the OutLayer oracle.
    pub timestamp: U64,
    pub recency_duration_sec: u32,
    pub prices: Vec<AssetOptionalPrice>,
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Prices,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOracle {
    owner_id: AccountId,
    prices: IterableMap<String, Price>,
}

#[near]
impl MockOracle {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            prices: IterableMap::new(StorageKey::Prices),
        }
    }

    pub fn set_price(&mut self, asset_id: String, multiplier: U128, decimals: u8) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "ERR_NOT_OWNER"
        );
        require!(multiplier.0 > 0, "ERR_ZERO_PRICE");
        self.prices.insert(
            asset_id,
            Price {
                multiplier,
                decimals,
            },
        );
    }

    /// Prices are reported as fresh at the current block: the mock has no feed to lag behind.
    pub fn get_price_data(&self, asset_ids: Option<Vec<String>>) -> PriceData {
        let ids = asset_ids.unwrap_or_else(|| self.prices.keys().cloned().collect());
        PriceData {
            timestamp: U64(env::block_timestamp()),
            recency_duration_sec: RECENCY_DURATION_SEC,
            prices: ids
                .into_iter()
                .map(|asset_id| {
                    let price = self.prices.get(&asset_id).cloned();
                    AssetOptionalPrice { asset_id, price }
                })
                .collect(),
        }
    }

    #[payable]
    pub fn request_price_data(&mut self, asset_ids: Option<Vec<String>>) -> PriceData {
        self.get_price_data(asset_ids)
    }

    #[payable]
    pub fn oracle_call(
        &mut self,
        receiver_id: AccountId,
        asset_ids: Option<Vec<String>>,
        msg: String,
    ) -> Promise {
        require!(
            env::attached_deposit() >= MIN_ORACLE_CALL_DEPOSIT,
            "ERR_DEPOSIT_TOO_LOW"
        );
        let data = self.get_price_data(asset_ids);
        let args = json!({
            "sender_id": env::predecessor_account_id(),
            "data": data,
            "msg": msg,
        });
        Promise::new(receiver_id).function_call_weight(
            "oracle_on_call".to_string(),
            args.to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(0),
            GasWeight(1),
        )
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
    use near_sdk::testing_env;

    fn owner() -> AccountId {
        "owner.test".parse().unwrap()
    }

    fn ctx(predecessor: &str, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(predecessor.parse().unwrap())
            .attached_deposit(deposit)
            .block_timestamp(1_700_000_000_000_000_000)
            .prepaid_gas(Gas::from_tgas(200))
            .build());
    }

    fn seeded() -> MockOracle {
        ctx("owner.test", NearToken::from_yoctonear(0));
        let mut oracle = MockOracle::new(owner());
        oracle.set_price("wrap.near".into(), U128(382_231_700), 8);
        oracle
    }

    #[test]
    fn price_data_matches_outlayer_shape() {
        let oracle = seeded();
        let data = oracle.get_price_data(Some(vec!["wrap.near".into(), "aurora".into()]));
        let value = near_sdk::serde_json::to_value(&data).unwrap();
        assert_eq!(value["timestamp"], "1700000000000000000");
        assert_eq!(value["recency_duration_sec"], 300);
        assert_eq!(value["prices"][0]["asset_id"], "wrap.near");
        assert_eq!(value["prices"][0]["price"]["multiplier"], "382231700");
        assert_eq!(value["prices"][0]["price"]["decimals"], 8);
        assert!(value["prices"][1]["price"].is_null());
    }

    #[test]
    fn set_price_overwrites() {
        let mut oracle = seeded();
        oracle.set_price("wrap.near".into(), U128(300_000_000), 8);
        let data = oracle.get_price_data(None);
        assert_eq!(data.prices.len(), 1);
        assert_eq!(
            data.prices[0].price.as_ref().unwrap().multiplier,
            U128(300_000_000)
        );
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_OWNER")]
    fn set_price_is_owner_only() {
        let mut oracle = seeded();
        ctx("mallory.test", NearToken::from_yoctonear(0));
        oracle.set_price("wrap.near".into(), U128(1), 8);
    }

    #[test]
    #[should_panic(expected = "ERR_ZERO_PRICE")]
    fn zero_price_rejected() {
        let mut oracle = seeded();
        oracle.set_price("wrap.near".into(), U128(0), 8);
    }

    #[test]
    #[should_panic(expected = "ERR_DEPOSIT_TOO_LOW")]
    fn oracle_call_requires_deposit() {
        let mut oracle = seeded();
        ctx("perps.test", NearToken::from_yoctonear(1));
        let _ = oracle.oracle_call("perps.test".parse().unwrap(), None, "refresh".into());
    }

    #[test]
    fn oracle_call_pushes_to_receiver() {
        let mut oracle = seeded();
        ctx("perps.test", MIN_ORACLE_CALL_DEPOSIT);
        let _ = oracle.oracle_call(
            "perps.test".parse().unwrap(),
            Some(vec!["wrap.near".into()]),
            "refresh".into(),
        );
        let receipts = get_created_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receiver_id.as_str(), "perps.test");
        let MockAction::FunctionCallWeight {
            method_name, args, ..
        } = &receipts[0].actions[0]
        else {
            panic!("expected a function call");
        };
        assert_eq!(method_name.as_slice(), b"oracle_on_call");
        let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
        assert_eq!(args["sender_id"], "perps.test");
        assert_eq!(args["msg"], "refresh");
        assert_eq!(
            args["data"]["prices"][0]["price"]["multiplier"],
            "382231700"
        );
    }
}
