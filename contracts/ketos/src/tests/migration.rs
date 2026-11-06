use super::*;
use crate::cross::MarginMode;
use crate::market::{ENTRY_UNIT_SCALE, USD};
use crate::orders::EntryOrder;
use crate::position::Side;
use near_sdk::json_types::Base64VecU8;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, Gas, PromiseOrValue};

fn account(name: &str) -> AccountId { name.parse().unwrap() }

fn context(predecessor: &str, now_ms: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(account("ketos.testnet"))
        .predecessor_account_id(account(predecessor))
        .block_timestamp(now_ms * 1_000_000)
        .prepaid_gas(Gas::from_tgas(300))
        .build());
}

fn legacy_fixture() -> (LegacyKetos, Vec<AccountId>, u64) {
    context("ketos.testnet", 0);
    let fixture: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(include_str!(
        "../../../tests/fixtures/ketos-v2-testnet.json"
    )).unwrap();
    for row in fixture["state"]["values"].as_array().unwrap() {
        let key: Base64VecU8 = near_sdk::serde_json::from_value(row["storage_path_base64"].clone()).unwrap();
        let value: Base64VecU8 = near_sdk::serde_json::from_value(row["value"].clone()).unwrap();
        env::storage_write(&key.0, &value.0);
    }
    let holders = near_sdk::serde_json::from_value(fixture["share_holders"].clone()).unwrap();
    let old: LegacyKetos = env::state_read().unwrap();
    let now = old.markets.values().map(|market| market.last_accrual_ms).max().unwrap() + 1_000;
    context("ketos.testnet", now);
    (old, holders, now)
}

#[test]
fn migration_keeps_legacy_orders_cancellable_and_positions_settleable() {
    let (mut old, holders, now) = legacy_fixture();
    let trader = account("legacy-trader.testnet");
    old.accounts.insert(trader.clone(), Account {
        margin: 20 * USD, reserved_margin: 50 * USD,
        positions: vec![3], orders: vec![10, 11], ..Account::default()
    });
    old.positions.insert(3, Position {
        account_id: trader.clone(), market_id: "NEAR".into(), side: Side::Long,
        margin_mode: MarginMode::Isolated, margin: 100 * USD, size: 200 * USD,
        entry_price: 400_000_000, leverage: 2, max_leverage: 20,
        entry_borrow_index: 0, entry_funding_paid_index: 0, entry_funding_received_index: 0,
        opened_at_ms: now, take_profit: Some(11), stop_loss: None,
    });
    let market = old.markets.get_mut(&"NEAR".to_string()).unwrap();
    market.price = U128(400_000_000);
    market.price_timestamp_ms = now;
    market.oi_long = U128(200 * USD);
    market.entry_units = [200 * USD * ENTRY_UNIT_SCALE / 400_000_000, 0];
    market.borrow_weight = [0; 2];
    market.borrow_index_long = U128(0);
    market.borrow_index_short = U128(0);
    market.last_accrual_ms = now;
    market.funding = Funding::new(now);
    // Admission ceilings can fall without rewriting an existing position's fixed
    // maintenance terms.
    let tail = old.markets.get_mut(&"ZEC".to_string()).unwrap();
    tail.max_leverage = 20;
    tail.max_leverage_cap = 20;
    let limit = OrderRequest::Limit(EntryOrder {
        market_id: "NEAR".into(), side: Side::Long, margin: U128(50 * USD),
        leverage: 2, trigger_price: U128(390_000_000), brackets: None,
        margin_mode: MarginMode::Isolated,
    });
    old.orders.insert(10, LegacyOrder {
        id: 10, account_id: trader.clone(), request: limit, created_at_ms: now,
    });
    old.orders.insert(11, LegacyOrder {
        id: 11, account_id: trader.clone(),
        request: OrderRequest::TakeProfit { position_id: 3, trigger_price: U128(500_000_000) },
        created_at_ms: now,
    });
    old.next_order_id = 12;
    old.next_position_id = 4;
    let balances = old.vaults.each_ref().map(|vault| vault.balance);
    env::state_write(&old);
    drop(old); // Flush every modified collection before reading through a new typed handle.

    let mut upgraded = Ketos::migrate(holders.clone());
    assert_eq!(upgraded.next_position_id, 4);
    assert_eq!(upgraded.next_order_id, 12);
    assert_eq!(upgraded.get_position(3).unwrap().maintenance_margin.0, 5 * USD);
    assert_eq!(upgraded.get_market("ZEC".into()).unwrap().market.max_leverage, 5);
    assert_eq!(upgraded.get_market("ZEC".into()).unwrap().market.leverage_increased_at_ms, now);
    for (i, vault) in upgraded.vaults.iter().enumerate() {
        assert_eq!(vault.balance, balances[i]);
        assert_eq!(upgraded.vault_shares[i].get(&holders[0]), Some(&(0, vault.total_shares)));
    }
    assert_eq!(upgraded.accounts.get(&trader).unwrap().reserved_margin, 50 * USD);
    // The V3 maintenance call does not migrate or reinitialize any user state.
    let retired = ["AURORA", "RHEA"].into_iter()
        .filter(|id| upgraded.markets.contains_key(*id))
        .map(str::to_string).collect::<Vec<_>>();
    let vaults_before = near_sdk::borsh::to_vec(&upgraded.vaults).unwrap();
    let history_before = upgraded.get_history(trader.clone(), None, None);
    assert_eq!(upgraded.retire_unsupported_markets(), retired);
    assert_eq!(near_sdk::borsh::to_vec(&upgraded.vaults).unwrap(), vaults_before);
    assert_eq!(upgraded.get_history(trader.clone(), None, None), history_before);
    for (i, vault) in upgraded.vaults.iter().enumerate() {
        assert_eq!(upgraded.vault_shares[i].get(&holders[0]), Some(&(0, vault.total_shares)));
    }
    assert!(upgraded.retire_unsupported_markets().is_empty());
    context(trader.as_str(), now);
    let PromiseOrValue::Value(refund) = upgraded.cancel_order(10, Some(false)) else {
        panic!("retained legacy cancellation must be synchronous");
    };
    assert_eq!(refund.0, 50 * USD);
    assert_eq!(upgraded.accounts.get(&trader).unwrap().margin, 70 * USD);
    assert_eq!(upgraded.accounts.get(&trader).unwrap().reserved_margin, 0);
    let close_fee = upgraded.get_position(3).unwrap().close_fee.0;
    let payout = upgraded.close_position_now(3).0;
    assert_eq!(payout, 100 * USD - close_fee);
    assert_eq!(upgraded.accounts.get(&trader).unwrap().margin, 70 * USD + payout);
    assert!(upgraded.get_orders(trader.clone()).is_empty());
    assert!(upgraded.get_positions(trader).is_empty());
    assert_eq!(upgraded.get_market("NEAR".into()).unwrap().market.oi_long.0, 0);
    assert_eq!(upgraded.vaults[0].balance, balances[0] + close_fee);
}

#[test]
#[should_panic(expected = "ERR_INCOMPLETE_SHARE_HOLDERS")]
fn migration_rejects_omitted_lp_claims() {
    let (old, _, _) = legacy_fixture();
    drop(old);
    let _ = Ketos::migrate(vec![]);
}

#[test]
#[should_panic(expected = "ERR_DUPLICATE_SHARE_HOLDER")]
fn migration_rejects_double_counted_lp_claims() {
    let (old, holders, _) = legacy_fixture();
    drop(old);
    let _ = Ketos::migrate(vec![holders[0].clone(), holders[0].clone()]);
}

#[test]
#[should_panic(expected = "ERR_PRIVATE_MIGRATION")]
fn migration_rejects_non_contract_caller() {
    let (old, holders, now) = legacy_fixture();
    drop(old);
    context("attacker.testnet", now);
    let _ = Ketos::migrate(holders);
}
