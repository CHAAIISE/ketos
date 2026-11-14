use super::*;
use crate::cross::MarginMode;
use crate::oracle::ORACLE_CALL_DEPOSIT;
use crate::pull_prices::PullAction;
use near_sdk::serde_json::{json, Value};

fn funded_context(caller: &str, now_ms: u64, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(id(CONTRACT))
        .predecessor_account_id(id(caller))
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(300))
        .build());
}

fn open_action() -> PullAction {
    PullAction::Open {
        account_id: id("alice.test"), market_id: "NEAR".into(), side: Side::Long,
        margin: U128(50 * USD), leverage: 2, brackets: None, margin_mode: MarginMode::Isolated,
        execution: execution_for_test(Side::Long, false, P4), bracket_bounds: None,
    }
}

fn result_value(result: PromiseOrValue<Value>) -> Value {
    match result { PromiseOrValue::Value(value) => value, _ => panic!("expected settled action") }
}

#[test]
fn cache_boundary_opens_immediately_then_requires_a_pull_without_locking_margin() {
    let mut ketos = trading_setup();
    let cost = ketos.get_price_request_deposit("NEAR".into()).0;
    funded_context("alice.test", T0_MS + 15_000, cost);
    let PromiseOrValue::Value(p) = ketos.open_position("NEAR".into(), Side::Long, U128(50 * USD), 2, None, None, None, execution_for_test(Side::Long, false, P4), None)
        else { panic!("15-second cache is usable"); };
    assert_eq!((p.entry_price.0, p.size.0), (P4, 100 * USD));
    let refunded: u128 = get_created_receipts().into_iter().filter(|r| r.receiver_id == id("alice.test"))
        .flat_map(|r| r.actions).filter_map(|a| match a { MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()), _ => None }).sum();
    assert_eq!(refunded, cost);
    let before = margin(&ketos, "alice.test");
    funded_context("alice.test", T0_MS + 15_001, cost);
    assert!(matches!(ketos.open_position("NEAR".into(), Side::Long, U128(50 * USD), 2, None, None, None,
        execution_for_test(Side::Long, false, P4), None), PromiseOrValue::Promise(_)));
    assert_eq!(margin(&ketos, "alice.test"), before);
    assert_eq!(ketos.get_positions(id("alice.test")).len(), 1);
}

fn assert_action_source_age(age: u64) {
    let mut ketos = trading_setup();
    let requested = T0_MS + 121_000;
    let now = requested + 1_000;
    set_price(&mut ketos, "NEAR", P4 + 1, now - age);
    ctx_at(CONTRACT, now);
    let action_id = ketos.reserve_price_action();
    let result = result_value(ketos.on_action_prices(
        action_id, open_action(), vec![("NEAR".into(), T0_MS)], requested, Ok(json!(true)),
    ));
    if age == 30_000 {
        assert_eq!(result["entry_price"], (P4 + 1).to_string());
        assert_eq!(margin(&ketos, "alice.test"), 150 * USD);
    } else {
        assert_eq!(result["error"], "ERR_ACTION_PRICE_UNAVAILABLE");
        assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
        assert!(ketos.get_positions(id("alice.test")).is_empty());
    }
    assert_eq!(stored_price(&ketos, "NEAR").1, now - age);
}

#[test]
fn action_accepts_fresh_trade_before_request_without_retimestamping() {
    assert_action_source_age(30_000);
}

#[test]
fn action_refuses_trade_past_execution_age_without_spending_margin() {
    assert_action_source_age(30_001);
}

#[test]
fn callback_rechecks_margin_and_caps_instead_of_using_pre_request_state() {
    let mut ketos = trading_setup();
    let requested = T0_MS + 121_000;
    ketos.accounts.get_mut(&id("alice.test")).unwrap().margin = 0;
    set_price(&mut ketos, "NEAR", P4, requested);
    ctx_at(CONTRACT, requested + 1);
    let action_id = ketos.reserve_price_action();
    let result = result_value(ketos.on_action_prices(action_id, open_action(),
        vec![("NEAR".into(), T0_MS)], requested, Ok(json!(true))));
    assert_eq!(result["error"], "ERR_INSUFFICIENT_MARGIN");
    assert_eq!(ketos.get_market("NEAR".into()).unwrap().market.oi_long.0, 0);
    assert!(ketos.get_positions(id("alice.test")).is_empty());
    ketos.accounts.get_mut(&id("alice.test")).unwrap().margin = 200 * USD;
    ketos.markets.get_mut("NEAR").unwrap().exit_capacity = U128(0);
    let action_id = ketos.reserve_price_action();
    let result = result_value(ketos.on_action_prices(action_id, open_action(),
        vec![("NEAR".into(), T0_MS)], requested, Ok(json!(true))));
    assert!(result["error"].is_string());
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
    assert_eq!(ketos.vaults.get(&VaultId::Core).unwrap().balance, 10_000 * USD);
}

#[test]
fn failed_vault_pull_returns_all_usdc_and_does_not_mint_shares() {
    let mut ketos = trading_setup();
    let before = ketos.get_vault(VaultId::Core);
    let action = PullAction::DepositVault { account_id: id("alice.test"), vault_id: VaultId::Core, amount: U128(25 * USD) };
    ctx_at(CONTRACT, T0_MS + 121_000);
    let action_id = ketos.reserve_price_action();
    let result = ketos.on_action_prices(action_id, action, vec![("BTC".into(), T0_MS)], T0_MS + 120_000, Err(PromiseError::Failed));
    assert_eq!(result_value(result), json!((25 * USD).to_string()));
    assert_eq!(ketos.get_vault(VaultId::Core).balance, before.balance);
    assert_eq!(ketos.get_vault(VaultId::Core).total_shares, before.total_shares);
    assert_eq!(ketos.get_vault_account(VaultId::Core, id("alice.test")).shares.0, 0);
}

#[test]
fn another_users_prepaid_oracle_credit_cannot_fund_keeper_spending() {
    let mut ketos = trading_setup();
    let credit = ORACLE_CALL_DEPOSIT.as_yoctonear();
    funded_context("alice.test", T0_MS, credit);
    ketos.fund_price_requests();
    let locked = near_sdk::env::storage_byte_cost().as_yoctonear() * u128::from(near_sdk::env::storage_usage());
    testing_env!(VMContextBuilder::new().current_account_id(id(CONTRACT))
        .predecessor_account_id(id("keeper.test"))
        .block_timestamp((T0_MS + 121_000) * 1_000_000)
        .account_balance(NearToken::from_yoctonear(credit + locked))
        .prepaid_gas(Gas::from_tgas(300)).build());
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        drop(ketos.open_position("NEAR".into(), Side::Long, U128(USD), 1, None, None, None, execution_for_test(Side::Long, false, P4), None));
    }));
    assert!(result.is_err());
    assert_eq!(ketos.get_price_deposit(id("alice.test")).0, credit);
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
}

#[test]
fn a_failed_worker_ack_cannot_borrow_a_concurrent_refresh_to_fill() {
    let mut ketos = trading_setup();
    let requested = T0_MS + 121_000;
    set_price(&mut ketos, "NEAR", P4, requested + 1);
    let context = VMContextBuilder::new()
        .current_account_id(id(CONTRACT)).predecessor_account_id(id(CONTRACT))
        .block_timestamp((requested + 2) * 1_000_000)
        .prepaid_gas(Gas::from_tgas(300)).build();
    testing_env!(context, near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(),
        Default::default(), vec![near_sdk::PromiseResult::Successful(b"1".to_vec()),
            near_sdk::PromiseResult::Successful(b"0".to_vec())]);
    let received = ketos.on_action_price_results(vec![1, 1]);
    assert!(!received);
    let action_id = ketos.reserve_price_action();
    let result = ketos.on_action_prices(action_id, open_action(), vec![("NEAR".into(), T0_MS)], requested, Ok(json!(received)));
    assert_eq!(result_value(result)["error"], "ERR_ACTION_PRICE_UNAVAILABLE");
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
    assert!(ketos.get_positions(id("alice.test")).is_empty());
}

fn assert_worker_source_age(age: u64) {
    let mut ketos = trading_setup();
    let requested = T0_MS + 121_000;
    let now = requested + 1_000;
    let response = json!({ "timestamp_ms": now - age, "prices": {
        "DOGE": ["8000000", ["coinbase", "kraken"]],
    }});
    ctx_at(CONTRACT, now);
    let updated = ketos.on_worker_prices(vec!["DOGE".into()], Some(requested), Ok(Some(response)));
    assert_eq!(updated, u32::from(age == 30_000));
    assert_eq!(stored_price(&ketos, "DOGE"), if age == 30_000 { (8_000_000, now - age) } else { (P4, T0_MS) });
}

#[test]
fn worker_ack_preserves_source_time_before_request() {
    assert_worker_source_age(30_000);
}

#[test]
fn worker_ack_refuses_observations_past_execution_window() {
    assert_worker_source_age(30_001);
}
