use super::*;
use near_sdk::{test_utils::VMContextBuilder, testing_env};

fn context(predecessor: &str, now: u64) {
    let mut ctx = VMContextBuilder::new();
    ctx.current_account_id("custody.testnet".parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .block_timestamp(now * 1_000_000);
    testing_env!(ctx.build());
}
fn setup() -> Custody {
    context("custody.testnet", 100_000);
    Custody::new(CustodyConfig { controller: "ketos.testnet".parse().unwrap(),
        usdc: "usdc.testnet".parse().unwrap(), wrapped_near: "wrap.testnet".parse().unwrap(),
        exchange: "ref.testnet".parse().unwrap(), pool_id: 7 })
}
fn command(nonce: u64, side: HedgeSide, amount: u128, min: u128) -> TradeCommand {
    TradeCommand { nonce, side, amount_in: U128(amount), min_out: U128(min), price: U128(400_000_000),
        price_timestamp_ms: 100_000, deadline_ms: 130_000 }
}
fn pending_fill(c: &mut Custody, command: TradeCommand, output: u128) {
    let before = [c.state.cash, c.state.inventory];
    c.begin(command.nonce, OperationKind::Trade, command.amount_in, Some(command), CustodyPhase::Checking);
    let pending = c.state.pending.as_mut().unwrap();
    pending.wallet_before = before;
    pending.output = U128(output);
    pending.deposited = pending.amount;
    pending.swapped = true;
}

#[test]
fn buy_sell_and_return_conserve_principal_and_realized_loss() {
    let mut c = setup();
    c.begin(1, OperationKind::Fund, U128(USD), None, CustodyPhase::Funding);
    c.settle([U128(USD), U128(0)]).detach();
    assert_eq!(c.state.total_funded.0, USD);
    let bought = NEAR * 99 / 400;
    pending_fill(&mut c, command(2, HedgeSide::Buy, USD, bought), bought);
    c.settle([U128(0), U128(bought)]).detach();
    assert_eq!((c.state.cash.0, c.state.inventory.0, c.state.cost_basis.0), (0, bought, USD));
    pending_fill(&mut c, command(3, HedgeSide::Sell, bought, 980_000), 980_000);
    c.settle([U128(980_000), U128(0)]).detach();
    assert_eq!((c.state.inventory.0, c.state.cost_basis.0), (0, 0));
    assert_eq!(c.state.realized_pnl.0, -20_000);
    assert_eq!(c.state.execution_cost.0, 20_000);
    c.begin(4, OperationKind::Return, U128(980_000), None, CustodyPhase::Returning);
    c.state.pending.as_mut().unwrap().deposited = U128(980_000);
    c.settle([U128(0), U128(0)]).detach();
    assert_eq!(c.state.cash.0, 0);
    assert_eq!(c.state.total_returned.0, 980_000);
    assert_eq!(signed(c.state.total_funded.0) + c.state.realized_pnl.0, signed(c.state.total_returned.0));
}

#[test]
fn output_receipt_without_wallet_tokens_cannot_inflate_inventory() {
    let mut c = setup(); c.state.cash = U128(USD);
    pending_fill(&mut c, command(1, HedgeSide::Buy, USD, NEAR / 5), NEAR / 4);
    c.settle([U128(0), U128(0)]).detach();
    assert_eq!(c.state.cash.0, USD);
    assert_eq!(c.state.inventory.0, 0);
    assert_eq!(c.state.pending.as_ref().unwrap().phase, CustodyPhase::Uncertain);
    assert!(c.state.last_fill.is_none());
    c.settle([U128(0), U128(NEAR / 4)]).detach();
    assert_eq!(c.state.inventory.0, NEAR / 4);
    assert!(c.state.pending.is_none());
    c.on_balances(1).detach();
    assert_eq!(c.state.inventory.0, NEAR / 4);
}

#[test]
fn preexisting_donations_do_not_cover_missing_trade_output() {
    let mut c = setup(); c.state.cash = U128(USD);
    pending_fill(&mut c, command(1, HedgeSide::Buy, USD, NEAR / 5), NEAR / 4);
    c.state.pending.as_mut().unwrap().wallet_before[1] = U128(NEAR);
    c.settle([U128(0), U128(NEAR)]).detach();
    assert!(c.state.pending.is_some());
    assert_eq!(c.state.inventory.0, 0);
    c.settle([U128(0), U128(NEAR + NEAR / 4)]).detach();
    assert_eq!(c.state.inventory.0, NEAR / 4);
}

#[test]
fn partial_sale_keeps_remaining_cost_basis_until_final_unwind() {
    let mut c = setup(); c.state.inventory = U128(NEAR); c.state.cost_basis = U128(3_000_001);
    pending_fill(&mut c, command(1, HedgeSide::Sell, NEAR / 4, 980_000), USD);
    c.settle([U128(USD), U128(NEAR * 3 / 4)]).detach();
    assert_eq!(c.state.cost_basis.0, 2_250_001);
    assert_eq!(c.state.realized_pnl.0, 250_000);
}

#[test]
fn aborted_partial_deposit_requires_actual_refund_before_unlock() {
    let mut c = setup(); c.state.cash = U128(USD);
    c.begin(1, OperationKind::Trade, U128(USD), Some(command(1, HedgeSide::Buy, USD, NEAR / 5)), CustodyPhase::Checking);
    c.state.pending.as_mut().unwrap().wallet_before = [U128(USD), U128(0)];
    c.state.pending.as_mut().unwrap().deposited = U128(USD / 2);
    c.settle([U128(USD / 2), U128(0)]).detach();
    assert!(c.state.pending.is_some());
    c.settle([U128(USD), U128(0)]).detach();
    assert!(c.state.pending.is_none());
    assert_eq!(c.state.cash.0, USD);
    assert!(c.state.last_fill.is_none());
}

#[test]
#[should_panic(expected = "ERR_CONTROLLER")]
fn arbitrary_account_cannot_authorize_custody_movement() {
    let c = setup(); context("attacker.testnet", 100_000); c.authorize(1);
}
#[test]
#[should_panic(expected = "ERR_NONCE")]
fn completed_authorization_cannot_be_replayed() {
    let mut c = setup(); c.state.nonce = 2; context("ketos.testnet", 100_000); c.authorize(2);
}
#[test]
#[should_panic(expected = "ERR_INVENTORY")]
fn spot_custody_cannot_sell_borrowed_inventory() {
    let c = setup(); c.validate(&command(1, HedgeSide::Sell, NEAR / 4, 980_000));
}
#[test]
#[should_panic(expected = "ERR_PRICE_BOUND")]
fn controller_cannot_waive_shortfall_bound() {
    let mut c = setup(); c.state.cash = U128(USD); c.validate(&command(1, HedgeSide::Buy, USD, 1));
}
#[test]
#[should_panic(expected = "ERR_PRICE_EXPIRED")]
fn stale_reference_cannot_authorize_a_new_swap() {
    let mut c = setup(); c.state.cash = U128(USD); context("ketos.testnet", 130_001);
    c.validate(&command(1, HedgeSide::Buy, USD, NEAR / 4));
}

#[test]
fn failed_preflight_cannot_unlock_an_unbacked_book() {
    let mut c = setup();
    c.state.cash = U128(USD);
    c.begin(1, OperationKind::Trade, U128(USD),
        Some(command(1, HedgeSide::Buy, USD, NEAR / 5)), CustodyPhase::Preflight);
    c.uncertain().detach();
    c.settle([U128(0), U128(0)]).detach();
    assert!(c.state.pending.is_some());
    assert_eq!(c.state.cash.0, USD);
    c.settle([U128(USD), U128(0)]).detach();
    assert!(c.state.pending.is_none());
    assert!(c.state.last_fill.is_none());
}
