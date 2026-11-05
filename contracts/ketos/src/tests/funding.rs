use super::*;
use crate::funding::{funding_rate, MAX_FUNDING_PER_HOUR};
use near_sdk::test_utils::get_logs;

fn pair(long_leverage: u32, short_leverage: u32) -> (Ketos, PositionView, PositionView) {
    let mut ketos = trading_setup();
    deposit(&mut ketos, "bob.test", 1_000 * USD);
    let long = open(&mut ketos, "NEAR", Side::Long, 100 * USD, long_leverage);
    ctx_at("bob.test", T0_MS);
    let short = ketos.open_position("NEAR".into(), Side::Short, U128(100 * USD), short_leverage, None, None);
    (ketos, long, short)
}

#[test]
fn funding_rate_tracks_imbalance_sign_and_never_exceeds_cap() {
    assert_eq!(funding_rate(0, 0), 0);
    assert_eq!(funding_rate(100, 100), 0);
    assert_eq!(funding_rate(300, 100), 250_000_000);
    assert_eq!(funding_rate(100, 300), -250_000_000);
    for oi in [1, USD, 500_000 * USD] {
        assert_eq!(funding_rate(oi, 0), MAX_FUNDING_PER_HOUR as i128);
        assert_eq!(funding_rate(0, oi), -(MAX_FUNDING_PER_HOUR as i128));
    }
}

#[test]
fn balanced_market_has_no_funding_after_ten_hours() {
    let (mut ketos, long, short) = pair(3, 3);
    ctx_at("stranger.test", T0_MS + 10 * HOUR_MS);
    ketos.settle_funding("NEAR".into());
    for id in [long.id, short.id] {
        let p = ketos.get_position(id).unwrap();
        assert_eq!(p.funding_paid.0, 0);
        assert_eq!(p.funding_received.0, 0);
        assert_eq!(p.equity.0, p.margin.0 as i128 - p.borrow_fee.0 as i128);
    }
    assert_eq!(ketos.get_vault(VaultId::Core).funding_net_due.0, 0);
}

#[test]
fn ten_hour_long_majority_pays_minority_and_remainder_to_vault() {
    assert_ten_hour_funding(3, 1);
}

#[test]
fn ten_hour_short_majority_pays_minority_and_remainder_to_vault() {
    assert_ten_hour_funding(1, 3);
}

fn assert_ten_hour_funding(long_leverage: u32, short_leverage: u32) {
    let (mut ketos, long, short) = pair(long_leverage, short_leverage);
    let now = T0_MS + 10 * HOUR_MS;
    ctx_at("stranger.test", now);
    let (payer, receiver) = if long_leverage > short_leverage {
        (long.id, short.id)
    } else {
        (short.id, long.id)
    };
    let before = ketos.get_position(payer).unwrap();
    assert_eq!(before.funding_paid.0, 750_000);
    assert_eq!(before.funding_received.0, 0);
    assert_eq!(before.funding_payment.0, 750_000);
    assert_eq!(before.equity.0, before.margin.0 as i128 - before.borrow_fee.0 as i128 - 750_000);
    assert_eq!(ketos.get_position(receiver).unwrap().funding_payment.0, -250_000);
    let vault = ketos.get_vault(VaultId::Core);
    assert_eq!(vault.funding_net_due.0, 500_000);
    assert_eq!(vault.reserved.0, 330 * USD + 250_000);
    assert_eq!(vault.nav.0, vault.balance.0 + vault.borrow_fees_due.0 + 500_000);
    // A public checkpoint works despite stale depth/prices, without double charging.
    ketos.settle_funding("NEAR".into());
    assert_eq!(ketos.get_position(payer).unwrap().funding_payment, before.funding_payment);
    assert!(get_logs().iter().any(|line| line.contains("\"event\":\"funding_accrued\"")));
    ketos.settle_funding("NEAR".into());
    assert_eq!(ketos.get_position(payer).unwrap().funding_payment, before.funding_payment);
    set_price(&mut ketos, "NEAR", P4, now);
    let mut payouts = 0;
    for (position, owner) in [(&long, "alice.test"), (&short, "bob.test")] {
        ctx_at(owner, now);
        let marked = ketos.get_position(position.id).unwrap();
        let payout = ketos.close_position(position.id).0;
        assert_eq!(payout as i128, marked.equity.0 - marked.close_fee.0 as i128);
        payouts += payout;
        assert!(get_logs().iter().any(|line| line.contains("\"event\":\"funding_settled\"")));
    }
    let fees = long.close_fee.0 + short.close_fee.0;
    let borrow = vault.borrow_fees_due.0;
    assert_eq!(ketos.vaults[0].balance, vault.balance.0 + fees + borrow + 500_000);
    assert_eq!(ketos.vaults[0].balance + payouts, vault.balance.0 + long.margin.0 + short.margin.0);
    assert_eq!(ketos.get_vault(VaultId::Core).funding_net_due.0, 0);
}

#[test]
fn a_new_position_never_inherits_funding_from_before_its_entry() {
    let mut ketos = trading_setup();
    let first = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 3);
    let now = T0_MS + 10 * HOUR_MS;
    set_depth_at(&mut ketos, "NEAR", measured_curve(), now);
    set_price(&mut ketos, "NEAR", P4, now);
    ctx_at("alice.test", now);
    let new = ketos.open_position("NEAR".into(), Side::Short, U128(100 * USD), 1, None, None);
    assert_eq!(new.funding_payment.0, 0);
    assert_eq!(ketos.get_position(first.id).unwrap().funding_payment.0, 1_500_000);
    ctx_at("stranger.test", now + HOUR_MS);
    assert_eq!(ketos.get_position(first.id).unwrap().funding_payment.0, 1_575_000);
    assert_eq!(ketos.get_position(new.id).unwrap().funding_payment.0, -25_000);
}

#[test]
fn funding_direction_changes_only_after_open_interest_changes() {
    let (mut ketos, long, short) = pair(3, 1);
    let now = T0_MS + HOUR_MS;
    set_depth_at(&mut ketos, "NEAR", measured_curve(), now);
    set_price(&mut ketos, "NEAR", P4, now);
    ctx_at("bob.test", now);
    let new = ketos.open_position("NEAR".into(), Side::Short, U128(800 * USD), 1, None, None);
    assert_eq!(new.funding_received.0, 0);
    assert_eq!(ketos.get_market("NEAR".into()).unwrap().funding_rate_per_hour.0, -250_000_000);
    ctx_at("stranger.test", now + HOUR_MS);
    let long = ketos.get_position(long.id).unwrap();
    let short = ketos.get_position(short.id).unwrap();
    assert_eq!((long.funding_paid.0, long.funding_received.0), (75_000, 75_000));
    assert_eq!((short.funding_paid.0, short.funding_received.0), (25_000, 25_000));
    assert_eq!(ketos.get_position(new.id).unwrap().funding_payment.0, 200_000);
    set_price(&mut ketos, "NEAR", P4, now + HOUR_MS);
    ctx_at("bob.test", now + HOUR_MS);
    ketos.close_position(new.id);
    assert_eq!(ketos.get_market("NEAR".into()).unwrap().funding_rate_per_hour.0, 250_000_000);
}

#[test]
fn vault_keeps_receiver_funding_reserved_after_payer_exits() {
    let (mut ketos, long, short) = pair(3, 1);
    let now = T0_MS + 10 * HOUR_MS;
    close_at(&mut ketos, long.id, P4, now);
    let receiver = ketos.get_position(short.id).unwrap();
    let vault = ketos.get_vault(VaultId::Core);
    assert_eq!(receiver.funding_payment.0, -250_000);
    assert_eq!(vault.funding_net_due.0, -250_000);
    assert_eq!(vault.reserved.0, 110 * USD + 250_000);
    assert_eq!(vault.nav.0, vault.balance.0 + vault.borrow_fees_due.0 - 250_000);
    // The former minority now pays at the one-sided maximum, without losing its old credit.
    ctx_at("stranger.test", now + HOUR_MS);
    let later = ketos.get_position(short.id).unwrap();
    assert_eq!(later.funding_received.0, 250_000);
    assert_eq!(later.funding_paid.0, 50_000);
    assert_eq!(later.funding_payment.0, -200_000);
}

#[test]
fn frequent_checkpoints_preserve_fractional_index_growth() {
    let (mut ketos, long, short) = pair(3, 1);
    // 250,000,000 index units/hour is fractional at a 1 ms checkpoint.
    for ms in 1..=100 {
        ctx_at("stranger.test", T0_MS + ms);
        ketos.settle_funding("NEAR".into());
    }
    let at = T0_MS + HOUR_MS;
    ctx_at("stranger.test", at);
    ketos.settle_funding("NEAR".into());
    let payer = ketos.get_position(long.id).unwrap();
    let receiver = ketos.get_position(short.id).unwrap();
    assert_eq!(payer.funding_paid.0, 75_000);
    assert_eq!(receiver.funding_received.0, 25_000);
    // Public funding checkpoints must not amplify borrow fees through repeated ceiling.
    assert_eq!(payer.borrow_fee.0, 3_081);
    assert_eq!(receiver.borrow_fee.0, 1_009);
    // Debt rounds up and credit rounds down at the USDC boundary.
    ctx_at("stranger.test", at + 1);
    assert_eq!(ketos.get_position(long.id).unwrap().funding_paid.0, 75_001);
    assert_eq!(ketos.get_position(short.id).unwrap().funding_received.0, 25_000);
}

#[test]
fn funding_alone_can_make_a_position_liquidatable() {
    let mut ketos = trading_setup();
    let position = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    // Price is unchanged: 200 hours of funding erodes more than the $49.50 buffer.
    let now = T0_MS + 200 * HOUR_MS;
    set_price(&mut ketos, "NEAR", P4, now);
    ctx_at("liquidator.test", now);
    let marked = ketos.get_position(position.id).unwrap();
    assert!(marked.equity.0 <= marked.maintenance_margin.0 as i128);
    assert!(marked.equity.0 + marked.funding_payment.0 > marked.maintenance_margin.0 as i128);
    assert!(marked.liquidation_price.0 > P4);
    let vault_before = ketos.vaults[VaultId::Core.index()].balance;
    let record = ketos.liquidate(position.id);
    assert_eq!(record.funding_paid.0, 50 * USD);
    assert_eq!(record.funding_payment, marked.funding_payment);
    assert_eq!(record.equity, marked.equity);
    assert_eq!(ketos.vaults[0].balance + record.reward.0 + record.returned.0, vault_before + position.margin.0);
    assert_eq!(ketos.get_vault(VaultId::Core).funding_net_due.0, 0);
}

#[test]
fn receivers_are_paid_even_when_payer_is_underwater() {
    let (mut ketos, long, short) = pair(3, 1);
    let now = T0_MS + 10 * HOUR_MS;
    set_price(&mut ketos, "NEAR", P4 / 2, now);
    ctx_at("liquidator.test", now);
    let record = ketos.liquidate(long.id);
    assert!(record.equity.0 < 0);
    assert_eq!(record.funding_paid.0, 750_000);
    ctx_at("bob.test", now);
    let receiver = ketos.get_position(short.id).unwrap();
    assert_eq!(receiver.funding_received.0, 250_000);
    let payout = ketos.close_position(short.id).0;
    assert_eq!(payout as i128, receiver.equity.0 - receiver.close_fee.0 as i128);
    assert_eq!(ketos.vaults[0].balance + payout, 10_000 * USD + 100 * USD + 100_000 + short.margin.0);
}

#[test]
#[should_panic(expected = "ERR_UNKNOWN_MARKET")]
fn funding_checkpoint_rejects_unknown_market() {
    setup().settle_funding("MISSING".into());
}
