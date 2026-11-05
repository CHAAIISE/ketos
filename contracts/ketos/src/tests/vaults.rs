use super::*;
use crate::vault::{Revenue, SNAPSHOT_INTERVAL_MS, VAULT_HISTORY_LEN};

pub(super) fn deposit_to(ketos: &mut Ketos, vault: &str, lp: &str, amount: u128) {
    seed_unpriced_markets(ketos);
    ctx_at(USDC, T0_MS);
    let PromiseOrValue::Value(unused) =
        ketos.ft_on_transfer(id(lp), U128(amount), format!("deposit_vault:{vault}"))
    else {
        panic!("synchronous deposit expected")
    };
    assert_eq!(unused.0, 0);
}

fn two_vaults() -> Ketos {
    two_vaults_with_depth(measured_curve())
}

fn two_vaults_with_depth(near_samples: Vec<DepthSample>) -> Ketos {
    let mut ketos = setup();
    deposit_to(&mut ketos, "core", "lp.test", 10_000 * USD);
    deposit_to(&mut ketos, "long-tail", "lp.test", 2_000 * USD);
    deposit(&mut ketos, "alice.test", 1_000 * USD);
    for market in ["NEAR", "ZEC"] {
        set_price(&mut ketos, market, P4, T0_MS);
        seed_depth(&mut ketos, market, if market == "NEAR" { near_samples.clone() } else { measured_curve() }, T0_MS);
    }
    ketos
}

fn revenue_total(revenue: &Revenue) -> i128 {
    revenue.fees.0 as i128
        + revenue.funding.0
        + revenue.trader_pnl.0
        + revenue.liquidations.0 as i128
        + revenue.listing.0 as i128
}

#[test]
fn shares_nav_and_reserves_follow_only_assigned_markets() {
    let mut ketos = two_vaults();
    assert_eq!(
        ketos
            .get_vault_account(VaultId::Core, id("lp.test"))
            .shares
            .0,
        10_000 * USD
    );
    assert_eq!(
        ketos
            .get_vault_account(VaultId::LongTail, id("lp.test"))
            .shares
            .0,
        2_000 * USD
    );
    let core = ketos.get_vault(VaultId::Core);
    let position = open(&mut ketos, "ZEC", Side::Long, 100 * USD, 5);
    set_price(&mut ketos, "ZEC", 440_000_000, T0_MS);
    assert_eq!(ketos.get_vault(VaultId::Core), core);
    let tail = ketos.get_vault(VaultId::LongTail);
    assert_eq!(tail.reserved.0, 550 * USD);
    assert_eq!(tail.traders_unrealized_pnl.0, 50 * USD as i128);
    assert_eq!(tail.nav.0, 1_951_500_000);
    deposit_to(&mut ketos, "long-tail", "other-lp.test", 1_000 * USD);
    let lp = ketos.get_vault_account(VaultId::LongTail, id("other-lp.test"));
    assert_eq!(lp.shares.0, 1_000 * USD * 2_000 * USD / tail.nav.0);
    assert_eq!(
        ketos
            .get_vault_account(VaultId::Core, id("other-lp.test"))
            .shares
            .0,
        0
    );
    ctx_at("alice.test", T0_MS);
    assert_eq!(ketos.close_position_now(position.id).0, 147 * USD);
    assert_eq!(ketos.get_vault(VaultId::Core), core);
    let tail = ketos.get_vault(VaultId::LongTail);
    assert_eq!(tail.reserved.0, 0);
    assert_eq!(tail.revenue.fees.0, 3 * USD);
    assert_eq!(tail.revenue.trader_pnl.0, -50 * USD as i128);
    assert_eq!(
        tail.balance.0 as i128 - 3_000 * USD as i128,
        revenue_total(&tail.revenue)
    );
}

#[test]
fn winning_tail_position_cannot_spend_core_liquidity() {
    let mut ketos = two_vaults();
    ctx("lp.test", 1);
    let epoch = ketos.vaults[VaultId::LongTail.index()].share_epoch;
    let _ = ketos.withdraw_vault_now(VaultId::LongTail, U128(1_500 * USD));
    ctx(CONTRACT, 0);
    ketos.on_vault_withdrawn(
        VaultId::LongTail,
        id("lp.test"),
        U128(1_500 * USD),
        U128(1_500 * USD),
        epoch,
        Ok(()),
    );
    let core = ketos.get_vault(VaultId::Core);
    let p = open(&mut ketos, "ZEC", Side::Long, 100 * USD, 5);
    set_price(&mut ketos, "ZEC", 3 * P4, T0_MS);
    ctx_at("alice.test", T0_MS);
    assert_eq!(ketos.close_position_now(p.id).0, 597 * USD);
    assert_eq!(ketos.get_vault(VaultId::Core), core);
    let tail = ketos.get_vault(VaultId::LongTail);
    assert_eq!(tail.balance.0, 3 * USD);
    assert_eq!(revenue_total(&tail.revenue), -497 * USD as i128);
}

#[test]
fn withdrawal_reserve_and_failure_callback_are_vault_local() {
    let mut ketos = two_vaults();
    open(&mut ketos, "ZEC", Side::Long, 100 * USD, 5);
    let tail_before = ketos.get_vault(VaultId::LongTail);
    let core_epoch = ketos.vaults[VaultId::Core.index()].share_epoch;
    let tail_epoch = ketos.vaults[VaultId::LongTail.index()].share_epoch;
    ctx("lp.test", 1);
    let _ = ketos.withdraw_vault_now(VaultId::Core, U128(10_000 * USD));
    assert_eq!(ketos.get_vault(VaultId::Core).balance.0, 0);
    assert_eq!(ketos.get_vault(VaultId::LongTail), tail_before);
    ctx(CONTRACT, 0);
    ketos.on_vault_withdrawn(
        VaultId::Core,
        id("lp.test"),
        U128(10_000 * USD),
        U128(10_000 * USD),
        core_epoch,
        Err(PromiseError::Failed),
    );
    assert_eq!(
        ketos
            .get_vault_account(VaultId::Core, id("lp.test"))
            .shares
            .0,
        10_000 * USD
    );
    assert_eq!(ketos.get_vault(VaultId::LongTail), tail_before);
    ctx("lp.test", 1);
    let _ = ketos.withdraw_vault_now(VaultId::LongTail, U128(1_000 * USD));
    let tail_after = ketos.get_vault(VaultId::LongTail);
    assert_eq!(tail_after.total_shares.0, 1_000 * USD);
    ctx(CONTRACT, 0);
    ketos.on_vault_withdrawn(
        VaultId::LongTail,
        id("lp.test"),
        U128(1_000 * USD),
        U128(tail_before.balance.0 - tail_after.balance.0),
        tail_epoch,
        Err(PromiseError::Failed),
    );
    assert_eq!(ketos.get_vault(VaultId::LongTail), tail_before);
    assert_eq!(ketos.get_vault(VaultId::Core).balance.0, 10_000 * USD);
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_SHARES")]
fn shares_in_another_vault_do_not_authorize_a_withdrawal() {
    let mut ketos = setup();
    deposit_to(&mut ketos, "core", "lp.test", 1_000 * USD);
    ctx("lp.test", 1);
    let _ = ketos.withdraw_vault_now(VaultId::LongTail, U128(USD));
}

#[test]
#[should_panic(expected = "ERR_UNKNOWN_VAULT")]
fn unknown_vault_deposit_is_rejected() {
    deposit_to(&mut setup(), "unknown", "lp.test", USD);
}

#[test]
fn realized_funding_fees_and_liquidations_reconcile_per_vault() {
    let mut ketos = two_vaults();
    let core_before = ketos.get_vault(VaultId::Core);
    let payer = open(&mut ketos, "ZEC", Side::Long, 100 * USD, 3);
    let receiver = open(&mut ketos, "ZEC", Side::Short, 100 * USD, 1);
    let at = T0_MS + 10 * HOUR_MS;
    set_price(&mut ketos, "ZEC", P4, at);
    ctx_at("alice.test", at);
    let borrow = ketos.get_position(payer.id).unwrap().borrow_fee.0
        + ketos.get_position(receiver.id).unwrap().borrow_fee.0;
    assert_eq!(
        ketos.get_vault(VaultId::LongTail).funding_net_due.0,
        500_000
    );
    ketos.close_position_now(payer.id);
    assert_eq!(
        ketos.get_vault(VaultId::LongTail).funding_net_due.0,
        -250_000
    );
    assert_eq!(
        ketos.get_vault(VaultId::LongTail).reserved.0,
        110 * USD + 250_000
    );
    ketos.close_position_now(receiver.id);
    let tail = ketos.get_vault(VaultId::LongTail);
    assert_eq!(tail.revenue.fees.0, 2_400_000 + borrow);
    assert_eq!(tail.revenue.funding.0, 500_000);
    assert_eq!(tail.revenue.trader_pnl.0, 0);
    assert_eq!(
        tail.balance.0 as i128 - 2_000 * USD as i128,
        revenue_total(&tail.revenue)
    );
    assert_eq!(ketos.get_vault(VaultId::Core), core_before);
    set_depth_at(&mut ketos, "ZEC", measured_curve(), at);
    ctx_at("alice.test", at);
    let p = ketos.open_position_now("ZEC".into(), Side::Long, U128(100 * USD), 5, None, None);
    set_price(&mut ketos, "ZEC", p.liquidation_price.0, at);
    ctx_at("stranger.test", at);
    let record = ketos.liquidate_now(p.id);
    let tail = ketos.get_vault(VaultId::LongTail);
    assert_eq!(tail.revenue.liquidations, record.penalty);
    assert_eq!(tail.revenue.liquidations.0, 5 * USD);
    assert_eq!(
        tail.balance.0 as i128 - 2_000 * USD as i128,
        revenue_total(&tail.revenue)
    );
    assert_eq!(ketos.get_vault(VaultId::Core), core_before);
}

#[test]
fn underwater_funding_is_not_recorded_as_collected_revenue() {
    let mut ketos = two_vaults();
    let p = open(&mut ketos, "ZEC", Side::Long, 100 * USD, 5);
    let at = T0_MS + 10 * HOUR_MS;
    set_price(&mut ketos, "ZEC", P4 / 2, at);
    ctx_at("stranger.test", at);
    ketos.liquidate_now(p.id);
    let tail = ketos.get_vault(VaultId::LongTail);
    assert_eq!(tail.revenue.funding.0, 0);
    assert_eq!(tail.revenue.fees.0, 1_500_000);
    assert_eq!(tail.revenue.liquidations.0, 0);
    assert_eq!(tail.revenue.trader_pnl.0, 98_500_000);
    assert_eq!(tail.balance.0, 2_100 * USD);
    assert_eq!(revenue_total(&tail.revenue), 100 * USD as i128);
}

#[test]
fn snapshots_are_permissionless_hourly_immutable_and_ordered_after_wraparound() {
    let mut ketos = two_vaults();
    let position = open(&mut ketos, "ZEC", Side::Long, 100 * USD, 5);
    set_price(&mut ketos, "ZEC", 440_000_000, T0_MS);
    ctx_at("stranger.test", T0_MS);
    let first = ketos.snapshot_vaults();
    assert_eq!(first[0].nav.0, 10_000 * USD);
    assert_eq!(first[1].nav.0, 1_951_500_000);
    assert_eq!(first[1].tvl.0, 2_000 * USD + 1_500_000);
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx_at("anyone.test", T0_MS + SNAPSHOT_INTERVAL_MS - 1);
        ketos.snapshot_vaults();
    }));
    assert!(err.is_err());
    assert_eq!(
        ketos.get_vault_history(VaultId::LongTail),
        vec![first[1].clone()]
    );
    ctx_at("alice.test", T0_MS);
    ketos.close_position_now(position.id);
    assert_eq!(ketos.get_vault_history(VaultId::LongTail)[0], first[1]);
    let mut expected = Vec::new();
    for hour in 1..=VAULT_HISTORY_LEN + 3 {
        let at = T0_MS + hour * SNAPSHOT_INTERVAL_MS;
        ctx_at("anyone.test", at);
        expected.push(ketos.snapshot_vaults());
    }
    for (index, vault_id) in [VaultId::Core, VaultId::LongTail].into_iter().enumerate() {
        let history = ketos.get_vault_history(vault_id);
        let expected: Vec<_> = expected[3..]
            .iter()
            .map(|pair| pair[index].clone())
            .collect();
        assert_eq!(history, expected);
        assert_eq!(history.len(), VAULT_HISTORY_LEN as usize);
        assert_eq!(history[0].timestamp_ms, T0_MS + 4 * SNAPSHOT_INTERVAL_MS);
        assert_eq!(
            history.last().unwrap().timestamp_ms,
            T0_MS + 171 * SNAPSHOT_INTERVAL_MS
        );
    }
}

fn twenty_x_vaults() -> Ketos {
    two_vaults_with_depth(curve_up_to(1_000_000))
}

#[test]
fn offsetting_long_and_short_leave_lp_withdrawal_liquidity() {
    let mut ketos = twenty_x_vaults();
    open(&mut ketos, "NEAR", Side::Long, 250 * USD, 20);
    open(&mut ketos, "NEAR", Side::Short, 250 * USD, 20);
    let before = ketos.get_vault(VaultId::Core);
    assert_eq!(ketos.vault_exposure(VaultId::Core), 5_000 * USD);
    assert_eq!(before.reserved.0, 5_500 * USD);
    assert_eq!(before.available.0, 4_550 * USD);
    assert_eq!(before.available_to_withdraw, before.available);
    ctx("lp.test", 1);
    let _ = ketos.withdraw_vault_now(VaultId::Core, U128(4_000 * USD));
    let after = ketos.get_vault(VaultId::Core);
    assert_eq!(before.balance.0 - after.balance.0, 4_020 * USD);
    assert_eq!(after.reserved.0, 5_500 * USD);
    assert!(ketos.vault_exposure(VaultId::Core) <= 2 * after.nav.0);
}

fn assert_deep_loss_is_collateral_bounded(side: Side) {
    let mut ketos = two_vaults();
    let p = open(&mut ketos, "ZEC", side, 100 * USD, 5);
    let at = T0_MS + 10 * HOUR_MS;
    let price = if side == Side::Long { P4 / 10 } else { 10 * P4 };
    set_price(&mut ketos, "ZEC", price, at);
    ctx_at("viewer.test", at);
    let position = ketos.get_position(p.id).unwrap();
    assert!(position.unrealized_pnl.0 < -(position.margin.0 as i128));
    assert!(position.borrow_fee.0 > 0);
    assert!(position.funding_paid.0 > 0);
    let view = ketos.get_vault(VaultId::LongTail);
    assert_eq!(view.traders_unrealized_pnl.0, -(position.margin.0 as i128));
    assert_eq!(view.borrow_fees_due.0, 0);
    assert_eq!(view.funding_net_due.0, 0);
    assert_eq!(view.nav.0, 2_100 * USD);
}

#[test]
fn deeply_losing_long_does_not_create_uncollectible_nav() {
    assert_deep_loss_is_collateral_bounded(Side::Long);
}

#[test]
fn deeply_losing_short_does_not_create_uncollectible_nav() {
    assert_deep_loss_is_collateral_bounded(Side::Short);
}

#[test]
fn collectible_fees_and_funding_share_one_collateral_budget() {
    let mut ketos = two_vaults();
    let p = open(&mut ketos, "ZEC", Side::Long, 100 * USD, 5);
    let at = T0_MS + 100_000 * HOUR_MS;
    set_price(&mut ketos, "ZEC", P4, at);
    ctx_at("viewer.test", at);
    let marked = ketos.get_position(p.id).unwrap();
    assert!(marked.borrow_fee.0 > marked.margin.0);
    assert!(marked.funding_paid.0 > marked.margin.0);
    let view = ketos.get_vault(VaultId::LongTail);
    assert_eq!(view.funding_net_due.0, marked.margin.0 as i128);
    assert_eq!(view.borrow_fees_due.0, 0);
    assert_eq!(view.nav.0, 2_100 * USD);
}

#[test]
fn losing_counterparty_does_not_cancel_a_winners_full_liability() {
    let mut ketos = two_vaults();
    open(&mut ketos, "ZEC", Side::Long, 100 * USD, 5);
    let loser = open(&mut ketos, "ZEC", Side::Short, 100 * USD, 5);
    set_price(&mut ketos, "ZEC", 3 * P4, T0_MS);
    ctx_at("viewer.test", T0_MS);
    let view = ketos.get_vault(VaultId::LongTail);
    assert_eq!(
        view.traders_unrealized_pnl.0,
        500 * USD as i128 - loser.margin.0 as i128
    );
    assert_eq!(view.nav.0, 1_601_500_000);
}

#[test]
fn funding_receivers_remain_liabilities_when_the_payer_is_insolvent() {
    let mut ketos = two_vaults();
    let payer = open(&mut ketos, "ZEC", Side::Long, 100 * USD, 5);
    let receiver = open(&mut ketos, "ZEC", Side::Short, 100 * USD, 1);
    let at = T0_MS + 100_000 * HOUR_MS;
    set_price(&mut ketos, "ZEC", P4, at);
    ctx_at("viewer.test", at);
    let paid = ketos.get_position(payer.id).unwrap();
    let received = ketos.get_position(receiver.id).unwrap();
    assert!(paid.funding_paid.0 > paid.margin.0);
    assert!(received.funding_received.0 > 2_000 * USD);
    let view = ketos.get_vault(VaultId::LongTail);
    assert_eq!(
        view.funding_net_due.0,
        paid.margin.0 as i128 - received.funding_received.0 as i128
    );
    assert_eq!(view.borrow_fees_due.0, received.borrow_fee.0.min(receiver.margin.0));
    assert_eq!(view.nav.0, 0);
}

#[test]
fn settled_cross_bad_debt_is_excluded_from_lp_capital_before_default() {
    let mut ketos = two_vaults();
    ctx_at("alice.test", T0_MS);
    let loser = ketos.open_position_now("NEAR".into(),
    Side::Long,
    U128(100 * USD),
    5,
    None,
    Some(crate::cross::MarginMode::Cross),);
    ketos.open_position_now("ZEC".into(),
    Side::Long,
    U128(100 * USD),
    1,
    None,
    Some(crate::cross::MarginMode::Cross),);
    set_price(&mut ketos, "NEAR", P4 / 2, T0_MS);
    ctx_at("alice.test", T0_MS);
    ketos.close_position_now(loser.id);
    let view = ketos.get_vault(VaultId::Core);
    assert_eq!(view.cross_receivable.0, 153 * USD);
    assert_eq!(view.balance.0, 10_253 * USD);
    assert_eq!(view.nav.0, 10_100 * USD);
    assert_eq!(view.reserved.0, 153 * USD);
    deposit_to(&mut ketos, "core", "new-lp.test", 1_010 * USD);
    assert_eq!(
        ketos.get_vault_account(VaultId::Core, id("new-lp.test")).shares.0,
        1_000 * USD
    );
}

#[test]
fn withdrawals_preserve_the_global_cap_after_unrealized_gains_reduce_nav() {
    let mut ketos = two_vaults();
    open(&mut ketos, "ZEC", Side::Long, 100 * USD, 5);
    set_price(&mut ketos, "ZEC", 3 * P4, T0_MS);
    ctx_at("viewer.test", T0_MS);
    let view = ketos.get_vault(VaultId::LongTail);
    assert_eq!(view.available_to_withdraw.0, 1_001_500_000);
    assert!(view.available.0 < view.balance.0 - view.reserved.0);
    ctx("lp.test", 1);
    let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = ketos.withdraw_vault_now(VaultId::LongTail, U128(1_500 * USD));
    }));
    assert!(rejected.is_err());
    ctx("lp.test", 1);
    let _ = ketos.withdraw_vault_now(VaultId::LongTail, U128(1_000 * USD));
    let after = ketos.get_vault(VaultId::LongTail);
    assert_eq!(after.nav.0, 750_750_000);
    assert!(ketos.vault_exposure(VaultId::LongTail) <= after.nav.0);
}

#[test]
#[should_panic(expected = "ERR_STALE_PRICE")]
fn deposit_rejects_a_stale_assigned_market_without_positions() {
    let mut ketos = two_vaults();
    set_price(&mut ketos, "BTC", P4, T0_MS - crate::market::MAX_PRICE_AGE_MS - 1);
    ctx_at(USDC, T0_MS);
    ketos.deposit_vault(VaultId::Core, &id("new-lp.test"), USD);
}

#[test]
#[should_panic(expected = "ERR_NO_PRICE")]
fn deposit_rejects_an_unpriced_assigned_market_without_positions() {
    let mut ketos = two_vaults();
    set_price(&mut ketos, "DOGE", 0, T0_MS);
    ctx_at(USDC, T0_MS);
    ketos.deposit_vault(VaultId::LongTail, &id("new-lp.test"), USD);
}

#[test]
#[should_panic(expected = "ERR_STALE_PRICE")]
fn withdrawal_rejects_a_stale_assigned_market_without_positions() {
    let mut ketos = two_vaults();
    set_price(&mut ketos, "DOGE", P4, T0_MS - crate::market::MAX_PRICE_AGE_MS - 1);
    testing_env!(VMContextBuilder::new()
        .current_account_id(id(CONTRACT))
        .predecessor_account_id(id("lp.test"))
        .block_timestamp(T0_MS * 1_000_000)
        .attached_deposit(NearToken::from_yoctonear(1))
        .prepaid_gas(Gas::from_tgas(300))
        .build());
    let _ = ketos.withdraw_vault_now(VaultId::LongTail, U128(USD));
}

#[test]
#[should_panic(expected = "ERR_NO_PRICE")]
fn withdrawal_rejects_an_unpriced_assigned_market_without_positions() {
    let mut ketos = two_vaults();
    set_price(&mut ketos, "BTC", 0, T0_MS);
    ctx("lp.test", 1);
    let _ = ketos.withdraw_vault_now(VaultId::Core, U128(USD));
}

#[test]
fn unpriced_markets_in_other_vaults_do_not_gate_lp_writes() {
    let mut ketos = two_vaults();
    set_price(&mut ketos, "DOGE", 0, T0_MS);
    ctx_at(USDC, T0_MS);
    let _ = ketos.ft_on_transfer(id("new-lp.test"), U128(USD), "deposit_vault:core".into());
    ctx("new-lp.test", 1);
    let _ = ketos.withdraw_vault_now(VaultId::Core, U128(USD));
}

#[test]
fn unowned_surplus_gets_protocol_shares_before_the_first_lp() {
    let mut ketos = setup();
    ketos.vaults[VaultId::LongTail.index()].balance = 500 * USD;
    deposit_to(&mut ketos, "long-tail", "lp.test", 1_000 * USD);
    let lp = ketos.get_vault_account(VaultId::LongTail, id("lp.test"));
    let protocol = ketos.get_vault_account(VaultId::LongTail, id(CONTRACT));
    assert_eq!(lp.shares.0, 1_000 * USD);
    assert_eq!(lp.value.0, 1_000 * USD);
    assert_eq!(protocol.shares.0, 500 * USD);
    assert_eq!(protocol.value.0, 500 * USD);
    assert_eq!(ketos.get_vault(VaultId::LongTail).total_shares.0, 1_500 * USD);
    ctx("lp.test", 1);
    let _ = ketos.withdraw_vault_now(VaultId::LongTail, lp.shares);
    assert_eq!(ketos.get_vault(VaultId::LongTail).balance.0, 500 * USD);
    assert_eq!(ketos.get_vault_account(VaultId::LongTail, id(CONTRACT)).value.0, 500 * USD);
}

#[test]
fn zero_nav_recapitalization_invalidates_old_shares_even_for_a_returning_lp() {
    let mut ketos = twenty_x_vaults();
    let old_epoch = ketos.vaults[VaultId::Core.index()].share_epoch;
    let p = open(&mut ketos, "NEAR", Side::Long, 1_000 * USD, 20);
    set_price(&mut ketos, "NEAR", 2 * P4, T0_MS);
    ctx_at("alice.test", T0_MS);
    assert_eq!(ketos.close_position_now(p.id).0, 11_000 * USD);
    assert_eq!(ketos.get_vault(VaultId::Core).nav.0, 0);
    deposit_to(&mut ketos, "core", "recap-lp.test", 1_000 * USD);
    assert!(ketos.vaults[VaultId::Core.index()].share_epoch > old_epoch);
    assert_eq!(ketos.get_vault_account(VaultId::Core, id("lp.test")).shares.0, 0);
    assert_eq!(ketos.get_vault_account(VaultId::Core, id("recap-lp.test")).value.0, 1_000 * USD);
    deposit_to(&mut ketos, "core", "lp.test", 100 * USD);
    let returning = ketos.get_vault_account(VaultId::Core, id("lp.test"));
    assert_eq!(returning.shares.0, 100 * USD);
    assert_eq!(returning.value.0, 100 * USD);
    assert_eq!(ketos.get_vault(VaultId::Core).total_shares.0, 1_100 * USD);
}

#[test]
fn failed_pending_withdrawal_after_wipeout_credits_cash_without_reviving_old_shares() {
    let mut ketos = twenty_x_vaults();
    assert!(ketos.get_account(id("lp.test")).is_none());
    let epoch = ketos.vaults[VaultId::Core.index()].share_epoch;
    ctx("lp.test", 1);
    let _ = ketos.withdraw_vault_now(VaultId::Core, U128(5_000 * USD));
    let p = open(&mut ketos, "NEAR", Side::Long, 500 * USD, 20);
    set_price(&mut ketos, "NEAR", 2 * P4, T0_MS);
    ctx_at("alice.test", T0_MS);
    assert_eq!(ketos.close_position_now(p.id).0, 5_500 * USD);
    deposit_to(&mut ketos, "core", "recap-lp.test", 1_000 * USD);
    let recap = ketos.get_vault(VaultId::Core);
    ctx(CONTRACT, 0);
    ketos.on_vault_withdrawn(
        VaultId::Core,
        id("lp.test"),
        U128(5_000 * USD),
        U128(5_000 * USD),
        epoch,
        Err(PromiseError::Failed),
    );
    assert_eq!(ketos.get_vault(VaultId::Core), recap);
    assert_eq!(margin(&ketos, "lp.test"), 5_000 * USD);
    assert_eq!(ketos.get_vault_account(VaultId::Core, id("lp.test")).shares.0, 0);
    assert_eq!(ketos.get_vault_account(VaultId::Core, id("recap-lp.test")).value.0, 1_000 * USD);
}

#[test]
fn a_new_first_deposit_also_separates_pending_full_withdrawals() {
    let mut ketos = two_vaults();
    let epoch = ketos.vaults[VaultId::Core.index()].share_epoch;
    ctx("lp.test", 1);
    let _ = ketos.withdraw_vault_now(VaultId::Core, U128(10_000 * USD));
    deposit_to(&mut ketos, "core", "new-lp.test", 1_000 * USD);
    let recap = ketos.get_vault(VaultId::Core);
    ctx(CONTRACT, 0);
    ketos.on_vault_withdrawn(
        VaultId::Core,
        id("lp.test"),
        U128(10_000 * USD),
        U128(10_000 * USD),
        epoch,
        Err(PromiseError::Failed),
    );
    assert_eq!(ketos.get_vault(VaultId::Core), recap);
    assert_eq!(margin(&ketos, "lp.test"), 10_000 * USD);
    assert_eq!(ketos.get_vault_account(VaultId::Core, id("lp.test")).shares.0, 0);
    assert_eq!(ketos.get_vault_account(VaultId::Core, id("new-lp.test")).value.0, 1_000 * USD);
}

#[test]
fn failed_full_withdrawal_cannot_capture_surplus_earned_without_shares() {
    let mut ketos = two_vaults();
    let epoch = ketos.vaults[VaultId::Core.index()].share_epoch;
    ctx("lp.test", 1);
    let _ = ketos.withdraw_vault_now(VaultId::Core, U128(10_000 * USD));
    ketos.record_opening_fee(VaultId::Core, T0_MS, 100 * USD);
    ctx(CONTRACT, 0);
    ketos.on_vault_withdrawn(
        VaultId::Core,
        id("lp.test"),
        U128(10_000 * USD),
        U128(10_000 * USD),
        epoch,
        Err(PromiseError::Failed),
    );
    let view = ketos.get_vault(VaultId::Core);
    assert_eq!(view.balance.0, 100 * USD);
    assert_eq!(view.nav.0, 100 * USD);
    assert_eq!(view.total_shares.0, 100 * USD);
    assert_eq!(ketos.get_vault_account(VaultId::Core, id(CONTRACT)).value.0, 100 * USD);
    assert_eq!(ketos.get_vault_account(VaultId::Core, id("lp.test")).shares.0, 0);
    assert_eq!(margin(&ketos, "lp.test"), 10_000 * USD);
}

#[test]
fn lp_writes_accept_prices_at_the_exact_freshness_boundary() {
    let mut ketos = two_vaults();
    let at = T0_MS + crate::market::MAX_PRICE_AGE_MS;
    ctx_at(USDC, at);
    ketos.deposit_vault(VaultId::Core, &id("new-lp.test"), USD);
    testing_env!(VMContextBuilder::new()
        .current_account_id(id(CONTRACT))
        .predecessor_account_id(id("new-lp.test"))
        .block_timestamp(at * 1_000_000)
        .attached_deposit(NearToken::from_yoctonear(1))
        .prepaid_gas(Gas::from_tgas(300))
        .build());
    let _ = ketos.withdraw_vault_now(VaultId::Core, U128(USD));
    assert_eq!(ketos.get_vault_account(VaultId::Core, id("new-lp.test")).shares.0, 0);
}
