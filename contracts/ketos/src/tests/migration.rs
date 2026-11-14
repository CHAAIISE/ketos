use super::*;
use crate::cross::MarginMode;
use crate::funding::Funding;
use crate::market::{VaultId, ENTRY_UNIT_SCALE, USD};
use crate::orders::{BracketBounds, Brackets, EntryOrder, OrderExecution, OrderRequest};
use crate::position::{ExecutionBounds, Side};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, Gas, NearToken, PromiseOrValue};
use crate::vault::SHARED_VAULT_IDS;

fn hedge_config() -> HedgeConfig {
    HedgeConfig { custody_id: account("hedge.testnet"), exchange_id: account("ref.testnet"),
        wrapped_near_id: account("wrap.testnet"), pool_id: 7 }
}

fn account(name: &str) -> AccountId { name.parse().unwrap() }

fn context(predecessor: &str, now_ms: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(account("ketos.testnet"))
        .predecessor_account_id(account(predecessor))
        .signer_account_id(account(predecessor))
        .account_balance(NearToken::from_near(1_000))
        .block_timestamp(now_ms * 1_000_000)
        .prepaid_gas(Gas::from_tgas(300)).build());
}

fn legacy_fixture() -> (LegacyKetos, Vec<AccountId>, u64) {
    context("ketos.testnet", 0);
    let fixture: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(include_str!(
        "../../../tests/fixtures/ketos-v5-derived.json"
    )).unwrap();
    for row in fixture["state"]["values"].as_array().unwrap() {
        let key: Base64VecU8 = near_sdk::serde_json::from_value(row["storage_path_base64"].clone()).unwrap();
        let value: Base64VecU8 = near_sdk::serde_json::from_value(row["value"].clone()).unwrap();
        env::storage_write(&key.0, &value.0);
    }
    let holders = near_sdk::serde_json::from_value(fixture["share_holders"].clone()).unwrap();
    let old: LegacyKetos = env::state_read().unwrap();
    let now = old.markets.values().map(|market| market.last_accrual_ms.max(market.price_timestamp_ms)).max().unwrap() + 1_000;
    context("ketos.testnet", now);
    (old, holders, now)
}

#[test]
fn migration_preserves_claims_bounded_orders_cross_debt_and_callback_leases() {
    let (mut old, holders, now) = legacy_fixture();
    let trader = account("legacy-trader.testnet");
    let cross_trader = account("legacy-cross.testnet");
    let entry_reward = USD / 10;
    let bracket_reserve = USD / 5;
    let exit_reward = USD / 10;
    assert!(old.next_position_id < 1_000 && old.next_order_id < 1_000);
    old.accounts.insert(trader.clone(), Account {
        margin: 20 * USD,
        reserved_margin: 50 * USD + entry_reward + bracket_reserve + exit_reward,
        positions: vec![1_000], orders: vec![1_000, 1_001], ..Account::default()
    });
    old.accounts.insert(cross_trader.clone(), Account {
        margin: 3 * USD, cross_cash: -(7 * USD as i128), cross_debt: [7 * USD, 0],
        positions: vec![1_001], cross_positions: vec![1_001], ..Account::default()
    });
    let position = Position {
        account_id: trader.clone(), market_id: "NEAR".into(), side: Side::Long,
        margin_mode: MarginMode::Isolated, margin: 100 * USD, size: 200 * USD,
        entry_price: 400_000_000, leverage: 2, max_leverage: 20,
        entry_borrow_index: 0, entry_funding_paid_index: 0, entry_funding_received_index: 0,
        opened_at_ms: now, take_profit: Some(1_001), stop_loss: None,
    };
    old.positions.insert(1_001, Position {
        account_id: cross_trader.clone(), side: Side::Short, margin_mode: MarginMode::Cross,
        margin: 50 * USD, size: 100 * USD, take_profit: None, ..position.clone()
    });
    old.positions.insert(1_000, position);
    old.vaults.get_mut(&VaultId::Core).unwrap().balance += 7 * USD;
    old.vaults.get_mut(&VaultId::Core).unwrap().cross_receivable += 7 * USD;
    let market = old.markets.get_mut(&"NEAR".to_string()).unwrap();
    assert_eq!((market.oi_long.0, market.oi_short.0), (0, 0));
    market.price = U128(400_000_000);
    market.price_timestamp_ms = now;
    market.oi_long = U128(200 * USD);
    market.oi_short = U128(100 * USD);
    market.entry_units = [200 * USD * ENTRY_UNIT_SCALE / 400_000_000, 100 * USD * ENTRY_UNIT_SCALE / 400_000_000];
    market.borrow_weight = [0; 2];
    market.borrow_index_long = U128(0);
    market.borrow_index_short = U128(0);
    market.last_accrual_ms = now;
    market.funding = Funding::new(now);
    let bounds = |price| ExecutionBounds { limit_price: U128(price), expires_at_ms: now + 600_000 };
    old.orders.insert(1_000, Order {
        id: 1_000, account_id: trader.clone(), created_at_ms: now,
        request: OrderRequest::Limit(EntryOrder {
            market_id: "NEAR".into(), side: Side::Long, margin: U128(50 * USD), leverage: 2,
            trigger_price: U128(390_000_000), margin_mode: MarginMode::Isolated,
            brackets: Some(Brackets { take_profit: Some(U128(450_000_000)), stop_loss: Some(U128(350_000_000)) }),
        }),
        execution_reward: U128(entry_reward), wallet_funded: true,
        bracket_reserve: U128(bracket_reserve), execution: Some(bounds(390_000_000)),
        bracket_bounds: Some(BracketBounds { take_profit: Some(bounds(450_000_000)), stop_loss: Some(bounds(340_000_000)) }),
    });
    old.orders.insert(1_001, Order {
        id: 1_001, account_id: trader.clone(), created_at_ms: now,
        request: OrderRequest::TakeProfit { position_id: 1_000, trigger_price: U128(500_000_000) },
        execution_reward: U128(exit_reward), wallet_funded: false, bracket_reserve: U128(0),
        execution: Some(bounds(500_000_000)), bracket_bounds: None,
    });
    old.next_order_id = 1_002;
    old.next_position_id = 1_002;
    let lease = old.next_price_action_id;
    old.pending_price_actions.insert(lease);
    old.next_price_action_id += 1;
    let vaults = SHARED_VAULT_IDS.map(|id| near_sdk::borsh::to_vec(old.vaults.get(&id).unwrap()).unwrap());
    let balances = SHARED_VAULT_IDS.map(|id| old.vaults.get(&id).unwrap().balance);
    let shares: Vec<_> = holders.iter().map(|holder| SHARED_VAULT_IDS.map(|id| old.vaults.get(&id).unwrap().shares.get(holder).copied())).collect();
    let histories = SHARED_VAULT_IDS.map(|id| old.vaults.get(&id).unwrap().history.iter()
        .map(|snapshot| near_sdk::borsh::to_vec(snapshot).unwrap()).collect::<Vec<_>>());
    let clocks = SHARED_VAULT_IDS.map(|id| {
        let vault = old.vaults.get(&id).unwrap();
        (vault.snapshot_count, vault.last_snapshot_at_ms)
    });
    let positions: Vec<_> = old.positions.iter().map(|(id, position)| (*id, near_sdk::borsh::to_vec(position).unwrap())).collect();
    let orders: Vec<_> = old.orders.iter().map(|(id, order)| (*id, near_sdk::borsh::to_vec(order).unwrap())).collect();
    let signer = old.price_signer.clone();
    let price_deposits_total = old.price_deposits_total;
    let trader_before = near_sdk::borsh::to_vec(old.accounts.get(&trader).unwrap()).unwrap();
    let cross_before = near_sdk::borsh::to_vec(old.accounts.get(&cross_trader).unwrap()).unwrap();
    env::state_write(&old);
    drop(old);

    let mut upgraded = Ketos::migrate(hedge_config());
    assert_eq!(upgraded.get_schema_version(), 6);
    assert_eq!((upgraded.next_position_id, upgraded.next_order_id), (1_002, 1_002));
    assert_eq!(upgraded.get_vaults(None, None).iter().map(|view| view.id).collect::<Vec<_>>(), SHARED_VAULT_IDS);
    for (index, id) in SHARED_VAULT_IDS.into_iter().enumerate() {
        let vault = upgraded.vaults.get(&id).unwrap();
        assert_eq!(near_sdk::borsh::to_vec(vault).unwrap(), vaults[index]);
        assert_eq!((vault.snapshot_count, vault.last_snapshot_at_ms), clocks[index]);
        assert_eq!(vault.history.iter().map(|snapshot| near_sdk::borsh::to_vec(snapshot).unwrap()).collect::<Vec<_>>(), histories[index]);
    }
    assert_eq!(upgraded.price_signer, signer);
    assert_eq!(upgraded.price_deposits_total, price_deposits_total);
    assert!(upgraded.pending_price_actions.contains(&lease));
    assert_eq!(upgraded.next_price_action_id, lease + 1);
    for (holder, expected) in holders.iter().zip(shares) {
        assert_eq!(SHARED_VAULT_IDS.map(|id| upgraded.vaults.get(&id).unwrap().shares.get(holder).copied()), expected);
    }
    for (id, expected) in positions {
        assert_eq!(near_sdk::borsh::to_vec(upgraded.positions.get(&id).unwrap()).unwrap(), expected);
    }
    for (id, expected) in orders {
        assert_eq!(near_sdk::borsh::to_vec(upgraded.orders.get(&id).unwrap()).unwrap(), expected);
    }
    assert_eq!(near_sdk::borsh::to_vec(upgraded.accounts.get(&cross_trader).unwrap()).unwrap(), cross_before);
    assert_eq!(upgraded.execute_orders_for(account("executor.testnet"), vec![1_000, 1_001], false), vec![
        OrderExecution::Skipped { order_id: 1_000 }, OrderExecution::Skipped { order_id: 1_001 },
    ]);
    assert_eq!(near_sdk::borsh::to_vec(upgraded.accounts.get(&trader).unwrap()).unwrap(), trader_before);
    assert!(upgraded.accounts.get(&account("executor.testnet")).is_none());

    context(trader.as_str(), now);
    let PromiseOrValue::Value(refund) = upgraded.cancel_order(1_000, Some(false)) else {
        panic!("retained cancellation must be synchronous");
    };
    let entry_refund = 50 * USD + entry_reward + bracket_reserve;
    assert_eq!(refund.0, entry_refund);
    assert_eq!(upgraded.accounts.get(&trader).unwrap().margin, 20 * USD + entry_refund);
    assert_eq!(upgraded.accounts.get(&trader).unwrap().reserved_margin, exit_reward);
    let close_fee = upgraded.get_position(1_000).unwrap().close_fee.0;
    let payout = upgraded.close_position_now(1_000).0;
    assert_eq!(payout, 100 * USD - close_fee + exit_reward);
    assert_eq!(upgraded.accounts.get(&trader).unwrap().margin, 20 * USD + entry_refund + payout);
    assert_eq!(upgraded.accounts.get(&trader).unwrap().reserved_margin, 0);
    assert!(upgraded.get_orders(trader.clone()).is_empty());
    assert!(upgraded.get_positions(trader).is_empty());
    assert_eq!(upgraded.get_market("NEAR".into()).unwrap().market.oi_long.0, 0);
    assert_eq!(upgraded.vaults.get(&VaultId::Core).unwrap().balance, balances[0] + close_fee);

    context(cross_trader.as_str(), now);
    let cross_fee = upgraded.get_position(1_001).unwrap().close_fee.0;
    upgraded.close_position_now(1_001);
    let settled = upgraded.accounts.get(&cross_trader).unwrap();
    assert_eq!(settled.cross_debt, [0, 0]);
    assert_eq!(settled.cross_cash, 0);
    assert_eq!(settled.margin, 3 * USD + 50 * USD - 7 * USD - cross_fee);
    assert_eq!(upgraded.vaults.get(&VaultId::Core).unwrap().cross_receivable, 0);
}

#[test]
#[should_panic(expected = "ERR_INCOMPATIBLE_V5_STATE")]
fn migration_replay_cannot_rewrite_v6_state() {
    let (old, _, _) = legacy_fixture();
    drop(old);
    let upgraded = Ketos::migrate(hedge_config());
    env::state_write(&upgraded);
    drop(upgraded);
    let _ = Ketos::migrate(hedge_config());
}

#[test]
#[should_panic(expected = "ERR_PRIVATE_MIGRATION")]
fn migration_rejects_non_contract_caller() {
    let (old, _, now) = legacy_fixture();
    drop(old);
    context("attacker.testnet", now);
    let _ = Ketos::migrate(hedge_config());
}

#[test]
fn migration_preserves_retired_isolated_vault_claims() {
    let (mut old, holders, now) = legacy_fixture();
    let vault_id = VaultId::Market(31);
    let mut vault = Vault::new(vault_id, Some("RETIRED".into()));
    vault.balance = 25 * USD;
    vault.total_shares = 50 * USD;
    vault.share_epoch = 3;
    vault.shares.insert(holders[0].clone(), (3, 50 * USD));
    old.vaults.insert(vault_id, vault);
    env::state_write(&old);
    drop(old);
    let mut upgraded = Ketos::migrate(hedge_config());
    let claim = upgraded.get_vault_account(vault_id, holders[0].clone());
    assert_eq!((claim.shares.0, claim.value.0), (50 * USD, 25 * USD));
    context(holders[0].as_str(), now);
    upgraded.withdraw_vault_for(holders[0].clone(), vault_id, U128(50 * USD)).detach();
    assert_eq!(upgraded.vaults.get(&vault_id).unwrap().balance, 0);
    assert_eq!(upgraded.get_vault_account(vault_id, holders[0].clone()).shares.0, 0);
}
