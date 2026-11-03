use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, AccountId, Gas, NearToken, PromiseError, PromiseOrValue};

use crate::market::USD;
use crate::Perps;

const CONTRACT: &str = "perps.test";
const USDC: &str = "usdc.test";

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(id(CONTRACT))
        .predecessor_account_id(id(predecessor))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(300))
        .build());
}

fn setup() -> Perps {
    ctx("owner.test", 0);
    Perps::new(id(USDC), id("oracle.test"), id("keeper.test"))
}

/// Deposits margin and checks the whole amount is kept (nothing refunded to the sender).
fn deposit(perps: &mut Perps, trader: &str, amount: u128) {
    ctx(USDC, 0);
    let PromiseOrValue::Value(unused) =
        perps.ft_on_transfer(id(trader), U128(amount), "deposit_margin".into())
    else {
        panic!("deposit must resolve synchronously");
    };
    assert_eq!(unused, U128(0));
}

fn margin(perps: &Perps, trader: &str) -> u128 {
    perps.get_account(id(trader)).map_or(0, |a| a.margin.0)
}

#[test]
fn lists_four_markets_with_oracle_ids() {
    let perps = setup();
    let markets = perps.get_markets();
    let ids: Vec<_> = markets
        .iter()
        .map(|m| (m.id.as_str(), m.oracle_asset_id.as_str()))
        .collect();
    assert_eq!(
        ids,
        [
            ("BTC", "nbtc.bridge.near"),
            ("ETH", "aurora"),
            ("NEAR", "wrap.near"),
            ("ZEC", "zec.omft.near")
        ]
    );
    assert_eq!(perps.get_market("ZEC".into()).unwrap().oi_short, U128(0));
    assert!(perps.get_market("DOGE".into()).is_none());
    assert_eq!(perps.get_config().usdc_id, id(USDC));
}

#[test]
fn deposit_credits_margin_and_keeps_all_tokens() {
    let mut perps = setup();
    deposit(&mut perps, "alice.test", 200 * USD);
    deposit(&mut perps, "alice.test", 50);
    assert_eq!(margin(&perps, "alice.test"), 200 * USD + 50);
}

#[test]
#[should_panic(expected = "ERR_WRONG_TOKEN")]
fn deposit_from_other_token_is_rejected() {
    let mut perps = setup();
    ctx("fake-usdc.test", 0);
    let _ = perps.ft_on_transfer(id("alice.test"), U128(200 * USD), "deposit_margin".into());
}

#[test]
#[should_panic(expected = "ERR_INVALID_MSG")]
fn unknown_message_is_rejected() {
    let mut perps = setup();
    ctx(USDC, 0);
    let _ = perps.ft_on_transfer(id("alice.test"), U128(200 * USD), "gift".into());
}

#[test]
#[should_panic(expected = "ERR_MIN_FIRST_DEPOSIT")]
fn first_deposit_below_minimum_is_rejected() {
    let mut perps = setup();
    deposit(&mut perps, "alice.test", USD - 1);
}

#[test]
fn withdraw_debits_margin_and_transfers_tokens() {
    let mut perps = setup();
    deposit(&mut perps, "alice.test", 200 * USD);
    ctx("alice.test", 1);
    let _ = perps.withdraw_margin(U128(150 * USD));
    assert_eq!(margin(&perps, "alice.test"), 50 * USD);

    let receipts = get_created_receipts();
    assert_eq!(receipts[0].receiver_id, id(USDC));
    let MockAction::FunctionCallWeight {
        method_name,
        args,
        attached_deposit,
        ..
    } = &receipts[0].actions[0]
    else {
        panic!("expected ft_transfer");
    };
    assert_eq!(method_name.as_slice(), b"ft_transfer");
    assert_eq!(*attached_deposit, NearToken::from_yoctonear(1));
    let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
    assert_eq!(args["receiver_id"], "alice.test");
    assert_eq!(args["amount"], (150 * USD).to_string());
}

#[test]
fn failed_transfer_restores_margin() {
    let mut perps = setup();
    deposit(&mut perps, "alice.test", 200 * USD);
    ctx("alice.test", 1);
    let _ = perps.withdraw_margin(U128(200 * USD));
    assert_eq!(margin(&perps, "alice.test"), 0);

    ctx(CONTRACT, 0);
    let sent =
        perps.on_margin_withdrawn(id("alice.test"), U128(200 * USD), Err(PromiseError::Failed));
    assert_eq!(sent, U128(0));
    assert_eq!(margin(&perps, "alice.test"), 200 * USD);

    let sent = perps.on_margin_withdrawn(id("alice.test"), U128(5), Ok(()));
    assert_eq!(sent, U128(5));
    assert_eq!(margin(&perps, "alice.test"), 200 * USD);
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_MARGIN")]
fn cannot_withdraw_more_than_margin() {
    let mut perps = setup();
    deposit(&mut perps, "alice.test", 200 * USD);
    ctx("alice.test", 1);
    let _ = perps.withdraw_margin(U128(200 * USD + 1));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_requires_one_yocto() {
    let mut perps = setup();
    deposit(&mut perps, "alice.test", 200 * USD);
    ctx("alice.test", 0);
    let _ = perps.withdraw_margin(U128(USD));
}

#[test]
#[should_panic(expected = "ERR_NO_ACCOUNT")]
fn withdraw_without_account_fails() {
    let mut perps = setup();
    ctx("bob.test", 1);
    let _ = perps.withdraw_margin(U128(USD));
}
