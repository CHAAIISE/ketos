use super::*;
use crate::cross::MarginMode;
use crate::market::{Market, UNSUPPORTED_MARKETS};
use crate::orders::{EntryOrder, OrderRequest};
use crate::pull_prices::PullAction;
use crate::wallet_trading::WalletOpenRequest;
use near_sdk::serde_json::{json, Value};

const RETIRED_ASSETS: [(&str, &str); 2] = [
    ("AURORA", "aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near"),
    ("RHEA", "token.rhealab.near"),
];

// Reproduce already-deployed registry entries without bypassing the production
// registration prohibition anywhere outside this legacy-state fixture.
fn add_legacy_markets(ketos: &mut Ketos) {
    for (symbol, asset) in RETIRED_ASSETS {
        let mut config = extra_market(symbol, PriceSource::Tee);
        config.oracle_asset_id = asset.into();
        config.intents_asset_id = format!("nep141:{asset}");
        ketos.oracle_markets.insert(asset.into(), symbol.into());
        ketos.markets.insert(symbol.into(), Market::new(config));
        seed_depth(ketos, symbol, measured_curve(), T0_MS);
        set_price(ketos, symbol, P4, T0_MS);
    }
}

fn entry(market: &str) -> EntryOrder {
    EntryOrder {
        market_id: market.into(), side: Side::Long, margin: U128(10 * USD), leverage: 2,
        trigger_price: U128(P4 - 1), brackets: None, margin_mode: MarginMode::Isolated,
    }
}

fn populated() -> Ketos {
    let mut ketos = trading_setup();
    vaults::deposit_to(&mut ketos, "core", "lp.test", 100 * USD);
    vaults::deposit_to(&mut ketos, "long-tail", "lp.test", 100 * USD);
    open(&mut ketos, "NEAR", Side::Long, 10 * USD, 2);
    ctx_at("alice.test", T0_MS);
    ketos.place_order_now(OrderRequest::Limit(entry("ZEC")));
    add_legacy_markets(&mut ketos);
    testing_env!(VMContextBuilder::new()
        .current_account_id(id(CONTRACT))
        .predecessor_account_id(id("alice.test"))
        .block_timestamp(T0_MS * 1_000_000)
        .attached_deposit(NearToken::from_millinear(7))
        .prepaid_gas(Gas::from_tgas(300))
        .build());
    assert_eq!(ketos.fund_price_requests().0, NearToken::from_millinear(7).as_yoctonear());
    ctx_at(CONTRACT, T0_MS);
    ketos
}

fn retained_state(ketos: &Ketos) -> Value {
    json!({
        "account": near_sdk::borsh::to_vec(ketos.accounts.get(&id("alice.test")).unwrap()).unwrap(),
        "positions": ketos.positions.iter().map(|(id, position)|
            (*id, near_sdk::borsh::to_vec(position).unwrap())).collect::<Vec<_>>(),
        "orders": ketos.orders.values().collect::<Vec<_>>(),
        "next_position_id": ketos.next_position_id,
        "next_order_id": ketos.next_order_id,
        "vaults": near_sdk::borsh::to_vec(&ketos.vaults).unwrap(),
        "shares": [
            near_sdk::borsh::to_vec(&ketos.vault_shares[0].get(&id("lp.test"))).unwrap(),
            near_sdk::borsh::to_vec(&ketos.vault_shares[1].get(&id("lp.test"))).unwrap(),
        ],
        "vault_history": [ketos.get_vault_history(VaultId::Core), ketos.get_vault_history(VaultId::LongTail)],
        "history": ketos.get_history(id("alice.test"), None, None),
        "stats": ketos.get_account_stats(id("alice.test")),
        "liquidations": near_sdk::borsh::to_vec(&ketos.liquidations).unwrap(),
        "liquidation_count": ketos.liquidation_count,
        "price_deposits_total": ketos.price_deposits_total.to_string(),
        "alice_price_deposit": ketos.get_price_deposit(id("alice.test")),
        "last_price_request_ms": ketos.last_price_request_ms,
        "price_signer": ketos.price_signer,
    })
}

fn registry_state(ketos: &Ketos) -> Value {
    json!({
        "state": near_sdk::borsh::to_vec(ketos).unwrap(),
        "markets": ketos.markets.values().collect::<Vec<_>>(),
        "depth": ketos.markets.keys().map(|id| (id, ketos.depth.get(id))).collect::<Vec<_>>(),
        "oracle_markets": RETIRED_ASSETS.map(|(_, asset)| ketos.oracle_markets.get(asset).cloned()),
        "retained": retained_state(ketos),
    })
}

fn assert_refused_without_changes(ketos: &mut Ketos, reason: &str) {
    let before = registry_state(ketos);
    let error = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ketos.retire_unsupported_markets();
    })).expect_err("unsafe retirement must fail");
    let message = error.downcast_ref::<String>().map(String::as_str)
        .or_else(|| error.downcast_ref::<&str>().copied()).unwrap_or("");
    assert!(message.contains(reason), "unexpected refusal: {message}");
    assert_eq!(registry_state(ketos), before);
}

#[test]
fn retirement_removes_only_unsupported_registry_oracle_and_depth_entries() {
    let mut ketos = populated();
    let retained = retained_state(&ketos);
    let other_markets = ketos.markets.values().filter(|market|
        !UNSUPPORTED_MARKETS.contains(&market.id.as_str())).cloned().collect::<Vec<_>>();
    let near_depth = ketos.get_depth("NEAR".into());
    assert_eq!(ketos.retire_unsupported_markets(), vec!["AURORA", "RHEA"]);
    assert_eq!(retained_state(&ketos), retained);
    // IterableMap removal may swap registry iteration order; compare by market id.
    for market in other_markets {
        assert_eq!(ketos.markets.get(&market.id), Some(&market));
        assert_eq!(ketos.oracle_markets.get(&market.oracle_asset_id), Some(&market.id));
    }
    assert_eq!(ketos.get_depth("NEAR".into()), near_depth);
    for (symbol, asset) in RETIRED_ASSETS {
        assert!(ketos.get_market(symbol.into()).is_none());
        assert!(ketos.oracle_markets.get(asset).is_none());
        assert!(ketos.depth.get(symbol).is_none());
    }
    let after = registry_state(&ketos);
    assert!(ketos.retire_unsupported_markets().is_empty());
    assert_eq!(registry_state(&ketos), after);
    // The consumer path no longer asks for the two unavailable prices.
    ctx_at(USDC, T0_MS);
    assert!(matches!(ketos.ft_on_transfer(id("new-lp.test"), U128(USD),
        "deposit_vault:long-tail".into()), PromiseOrValue::Value(U128(0))));
    assert!(ketos.get_vault_account(VaultId::LongTail, id("new-lp.test")).shares.0 > 0);
}

#[test]
fn retirement_is_idempotent_when_one_market_is_already_missing() {
    let mut ketos = populated();
    let aurora = ketos.markets.remove("AURORA").unwrap();
    ketos.oracle_markets.remove(&aurora.oracle_asset_id);
    ketos.depth.remove("AURORA");
    assert_eq!(ketos.retire_unsupported_markets(), vec!["RHEA"]);
    assert!(ketos.retire_unsupported_markets().is_empty());
}

#[test]
fn retirement_checks_both_sides_of_both_markets_before_mutation() {
    let mut ketos = populated();
    for symbol in UNSUPPORTED_MARKETS {
        for long in [true, false] {
            let market = ketos.markets.get_mut(symbol).unwrap();
            if long { market.oi_long = U128(1); } else { market.oi_short = U128(1); }
            assert_refused_without_changes(&mut ketos, "ERR_MARKET_HAS_OPEN_INTEREST");
            let market = ketos.markets.get_mut(symbol).unwrap();
            market.oi_long = U128(0);
            market.oi_short = U128(0);
        }
    }
}

#[test]
fn retirement_refuses_positions_even_with_zero_oi_or_missing_registry() {
    let mut ketos = populated();
    let position = open(&mut ketos, "RHEA", Side::Long, 10 * USD, 2);
    ketos.markets.get_mut("RHEA").unwrap().oi_long = U128(0);
    ctx_at(CONTRACT, T0_MS);
    assert_refused_without_changes(&mut ketos, "ERR_MARKET_HAS_POSITIONS");
    ketos.markets.remove("RHEA");
    assert_refused_without_changes(&mut ketos, "ERR_MARKET_HAS_POSITIONS");
    assert!(ketos.positions.get(&position.id).is_some());
}

#[test]
fn retirement_refuses_limit_and_stop_orders_even_with_missing_registry() {
    let mut ketos = populated();
    for stop in [false, true] {
        ctx_at("alice.test", T0_MS);
        let request = if stop { OrderRequest::StopMarket(entry("RHEA")) }
            else { OrderRequest::Limit(entry("RHEA")) };
        let order = ketos.place_order_now(request);
        ctx_at(CONTRACT, T0_MS);
        assert_refused_without_changes(&mut ketos, "ERR_MARKET_HAS_ORDERS");
        let market = ketos.markets.remove("RHEA").unwrap();
        assert_refused_without_changes(&mut ketos, "ERR_MARKET_HAS_ORDERS");
        ketos.markets.insert("RHEA".into(), market);
        ctx_at("alice.test", T0_MS);
        drop(ketos.cancel_order(order.id, Some(false)));
    }
}

#[test]
fn retirement_rejects_external_callers_before_mutation() {
    let mut ketos = populated();
    ctx_at("attacker.test", T0_MS);
    assert_refused_without_changes(&mut ketos, "ERR_PRIVATE_RETIREMENT");
}

#[test]
fn paid_listing_cannot_restore_retired_symbols_or_alias_their_assets() {
    let mut ketos = populated();
    ketos.retire_unsupported_markets();
    for (symbol, asset) in RETIRED_ASSETS {
        for alias in [symbol, "RENAMED"] {
            ctx_at(USDC, T0_MS);
            let before = registry_state(&ketos);
            let request = json!({ "symbol": alias, "oracle_asset_id": asset,
                "intents_asset_id": format!("nep141:{asset}"), "price_source": "tee" });
            assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                drop(ketos.ft_on_transfer(id("lister.test"), U128(crate::listing::LISTING_FEE),
                    format!("list_market:{request}")));
            })).is_err());
            assert_eq!(registry_state(&ketos), before);
        }
    }
}

#[test]
fn pre_upgrade_pending_token_actions_refund_without_resurrecting_retired_markets() {
    let mut ketos = populated();
    // Receipts are external to contract state. Simulate callbacks scheduled by the
    // previous code, both when the retired market was stale and when only ZEC was.
    ketos.retire_unsupported_markets();
    let before = registry_state(&ketos);
    let requested_at = T0_MS - 1;
    for symbol in UNSUPPORTED_MARKETS {
        for requests in [vec![(symbol.into(), 0)], vec![("ZEC".into(), 0)]] {
            let action = PullAction::WalletOpen {
                account_id: id("alice.test"), amount: U128(25 * USD),
                request: WalletOpenRequest { market_id: symbol.into(), side: Side::Long,
                    margin: None, leverage: 2, margin_mode: MarginMode::Isolated,
                    brackets: None, signed_prices: None },
            };
            let result = ketos.on_action_prices(action, requests, requested_at, Ok(json!(true)));
            let PromiseOrValue::Value(refund) = result else { panic!("expected settled token action"); };
            assert_eq!(refund, json!((25 * USD).to_string()));
            assert_eq!(registry_state(&ketos), before);
        }
        let action = PullAction::DepositVault { account_id: id("alice.test"),
            vault_id: VaultId::LongTail, amount: U128(25 * USD) };
        let result = ketos.on_action_prices(action, vec![(symbol.into(), 0)], requested_at, Ok(json!(true)));
        let PromiseOrValue::Value(refund) = result else { panic!("expected settled token action"); };
        assert_eq!(refund, json!((25 * USD).to_string()));
        assert_eq!(registry_state(&ketos), before);
    }
}

#[test]
fn retirement_on_fresh_defaults_is_a_noop() {
    let mut ketos = setup();
    ctx_at(CONTRACT, T0_MS);
    let before = near_sdk::borsh::to_vec(&ketos).unwrap();
    assert!(ketos.retire_unsupported_markets().is_empty());
    assert!(ketos.retire_unsupported_markets().is_empty());
    assert_eq!(near_sdk::borsh::to_vec(&ketos).unwrap(), before);
}
