use super::*;
use crate::{cross::MarginMode, position::{Position, Side}};
use near_sdk::{json_types::I128, test_utils::VMContextBuilder, testing_env, PromiseResult};
use std::collections::HashMap;

const NOW: u64 = 100_000;
fn id(value: &str) -> AccountId { value.parse().unwrap() }
fn context(who: &str, now: u64, results: Vec<PromiseResult>) {
    testing_env!(VMContextBuilder::new().current_account_id(id("ketos.testnet"))
        .predecessor_account_id(id(who)).signer_account_id(id(who))
        .account_balance(NearToken::from_near(100)).prepaid_gas(Gas::from_tgas(300))
        .block_timestamp(now * 1_000_000).build(), near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(), HashMap::default(), results);
}
fn snapshot(k: &Ketos) -> CustodySnapshot {
    let cfg = &k.hedge.as_ref().unwrap().config;
    CustodySnapshot { config: CustodyConfig { controller:id("ketos.testnet"),usdc:id("usdc.testnet"),
        wrapped_near:cfg.wrapped_near_id.clone(),exchange:cfg.exchange_id.clone(),pool_id:cfg.pool_id },
        nonce:0,cash:U128(0),inventory:U128(0),cost_basis:U128(0),total_funded:U128(0),total_returned:U128(0),
        realized_pnl:I128(0),execution_cost:I128(0),pending:None,last_fill:None }
}
fn sync(k: &mut Ketos, book: &CustodySnapshot) -> bool {
    let nonce = k.hedge.as_ref().unwrap().nonce;
    context("ketos.testnet", NOW, vec![PromiseResult::Successful(serde_json::to_vec(book).unwrap())]);
    k.on_hedge_snapshot(nonce, None)
}
fn setup() -> Ketos {
    context("ketos.testnet", NOW, vec![]);
    let mut k = Ketos::new(id("usdc.testnet"),id("oracle.testnet"),id("keeper.testnet"),id("outlayer.testnet"),
        Some(HedgeConfig { custody_id:id("custody.testnet"),exchange_id:id("ref.testnet"),
            wrapped_near_id:id("wrap.testnet"),pool_id:7 }));
    for market in k.markets.values_mut() { market.price=U128(400_000_000); market.price_timestamp_ms=NOW; }
    k.deposit_vault(VaultId::Core, &id("lp.testnet"), 100 * USD);
    k.deposit_vault(VaultId::LongTail, &id("lp.testnet"), 50 * USD);
    let book = snapshot(&k);
    assert!(sync(&mut k, &book));
    add_position(&mut k, 0, Side::Long, 400_000_000);
    k
}
fn add_position(k: &mut Ketos, key: u64, side: Side, entry: u128) {
    k.positions.insert(key, Position { account_id:id("trader.testnet"),market_id:"NEAR".into(),side,
        margin_mode:MarginMode::Isolated,margin:USD,size:USD,entry_price:entry,leverage:1,max_leverage:20,
        entry_borrow_index:0,entry_funding_paid_index:0,entry_funding_received_index:0,opened_at_ms:NOW,
        take_profit:None,stop_loss:None });
    let market = k.markets.get_mut(MARKET).unwrap();
    if side == Side::Long { market.oi_long.0 += USD; } else { market.oi_short.0 += USD; }
}
fn funded() -> Ketos {
    let mut k=setup(); context("keeper.testnet", NOW, vec![]);
    k.fund_hedge(1,U128(USD)).detach();
    context("ketos.testnet", NOW, vec![PromiseResult::Successful(Vec::new())]);
    k.on_hedge_funded_transfer(1).detach();
    assert!(k.on_hedge_completed(1));
    let mut book=snapshot(&k); book.nonce=1; book.cash=U128(USD); book.total_funded=U128(USD);
    assert!(sync(&mut k,&book));
    k
}

#[test]
fn funding_keeps_nav_but_never_reuses_external_capital_for_admission() {
    let k=funded();
    let core=k.get_vault(VaultId::Core);
    assert_eq!((core.balance.0,core.nav.0,core.hedge_assets.0),(99*USD,100*USD,USD));
    assert_eq!(k.vault_capital_limits(VaultId::Core).0,99*USD*VaultId::Core.oi_multiplier());
    assert_eq!(k.get_vault(VaultId::LongTail).nav.0,50*USD);
}
#[test]
fn unknown_funding_blocks_only_its_vault_without_creating_an_asset() {
    let mut k=setup(); context("keeper.testnet",NOW,vec![]);
    k.fund_hedge(1,U128(USD)).detach();
    let core=k.get_vault(VaultId::Core);
    assert!(!core.hedge_valuation_ready);
    assert_eq!((core.hedge_assets.0,core.available_to_withdraw.0),(0,0));
    assert_eq!(k.vault_capital_limits(VaultId::Core).0,0);
    assert!(k.get_vault(VaultId::LongTail).hedge_valuation_ready);
    let before=snapshot(&k);
    assert!(!sync(&mut k,&before));
    assert_eq!(k.get_vault(VaultId::Core).balance.0,99*USD);
}
#[test]
fn confirmed_atomic_transfer_failure_restores_cash_once() {
    let mut k=setup(); context("keeper.testnet",NOW,vec![]);
    k.fund_hedge(1,U128(USD)).detach();
    context("ketos.testnet",NOW,vec![PromiseResult::Failed]);
    k.on_hedge_funded_transfer(1).detach(); k.on_hedge_completed(1);
    let old=snapshot(&k);
    assert!(sync(&mut k,&old));
    assert!(sync(&mut k,&old));
    assert_eq!(k.get_vault(VaultId::Core).balance.0,100*USD);
}
#[test]
fn cash_return_requires_the_real_token_sender_and_is_credited_once() {
    let mut k=funded(); context("keeper.testnet",NOW,vec![]);
    k.return_hedge_cash(2,U128(USD)).detach();
    assert_eq!(k.receive_hedge_return(&id("attacker.testnet"),U128(USD),2).0,USD);
    assert_eq!(k.receive_hedge_return(&id("custody.testnet"),U128(USD),2).0,0);
    assert_eq!(k.receive_hedge_return(&id("custody.testnet"),U128(USD),2).0,USD);
    k.on_hedge_completed(2);
    let mut book=k.hedge.as_ref().unwrap().confirmed.clone().unwrap();
    book.nonce=2; book.cash=U128(0); book.total_returned=U128(USD);
    assert!(sync(&mut k,&book));
    assert_eq!((k.get_vault(VaultId::Core).balance.0,k.get_vault(VaultId::Core).nav.0),(100*USD,100*USD));
}
#[test]
fn differently_priced_entries_do_not_cancel_by_dollar_open_interest() {
    let mut k=funded(); add_position(&mut k,1,Side::Short,800_000_000);
    let plan=k.hedge_plan();
    assert_eq!(plan.trader_delta.0,signed(NEAR/8));
    assert_eq!(plan.amount_in.0,USD/2);
}
#[test]
fn fill_reconciliation_preserves_cost_and_rejects_duplicate_inventory() {
    let mut k=funded(); context("keeper.testnet",NOW,vec![]);
    let quantity=NEAR*99/400;
    k.rebalance_hedge(2,HedgeSide::Buy,U128(USD),U128(quantity),NOW+30_000).detach();
    k.on_hedge_completed(2);
    let mut book=k.hedge.as_ref().unwrap().confirmed.clone().unwrap();
    book.nonce=2; book.cash=U128(0); book.inventory=U128(quantity); book.cost_basis=U128(USD);
    book.execution_cost=I128(10_000);
    book.last_fill=Some(HedgeFill { nonce:2,side:HedgeSide::Buy,amount_in:U128(USD),amount_out:U128(quantity),
        reference_price:U128(400_000_000),reference_timestamp_ms:NOW,started_at_ms:NOW,confirmed_at_ms:NOW,
        execution_cost:I128(10_000),realized_pnl:I128(0),recovered:false });
    assert!(sync(&mut k,&book));
    assert!(sync(&mut k,&book));
    assert_eq!(k.get_hedge_fills(None).len(),1);
    assert_eq!(k.get_hedge().unwrap().confirmed.unwrap().inventory.0,quantity);
    assert_eq!(k.get_vault(VaultId::Core).hedge_assets.0,970_200);
    context("keeper.testnet",NOW+30_001,vec![]);
    assert!(!k.get_vault(VaultId::Core).hedge_valuation_ready);
    assert_eq!(k.vault_capital_limits(VaultId::Core).0,0);
}
#[test]
#[should_panic(expected="ERR_HEDGE_VALUATION_UNCERTAIN")]
fn lp_shares_cannot_be_minted_while_external_capital_is_unknown() {
    let mut k=setup(); context("keeper.testnet",NOW,vec![]);
    k.fund_hedge(1,U128(USD)).detach();
    k.deposit_vault(VaultId::Core,&id("new-lp.testnet"),USD);
}
#[test]
#[should_panic(expected="ERR_HEDGE_IN_FLIGHT")]
fn pending_external_execution_cannot_be_recovered_early() {
    let mut k=funded(); context("keeper.testnet",NOW,vec![]);
    k.rebalance_hedge(2,HedgeSide::Buy,U128(USD),U128(NEAR/4),NOW+30_000).detach();
    k.recover_hedge(2).detach();
}

#[test]
fn cross_delta_retains_loss_exposure_backed_by_shared_cash() {
    let mut k = setup();
    let position = k.positions.get_mut(&0).unwrap();
    position.margin_mode = MarginMode::Cross;
    position.margin = 100_000;
    k.accounts.insert(id("trader.testnet"), crate::account::Account {
        cross_cash: 2 * USD as i128, positions: vec![0], cross_positions: vec![0],
        ..Default::default()
    });
    k.markets.get_mut(MARKET).unwrap().price = U128(200_000_000);
    assert_eq!(k.get_hedge().unwrap().plan.trader_delta.0, (NEAR / 4) as i128);
    k.accounts.get_mut(&id("trader.testnet")).unwrap().cross_cash = 0;
    assert_eq!(k.get_hedge().unwrap().plan.trader_delta.0, 0);
}
