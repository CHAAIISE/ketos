use super::*;

fn limits(ketos: &Ketos, market: &str) -> (u128, u32) {
    let market = ketos.markets.get(market).unwrap();
    (market.exit_capacity.0 / USD, market.max_leverage)
}

#[test]
fn cold_start_doubles_per_report_and_leverage_never_banks_hourly_increases() {
    let mut ketos = setup();
    let curve = curve_up_to(1_000_000);
    for (i, capacity) in [10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 1_000_000].into_iter().enumerate() {
        set_depth_at(&mut ketos, "BTC", curve.clone(), T0_MS + i as u64);
        assert_eq!(limits(&ketos, "BTC"), (capacity, if i < 3 { 2 } else { 5 }));
    }
    assert!(ketos.get_market("BTC".into()).unwrap().measured_cap_is_grid_max);
    // A quiet day allows one step, not the two tiers missed since the last raise.
    let day = T0_MS + 86_400_000;
    set_depth_at(&mut ketos, "BTC", curve.clone(), day);
    assert_eq!(limits(&ketos, "BTC"), (1_000_000, 10));
    set_depth_at(&mut ketos, "BTC", curve.clone(), day + HOUR_MS - 1);
    assert_eq!(limits(&ketos, "BTC"), (1_000_000, 10));
    set_depth_at(&mut ketos, "BTC", curve.clone(), day + HOUR_MS);
    assert_eq!(limits(&ketos, "BTC"), (1_000_000, 20));
    // Reducing and immediately restoring reports cannot reset the hourly lease.
    set_depth_at(&mut ketos, "BTC", curve_up_to(10_000), day + HOUR_MS + 1);
    assert_eq!(limits(&ketos, "BTC"), (10_000, 2));
    for i in 2..=8 {
        set_depth_at(&mut ketos, "BTC", curve.clone(), day + HOUR_MS + i);
    }
    assert_eq!(limits(&ketos, "BTC"), (1_000_000, 2));
    set_depth_at(&mut ketos, "BTC", curve, day + 2 * HOUR_MS);
    assert_eq!(limits(&ketos, "BTC"), (1_000_000, 5));
}

#[test]
fn submitted_timestamps_cannot_accelerate_the_hour_after_the_first_raise() {
    ctx_at("owner.test", T0_MS);
    let mut ketos = Ketos::new(id(USDC), id(ORACLE), id("keeper.test"), id("outlayer.test"));
    for i in 0..8 {
        ctx_at("keeper.test", T0_MS + i);
        ketos.set_depth("NEAR".into(), curve_up_to(1_000_000), T0_MS + i + 60_000);
    }
    assert_eq!(limits(&ketos, "NEAR"), (1_000_000, 5));
    assert_eq!(ketos.markets.get("NEAR").unwrap().depth_measured_at_ms, T0_MS + 7);
    set_depth_at(&mut ketos, "NEAR", curve_up_to(1_000_000), T0_MS + HOUR_MS - 1);
    assert_eq!(limits(&ketos, "NEAR").1, 5);
    set_depth_at(&mut ketos, "NEAR", curve_up_to(1_000_000), T0_MS + HOUR_MS + 3);
    assert_eq!(limits(&ketos, "NEAR").1, 10);
}

#[test]
fn zero_capacity_recovers_at_opening_threshold_and_nonzero_tiny_capacity_only_doubles() {
    let mut ketos = setup();
    set_depth_at(&mut ketos, "ETH", curve_up_to(0), T0_MS);
    assert_eq!(limits(&ketos, "ETH"), (0, 2));
    assert!(!ketos.get_market("ETH".into()).unwrap().measured_cap_is_grid_max);
    set_depth_at(&mut ketos, "ETH", curve_up_to(1_000_000), T0_MS + 1);
    assert_eq!(limits(&ketos, "ETH"), (10_000, 2));
    set_depth_at(&mut ketos, "ETH", vec![DepthSample { size_usd: 1, impact_bps: Some(10) }], T0_MS + 2);
    assert_eq!(limits(&ketos, "ETH"), (1, 2));
    set_depth_at(&mut ketos, "ETH", curve_up_to(1_000_000), T0_MS + 3);
    assert_eq!(limits(&ketos, "ETH"), (2, 2));
}

#[test]
fn decreasing_impact_even_across_a_hole_is_rejected_without_touching_limits() {
    let mut ketos = trading_setup();
    let before = ketos.get_depth("NEAR".into()).unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        set_depth_at(&mut ketos, "NEAR", vec![
            DepthSample { size_usd: 1_000, impact_bps: Some(101) },
            DepthSample { size_usd: 10_000, impact_bps: None },
            DepthSample { size_usd: 50_000, impact_bps: Some(20) },
        ], T0_MS + 1);
    }));
    assert!(result.is_err());
    ctx_at("keeper.test", T0_MS);
    assert_eq!(ketos.get_depth("NEAR".into()).unwrap(), before);
}

#[test]
fn every_long_tail_market_including_zec_stays_at_most_five_x() {
    let mut ketos = setup();
    let markets: Vec<_> = ketos.markets.values().filter(|m| m.vault_id == VaultId::LongTail).map(|m| m.id.clone()).collect();
    for market in markets {
        seed_depth(&mut ketos, &market, curve_up_to(1_000_000), T0_MS);
        assert_eq!(limits(&ketos, &market), (1_000_000, 5), "{market}");
        assert_eq!(ketos.markets.get(&market).unwrap().max_leverage_cap, 5);
    }
}

#[test]
fn dust_deposits_cannot_grow_existing_margin_or_vault_records() {
    let mut ketos = trading_setup();
    let account = ketos.get_account(id("alice.test"));
    let history = ketos.get_history(id("alice.test"), None, None);
    let stats = ketos.get_account_stats(id("alice.test"));
    let vault = ketos.get_vault(VaultId::Core);
    for amount in [1, USD - 1] {
        for message in ["deposit_margin", "deposit_vault:core"] {
            ctx_at(USDC, T0_MS);
            let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                ketos.ft_on_transfer(id("alice.test"), U128(amount), message.into())
            }));
            assert!(rejected.is_err());
            assert_eq!(ketos.get_account(id("alice.test")), account);
            assert_eq!(ketos.get_history(id("alice.test"), None, None), history);
            assert_eq!(ketos.get_account_stats(id("alice.test")), stats);
            assert_eq!(ketos.get_vault(VaultId::Core), vault);
            assert_eq!(ketos.get_vault_account(VaultId::Core, id("alice.test")).shares.0, 0);
        }
    }
}
