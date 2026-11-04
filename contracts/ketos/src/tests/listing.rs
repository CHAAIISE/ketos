use super::*;
use crate::listing::LISTING_FEE;
use near_sdk::serde_json::{json, Value};

fn request() -> Value {
    json!({
        "symbol": "NEW",
        "oracle_asset_id": "new.token.near",
        "intents_asset_id": "nep141:new.token.near",
        "price_source": "tee",
    })
}

fn list(ketos: &mut Ketos, request: Value, amount: u128) {
    ctx_at(USDC, T0_MS);
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
    assert_eq!(tail.share_price.0, 1_005_000);
    assert_eq!(tail.revenue.listing.0, LISTING_FEE);
    assert_eq!(tail.revenue.fees.0, 0);
    assert_eq!(tail.fees_7d.0, LISTING_FEE);
    assert!(ketos.get_account(id("lister.test")).is_none());
    assert_eq!(ketos.get_vault_account(VaultId::LongTail, id("lister.test")).shares.0, 0);
    let market = ketos.get_market("NEW".into()).unwrap();
    assert!(!market.is_open);
    assert_eq!(market.max_oi_per_side.0, 0);
}

#[test]
fn listed_market_trades_after_authenticated_price_and_depth_with_five_x_ceiling() {
    let mut ketos = setup();
    list(&mut ketos, request(), LISTING_FEE);
    let data = price_data(T0_MS, &[("new.token.near", Some((P4, 8)))]);
    push_prices(&mut ketos, ORACLE, T0_MS, data);
    assert!(!ketos.get_market("NEW".into()).unwrap().is_open);
    set_depth_at(&mut ketos, "NEW", vec![DepthSample { size_usd: 1_000_000, impact_bps: Some(100) }], T0_MS);
    let market = ketos.get_market("NEW".into()).unwrap();
    assert!(market.is_open);
    assert_eq!(market.market.max_leverage, 5);
    assert_eq!(market.max_oi_per_side.0, 500_000 * USD);
    super::vaults::deposit_to(&mut ketos, "long-tail", "lp.test", 1_000 * USD);
    deposit(&mut ketos, "alice.test", 200 * USD);
    let core = ketos.get_vault(VaultId::Core);
    let p = open(&mut ketos, "NEW", Side::Long, 100 * USD, 5);
    assert_eq!(p.entry_price.0, P4);
    assert_eq!(p.size.0, 500 * USD);
    assert_eq!(p.margin.0, 99_500_000);
    assert_eq!(ketos.get_vault(VaultId::Core), core);
    assert_eq!(ketos.get_vault(VaultId::LongTail).revenue.fees.0, 500_000);
    ctx_at("alice.test", T0_MS);
    assert_eq!(ketos.close_position(p.id).0, 99 * USD);
    assert_eq!(ketos.get_vault(VaultId::LongTail).balance.0, 1_006 * USD);
}

#[test]
#[should_panic(expected = "ERR_MARKET_CLOSED")]
fn listing_with_a_price_cannot_trade_before_depth() {
    let mut ketos = setup();
    list(&mut ketos, request(), LISTING_FEE);
    set_price(&mut ketos, "NEW", P4, T0_MS);
    deposit(&mut ketos, "alice.test", 200 * USD);
    open(&mut ketos, "NEW", Side::Long, 100 * USD, 2);
}

#[test]
#[should_panic(expected = "ERR_NO_PRICE")]
fn depth_alone_cannot_make_an_unpriced_asset_tradable() {
    let mut ketos = setup();
    list(&mut ketos, request(), LISTING_FEE);
    set_depth_at(&mut ketos, "NEW", measured_curve(), T0_MS);
    deposit(&mut ketos, "alice.test", 200 * USD);
    open(&mut ketos, "NEW", Side::Long, 100 * USD, 5);
}

#[test]
#[should_panic(expected = "ERR_LEVERAGE_TOO_HIGH: max 5")]
fn listed_market_cannot_use_twenty_x_even_with_deep_liquidity() {
    let mut ketos = setup();
    list(&mut ketos, request(), LISTING_FEE);
    set_depth_at(&mut ketos, "NEW", vec![DepthSample { size_usd: 1_000_000, impact_bps: Some(20) }], T0_MS);
    set_price(&mut ketos, "NEW", P4, T0_MS);
    deposit(&mut ketos, "alice.test", 200 * USD);
    open(&mut ketos, "NEW", Side::Long, 100 * USD, 6);
}

#[test]
#[should_panic(expected = "ERR_MARKET_EXISTS")]
fn duplicate_symbol_cannot_replace_a_market() {
    let mut ketos = setup();
    let mut value = request();
    value["symbol"] = json!("NEAR");
    list(&mut ketos, value, LISTING_FEE);
}

#[test]
#[should_panic(expected = "ERR_ASSET_EXISTS")]
fn duplicate_oracle_asset_cannot_be_listed_under_a_new_symbol() {
    let mut ketos = setup();
    let mut value = request();
    value["oracle_asset_id"] = json!("wrap.near");
    list(&mut ketos, value, LISTING_FEE);
}

#[test]
#[should_panic(expected = "ERR_ASSET_EXISTS")]
fn duplicate_intents_asset_cannot_be_listed_with_a_different_oracle() {
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
#[should_panic(expected = "ERR_INVALID_ASSET")]
fn non_nep141_intents_asset_is_rejected() {
    let mut ketos = setup();
    let mut value = request();
    value["intents_asset_id"] = json!("wrap.near");
    list(&mut ketos, value, LISTING_FEE);
}
