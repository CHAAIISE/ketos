use super::*;
use crate::cross::MarginMode;
use crate::orders::{EntryOrder, OrderExecution, OrderRequest};

fn capital_setup(core: u128, tail: u128) -> Ketos {
    let mut ketos = setup();
    for market in ketos.markets.values_mut() {
        market.price = U128(P4);
        market.price_timestamp_ms = T0_MS;
        market.fee_bps = 0;
    }
    ketos.vaults.get_mut(&VaultId::Core).unwrap().balance = core;
    ketos.vaults.get_mut(&VaultId::LongTail).unwrap().balance = tail;
    deposit(&mut ketos, "alice.test", 100_000 * USD);
    for market in ["NEAR", "ETH", "ZEC", "DOGE"] {
        seed_depth(&mut ketos, market, measured_curve(), T0_MS);
    }
    ctx_at("alice.test", T0_MS);
    ketos
}

fn try_entry(
    ketos: &mut Ketos,
    market: &str,
    side: Side,
    collateral: u128,
    leverage: u32,
    mode: MarginMode,
) -> Result<PositionView, String> {
    ctx_at("alice.test", T0_MS);
    ketos.try_open_position_for(id("alice.test"), market.into(), side, U128(collateral), leverage, None, mode, execution_for_test(side, false, P4), None)
}

fn assert_capital_error(result: Result<PositionView, String>, room: u128) {
    assert_eq!(result.unwrap_err(), format!("ERR_EXCEEDS_VAULT_CAPITAL: cap {room}"));
}

#[test]
fn empty_and_small_vaults_reject_even_with_deep_exit_liquidity() {
    let mut ketos = capital_setup(0, 0);
    for capital in [0, 49 * USD] {
        ketos.vaults.get_mut(&VaultId::Core).unwrap().balance = capital;
        let before_margin = margin(&ketos, "alice.test");
        let market = ketos.get_market("NEAR".into()).unwrap();
        assert_eq!(market.max_oi_per_side.0, 100_000 * USD);
        assert_eq!(market.vault_backed_cap_usd.0, 2 * capital);
        assert_eq!(market.effective_max_oi_per_side.0, 2 * capital);
        assert_eq!(market.is_open, capital > 0);
        assert_capital_error(
            try_entry(&mut ketos, "NEAR", Side::Long, 50 * USD, 2, MarginMode::Isolated),
            2 * capital,
        );
        assert_eq!(margin(&ketos, "alice.test"), before_margin);
        assert_eq!(ketos.vault_exposure(VaultId::Core), 0);
        assert!(ketos.get_positions(id("alice.test")).is_empty());
    }
}

#[test]
fn exact_cap_boundary_is_inclusive_without_crediting_the_upcoming_fee() {
    let mut ketos = capital_setup(50 * USD, 0);
    ketos.markets.get_mut(&"NEAR".to_string()).unwrap().fee_bps = 10;
    assert_capital_error(
        try_entry(&mut ketos, "NEAR", Side::Long, 100 * USD + 1, 1, MarginMode::Isolated),
        100 * USD,
    );
    assert_eq!(ketos.vaults.get(&VaultId::Core).unwrap().balance, 50 * USD);
    let position = try_entry(
        &mut ketos, "NEAR", Side::Long, 50 * USD, 2, MarginMode::Isolated,
    ).unwrap();
    assert_eq!(position.size.0, 100 * USD);
    assert_eq!(ketos.vault_exposure(VaultId::Core), 100 * USD);
    assert_eq!(ketos.vaults.get(&VaultId::Core).unwrap().balance, 50 * USD + 300_000);
}

#[test]
fn hard_and_depth_limits_keep_their_exit_liquidity_error_precedence() {
    let mut ketos = capital_setup(0, 0);
    assert_eq!(
        try_entry(&mut ketos, "NEAR", Side::Long, 25_000 * USD, 5, MarginMode::Isolated)
            .unwrap_err(),
        format!("ERR_EXCEEDS_EXIT_LIQUIDITY: cap {}", 100_000 * USD),
    );
    ketos.markets.get_mut(&"NEAR".to_string()).unwrap().hard_cap = U128(10 * USD);
    assert_eq!(
        try_entry(&mut ketos, "NEAR", Side::Long, 6 * USD, 2, MarginMode::Isolated)
            .unwrap_err(),
        format!("ERR_EXCEEDS_EXIT_LIQUIDITY: cap {}", 10 * USD),
    );
}

#[test]
fn vault_budget_is_shared_across_markets_but_opposite_sides_share_exposure() {
    let mut ketos = capital_setup(1_000 * USD, 0);
    try_entry(&mut ketos, "NEAR", Side::Long, 600 * USD, 2, MarginMode::Isolated).unwrap();
    let eth = ketos.get_market("ETH".into()).unwrap();
    assert_eq!(eth.vault_backed_cap_usd.0, 804_800_000);
    assert_eq!(eth.effective_max_oi_per_side.0, 804_800_000);
    try_entry(&mut ketos, "ETH", Side::Long, 400 * USD, 2, MarginMode::Isolated).unwrap();
    assert_eq!(ketos.vault_exposure(VaultId::Core), 2_000 * USD);
    assert_capital_error(
        try_entry(&mut ketos, "ETH", Side::Long, 9 * USD, 1, MarginMode::Isolated), 8 * USD,
    );
    let near = ketos.get_market("NEAR".into()).unwrap();
    assert!(near.is_open);
    assert_eq!(near.effective_max_oi_per_side.0, 1_208 * USD);
    try_entry(&mut ketos, "NEAR", Side::Short, 600 * USD, 2, MarginMode::Isolated).unwrap();
    assert_eq!(ketos.vault_exposure(VaultId::Core), 2_000 * USD);
    let near = ketos.get_market("NEAR".into()).unwrap();
    assert!(near.is_open);
    assert_eq!(near.effective_max_oi_per_side.0, 1_212_800_000);
    assert_capital_error(
        try_entry(&mut ketos, "NEAR", Side::Short, 13 * USD, 1, MarginMode::Isolated), 12_800_000,
    );
}

#[test]
fn core_and_long_tail_have_distinct_multipliers_and_isolated_budgets() {
    let mut ketos = capital_setup(1_000 * USD, 1_000 * USD);
    assert_eq!(VaultId::Core.oi_multiplier(), 2);
    assert_eq!(VaultId::LongTail.oi_multiplier(), 1);
    assert_eq!(ketos.get_market("NEAR".into()).unwrap().vault_backed_cap_usd.0, 2_000 * USD);
    assert_eq!(ketos.get_market("ZEC".into()).unwrap().vault_backed_cap_usd.0, 1_000 * USD);
    try_entry(&mut ketos, "ZEC", Side::Long, 500 * USD, 2, MarginMode::Isolated).unwrap();
    assert_capital_error(
        try_entry(&mut ketos, "DOGE", Side::Short, 3 * USD, 1, MarginMode::Isolated), 2 * USD,
    );
    try_entry(&mut ketos, "NEAR", Side::Long, 1_000 * USD, 2, MarginMode::Isolated).unwrap();
    assert_eq!(ketos.vault_exposure(VaultId::Core), 2_000 * USD);
    assert_eq!(ketos.vault_exposure(VaultId::LongTail), 1_000 * USD);
}

#[test]
fn nav_decline_blocks_even_non_increasing_opposite_side_exposure() {
    let mut ketos = capital_setup(998 * USD, 0);
    try_entry(&mut ketos, "NEAR", Side::Long, 500 * USD, 2, MarginMode::Isolated).unwrap();
    set_price(&mut ketos, "NEAR", 1_000_000_000, T0_MS);
    assert_eq!(ketos.get_vault(VaultId::Core).nav.0, 0);
    assert!(!ketos.get_market("NEAR".into()).unwrap().is_open);
    assert_capital_error(
        try_entry(&mut ketos, "NEAR", Side::Short, 100 * USD, 1, MarginMode::Isolated), 0,
    );
    assert_eq!(ketos.vault_exposure(VaultId::Core), 1_000 * USD);
}

#[test]
fn cross_entries_use_the_same_shared_cap_and_exact_boundary() {
    let mut ketos = capital_setup(100 * USD, 0);
    assert_capital_error(
        try_entry(&mut ketos, "NEAR", Side::Long, 100 * USD + 1, 2, MarginMode::Cross),
        200 * USD,
    );
    assert_eq!(ketos.get_cross_account(id("alice.test")).position_count, 0);
    try_entry(&mut ketos, "NEAR", Side::Long, 100 * USD, 2, MarginMode::Cross).unwrap();
    assert_capital_error(
        try_entry(&mut ketos, "ETH", Side::Short, USD, 1, MarginMode::Cross), 800_000,
    );
    assert_eq!(ketos.get_cross_account(id("alice.test")).position_count, 1);
    assert_eq!(ketos.vault_exposure(VaultId::Core), 200 * USD);
}

#[test]
fn triggered_entries_recheck_reduced_nav_and_refund_isolated_and_cross_margin() {
    let mut ketos = capital_setup(998 * USD, 0);
    try_entry(&mut ketos, "NEAR", Side::Long, 500 * USD, 2, MarginMode::Isolated).unwrap();
    let before_margin = margin(&ketos, "alice.test");
    let mut ids = Vec::new();
    for margin_mode in [MarginMode::Isolated, MarginMode::Cross] {
        ctx_at("alice.test", T0_MS);
        let order = ketos.place_order_now(OrderRequest::Limit(EntryOrder {
            market_id: "ETH".into(), side: Side::Long, margin: U128(100 * USD),
            leverage: 2, trigger_price: U128(P4), brackets: None, margin_mode,
        }));
        ids.push(order.id);
    }
    assert_eq!(margin(&ketos, "alice.test"), before_margin - 200 * USD - 200_000);
    set_price(&mut ketos, "NEAR", P4 * 2, T0_MS);
    assert_eq!(ketos.get_vault(VaultId::Core).nav.0, 0);
    ctx_at("executor.test", T0_MS);
    let executions = ketos.execute_orders_now(ids.clone());
    for (execution, order_id) in executions.iter().zip(ids) {
        assert_eq!(execution, &OrderExecution::Rejected {
            order_id, reason: "ERR_EXCEEDS_VAULT_CAPITAL: cap 0".into(),
        });
    }
    let account = ketos.get_account(id("alice.test")).unwrap();
    assert_eq!(account.margin.0, before_margin);
    assert_eq!(account.reserved_margin.0, 0);
    assert!(ketos.get_orders(id("alice.test")).is_empty());
    assert_eq!(ketos.get_positions(id("alice.test")).len(), 1);
    assert_eq!(ketos.vault_exposure(VaultId::Core), 1_000 * USD);
}

#[test]
fn every_market_view_reports_identical_caps_and_latest_grid_censoring() {
    let mut ketos = capital_setup(1_000 * USD, 0);
    try_entry(&mut ketos, "NEAR", Side::Long, 100 * USD, 2, MarginMode::Isolated).unwrap();
    assert!(!ketos.get_market("NEAR".into()).unwrap().measured_cap_is_grid_max);
    set_depth_at(&mut ketos, "NEAR", vec![
        DepthSample { size_usd: 10_000, impact_bps: Some(20) },
        DepthSample { size_usd: 100_000, impact_bps: Some(30) },
    ], T0_MS + 1);
    for market in ketos.get_markets(None, None) {
        assert_eq!(ketos.get_market(market.market.id.clone()).unwrap(), market);
        assert_eq!(ketos.get_depth(market.market.id.clone()).unwrap().market, market);
    }
    let near = ketos.get_market("NEAR".into()).unwrap();
    assert!(near.measured_cap_is_grid_max);
    assert_eq!(near.max_oi_per_side.0, 100_000 * USD);
    assert_eq!(
        near.effective_max_oi_per_side.0,
        2 * ketos.get_vault(VaultId::Core).nav.0
    );
    assert!(!ketos.get_market("ETH".into()).unwrap().measured_cap_is_grid_max);
    set_depth_at(&mut ketos, "NEAR", measured_curve(), T0_MS + 2);
    assert!(!ketos.get_depth("NEAR".into()).unwrap().market.measured_cap_is_grid_max);
}

#[test]
fn receivables_are_excluded_once_from_the_nav_backing_cap() {
    let mut ketos = capital_setup(1_000 * USD, 0);
    ketos.vaults.get_mut(&VaultId::Core).unwrap().cross_receivable = 400 * USD;
    assert_eq!(ketos.get_vault(VaultId::Core).nav.0, 600 * USD);
    let market = ketos.get_market("NEAR".into()).unwrap();
    assert_eq!(market.vault_backed_cap_usd.0, 1_200 * USD);
    try_entry(&mut ketos, "NEAR", Side::Long, 600 * USD, 2, MarginMode::Isolated).unwrap();
    assert_capital_error(
        try_entry(&mut ketos, "ETH", Side::Short, 5 * USD, 1, MarginMode::Isolated), 4_800_000,
    );
}

#[test]
fn triggered_batch_consumes_one_budget_across_markets_sides_and_margin_modes() {
    let mut ketos = capital_setup(500 * USD, 0);
    let before_margin = margin(&ketos, "alice.test");
    let mut ids = Vec::new();
    for (market_id, side, margin_mode) in [
        ("NEAR", Side::Long, MarginMode::Isolated),
        ("ETH", Side::Short, MarginMode::Cross),
    ] {
        let order = ketos.place_order_now(OrderRequest::Limit(EntryOrder {
            market_id: market_id.into(), side, margin: U128(300 * USD), leverage: 2,
            trigger_price: U128(P4), brackets: None, margin_mode,
        }));
        ids.push(order.id);
    }
    ctx_at("executor.test", T0_MS);
    let executions = ketos.execute_orders_now(ids.clone());
    assert!(matches!(executions[0], OrderExecution::Filled { .. }));
    assert_eq!(executions[1], OrderExecution::Rejected {
        order_id: ids[1],
        reason: format!("ERR_EXCEEDS_VAULT_CAPITAL: cap {}", 402_400_000),
    });
    assert_eq!(ketos.vault_exposure(VaultId::Core), 600 * USD);
    let account = ketos.get_account(id("alice.test")).unwrap();
    assert_eq!(account.margin.0, before_margin - 300 * USD - 300_000);
    assert_eq!(account.reserved_margin.0, 0);
    assert!(ketos.get_orders(id("alice.test")).is_empty());
    assert_eq!(ketos.get_cross_account(id("alice.test")).position_count, 0);
}
