//! Local stand-in for OutLayer's `price-oracle.testnet`, used in sandbox and end-to-end runs.
//! Exposes the TEE read/push interface and the pinned Ketos worker's `request_execution`,
//! with owner-controlled prices and execution responses for sandbox failure scenarios.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Map, Value};
use near_sdk::store::IterableMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault,
    Promise,
};

/// Same minimum as the OutLayer oracle for a pushed price request.
pub const MIN_ORACLE_CALL_DEPOSIT: NearToken = NearToken::from_millinear(10);
pub const MIN_EXECUTION_DEPOSIT: NearToken = NearToken::from_millinear(20);
const WORKER_PROJECT: &str = "ketos.testnet/ketos-prices";
const WORKER_VERSION: &str = "cb7881555d790224f06738cd0c95aeb8798b1acd99548affcd4ea737e71aa07f";

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
    use_canned_response: bool,
    execution_response: Option<String>,
    fail_execution: bool,
    fail_tee: bool,
    recency_duration_sec: u32,
}

#[near]
impl MockOracle {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            prices: IterableMap::new(StorageKey::Prices),
            use_canned_response: false,
            execution_response: None,
            fail_execution: false,
            fail_tee: false,
            recency_duration_sec: 0,
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

    pub fn set_tee_failure(&mut self, fail: bool) {
        require!(env::predecessor_account_id() == self.owner_id, "ERR_NOT_OWNER");
        self.fail_tee = fail;
    }
    pub fn set_recency_duration_sec(&mut self, recency_duration_sec: u32) {
        require!(env::predecessor_account_id() == self.owner_id, "ERR_NOT_OWNER");
        self.recency_duration_sec = recency_duration_sec;
    }


    /// Prices are reported as fresh at the current block: the mock has no feed to lag behind.
    pub fn get_price_data(&self, asset_ids: Option<Vec<String>>) -> PriceData {
        let ids = asset_ids.unwrap_or_else(|| self.prices.keys().cloned().collect());
        PriceData {
            timestamp: U64(env::block_timestamp()),
            recency_duration_sec: self.recency_duration_sec,
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

    /// Override the worker result, including an explicit `None`, or restore generated prices.
    pub fn set_execution_response(
        &mut self,
        use_canned_response: bool,
        result: Option<Value>,
        fail: bool,
    ) {
        require!(env::predecessor_account_id() == self.owner_id, "ERR_NOT_OWNER");
        self.use_canned_response = use_canned_response;
        self.execution_response = result.map(|value| value.to_string());
        self.fail_execution = fail;
    }

    /// Direct JSON return stands in for the production OutLayer yield/resume result.
    #[payable]
    pub fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<Value>,
        payer_account_id: Option<AccountId>,
        params: Option<Value>,
    ) -> Option<Value> {
        require!(env::attached_deposit() >= MIN_EXECUTION_DEPOSIT, "ERR_DEPOSIT_TOO_LOW");
        require!(
            source == json!({
                "Project": { "project_id": WORKER_PROJECT, "version_key": WORKER_VERSION }
            }),
            "ERR_WORKER_SOURCE"
        );
        require!(resource_limits.as_ref().is_some_and(Value::is_object), "ERR_RESOURCE_LIMITS");
        require!(response_format == Some(json!("Json")), "ERR_RESPONSE_FORMAT");
        let _ = (secrets_ref, payer_account_id, params);
        let input_data = input_data.unwrap_or_else(|| env::panic_str("ERR_WORKER_INPUT"));
        require!(input_data.len() <= 1024, "ERR_WORKER_INPUT");
        let input: Value = near_sdk::serde_json::from_str(&input_data)
            .unwrap_or_else(|_| env::panic_str("ERR_WORKER_INPUT"));
        let object = input.as_object().unwrap_or_else(|| env::panic_str("ERR_WORKER_INPUT"));
        require!(object.len() == 1, "ERR_WORKER_INPUT");
        let assets = input["assets"].as_array()
            .unwrap_or_else(|| env::panic_str("ERR_WORKER_INPUT"));
        require!(!assets.is_empty() && assets.len() <= 12, "ERR_WORKER_INPUT");
        let mut symbols = Vec::with_capacity(assets.len());
        for asset in assets {
            let symbol = asset.as_str().unwrap_or_else(|| env::panic_str("ERR_WORKER_INPUT"));
            require!(
                !symbol.is_empty() && symbol.bytes().all(|byte| byte.is_ascii_uppercase())
                    && !symbols.contains(&symbol),
                "ERR_WORKER_INPUT"
            );
            symbols.push(symbol);
        }
        require!(!self.fail_execution, "ERR_EXECUTION_FAILED");
        if self.use_canned_response {
            return self.execution_response.as_ref().map(|value| {
                near_sdk::serde_json::from_str(value)
                    .unwrap_or_else(|_| env::panic_str("ERR_CANNED_RESPONSE"))
            });
        }
        let mut prices = Map::new();
        for symbol in symbols {
            let Some(price) = self.prices.get(symbol) else {
                continue;
            };
            let price8 = if price.decimals <= 8 {
                price.multiplier.0.checked_mul(10_u128.pow(u32::from(8 - price.decimals)))
            } else {
                10_u128.checked_pow(u32::from(price.decimals - 8))
                    .map(|scale| price.multiplier.0 / scale)
            };
            if let Some(price8) = price8.filter(|value| *value > 0) {
                prices.insert(symbol.to_owned(), json!([price8.to_string(), ["coinbase", "kraken"]]));
            }
        }
        Some(json!({ "timestamp_ms": env::block_timestamp_ms(), "prices": prices }))
    }

    #[payable]
    pub fn oracle_call(
        &mut self,
        receiver_id: AccountId,
        asset_ids: Option<Vec<String>>,
        msg: String,
    ) -> Promise {
        require!(!self.fail_tee, "ERR_TEE_UNAVAILABLE");
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
            Gas::from_tgas(30),
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

    fn execution(oracle: &mut MockOracle, assets: Value) -> Option<Value> {
        oracle.request_execution(
            json!({ "Project": { "project_id": WORKER_PROJECT, "version_key": WORKER_VERSION } }),
            Some(json!({})),
            Some(json!({ "assets": assets }).to_string()),
            None,
            Some(json!("Json")),
            None,
            None,
        )
    }

    #[test]
    fn execution_normalizes_prices_and_omits_unavailable_assets() {
        let mut oracle = seeded();
        oracle.set_price("DOGE".into(), U128(12_345), 6);
        oracle.set_price("XRP".into(), U128(234_567_899_000), 11);
        oracle.set_price("ADA".into(), U128(1), 9);
        ctx("ketos.test", MIN_EXECUTION_DEPOSIT);
        let result = execution(&mut oracle, json!(["DOGE", "XRP", "ADA", "LTC"])).unwrap();
        assert_eq!(result["timestamp_ms"], 1_700_000_000_000_u64);
        assert_eq!(result["prices"]["DOGE"], json!(["1234500", ["coinbase", "kraken"]]));
        assert_eq!(result["prices"]["XRP"][0], "234567899");
        assert_eq!(result["prices"].as_object().unwrap().len(), 2);
    }

    #[test]
    fn execution_can_explicitly_return_none_and_restore_generated_prices() {
        let mut oracle = seeded();
        oracle.set_price("DOGE".into(), U128(15_000_000), 8);
        oracle.set_execution_response(true, None, false);
        ctx("ketos.test", MIN_EXECUTION_DEPOSIT);
        assert!(execution(&mut oracle, json!(["DOGE"])).is_none());
        ctx("owner.test", NearToken::from_yoctonear(0));
        oracle.set_execution_response(false, None, false);
        ctx("ketos.test", MIN_EXECUTION_DEPOSIT);
        assert_eq!(execution(&mut oracle, json!(["DOGE"])).unwrap()["prices"]["DOGE"][0], "15000000");
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_OWNER")]
    fn execution_response_is_owner_only() {
        let mut oracle = seeded();
        ctx("mallory.test", NearToken::from_yoctonear(0));
        oracle.set_execution_response(true, Some(json!({ "prices": {} })), true);
    }

    #[test]
    #[should_panic(expected = "ERR_WORKER_INPUT")]
    fn execution_rejects_duplicate_assets() {
        let mut oracle = seeded();
        ctx("ketos.test", MIN_EXECUTION_DEPOSIT);
        execution(&mut oracle, json!(["DOGE", "DOGE"]));
    }

    #[test]
    fn price_data_matches_outlayer_shape() {
        let oracle = seeded();
        let data = oracle.get_price_data(Some(vec!["wrap.near".into(), "aurora".into()]));
        let value = near_sdk::serde_json::to_value(&data).unwrap();
        assert_eq!(value["timestamp"], "1700000000000000000");
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
        ctx("ketos.test", NearToken::from_yoctonear(1));
        let _ = oracle.oracle_call("ketos.test".parse().unwrap(), None, "refresh".into());
    }

    #[test]
    fn oracle_call_pushes_to_receiver() {
        let mut oracle = seeded();
        ctx("ketos.test", MIN_ORACLE_CALL_DEPOSIT);
        let _ = oracle.oracle_call(
            "ketos.test".parse().unwrap(),
            Some(vec!["wrap.near".into()]),
            "refresh".into(),
        );
        let receipts = get_created_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receiver_id.as_str(), "ketos.test");
        let MockAction::FunctionCallWeight {
            method_name, args, ..
        } = &receipts[0].actions[0]
        else {
            panic!("expected a function call");
        };
        assert_eq!(method_name.as_slice(), b"oracle_on_call");
        let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
        assert_eq!(args["sender_id"], "ketos.test");
        assert_eq!(args["msg"], "refresh");
        assert_eq!(
            args["data"]["prices"][0]["price"]["multiplier"],
            "382231700"
        );
    }
}
