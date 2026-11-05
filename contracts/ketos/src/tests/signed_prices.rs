use super::*;
use crate::signed_prices::SignedPrices;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{json, Value};

fn signing_key() -> SigningKey { SigningKey::from_bytes(&[17; 32]) }

fn key_string(key: &SigningKey) -> String {
    String::from(&near_sdk::PublicKey::from_parts(near_sdk::CurveType::ED25519,
        key.verifying_key().to_bytes().to_vec()).unwrap())
}

fn pin(ketos: &mut Ketos) {
    ctx_at(CONTRACT, T0_MS);
    ketos.set_price_signer(key_string(&signing_key()).parse().unwrap());
}

fn payload(timestamp: u64) -> Value {
    json!({"domain":"ketos:prices:v1","prices":{
        "NEAR":{"price":(P4 + 1).to_string(),"publish_time":timestamp / 1_000,"sources":["coinbase","kraken"]}
    }})
}

fn sign(value: Value) -> SignedPrices {
    let payload = value.to_string();
    SignedPrices { signature: Base64VecU8(signing_key().sign(payload.as_bytes()).to_bytes().to_vec()),
        payload, public_key: key_string(&signing_key()) }
}

#[test]
fn valid_signed_price_opens_from_a_cold_cache_with_zero_oracle_deposit() {
    let mut ketos = trading_setup();
    pin(&mut ketos);
    let now = T0_MS + 130_000;
    ctx_at("alice.test", now);
    let result = ketos.open_position("NEAR".into(), Side::Long, U128(50 * USD), 2, None, None, Some(sign(payload(now))));
    let PromiseOrValue::Value(position) = result else { panic!("signed entry must be synchronous"); };
    assert_eq!(position.entry_price.0, P4 + 1);
    assert_eq!(position.size.0, 100 * USD);
    assert_eq!(margin(&ketos, "alice.test"), 150 * USD);
    assert!(get_created_receipts().is_empty(), "no oracle requests or fees");
}

#[test]
fn invalid_signatures_domains_sources_and_age_leave_prices_unchanged() {
    let mut ketos = trading_setup();
    pin(&mut ketos);
    let now = T0_MS + 130_000;
    ctx_at("alice.test", now);
    let good = payload(now);
    let mut cases = Vec::new();
    let mut changed = sign(good.clone()); changed.payload.push(' '); cases.push(changed);
    let mut bad_sig = sign(good.clone()); bad_sig.signature.0[0] ^= 1; cases.push(bad_sig);
    let mut bad_key = sign(good.clone()); bad_key.public_key = key_string(&SigningKey::from_bytes(&[18; 32])); cases.push(bad_key);
    cases.push(sign(payload(now - 16_000)));
    cases.push(sign(payload(now + 1_000)));
    let mut wrong_domain = good.clone(); wrong_domain["domain"] = json!("other-feed"); cases.push(sign(wrong_domain));
    for sources in [json!(["coinbase"]), json!(["coinbase","coinbase"]), json!(["coinbase","unknown"])] {
        let mut value = good.clone(); value["prices"]["NEAR"]["sources"] = sources; cases.push(sign(value));
    }
    for value in ["0", "-1", "340282366920938463463374607431768211456"] {
        let mut invalid = good.clone(); invalid["prices"]["NEAR"]["price"] = json!(value); cases.push(sign(invalid));
    }
    for signed in cases {
        assert!(!ketos.apply_signed_prices(Some(&signed), &["NEAR".into()]));
        assert_eq!(stored_price(&ketos, "NEAR"), (P4, T0_MS));
    }
}

#[test]
fn incomplete_batch_and_replayed_batch_never_partially_advance_a_market() {
    let mut ketos = trading_setup();
    pin(&mut ketos);
    let now = T0_MS + 130_000;
    ctx_at("alice.test", now);
    let signed = sign(payload(now));
    assert!(!ketos.apply_signed_prices(Some(&signed), &["NEAR".into(), "ETH".into()]));
    assert_eq!(stored_price(&ketos, "NEAR"), (P4, T0_MS));
    assert!(ketos.apply_signed_prices(Some(&signed), &["NEAR".into(), "NEAR".into()]));
    assert_eq!(stored_price(&ketos, "NEAR"), (P4 + 1, now));
    assert!(!ketos.apply_signed_prices(Some(&signed), &["NEAR".into()]));
    assert_eq!(stored_price(&ketos, "NEAR"), (P4 + 1, now));
}

#[test]
fn invalid_envelope_uses_original_funded_pull_without_spending_margin() {
    let mut ketos = trading_setup();
    pin(&mut ketos);
    let now = T0_MS + 130_000;
    let cost = ketos.get_price_request_deposit("NEAR".into()).0;
    let mut signed = sign(payload(now)); signed.signature.0[0] ^= 1;
    testing_env!(VMContextBuilder::new().current_account_id(id(CONTRACT)).predecessor_account_id(id("alice.test"))
        .block_timestamp(now * 1_000_000).attached_deposit(NearToken::from_yoctonear(cost))
        .prepaid_gas(Gas::from_tgas(300)).build());
    assert!(matches!(ketos.open_position("NEAR".into(), Side::Long, U128(50 * USD), 2, None, None, Some(signed)), PromiseOrValue::Promise(_)));
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
    assert_eq!(stored_price(&ketos, "NEAR"), (P4, T0_MS));
    assert!(ketos.get_positions(id("alice.test")).is_empty());
}

#[test]
fn fifteen_second_boundary_and_asset_identity_are_enforced() {
    let mut ketos = trading_setup(); pin(&mut ketos);
    let observed = T0_MS + 130_000;
    let signed = sign(payload(observed));
    ctx_at("alice.test", observed + 15_001);
    assert!(!ketos.apply_signed_prices(Some(&signed), &["NEAR".into()]));
    ctx_at("alice.test", observed + 15_000);
    ketos.markets.get_mut("NEAR").unwrap().oracle_asset_id = "unrelated.token".into();
    assert!(!ketos.apply_signed_prices(Some(&signed), &["NEAR".into()]));
    assert_eq!(stored_price(&ketos, "NEAR"), (P4, T0_MS));
    ketos.markets.get_mut("NEAR").unwrap().oracle_asset_id = "wrap.near".into();
    assert!(ketos.apply_signed_prices(Some(&signed), &["NEAR".into()]));
    assert_eq!(stored_price(&ketos, "NEAR"), (P4 + 1, observed));
}

#[test]
#[should_panic(expected = "ERR_PRICE_SIGNER_ALREADY_SET")]
fn signer_cannot_be_rotated_after_pinning() {
    let mut ketos = trading_setup(); pin(&mut ketos); pin(&mut ketos);
}
