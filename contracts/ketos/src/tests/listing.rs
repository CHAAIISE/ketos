use super::*;
use crate::listing::LISTING_FEE;
use near_sdk::serde_json::{json, Value};

fn request() -> Value {
    json!({
        "symbol": "UNI",
        "oracle_asset_id": "UNI",
        "intents_asset_id": "nep141:eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near",
        "price_source": "outlayer_worker",
    })
}

fn list(ketos: &mut Ketos, request: Value, amount: u128) {
    ctx_at(USDC, T0_MS - 4 * HOUR_MS);
    let _ = ketos.ft_on_transfer(id("lister.test"), U128(amount), format!("list_market:{request}"));
}

#[test]
fn paid_listing_earns_only_long_tail_income_without_minting_shares_or_margin() {
    let mut ketos = setup();
    super::vaults::deposit_to(&mut ketos, "core", "lp.test", 1_000 * USD);
    super::vaults::deposit_to(&mut ketos, "long-tail", "lp.test", 1_000 * USD);
    let core = ketos.get_vault(VaultId::Core);
    let before = ketos.get_vault(VaultId::LongTail);
    list(&mut ketos, request(), LISTING_FEE);
    let tail = ketos.get_vault(VaultId::LongTail);
    assert_eq!(ketos.get_vault(VaultId::Core), core);
    assert_eq!(tail.balance.0, before.balance.0 + LISTING_FEE);
    assert_eq!(tail.nav.0, before.nav.0 + LISTING_FEE);
    assert_eq!(tail.total_shares, before.total_shares);
    assert_eq!(tail.share_price.0, 1_025_000);
    assert_eq!(tail.revenue.listing.0, LISTING_FEE);
    assert_eq!(tail.revenue.fees.0, 0);
    assert_eq!(tail.fees_7d.0, LISTING_FEE);
    assert!(ketos.get_account(id("lister.test")).is_none());
    assert_eq!(ketos.get_vault_account(VaultId::LongTail, id("lister.test")).shares.0, 0);
    let market = ketos.get_market("UNI".into()).unwrap();
    assert!(!market.is_open);
    assert_eq!(market.max_oi_per_side.0, 0);
}

#[test]
fn listed_market_trades_after_authenticated_price_and_depth_with_five_x_ceiling() {
    let mut ketos = setup();
    list(&mut ketos, request(), LISTING_FEE);
    ctx_at(CONTRACT, T0_MS);
    assert_eq!(ketos.on_worker_prices(vec!["UNI".into()], None, Ok(Some(json!({
        "timestamp_ms": T0_MS, "prices": { "UNI": [P4.to_string(), ["coinbase", "kraken"]] }
    })))), 1);
    assert!(!ketos.get_market("UNI".into()).unwrap().is_open);
    seed_depth(&mut ketos, "UNI", vec![DepthSample { size_usd: 1_000_000, impact_bps: Some(100) }], T0_MS);
    assert!(!ketos.get_market("UNI".into()).unwrap().is_open);
    super::vaults::deposit_to(&mut ketos, "market-0", "lp.test", 1_000 * USD);
    let market = ketos.get_market("UNI".into()).unwrap();
    assert!(market.is_open);
    assert_eq!(market.market.max_leverage, 5);
    assert_eq!(market.max_oi_per_side.0, 500_000 * USD);
    deposit(&mut ketos, "alice.test", 200 * USD);
    let core = ketos.get_vault(VaultId::Core);
    let p = open(&mut ketos, "UNI", Side::Long, 100 * USD, 5);
    assert_eq!(p.entry_price.0, P4);
    assert_eq!(p.size.0, 500 * USD);
    assert_eq!(p.margin.0, 94_500_000);
    assert_eq!(ketos.get_vault(VaultId::Core), core);
    assert_eq!(ketos.get_vault(VaultId::Market(0)).revenue.fees.0, 5_500_000);
    ctx_at("alice.test", T0_MS);
    assert_eq!(ketos.close_position_now(p.id).0, 89 * USD);
    assert_eq!(ketos.get_vault(VaultId::Market(0)).balance.0, 1_011 * USD);
    assert_eq!(ketos.get_vault(VaultId::LongTail).balance.0, LISTING_FEE);
}

#[test]
#[should_panic(expected = "ERR_MARKET_CLOSED")]
fn listing_with_a_price_cannot_trade_before_depth() {
    let mut ketos = setup();
    list(&mut ketos, request(), LISTING_FEE);
    set_price(&mut ketos, "UNI", P4, T0_MS);
    deposit(&mut ketos, "alice.test", 200 * USD);
    open(&mut ketos, "UNI", Side::Long, 100 * USD, 2);
}

#[test]
#[should_panic(expected = "ERR_NO_PRICE")]
fn depth_alone_cannot_make_an_unpriced_asset_tradable() {
    let mut ketos = setup();
    list(&mut ketos, request(), LISTING_FEE);
    seed_depth(&mut ketos, "UNI", measured_curve(), T0_MS);
    deposit(&mut ketos, "alice.test", 200 * USD);
    open(&mut ketos, "UNI", Side::Long, 100 * USD, 5);
}

#[test]
#[should_panic(expected = "ERR_LEVERAGE_TOO_HIGH: max 5")]
fn listed_market_cannot_use_twenty_x_even_with_deep_liquidity() {
    let mut ketos = setup();
    list(&mut ketos, request(), LISTING_FEE);
    seed_depth(&mut ketos, "UNI", vec![DepthSample { size_usd: 1_000_000, impact_bps: Some(20) }], T0_MS);
    set_price(&mut ketos, "UNI", P4, T0_MS);
    super::vaults::deposit_to(&mut ketos, "market-0", "lp.test", 1_000 * USD);
    deposit(&mut ketos, "alice.test", 200 * USD);
    open(&mut ketos, "UNI", Side::Long, 100 * USD, 6);
}

#[test]
#[should_panic(expected = "ERR_MARKET_EXISTS")]
fn duplicate_symbol_cannot_replace_a_market() {
    let mut ketos = setup();
    list(&mut ketos, request(), LISTING_FEE);
    list(&mut ketos, request(), LISTING_FEE);
}

#[test]
#[should_panic(expected = "ERR_ASSET_MISMATCH")]
fn duplicate_oracle_asset_cannot_be_listed_under_a_new_symbol() {
    let mut ketos = setup();
    let mut value = request();
    value["oracle_asset_id"] = json!("wrap.near");
    value["intents_asset_id"] = json!("nep141:wrap.near");
    list(&mut ketos, value, LISTING_FEE);
}

#[test]
#[should_panic(expected = "ERR_ASSET_MISMATCH")]
fn duplicate_intents_asset_cannot_borrow_a_different_oracle() {
    let mut ketos = setup();
    let mut value = request();
    value["intents_asset_id"] = json!("nep141:wrap.near");
    list(&mut ketos, value, LISTING_FEE);
}

#[test]
#[should_panic(expected = "ERR_LISTING_FEE")]
fn underpaid_listing_is_rejected() {
    let mut ketos = setup();
    list(&mut ketos, request(), LISTING_FEE - 1);
}

#[test]
#[should_panic(expected = "ERR_LISTING_FEE")]
fn overpaid_listing_is_not_silently_donated() {
    let mut ketos = setup();
    list(&mut ketos, request(), LISTING_FEE + 1);
}

#[test]
#[should_panic(expected = "ERR_WRONG_TOKEN")]
fn counterfeit_token_cannot_pay_for_a_listing() {
    let mut ketos = setup();
    ctx_at("fake-usdc.test", T0_MS);
    let _ = ketos.ft_on_transfer(id("lister.test"), U128(LISTING_FEE), format!("list_market:{}", request()));
}

#[test]
#[should_panic(expected = "ERR_INVALID_LISTING")]
fn malformed_listing_is_rejected() {
    let mut ketos = setup();
    ctx_at(USDC, T0_MS);
    let _ = ketos.ft_on_transfer(id("lister.test"), U128(LISTING_FEE), "list_market:{".into());
}

#[test]
#[should_panic(expected = "ERR_INVALID_LISTING")]
fn caller_cannot_override_risk_parameters() {
    let mut ketos = setup();
    let mut value = request();
    value["max_leverage_cap"] = json!(20);
    list(&mut ketos, value, LISTING_FEE);
}

#[test]
#[should_panic(expected = "ERR_INVALID_SYMBOL")]
fn symbol_case_alias_is_rejected() {
    let mut ketos = setup();
    let mut value = request();
    value["symbol"] = json!("near");
    list(&mut ketos, value, LISTING_FEE);
}

#[test]
#[should_panic(expected = "ERR_ASSET_MISMATCH")]
fn non_nep141_intents_asset_is_rejected() {
    let mut ketos = setup();
    let mut value = request();
    value["intents_asset_id"] = json!("wrap.near");
    list(&mut ketos, value, LISTING_FEE);
}

#[test]
fn worker_listing_binds_ticker_oracle_and_exact_route_and_rejects_reserved_signed_source() {
    let mut ketos = setup();
    let valid = json!({
        "symbol": "UNI", "oracle_asset_id": "UNI",
        "intents_asset_id": "nep141:eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near",
        "price_source": "outlayer_worker",
    });
    let before = ketos.get_vault(VaultId::LongTail);
    for (field, value) in [
        ("symbol", json!("ALIAS")),
        ("oracle_asset_id", json!("AAVE")),
        ("intents_asset_id", json!("nep141:wrap.near")),
        ("price_source", json!("signed")),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = value;
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            list(&mut ketos, invalid, LISTING_FEE);
        })).is_err());
        assert_eq!(ketos.get_vault(VaultId::LongTail), before);
        assert!(ketos.get_market("UNI".into()).is_none());
    }
    list(&mut ketos, valid, LISTING_FEE);
    assert_eq!(ketos.get_market("UNI".into()).unwrap().market.oracle_asset_id, "UNI");
    assert_eq!(ketos.get_vault(VaultId::LongTail).balance.0, before.balance.0 + LISTING_FEE);
}

#[test]
fn dead_listing_can_be_removed_and_identifiers_reused_without_refunding_fees() {
    let mut ketos = setup();
    list(&mut ketos, request(), LISTING_FEE);
    let created = ketos.markets.get("UNI").unwrap().created_at_ms;
    let deadline = created + crate::listing::DEAD_MARKET_AGE_MS;
    ctx_at("stranger.test", deadline - 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ketos.delist_dead_market("UNI".into());
    })).is_err());
    assert!(ketos.get_market("UNI".into()).is_some());
    ctx_at("stranger.test", deadline);
    ketos.delist_dead_market("UNI".into());
    assert!(ketos.get_market("UNI".into()).is_none());
    assert!(!ketos.oracle_markets.contains_key(&"UNI".to_string()));
    assert!(ketos.depth.get("UNI").is_none());
    assert_eq!(ketos.get_vault(VaultId::LongTail).revenue.listing.0, LISTING_FEE);
    ctx_at(USDC, deadline + 1);
    let _ = ketos.ft_on_transfer(id("another.test"), U128(LISTING_FEE), format!("list_market:{}", request()));
    let relisted = ketos.get_market("UNI".into()).unwrap();
    assert_eq!(relisted.market.created_at_ms, deadline + 1);
    assert_eq!(relisted.market.depth_measured_at_ms, 0);
    assert!(!relisted.is_open);
    assert_eq!(ketos.get_vault(VaultId::LongTail).revenue.listing.0, 2 * LISTING_FEE);
}

#[test]
fn any_new_depth_report_restarts_the_seven_day_delisting_window() {
    let mut ketos = setup();
    list(&mut ketos, request(), LISTING_FEE);
    let created = ketos.markets.get("UNI").unwrap().created_at_ms;
    let report = created + crate::listing::DEAD_MARKET_AGE_MS - 1;
    set_depth_at(&mut ketos, "UNI", curve_up_to(0), report);
    ctx_at("stranger.test", created + crate::listing::DEAD_MARKET_AGE_MS);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ketos.delist_dead_market("UNI".into());
    })).is_err());
    ctx_at("stranger.test", report + crate::listing::DEAD_MARKET_AGE_MS);
    ketos.delist_dead_market("UNI".into());
    assert!(ketos.get_market("UNI".into()).is_none());
}

#[test]
fn old_depth_never_allows_removing_a_market_with_open_interest() {
    let mut ketos = trading_setup();
    let position = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    ctx_at("stranger.test", T0_MS + crate::listing::DEAD_MARKET_AGE_MS);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ketos.delist_dead_market("NEAR".into());
    })).is_err());
    assert_eq!(ketos.get_position(position.id).unwrap().size, position.size);
    assert_eq!(ketos.get_market("NEAR".into()).unwrap().market.oi_long, position.size);
}

#[test]
fn delisted_orders_refund_margin_and_reward_even_after_the_symbol_is_relisted() {
    use crate::orders::{EntryOrder, OrderExecution, OrderRequest};
    let mut ketos = setup();
    list(&mut ketos, request(), LISTING_FEE);
    deposit(&mut ketos, "alice.test", 200 * USD);
    ctx_at("alice.test", T0_MS);
    let request = OrderRequest::Limit(EntryOrder {
        market_id: "UNI".into(), side: Side::Long, margin: U128(10 * USD), leverage: 2,
        trigger_price: U128(P4), brackets: None, margin_mode: crate::cross::MarginMode::Isolated,
    });
    let first = ketos.place_order_now(request.clone());
    let second = ketos.place_order_now(request);
    let dead = T0_MS + crate::listing::DEAD_MARKET_AGE_MS;
    ctx_at("stranger.test", dead);
    ketos.delist_dead_market("UNI".into());
    assert!(ketos.orders_price_market_ids(&[first.id]).is_empty());
    assert_eq!(ketos.execute_orders_now(vec![first.id]), vec![OrderExecution::Rejected {
        order_id: first.id, reason: "ERR_MARKET_DELISTED".into(),
    }]);
    let listing = self::request();
    ctx_at(USDC, dead + 1);
    let _ = ketos.ft_on_transfer(id("lister.test"), U128(LISTING_FEE), format!("list_market:{listing}"));
    assert!(ketos.orders_price_market_ids(&[second.id]).is_empty());
    ctx_at("executor.test", dead + 2);
    assert_eq!(ketos.execute_orders_now(vec![second.id]), vec![OrderExecution::Rejected {
        order_id: second.id, reason: "ERR_MARKET_DELISTED".into(),
    }]);
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
    assert_eq!(ketos.get_account(id("alice.test")).unwrap().reserved_margin.0, 0);
    assert!(ketos.get_orders(id("alice.test")).is_empty());
    assert!(ketos.get_positions(id("alice.test")).is_empty());
}

#[test]
fn market_vault_pnl_and_cross_rejection_cannot_touch_another_market() {
    use crate::cross::MarginMode;
    let mut ketos = setup();
    list(&mut ketos, request(), LISTING_FEE);
    list(&mut ketos, json!({
        "symbol": "AAVE", "oracle_asset_id": "AAVE",
        "intents_asset_id": "nep141:eth-0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9.omft.near",
        "price_source": "outlayer_worker",
    }), LISTING_FEE);
    for (symbol, vault) in [("UNI", "market-0"), ("AAVE", "market-1")] {
        set_price(&mut ketos, symbol, P4, T0_MS);
        seed_depth(&mut ketos, symbol, measured_curve(), T0_MS);
        super::vaults::deposit_to(&mut ketos, vault, "lp.test", 1_000 * USD);
    }
    deposit(&mut ketos, "alice.test", 200 * USD);
    let untouched = ketos.get_vault(VaultId::Market(1));
    let shared = [ketos.get_vault(VaultId::Core), ketos.get_vault(VaultId::LongTail)];
    ctx_at("alice.test", T0_MS);
    let account_before = near_sdk::borsh::to_vec(ketos.accounts.get(&id("alice.test")).unwrap()).unwrap();
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ketos.open_position_now("UNI".into(), Side::Long, U128(100 * USD), 5, None, Some(MarginMode::Cross));
    })).is_err());
    assert_eq!(near_sdk::borsh::to_vec(ketos.accounts.get(&id("alice.test")).unwrap()).unwrap(), account_before);
    let position = open(&mut ketos, "UNI", Side::Long, 100 * USD, 5);
    set_price(&mut ketos, "UNI", P4 * 110 / 100, T0_MS);
    let marked = ketos.get_vault(VaultId::Market(0));
    let isolated_before = near_sdk::borsh::to_vec(ketos.positions.get(&position.id).unwrap()).unwrap();
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ketos.switch_to_cross(position.id);
    })).is_err());
    assert_eq!(near_sdk::borsh::to_vec(ketos.positions.get(&position.id).unwrap()).unwrap(), isolated_before);
    assert!(marked.nav.0 < 1_000 * USD);
    assert_eq!(ketos.get_vault(VaultId::Market(1)), untouched);
    assert_eq!([ketos.get_vault(VaultId::Core), ketos.get_vault(VaultId::LongTail)], shared);
    ctx_at("alice.test", T0_MS);
    let payout = ketos.close_position_now(position.id).0;
    assert!(payout > 100 * USD);
    assert!(ketos.get_vault(VaultId::Market(0)).balance.0 < 1_000 * USD);
    assert_eq!(ketos.get_vault(VaultId::Market(1)), untouched);
    assert_eq!([ketos.get_vault(VaultId::Core), ketos.get_vault(VaultId::LongTail)], shared);
}

#[test]
fn retired_market_claims_survive_relisting_and_snapshots_have_independent_clocks() {
    let mut ketos = setup();
    list(&mut ketos, request(), LISTING_FEE);
    super::vaults::deposit_to(&mut ketos, "market-0", "lp.test", 100 * USD);
    ctx_at(CONTRACT, T0_MS);
    ketos.snapshot_vaults(vec![VaultId::Market(0)]);
    let original_history = ketos.get_vault_history(VaultId::Market(0));
    let dead = T0_MS + crate::listing::DEAD_MARKET_AGE_MS;
    ctx_at("stranger.test", dead);
    ketos.delist_dead_market("UNI".into());
    ctx_at(USDC, dead + 1);
    let _ = ketos.ft_on_transfer(id("lister.test"), U128(LISTING_FEE), format!("list_market:{}", request()));
    assert_eq!(ketos.get_market("UNI".into()).unwrap().market.vault_id, VaultId::Market(1));
    assert_eq!(ketos.get_vault_account(VaultId::Market(0), id("lp.test")).shares.0, 100 * USD);
    assert_eq!(ketos.get_vault_account(VaultId::Market(1), id("lp.test")).shares.0, 0);
    assert_eq!(ketos.get_vault(VaultId::Market(1)).balance.0, 0);
    ketos.snapshot_vaults(vec![VaultId::Market(1)]);
    assert_eq!(ketos.get_vault_history(VaultId::Market(0)), original_history);
    ketos.snapshot_vaults(vec![VaultId::Market(0)]);
    assert_eq!(ketos.get_vault_history(VaultId::Market(0)).len(), 2);
    assert_eq!(ketos.get_vault_history(VaultId::Market(1)).len(), 1);
    let _ = ketos.withdraw_vault_for(id("lp.test"), VaultId::Market(0), U128(100 * USD));
    assert_eq!(ketos.get_vault_account(VaultId::Market(0), id("lp.test")).shares.0, 0);
    assert_eq!(ketos.get_vault(VaultId::Market(0)).balance.0, 0);
    assert_eq!(ketos.get_vault(VaultId::Market(1)).balance.0, 0);
}

#[test]
fn isolated_withdrawal_reserves_and_failed_transfers_preserve_the_correct_epoch() {
    let mut ketos = setup();
    list(&mut ketos, request(), LISTING_FEE);
    super::vaults::deposit_to(&mut ketos, "market-0", "lp.test", 1_000 * USD);
    seed_depth(&mut ketos, "UNI", measured_curve(), T0_MS);
    set_price(&mut ketos, "UNI", P4, T0_MS);
    deposit(&mut ketos, "alice.test", 200 * USD);
    let position = open(&mut ketos, "UNI", Side::Long, 100 * USD, 5);
    let before = ketos.get_vault(VaultId::Market(0));
    let epoch = ketos.vaults.get(&VaultId::Market(0)).unwrap().share_epoch;
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = ketos.withdraw_vault_for(id("lp.test"), VaultId::Market(0), U128(1_000 * USD));
    })).is_err());
    assert_eq!(ketos.get_vault(VaultId::Market(0)), before);
    let _ = ketos.withdraw_vault_for(id("lp.test"), VaultId::Market(0), U128(100 * USD));
    let paid = before.balance.0 - ketos.get_vault(VaultId::Market(0)).balance.0;
    ctx_at(CONTRACT, T0_MS);
    ketos.on_vault_withdrawn(VaultId::Market(0), id("lp.test"), U128(100 * USD),
        U128(paid), epoch, Err(PromiseError::Failed));
    assert_eq!(ketos.get_vault(VaultId::Market(0)), before);
    assert_eq!(ketos.get_vault_account(VaultId::Market(0), id("lp.test")).shares.0, 1_000 * USD);
    ctx_at("alice.test", T0_MS);
    ketos.close_position_now(position.id);
    let full = ketos.get_vault(VaultId::Market(0)).balance;
    let _ = ketos.withdraw_vault_for(id("lp.test"), VaultId::Market(0), U128(1_000 * USD));
    super::vaults::deposit_to(&mut ketos, "market-0", "new-lp.test", 200 * USD);
    let recap = ketos.get_vault(VaultId::Market(0));
    ctx_at(CONTRACT, T0_MS);
    ketos.on_vault_withdrawn(VaultId::Market(0), id("lp.test"), U128(1_000 * USD),
        full, epoch, Err(PromiseError::Failed));
    assert_eq!(ketos.get_vault(VaultId::Market(0)), recap);
    assert_eq!(margin(&ketos, "lp.test"), full.0);
    assert_eq!(ketos.get_vault_account(VaultId::Market(0), id("lp.test")).shares.0, 0);
    assert_eq!(ketos.get_vault_account(VaultId::Market(0), id("new-lp.test")).value.0, 200 * USD);
    assert_eq!(ketos.get_vault(VaultId::LongTail).balance.0, LISTING_FEE);
    assert_eq!(ketos.get_vault(VaultId::Core).balance.0, 0);
}
