use super::*;
use crate::orders::{BracketAmendment, BracketBounds, BracketOrderIds, Brackets, Order, OrderRequest};
use crate::pull_prices::PullAction;
use near_sdk::serde_json::{json, Value};

fn initial(side: Side) -> Brackets {
    match side {
        Side::Long => Brackets { take_profit: Some(U128(440_000_000)), stop_loss: Some(U128(380_000_000)) },
        Side::Short => Brackets { take_profit: Some(U128(360_000_000)), stop_loss: Some(U128(420_000_000)) },
    }
}

fn opened(side: Side) -> (Ketos, PositionView) {
    // Each scenario owns a fresh mocked trie; testing_env otherwise preserves storage.
    near_sdk::mock::with_mocked_blockchain(|blockchain| { blockchain.take_storage(); });
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS);
    let position = ketos.open_position_now("NEAR".into(), side, U128(100 * USD), 5, Some(initial(side)), None);
    (ketos, position)
}

fn amendment(position: &PositionView, brackets: Brackets) -> BracketAmendment {
    let execution = bracket_execution(position.side, Some(&brackets)).unwrap_or_default();
    BracketAmendment {
        position_id: position.id,
        expected: BracketOrderIds { take_profit: position.take_profit, stop_loss: position.stop_loss },
        brackets, execution,
    }
}

fn claims(ketos: &Ketos, position_id: u64) -> (u128, u128, Vec<Order>, Option<PositionView>) {
    let account = ketos.get_account(id("alice.test")).unwrap();
    (account.margin.0, account.reserved_margin.0, ketos.get_orders(id("alice.test")), ketos.get_position(position_id))
}

fn callback_value(result: PromiseOrValue<Value>) -> Value {
    match result { PromiseOrValue::Value(value) => value, _ => panic!("unexpected transfer") }
}

#[test]
fn replacement_reuses_existing_rewards_and_can_lock_in_profit_on_both_sides() {
    for side in [Side::Long, Side::Short] {
        let (mut ketos, position) = opened(side);
        // All unreserved cash can be used elsewhere; existing rewards still fund replacement.
        ketos.accounts.get_mut(&id("alice.test")).unwrap().margin = 0;
        let (price, brackets) = match side {
            Side::Long => (500_000_000, Brackets { take_profit: Some(U128(600_000_000)), stop_loss: Some(U128(450_000_000)) }),
            Side::Short => (300_000_000, Brackets { take_profit: Some(U128(280_000_000)), stop_loss: Some(U128(350_000_000)) }),
        };
        set_price(&mut ketos, "NEAR", price, T0_MS);
        let before_reserved = ketos.get_account(id("alice.test")).unwrap().reserved_margin;
        let request = amendment(&position, brackets.clone());
        let result = ketos.try_amend_brackets_for(id("alice.test"), request, false).unwrap();
        assert!(matches!(result, PromiseOrValue::Value(U128(0))));
        let after = ketos.get_position(position.id).unwrap();
        assert_eq!((after.margin, after.size, after.entry_price), (position.margin, position.size, position.entry_price));
        assert_eq!(margin(&ketos, "alice.test"), 0);
        assert_eq!(ketos.get_account(id("alice.test")).unwrap().reserved_margin, before_reserved);
        assert!(!ketos.orders.contains_key(&position.take_profit.unwrap()));
        assert!(!ketos.orders.contains_key(&position.stop_loss.unwrap()));
        assert_eq!(ketos.orders.get(&after.take_profit.unwrap()).unwrap().request,
            OrderRequest::TakeProfit { position_id: position.id, trigger_price: brackets.take_profit.unwrap() });
        assert_eq!(ketos.orders.get(&after.stop_loss.unwrap()).unwrap().request,
            OrderRequest::StopLoss { position_id: position.id, trigger_price: brackets.stop_loss.unwrap() });
        let market = ketos.get_market("NEAR".into()).unwrap();
        assert_eq!(market.market.oi(side), position.size.0);
    }
}

#[test]
fn removing_one_bracket_refunds_only_its_reward_and_restores_failed_wallet_payment() {
    let (mut ketos, position) = opened(Side::Long);
    let before = margin(&ketos, "alice.test");
    let reward = crate::orders::execution_reward(position.size.0);
    let request = amendment(&position, Brackets { take_profit: Some(U128(450_000_000)), stop_loss: None });
    assert!(matches!(ketos.try_amend_brackets_for(id("alice.test"), request, true).unwrap(), PromiseOrValue::Promise(_)));
    assert_eq!(margin(&ketos, "alice.test"), before);
    assert_eq!(ketos.get_account(id("alice.test")).unwrap().reserved_margin.0, reward);
    assert_margin_wallet_transfer(reward);
    ctx_at(CONTRACT, T0_MS + 1);
    ketos.on_margin_withdrawn(id("alice.test"), U128(reward), Err(PromiseError::Failed));
    assert_eq!(margin(&ketos, "alice.test"), before + reward);
    let after = ketos.get_position(position.id).unwrap();
    assert!(after.take_profit.is_some());
    assert_eq!(after.stop_loss, None);
}

#[test]
fn clearing_brackets_does_not_require_an_available_oracle() {
    let (mut ketos, position) = opened(Side::Long);
    let before = margin(&ketos, "alice.test");
    let reward = 2 * crate::orders::execution_reward(position.size.0);
    ctx_at("alice.test", T0_MS + 1_000_000);
    let result = ketos.amend_brackets(amendment(&position, Brackets::default()), Some(false), None);
    assert!(matches!(result, PromiseOrValue::Value(U128(value)) if value == reward));
    assert_eq!(margin(&ketos, "alice.test"), before + reward);
    assert_eq!(ketos.get_account(id("alice.test")).unwrap().reserved_margin.0, 0);
    assert_eq!(ketos.get_position(position.id).unwrap().size, position.size);
    assert!(ketos.get_orders(id("alice.test")).is_empty());
    assert!(get_created_receipts().is_empty());
}

#[test]
fn invalid_amendments_leave_existing_brackets_and_reservations_untouched() {
    for failure in ["owner", "version", "trigger", "expiry", "funds", "missing-bound"] {
        let (mut ketos, position) = opened(Side::Long);
        let mut request = amendment(&position, initial(Side::Long));
        let mut actor = id("alice.test");
        let expected_error = match failure {
            "owner" => { actor = id("bob.test"); "ERR_NOT_OWNER" }
            "version" => { request.expected.take_profit = Some(u64::MAX); "ERR_BRACKETS_CHANGED" }
            "trigger" => { request.brackets.take_profit = Some(U128(0)); "ERR_INVALID_TAKE_PROFIT" }
            "expiry" => { request.execution.take_profit.as_mut().unwrap().expires_at_ms = T0_MS - 1; "ERR_EXECUTION_EXPIRED" }
            "funds" => {
                ctx_at("alice.test", T0_MS);
                let _ = ketos.cancel_order(position.stop_loss.unwrap(), Some(false));
                let current = ketos.get_position(position.id).unwrap();
                request = amendment(&current, initial(Side::Long));
                ketos.accounts.get_mut(&id("alice.test")).unwrap().margin = 0;
                "ERR_INSUFFICIENT_MARGIN"
            }
            "missing-bound" => { request.execution = BracketBounds::default(); "ERR_BRACKET_EXECUTION_REQUIRED" }
            _ => unreachable!(),
        };
        let before = claims(&ketos, position.id);
        assert_eq!(ketos.try_amend_brackets_for(actor, request, false).err().as_deref(), Some(expected_error));
        assert_eq!(claims(&ketos, position.id), before, "{failure}");
    }
}

#[test]
fn replacement_callback_checks_the_reviewed_order_ids_again_and_cannot_replay() {
    let (mut ketos, position) = opened(Side::Long);
    let pending = amendment(&position, initial(Side::Long));
    let requested = T0_MS + 20_000;
    let nonce = ketos.reserve_price_action();
    let _ = ketos.try_amend_brackets_for(id("alice.test"), pending.clone(), false).unwrap();
    let now = requested + 1;
    set_price(&mut ketos, "NEAR", P4, now);
    ctx_at(CONTRACT, now);
    let action = PullAction::AmendBrackets { account_id: id("alice.test"), request: pending, to_wallet: false };
    let before = claims(&ketos, position.id);
    let result = callback_value(ketos.on_action_prices(nonce, action.clone(), vec![("NEAR".into(), T0_MS)], requested, Ok(json!(true))));
    assert_eq!(result["error"], "ERR_BRACKETS_CHANGED");
    assert_eq!(claims(&ketos, position.id), before);
    let replay = callback_value(ketos.on_action_prices(nonce, action, vec![("NEAR".into(), T0_MS)], requested, Ok(json!(true))));
    assert_eq!(replay["error"], "ERR_ACTION_ALREADY_SETTLED");
    assert_eq!(claims(&ketos, position.id), before);
}

#[test]
fn a_position_closed_before_the_amendment_callback_cannot_recreate_exit_orders() {
    let (mut ketos, position) = opened(Side::Long);
    let request = amendment(&position, initial(Side::Long));
    ketos.close_position_at(position.id, P4, T0_MS);
    let before = (margin(&ketos, "alice.test"), ketos.get_orders(id("alice.test")));
    assert_eq!(ketos.try_amend_brackets_for(id("alice.test"), request, false).err().as_deref(), Some("ERR_NO_POSITION"));
    assert_eq!((margin(&ketos, "alice.test"), ketos.get_orders(id("alice.test"))), before);
    assert!(ketos.get_position(position.id).is_none());
}
