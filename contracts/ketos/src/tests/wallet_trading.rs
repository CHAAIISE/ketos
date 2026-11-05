use super::*;
use crate::pull_prices::PullAction;
use crate::wallet_trading::WalletOpenRequest;
use near_sdk::serde_json::{json, Value};

fn open_request(margin: Option<u128>) -> Value {
    json!({ "market_id": "NEAR", "side": "long", "leverage": 2,
        "margin": margin.map(|value| value.to_string()) })
}

fn receive(ketos: &mut Ketos, trader: &str, amount: u128, prefix: &str, request: Value) -> U128 {
    ctx_at(USDC, T0_MS);
    match ketos.ft_on_transfer(id(trader), U128(amount), format!("{prefix}:{request}")) {
        PromiseOrValue::Value(unused) => unused,
        _ => panic!("expected immediate admission"),
    }
}

#[test]
fn wallet_open_uses_only_received_collateral_and_returns_surplus() {
    let mut ketos = trading_setup();
    let unused = receive(&mut ketos, "alice.test", 75 * USD, "open", open_request(Some(50 * USD)));
    assert_eq!(unused.0, 25 * USD);
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
    let positions = ketos.get_positions(id("alice.test"));
    assert_eq!(positions[0].size.0, 100 * USD);
    assert_eq!(positions[0].margin.0, 50 * USD - 300_000);
    let events = ketos.get_history(id("alice.test"), None, None);
    let deposit = events.iter().find(|event| event.kind == crate::history::HistoryKind::Deposit && event.size.0 == 50 * USD);
    assert!(deposit.is_some());
}

#[test]
fn new_wallet_can_open_with_brackets_without_a_margin_deposit() {
    let mut ketos = trading_setup();
    let mut request = open_request(None);
    request["brackets"] = json!({ "take_profit": "500000000", "stop_loss": "300000000" });
    assert_eq!(receive(&mut ketos, "bob.test", 50 * USD, "open", request).0, 0);
    let account = ketos.get_account(id("bob.test")).unwrap();
    assert_eq!(account.margin.0, 0);
    assert_eq!(account.reserved_margin.0, 200_000);
    let position = &ketos.get_positions(id("bob.test"))[0];
    assert_eq!(position.size.0, 99_600_000);
    assert_eq!(ketos.get_orders(id("bob.test")).len(), 2);
}

#[test]
fn refusals_return_the_entire_transfer_without_spending_old_margin_or_writing_history() {
    let mut ketos = trading_setup();
    let before = ketos.get_history(id("alice.test"), None, None);
    // Even a funded account cannot subsidize an undersized wallet transfer.
    assert_eq!(receive(&mut ketos, "alice.test", 25 * USD, "open", open_request(Some(50 * USD))).0, 25 * USD);
    let mut bad_bracket = open_request(Some(25 * USD));
    bad_bracket["brackets"] = json!({ "take_profit": "300000000" });
    assert_eq!(receive(&mut ketos, "alice.test", 50 * USD, "open", bad_bracket).0, 50 * USD);
    ketos.markets.get_mut("NEAR").unwrap().exit_capacity = U128(0);
    assert_eq!(receive(&mut ketos, "bob.test", 50 * USD, "open", open_request(None)).0, 50 * USD);
    assert!(ketos.get_account(id("bob.test")).is_none());
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
    assert_eq!(ketos.get_history(id("alice.test"), None, None), before);
    assert_eq!(ketos.markets.get("NEAR").unwrap().oi_long.0, 0);
}

#[test]
fn cold_transfer_is_not_free_margin_and_failed_pull_returns_all_tokens() {
    let mut ketos = trading_setup();
    let now = T0_MS + 121_000;
    let cost = ketos.get_price_request_deposit("NEAR".into()).0;
    testing_env!(VMContextBuilder::new().current_account_id(id(CONTRACT))
        .predecessor_account_id(id(USDC)).block_timestamp(now * 1_000_000)
        .attached_deposit(NearToken::from_yoctonear(cost)).prepaid_gas(Gas::from_tgas(300)).build());
    ketos.fund_transfer_price_requests(id("bob.test"));
    ctx_at(USDC, now);
    let request: WalletOpenRequest = near_sdk::serde_json::from_value(open_request(None)).unwrap();
    assert!(matches!(ketos.ft_on_transfer(id("bob.test"), U128(50 * USD), format!("open:{}", open_request(None))), PromiseOrValue::Promise(_)));
    assert!(ketos.get_account(id("bob.test")).is_none());
    assert_eq!(ketos.get_price_deposit(id("bob.test")).0, 0);
    ctx_at(CONTRACT, now + 1);
    let result = ketos.on_action_prices(PullAction::WalletOpen {
        account_id: id("bob.test"), amount: U128(50 * USD), request,
    }, vec![("NEAR".into(), T0_MS)], now, Err(PromiseError::Failed));
    let PromiseOrValue::Value(unused) = result else { panic!("refund expected"); };
    assert_eq!(unused, json!((50 * USD).to_string()));
    assert!(ketos.get_account(id("bob.test")).is_none());
}

#[test]
fn callback_rechecks_caps_and_never_keeps_refunded_usdc_in_margin() {
    let mut ketos = trading_setup();
    let now = T0_MS + 121_000;
    set_price(&mut ketos, "NEAR", P4, now);
    ketos.markets.get_mut("NEAR").unwrap().exit_capacity = U128(0);
    ctx_at(CONTRACT, now + 1);
    let action = PullAction::WalletOpen { account_id: id("alice.test"), amount: U128(50 * USD),
        request: near_sdk::serde_json::from_value(open_request(None)).unwrap() };
    let result = ketos.on_action_prices(action, vec![("NEAR".into(), T0_MS)], now, Ok(json!(true)));
    let PromiseOrValue::Value(unused) = result else { panic!("refund expected"); };
    assert_eq!(unused, json!((50 * USD).to_string()));
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
    assert!(ketos.get_positions(id("alice.test")).is_empty());
}

#[test]
fn wallet_entry_orders_reserve_future_bracket_rewards_without_free_margin() {
    let mut ketos = trading_setup();
    let mut request = open_request(Some(50 * USD));
    request["kind"] = json!("limit");
    request["trigger_price"] = json!("400000000");
    request["brackets"] = json!({ "take_profit": "500000000", "stop_loss": "300000000" });
    assert_eq!(receive(&mut ketos, "bob.test", 51 * USD, "order", request).0, 700_000);
    let order = &ketos.get_orders(id("bob.test"))[0];
    assert_eq!(order.bracket_reserve.0, 200_000);
    assert!(order.wallet_funded);
    assert_eq!(margin(&ketos, "bob.test"), 0);
    assert_eq!(ketos.get_account(id("bob.test")).unwrap().reserved_margin.0, 50_300_000);
    ctx_at("executor.test", T0_MS);
    let fills = ketos.execute_orders_now(vec![order.id]);
    assert!(matches!(fills[0], crate::orders::OrderExecution::Filled { .. }));
    assert_eq!(ketos.get_positions(id("bob.test"))[0].size.0, 100 * USD);
    assert_eq!(ketos.get_orders(id("bob.test")).len(), 2);
    assert_eq!(ketos.get_account(id("bob.test")).unwrap().reserved_margin.0, 200_000);
    assert_eq!(margin(&ketos, "bob.test"), 0);
    assert_eq!(margin(&ketos, "executor.test"), 100_000);
}

#[test]
fn automatic_collateral_is_maximal_across_reward_rounding_boundaries() {
    let mut ketos = trading_setup();
    for (index, amount) in [100_199_999u128, 100_200_000, 100_200_001, 1_234_567_890].into_iter().enumerate() {
        for entry_order in [false, true] {
            let trader = format!("wallet-{index}-{entry_order}.test");
            let mut request = open_request(None);
            request["brackets"] = json!({ "take_profit": "500000000", "stop_loss": "300000000" });
            if entry_order {
                request["kind"] = json!("limit");
                request["trigger_price"] = json!("390000000");
            }
            let unused = receive(&mut ketos, &trader, amount, if entry_order { "order" } else { "open" }, request).0;
            let committed = if entry_order {
                ketos.get_orders(id(&trader))[0].request.entry().unwrap().margin.0
            } else {
                ketos.get_positions(id(&trader))[0].size.0 / 2
            };
            let slots = if entry_order { 3 } else { 2 };
            let reward = |margin: u128| (margin * 2 * 5).div_ceil(10_000).max(100_000);
            assert_eq!(committed + slots * reward(committed) + unused, amount);
            assert!(committed + 1 + slots * reward(committed + 1) > amount);
            assert_eq!(margin(&ketos, &trader), 0);
        }
    }
}

#[test]
#[should_panic(expected = "ERR_WRONG_TOKEN")]
fn another_caller_cannot_assign_someone_elses_price_credit() {
    let mut ketos = setup();
    ctx("stranger.test", 100);
    ketos.fund_transfer_price_requests(id("alice.test"));
}
