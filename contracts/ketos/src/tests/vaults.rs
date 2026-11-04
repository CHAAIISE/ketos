use super::*;
use crate::vault::{Revenue, SNAPSHOT_INTERVAL_MS, VAULT_HISTORY_LEN};

pub(super) fn deposit_to(ketos: &mut Ketos, vault: &str, lp: &str, amount: u128) {
    ctx_at(USDC, T0_MS);
    let PromiseOrValue::Value(unused) =
        ketos.ft_on_transfer(id(lp), U128(amount), format!("deposit_vault:{vault}"))
    else {
        panic!("synchronous deposit expected")
    };
    assert_eq!(unused.0, 0);
}

fn two_vaults() -> Ketos {
    let mut ketos = setup();
    deposit_to(&mut ketos, "core", "lp.test", 10_000 * USD);
    deposit_to(&mut ketos, "long-tail", "lp.test", 2_000 * USD);
    deposit(&mut ketos, "alice.test", 1_000 * USD);
    for market in ["NEAR", "ZEC"] {
        set_price(&mut ketos, market, P4, T0_MS);
        set_depth_at(&mut ketos, market, measured_curve(), T0_MS);
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
    assert_eq!(tail.reserved.0, 500 * USD);
    assert_eq!(tail.traders_unrealized_pnl.0, 50 * USD as i128);
    assert_eq!(tail.nav.0, 1_950_500_000);
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
    assert_eq!(ketos.close_position(position.id).0, 149 * USD);
    assert_eq!(ketos.get_vault(VaultId::Core), core);
    let tail = ketos.get_vault(VaultId::LongTail);
    assert_eq!(tail.reserved.0, 0);
    assert_eq!(tail.revenue.fees.0, USD);
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
    let _ = ketos.withdraw_vault(VaultId::LongTail, U128(2_000 * USD));
    ctx(CONTRACT, 0);
    ketos.on_vault_withdrawn(
        VaultId::LongTail,
        id("lp.test"),
        U128(2_000 * USD),
        U128(2_000 * USD),
        Ok(()),
    );
    let core = ketos.get_vault(VaultId::Core);
    let p = open(&mut ketos, "ZEC", Side::Long, 100 * USD, 5);
    set_price(&mut ketos, "ZEC", 800_000_000, T0_MS);
    ctx_at("alice.test", T0_MS);
    assert_eq!(ketos.close_position(p.id).0, 100 * USD);
    assert_eq!(ketos.get_vault(VaultId::Core), core);
    let tail = ketos.get_vault(VaultId::LongTail);
    assert_eq!(tail.balance.0, 0);
    assert_eq!(revenue_total(&tail.revenue), 0);
}

#[test]
fn withdrawal_reserve_and_failure_callback_are_vault_local() {
    let mut ketos = two_vaults();
    open(&mut ketos, "ZEC", Side::Long, 100 * USD, 5);
    let tail_before = ketos.get_vault(VaultId::LongTail);
    ctx("lp.test", 1);
    let _ = ketos.withdraw_vault(VaultId::Core, U128(10_000 * USD));
    assert_eq!(ketos.get_vault(VaultId::Core).balance.0, 0);
    assert_eq!(ketos.get_vault(VaultId::LongTail), tail_before);
    ctx(CONTRACT, 0);
    ketos.on_vault_withdrawn(
        VaultId::Core,
        id("lp.test"),
        U128(10_000 * USD),
        U128(10_000 * USD),
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
    let _ = ketos.withdraw_vault(VaultId::LongTail, U128(1_000 * USD));
    let tail_after = ketos.get_vault(VaultId::LongTail);
    assert_eq!(tail_after.total_shares.0, 1_000 * USD);
    ctx(CONTRACT, 0);
    ketos.on_vault_withdrawn(
        VaultId::LongTail,
        id("lp.test"),
        U128(1_000 * USD),
        U128(tail_before.balance.0 - tail_after.balance.0),
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
    let _ = ketos.withdraw_vault(VaultId::LongTail, U128(USD));
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
    ketos.close_position(payer.id);
    assert_eq!(
        ketos.get_vault(VaultId::LongTail).funding_net_due.0,
        -250_000
    );
    ketos.close_position(receiver.id);
    let tail = ketos.get_vault(VaultId::LongTail);
    assert_eq!(tail.revenue.fees.0, 800_000 + borrow);
    assert_eq!(tail.revenue.funding.0, 500_000);
    assert_eq!(tail.revenue.trader_pnl.0, 0);
    assert_eq!(
        tail.balance.0 as i128 - 2_000 * USD as i128,
        revenue_total(&tail.revenue)
    );
    assert_eq!(ketos.get_vault(VaultId::Core), core_before);
    set_depth_at(&mut ketos, "ZEC", measured_curve(), at);
    ctx_at("alice.test", at);
    let p = ketos.open_position("ZEC".into(), Side::Long, U128(100 * USD), 5, None, None);
    set_price(&mut ketos, "ZEC", p.liquidation_price.0, at);
    ctx_at("stranger.test", at);
    let record = ketos.liquidate(p.id);
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
    ketos.liquidate(p.id);
    let tail = ketos.get_vault(VaultId::LongTail);
    assert_eq!(tail.revenue.funding.0, 0);
    assert_eq!(tail.revenue.fees.0, 500_000);
    assert_eq!(tail.revenue.liquidations.0, 0);
    assert_eq!(tail.revenue.trader_pnl.0, 99_500_000);
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
    assert_eq!(first[1].nav.0, 1_950_500_000);
    assert_eq!(first[1].tvl.0, 2_000 * USD + 500_000);
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
    ketos.close_position(position.id);
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
