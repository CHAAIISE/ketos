use super::*;
use near_sdk::serde_json::{json, Value};

fn deliver(ketos: &mut Ketos, now: u64, response: Value) -> u32 {
    ctx_at(CONTRACT, now);
    ketos.on_worker_prices(vec!["DOGE".into(), "XRP".into()], None, Ok(Some(response)))
}

fn response(at: u64) -> Value {
    json!({ "timestamp_ms": at, "prices": {
        "DOGE": ["8000000", ["coinbase", "kraken"]],
        "XRP": ["130000000", ["kraken", "binance"]],
    }})
}

#[test]
fn quorum_prices_enable_worker_market_trading_only_after_depth() {
    let mut ketos = setup();
    assert_eq!(deliver(&mut ketos, T0_MS, response(T0_MS)), 2);
    assert_eq!(stored_price(&ketos, "DOGE"), (8_000_000, T0_MS));
    assert_eq!(stored_price(&ketos, "XRP"), (130_000_000, T0_MS));
    assert!(!ketos.get_market("DOGE".into()).unwrap().is_open);
    seed_depth(&mut ketos, "DOGE", measured_curve(), T0_MS);
    deposit(&mut ketos, "alice.test", 200 * USD);
    super::vaults::deposit_to(&mut ketos, "long-tail", "lp.test", 10_000 * USD);
    let position = open(&mut ketos, "DOGE", Side::Long, 100 * USD, 5);
    assert_eq!(position.entry_price.0, 8_000_000);
    let mut higher = response(T0_MS + 1);
    higher["prices"]["DOGE"][0] = json!("8800000");
    assert_eq!(deliver(&mut ketos, T0_MS + 1, higher), 2);
    ctx_at("alice.test", T0_MS + 1);
    let payout = ketos.close_position_now(position.id).0;
    // At +10%, the long earns $50 less $3 in base/impact fees and accrued charges.
    assert!(payout <= 147 * USD && payout >= 147 * USD - 2);
    let history = ketos.get_history(id("alice.test"), None, None);
    assert_eq!(history.len(), 4);
    assert_eq!(history[0].kind, crate::history::HistoryKind::Deposit);
}

#[test]
fn malformed_missing_and_failed_results_preserve_price_and_original_age() {
    let mut ketos = setup();
    deliver(&mut ketos, T0_MS, response(T0_MS));
    for bad in [
        Value::Null,
        json!("not an object"),
        json!({"prices": {}}),
        json!({"timestamp_ms": "1700000000000", "prices": {}}),
        json!({"timestamp_ms": T0_MS + 1, "prices": [], "extra": true}),
    ] {
        assert_eq!(deliver(&mut ketos, T0_MS + 1, bad), 0);
        assert_eq!(stored_price(&ketos, "DOGE"), (8_000_000, T0_MS));
    }
    ctx_at(CONTRACT, T0_MS + 120_001);
    assert_eq!(ketos.on_worker_prices(vec!["DOGE".into()], None, Ok(None)), 0);
    assert_eq!(
        ketos.on_worker_prices(vec!["DOGE".into()], None, Err(PromiseError::Failed)),
        0
    );
    assert_eq!(stored_price(&ketos, "DOGE"), (8_000_000, T0_MS));
    assert!(
        !ketos
            .get_prices()
            .iter()
            .find(|p| p.market_id == "DOGE")
            .unwrap()
            .is_fresh
    );
}

#[test]
fn timestamp_boundary_future_replay_and_out_of_order_cannot_reprice() {
    let mut ketos = setup();
    assert_eq!(deliver(&mut ketos, T0_MS, response(T0_MS - 120_001)), 0);
    assert_eq!(deliver(&mut ketos, T0_MS, response(T0_MS + 1)), 0);
    assert_eq!(deliver(&mut ketos, T0_MS, response(0)), 0);
    assert_eq!(stored_price(&ketos, "DOGE"), (0, 0));
    assert_eq!(deliver(&mut ketos, T0_MS, response(T0_MS - 120_000)), 2);
    assert_eq!(deliver(&mut ketos, T0_MS, response(T0_MS)), 2);
    for at in [T0_MS - 1, T0_MS] {
        let mut replay = response(at);
        replay["prices"]["DOGE"][0] = json!("1");
        assert_eq!(deliver(&mut ketos, T0_MS + 1, replay), 0);
        assert_eq!(stored_price(&ketos, "DOGE"), (8_000_000, T0_MS));
    }
}

#[test]
fn invalid_asset_quorum_and_integer_formats_do_not_poison_valid_siblings() {
    let mut ketos = setup();
    let bad_entries = [
        json!(["8000000", ["coinbase"]]),
        json!(["8000000", ["kraken", "kraken"]]),
        json!(["8000000", ["coinbase", "invented"]]),
        json!(["8000000", ["coinbase", "kraken", "binance", "kraken"]]),
        json!([8000000, ["coinbase", "kraken"]]),
        json!(["0", ["coinbase", "kraken"]]),
        json!(["-1", ["coinbase", "kraken"]]),
        json!(["+1", ["coinbase", "kraken"]]),
        json!(["1.5", ["coinbase", "kraken"]]),
        json!([
            "340282366920938463463374607431768211456",
            ["coinbase", "kraken"]
        ]),
        json!(["8000000", null]),
        json!({"price": "8000000", "sources": ["coinbase", "kraken"]}),
    ];
    for (i, entry) in bad_entries.into_iter().enumerate() {
        let now = T0_MS + i as u64;
        let mut result = response(now);
        result["prices"]["DOGE"] = entry;
        assert_eq!(deliver(&mut ketos, now, result), 1);
        assert_eq!(stored_price(&ketos, "DOGE"), (0, 0));
        assert_eq!(stored_price(&ketos, "XRP"), (130_000_000, now));
    }
}

#[test]
fn worker_cannot_update_tee_signed_or_unrequested_markets() {
    let mut ketos = setup();
    ketos.register_market(extra_market("SIGNED", PriceSource::Signed));
    let mut data = response(T0_MS);
    for asset in ["wrap.near", "SIGNED.oracle", "LTC", "unknown"] {
        data["prices"][asset] = json!(["1", ["coinbase", "kraken"]]);
    }
    assert_eq!(deliver(&mut ketos, T0_MS, data.clone()), 2);
    ctx_at(CONTRACT, T0_MS + 1);
    assert_eq!(
        ketos.on_worker_prices(
            vec!["wrap.near".into(), "SIGNED.oracle".into()],
            None,
            Ok(Some(data))
        ),
        0
    );
    for market in ["NEAR", "SIGNED", "LTC"] {
        assert_eq!(stored_price(&ketos, market), (0, 0));
    }
    // Conversely the TEE push cannot fill a worker market.
    let data = price_data(T0_MS + 1, &[("DOGE", Some((1, 8)))]);
    push_prices(&mut ketos, ORACLE, T0_MS + 1, data);
    assert_eq!(stored_price(&ketos, "DOGE"), (8_000_000, T0_MS));
}

#[test]
#[should_panic(expected = "ERR_UNSUPPORTED_WORKER_ASSET")]
fn unsupported_permissionless_worker_listing_cannot_break_every_batch() {
    let mut ketos = setup();
    ketos.register_market(extra_market("UNKNOWN", PriceSource::OutlayerWorker));
}

#[test]
#[should_panic(expected = "ERR_ORACLE_FUNDS_LOW")]
fn refresh_accounts_for_both_adapters_before_spending_any_deposit() {
    let mut ketos = setup();
    testing_env!(VMContextBuilder::new()
        .current_account_id(id(CONTRACT))
        .predecessor_account_id(id("keeper.test"))
        .account_balance(NearToken::from_millinear(39))
        .storage_usage(0)
        .prepaid_gas(Gas::from_tgas(200))
        .build());
    let _ = ketos.refresh_prices(None);
}
