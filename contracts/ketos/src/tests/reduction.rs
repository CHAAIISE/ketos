use super::*;
use crate::cross::MarginMode;
use crate::history::HistoryKind;
use crate::orders::{execution_reward, BracketAmendment, BracketOrderIds, Brackets};
use crate::pull_prices::PullAction;
use crate::reduction::ReductionRequest;
use near_sdk::serde_json::json;

fn opened(side: Side, mode: MarginMode) -> (Ketos, PositionView) {
    near_sdk::mock::with_mocked_blockchain(|blockchain| { blockchain.take_storage(); });
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS);
    let brackets = match side {
        Side::Long => Brackets { take_profit: Some(U128(P4 * 2)), stop_loss: Some(U128(P4 / 2)) },
        Side::Short => Brackets { take_profit: Some(U128(P4 / 2)), stop_loss: Some(U128(P4 * 2)) },
    };
    let position = ketos.open_position_now("NEAR".into(), side, U128(100 * USD), 5, Some(brackets), Some(mode));
    (ketos, position)
}

fn backing(ketos: &Ketos) -> i128 {
    let mut total = ketos.vaults.values().map(|vault| math::to_i128(vault.balance)).sum::<i128>();
    for who in ["alice.test", "bob.test", "keeper.test"] {
        if let Some(account) = ketos.accounts.get(&id(who)) {
            total += math::to_i128(account.margin + account.reserved_margin) + account.cross_cash;
            total += account.positions.iter().map(|id| math::to_i128(ketos.positions.get(id).unwrap().margin)).sum::<i128>();
            assert_eq!(account.cross_cash.min(0).unsigned_abs(), account.cross_debt.iter().sum::<u128>());
        }
    }
    for (vault_id, vault) in ketos.vaults.iter() {
        assert_eq!(vault.cross_receivable, ["alice.test", "bob.test", "keeper.test"].iter()
            .filter_map(|who| ketos.accounts.get(&id(who)))
            .map(|a| if vault_id.is_market() { 0 } else { a.cross_debt[vault_id.shared_index()] }).sum::<u128>());
        assert!(vault.cross_receivable <= vault.balance);
    }
    total
}

fn request(position: &PositionView, size: u128) -> ReductionRequest {
    ReductionRequest { position_id: position.id, expected_size: position.size, size: U128(size) }
}

fn value(result: PromiseOrValue<U128>) -> u128 {
    match result { PromiseOrValue::Value(amount) => amount.0, _ => panic!("unexpected transfer") }
}

#[test]
fn two_reductions_preserve_accruals_brackets_and_custody_in_both_modes_and_sides() {
    for side in [Side::Long, Side::Short] {
        for mode in [MarginMode::Isolated, MarginMode::Cross] {
            let (mut ketos, original) = opened(side, mode);
            let total = backing(&ketos);
            let entry = ketos.positions.get(&original.id).unwrap().clone();
            let original_orders = ketos.get_orders(id("alice.test"));
            let now = T0_MS + HOUR_MS;
            let price = if side == Side::Long { P4 * 105 / 100 } else { P4 * 95 / 100 };
            set_price(&mut ketos, "NEAR", price, now);
            ctx_at("alice.test", now);
            for _ in 0..2 {
                let before = ketos.get_position(original.id).unwrap();
                let account_before = ketos.get_account(id("alice.test")).unwrap();
                let cash_before = ketos.get_cross_account(id("alice.test")).cash.0;
                let slice_size = before.size.0 / 2;
                let slice_margin = math::mul_div_floor(before.margin.0, slice_size, before.size.0);
                let market = ketos.markets.get("NEAR").unwrap();
                let marked = ketos.positions.get(&original.id).unwrap().mark_slice(slice_size, slice_margin, market, price, now);
                assert!(marked.borrow_fee > 0);
                assert!(marked.funding_paid > 0);
                let expected = marked.equity - math::to_i128(marked.close_fee + ketos.impact_fee(&"NEAR".into(), slice_size));
                let old_orders = ketos.get_orders(id("alice.test"));
                let released = value(ketos.reduce_position_for(id("alice.test"), request(&before, slice_size), false,
                    execution_for_test(side, true, price)).unwrap());
                let after = ketos.get_position(original.id).unwrap();
                let remainder = ketos.positions.get(&original.id).unwrap();
                assert_eq!(after.size.0, before.size.0 - slice_size);
                assert_eq!(after.margin.0, before.margin.0 - slice_margin);
                assert_eq!((remainder.entry_price, remainder.entry_borrow_index, remainder.entry_funding_paid_index,
                    remainder.entry_funding_received_index, remainder.opened_at_ms),
                    (entry.entry_price, entry.entry_borrow_index, entry.entry_funding_paid_index,
                    entry.entry_funding_received_index, entry.opened_at_ms));
                let reserve = 2 * execution_reward(after.size.0);
                let reward_refund = account_before.reserved_margin.0 - reserve;
                assert_eq!(ketos.get_account(id("alice.test")).unwrap().reserved_margin.0, reserve);
                assert_eq!(released, reward_refund + if mode == MarginMode::Cross { 0 } else { expected as u128 });
                assert_eq!(ketos.get_cross_account(id("alice.test")).cash.0,
                    cash_before + if mode == MarginMode::Cross { expected } else { 0 });
                let orders = ketos.get_orders(id("alice.test"));
                assert_eq!(orders.len(), 2);
                for (new, old) in orders.iter().zip(&old_orders) {
                    assert_ne!(new.id, old.id);
                    assert_eq!(new.request, old.request);
                    assert_eq!(new.execution, old.execution);
                }
                assert_eq!(backing(&ketos), total);
                assert_eq!(ketos.get_market("NEAR".into()).unwrap().market.oi_long.0
                    + ketos.get_market("NEAR".into()).unwrap().market.oi_short.0, after.size.0);
            }
            let remainder = ketos.get_position(original.id).unwrap();
            let _ = ketos.reduce_position_for(id("alice.test"), request(&remainder, remainder.size.0), false,
                execution_for_test(side, true, price)).unwrap();
            assert!(ketos.get_position(original.id).is_none());
            assert!(ketos.get_orders(id("alice.test")).is_empty());
            assert!(original_orders.iter().all(|old| ketos.orders.get(&old.id).is_none()));
            assert_eq!(ketos.get_account(id("alice.test")).unwrap().reserved_margin.0, 0);
            assert_eq!(ketos.get_cross_account(id("alice.test")).cash.0, 0);
            assert_eq!(backing(&ketos), total);
            let history = ketos.get_history(id("alice.test"), None, None);
            assert_eq!(history.iter().filter(|e| e.kind == HistoryKind::Reduce).map(|e| e.size.0).sum::<u128>(), original.size.0 - remainder.size.0);
            assert_eq!(history.iter().filter(|e| e.kind == HistoryKind::Close).count(), 1);
        }
    }
}

#[test]
fn reduction_wallet_payment_releases_only_this_action_and_failure_restores_it() {
    let (mut ketos, position) = opened(Side::Long, MarginMode::Isolated);
    let total = backing(&ketos);
    let free_before = margin(&ketos, "alice.test");
    let before = ketos.positions.get(&position.id).unwrap();
    let market = ketos.markets.get("NEAR").unwrap();
    let size = position.size.0 / 2;
    let marked = before.mark_slice(size, before.margin / 2, market, P4, T0_MS);
    let amount = (marked.equity - math::to_i128(marked.close_fee + ketos.impact_fee(&"NEAR".into(), size))) as u128
        + 2 * (execution_reward(position.size.0) - execution_reward(size));
    assert!(matches!(ketos.reduce_position_for(id("alice.test"), request(&position, size), true,
        execution_for_test(Side::Long, true, P4)).unwrap(), PromiseOrValue::Promise(_)));
    assert_margin_wallet_transfer(amount);
    assert_eq!(margin(&ketos, "alice.test"), free_before);
    assert_eq!(backing(&ketos) + math::to_i128(amount), total);
    ctx_at(CONTRACT, T0_MS + 1);
    ketos.on_margin_withdrawn(id("alice.test"), U128(amount), Err(PromiseError::Failed));
    assert_eq!(margin(&ketos, "alice.test"), free_before + amount);
    assert_eq!(ketos.get_position(position.id).unwrap().size.0, size);
    assert_eq!(backing(&ketos), total);
}

#[test]
fn invalid_reductions_leave_positions_orders_and_cash_unchanged() {
    for case in ["owner", "version", "zero", "excess", "dust", "expired", "price-bound", "stale", "health"] {
        let (mut ketos, position) = opened(Side::Long, MarginMode::Isolated);
        let mut actor = id("alice.test");
        let mut req = request(&position, position.size.0 / 2);
        let mut bounds = execution_for_test(Side::Long, true, P4);
        let expected = match case {
            "owner" => { actor = id("bob.test"); "ERR_NOT_OWNER" }
            "version" => { req.expected_size.0 -= 1; "ERR_POSITION_CHANGED" }
            "zero" => { req.size.0 = 0; "ERR_REDUCTION_SIZE" }
            "excess" => { req.size.0 = position.size.0 + 1; "ERR_REDUCTION_SIZE" }
            "dust" => { req.size.0 = position.size.0 - 1; "ERR_REDUCTION_DUST" }
            "expired" => { bounds.expires_at_ms = T0_MS - 1; "ERR_EXECUTION_EXPIRED" }
            "price-bound" => { bounds.limit_price = U128(P4 + 1); "ERR_EXECUTION_PRICE_LIMIT" }
            "stale" => { set_price(&mut ketos, "NEAR", P4, T0_MS - 120_001); "ERR_STALE_PRICE" }
            "health" => { set_price(&mut ketos, "NEAR", P4 / 2, T0_MS); "ERR_REDUCTION_UNDERMARGINED" }
            _ => unreachable!(),
        };
        let before = (ketos.get_position(position.id), ketos.get_orders(id("alice.test")), ketos.get_account(id("alice.test")), backing(&ketos));
        assert_eq!(ketos.reduce_position_for(actor, req, false, bounds).err().as_deref(), Some(expected), "{case}");
        assert_eq!((ketos.get_position(position.id), ketos.get_orders(id("alice.test")), ketos.get_account(id("alice.test")), backing(&ketos)), before, "{case}");
    }
}

#[test]
fn changed_size_invalidates_async_reduction_and_old_bracket_review() {
    let (mut ketos, position) = opened(Side::Long, MarginMode::Isolated);
    let req = request(&position, position.size.0 / 2);
    let bounds = execution_for_test(Side::Long, true, P4);
    let nonce = ketos.reserve_price_action();
    let brackets = Brackets { take_profit: Some(U128(P4 * 2)), stop_loss: Some(U128(P4 / 2)) };
    let amend = BracketAmendment { position_id: position.id,
        expected: BracketOrderIds { take_profit: position.take_profit, stop_loss: position.stop_loss },
        execution: bracket_execution(Side::Long, Some(&brackets)).unwrap(), brackets };
    let _ = ketos.reduce_position_for(id("alice.test"), req, false, bounds).unwrap();
    ctx_at(CONTRACT, T0_MS + 1);
    set_price(&mut ketos, "NEAR", P4, T0_MS + 1);
    let before = ketos.get_position(position.id);
    let action = PullAction::Reduce { account_id: id("alice.test"), request: req, to_wallet: false, execution: bounds };
    let result = ketos.on_action_prices(nonce, action.clone(), vec![("NEAR".into(), T0_MS)], T0_MS, Ok(json!(true)));
    let PromiseOrValue::Value(value) = result else { panic!("unexpected transfer") };
    assert_eq!(value["error"], "ERR_POSITION_CHANGED");
    let PromiseOrValue::Value(value) = ketos.on_action_prices(nonce, action, vec![("NEAR".into(), T0_MS)], T0_MS, Ok(json!(true))) else { panic!("unexpected transfer") };
    assert_eq!(value["error"], "ERR_ACTION_ALREADY_SETTLED");
    assert_eq!(ketos.try_amend_brackets_for(id("alice.test"), amend, false).err().as_deref(), Some("ERR_BRACKETS_CHANGED"));
    assert_eq!(ketos.get_position(position.id), before);
}

#[test]
fn cross_reduction_neither_withdraws_shared_cash_nor_ignores_stale_peer() {
    let (mut ketos, position) = opened(Side::Long, MarginMode::Cross);
    let _ = ketos.open_position_now("ZEC".into(), Side::Short, U128(50 * USD), 2, None, Some(MarginMode::Cross));
    let req = request(&position, position.size.0 / 2);
    let now = T0_MS + 120_001;
    set_price(&mut ketos, "NEAR", P4, now);
    ctx_at("alice.test", now);
    let before = ketos.get_position(position.id);
    assert_eq!(ketos.reduce_position_for(id("alice.test"), req, true, execution_for_test(Side::Long, true, P4)).err().as_deref(), Some("ERR_STALE_CROSS_PRICE"));
    assert_eq!(ketos.get_position(position.id), before);
    set_price(&mut ketos, "ZEC", P4, now);
    let free = margin(&ketos, "alice.test");
    let reward_refund = 2 * (execution_reward(position.size.0) - execution_reward(req.size.0));
    assert!(matches!(ketos.reduce_position_for(id("alice.test"), req, true,
        execution_for_test(Side::Long, true, P4)).unwrap(), PromiseOrValue::Promise(_)));
    assert_margin_wallet_transfer(reward_refund);
    assert_eq!(margin(&ketos, "alice.test"), free);
    assert_eq!(ketos.get_cross_account(id("alice.test")).position_count, 2);
    assert!(ketos.get_cross_account(id("alice.test")).cash.0 > 0);
}

#[test]
fn received_funding_is_realized_only_for_the_reduced_notional() {
    let (mut ketos, position) = opened(Side::Short, MarginMode::Isolated);
    deposit(&mut ketos, "bob.test", 400 * USD);
    ctx_at("bob.test", T0_MS);
    ketos.open_position_now("NEAR".into(), Side::Long, U128(200 * USD), 5, None, None);
    let total = backing(&ketos);
    let now = T0_MS + HOUR_MS;
    set_price(&mut ketos, "NEAR", P4, now);
    ctx_at("alice.test", now);
    let accrued = ketos.get_position(position.id).unwrap().funding_received.0;
    assert!(accrued > 0);
    let size = position.size.0 / 4;
    let _ = ketos.reduce_position_for(id("alice.test"), request(&position, size), false,
        execution_for_test(Side::Short, true, P4)).unwrap();
    let history = ketos.get_history(id("alice.test"), None, None);
    let reduced = history.iter().find(|e| e.kind == HistoryKind::Reduce).unwrap();
    let remaining = ketos.get_position(position.id).unwrap();
    assert!(reduced.funding_received.0 > 0 && reduced.funding_received.0 < accrued);
    assert!(remaining.funding_received.0 > 0);
    // Flooring each credited slice can only retain a rounding unit for the vault.
    assert!(reduced.funding_received.0 + remaining.funding_received.0 <= accrued);
    assert!(accrued - reduced.funding_received.0 - remaining.funding_received.0 <= 1);
    assert_eq!(backing(&ketos), total);
}

#[test]
fn cross_reduction_rejects_dust_and_insufficient_projected_aggregate_health() {
    let (mut ketos, position) = opened(Side::Long, MarginMode::Cross);
    let bounds = execution_for_test(Side::Long, true, P4);
    assert_eq!(ketos.reduce_position_for(id("alice.test"), request(&position, position.size.0 - 1), false, bounds)
        .err().as_deref(), Some("ERR_REDUCTION_DUST"));
    set_price(&mut ketos, "NEAR", P4 * 84 / 100, T0_MS);
    let before = (ketos.get_position(position.id), ketos.get_cross_account(id("alice.test")), backing(&ketos));
    assert_eq!(ketos.reduce_position_for(id("alice.test"), request(&position, position.size.0 / 2), false, bounds)
        .err().as_deref(), Some("ERR_CROSS_UNDERMARGINED"));
    assert_eq!((ketos.get_position(position.id), ketos.get_cross_account(id("alice.test")), backing(&ketos)), before);
}
