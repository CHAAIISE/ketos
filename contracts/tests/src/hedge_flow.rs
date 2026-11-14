//! Real Ref/wNEAR bytecode in an isolated sandbox; oracle inputs are controlled, not live prices.
use super::*;

const YOCTO: u128 = 1_000_000_000_000_000_000_000_000;
async fn tx(account: &Account, contract: &Contract, method: &str, args: Value, deposit: u128) -> Result<Value> {
    let result = account.call(contract.id(), method).args_json(args)
        .deposit(NearToken::from_yoctonear(deposit)).gas(Gas::from_tgas(300)).transact().await?;
    assert!(result.failures().is_empty(), "{method}: {:?}", result.failures());
    Ok(ok(result))
}
async fn register(root: &Account, token: &Contract, account: &Account) -> Result<()> {
    tx(root, token, "storage_deposit", json!({"account_id":account.id(),"registration_only":true}), YOCTO/100).await?;
    Ok(())
}
async fn sync(root: &Account, ketos: &Contract) -> Result<Value> {
    let accepted = tx(root,ketos,"sync_hedge",json!({"reported_transaction_hash":null}),0).await?;
    let state = view(ketos,"get_hedge",json!({})).await?;
    assert_eq!(accepted,true,"custody reconciliation failed: {state}");
    assert!(state["pending"].is_null(),"{state}");
    Ok(state)
}

#[tokio::test]
async fn real_ref_hedge_conserves_vault_claims_through_buy_unwind_and_return() -> Result<()> {
    let worker=near_workspaces::sandbox().await?;
    let root=worker.root_account()?;
    let usdc=sub(&root,"usdc",10).await?.deploy(&wasm("mock_usdc")).await?.into_result()?;
    let oracle=sub(&root,"oracle",10).await?.deploy(&wasm("mock_oracle")).await?.into_result()?;
    let exchange=sub(&root,"ref",20).await?.deploy(&wasm("ref_exchange")).await?.into_result()?;
    let wrapped=sub(&root,"wrap",10).await?.deploy(&wasm("wrapped_near")).await?.into_result()?;
    let ketos=sub(&root,"ketos",30).await?.deploy(&wasm("ketos")).await?.into_result()?;
    let custody=sub(&root,"custody",10).await?.deploy(&wasm("hedge_custody")).await?.into_result()?;
    let trader=sub(&root,"trader",10).await?;
    tx(usdc.as_account(),&usdc,"new",json!({"owner_id":root.id()}),0).await?;
    tx(oracle.as_account(),&oracle,"new",json!({"owner_id":root.id()}),0).await?;
    tx(exchange.as_account(),&exchange,"new",json!({"owner_id":root.id(),"exchange_fee":0,"referral_fee":0,
        "boost_farm_id":root.id(),"burrowland_id":root.id()}),0).await?;
    tx(wrapped.as_account(),&wrapped,"new",json!({}),0).await?;
    for account in [&root,exchange.as_account(),custody.as_account(),ketos.as_account()] {
        register(&root,&usdc,account).await?;
        register(&root,&wrapped,account).await?;
    }
    for account in [&root,custody.as_account()] {
        tx(&root,&exchange,"storage_deposit",json!({"account_id":account.id(),"registration_only":false}),YOCTO/10).await?;
        tx(account,&exchange,"register_tokens",json!({"token_ids":[usdc.id(),wrapped.id()]}),1).await?;
    }
    tx(&root,&usdc,"faucet",json!({}),0).await?;
    tx(&trader,&usdc,"faucet",json!({}),0).await?;
    tx(&root,&wrapped,"near_deposit",json!({}),50*YOCTO).await?;
    tx(&root,&usdc,"ft_transfer_call",json!({"receiver_id":exchange.id(),"amount":(200*USD).to_string(),"msg":""}),1).await?;
    tx(&root,&wrapped,"ft_transfer_call",json!({"receiver_id":exchange.id(),"amount":(50*YOCTO).to_string(),"msg":""}),1).await?;
    let pool=tx(&root,&exchange,"add_simple_pool",json!({"tokens":[usdc.id(),wrapped.id()],"fee":25}),YOCTO/10).await?;
    let pool_id=pool.as_u64().expect("Ref pool ID");
    tx(&root,&exchange,"add_liquidity",json!({"pool_id":pool_id,
        "amounts":[(200*USD).to_string(),(50*YOCTO).to_string()]}),YOCTO/10).await?;
    // Deployment separates experiment LP ownership from the future vault custody.
    let pool_token=format!(":{pool_id}");
    let lp_shares=view(&exchange,"mft_balance_of",json!({"token_id":pool_token,"account_id":root.id()})).await?;
    tx(&trader,&exchange,"mft_register",json!({"token_id":pool_token,"account_id":trader.id()}),YOCTO/100).await?;
    tx(&root,&exchange,"mft_transfer",json!({"token_id":pool_token,"receiver_id":trader.id(),"amount":lp_shares,"memo":null}),1).await?;
    assert_eq!(view(&exchange,"mft_balance_of",json!({"token_id":pool_token,"account_id":root.id()})).await?,"0");
    assert_eq!(view(&exchange,"mft_balance_of",json!({"token_id":pool_token,"account_id":trader.id()})).await?,lp_shares);
    tx(custody.as_account(),&custody,"new",json!({"config":{"controller":ketos.id(),"usdc":usdc.id(),
        "wrapped_near":wrapped.id(),"exchange":exchange.id(),"pool_id":pool_id}}),0).await?;
    tx(ketos.as_account(),&ketos,"new",json!({"usdc_id":usdc.id(),"oracle_id":oracle.id(),
        "outlayer_id":oracle.id(),"keeper_id":root.id(),"hedge_config":{"custody_id":custody.id(),
        "exchange_id":exchange.id(),"wrapped_near_id":wrapped.id(),"pool_id":pool_id}}),0).await?;
    for (asset_id,price) in PRICES {
        tx(&root,&oracle,"set_price",json!({"asset_id":asset_id,"multiplier":price.to_string(),"decimals":8}),0).await?;
    }
    refresh(&worker,&root,&ketos).await?;
    for _ in 0..5 { depth(&worker,&root,&ketos,"NEAR").await?; }
    sync(&root,&ketos).await?;
    transfer_call(&root,&usdc,&ketos,100*USD,"deposit_vault:core").await?;
    transfer_call(&trader,&usdc,&ketos,10*USD,"deposit_margin").await?;
    let position=call(&trader,&ketos,"open_position",json!({"market_id":"NEAR","side":"long",
        "margin":(2*USD).to_string(),"leverage":1,"execution":execution(&worker,400_000_000,60_000).await?})).await?;
    tx(&root,&ketos,"fund_hedge",json!({"nonce":1,"amount":USD.to_string()}),0).await?;
    let pending=view(&ketos,"get_vault",json!({"vault_id":"core"})).await?;
    assert_eq!(pending["hedge_assets"],"0");
    assert_eq!(pending["available"],"0");
    sync(&root,&ketos).await?;
    assert_eq!(ft_balance(&usdc,custody.as_account()).await?,USD);
    refresh(&worker,&root,&ketos).await?;
    tx(&root,&ketos,"rebalance_hedge",json!({"nonce":2,"side":"Buy","amount_in":USD.to_string(),
        "min_out":(YOCTO*98/400).to_string(),"expires_at_ms":now_ms(&worker).await?+30_000}),0).await?;
    let bought=sync(&root,&ketos).await?;
    let quantity=ft_balance(&wrapped,custody.as_account()).await?;
    assert!(quantity>=YOCTO*98/400 && quantity<YOCTO/4);
    assert_eq!(bought["confirmed"]["inventory"],quantity.to_string());
    assert_eq!(bought["confirmed"]["cash"],"0");
    assert_eq!(bought["confirmed"]["cost_basis"],USD.to_string());
    let duplicate=err(root.call(ketos.id(),"rebalance_hedge").args_json(json!({"nonce":2,"side":"Buy",
        "amount_in":USD.to_string(),"min_out":(YOCTO*98/400).to_string(),"expires_at_ms":now_ms(&worker).await?+30_000}))
        .gas(Gas::from_tgas(300)).transact().await);
    assert!(duplicate.contains("ERR_HEDGE"),"{duplicate}");
    assert_eq!(ft_balance(&wrapped,custody.as_account()).await?,quantity);
    call(&trader,&ketos,"close_position",json!({"position_id":position["id"],
        "execution":execution(&worker,400_000_000,60_000).await?})).await?;
    advance_ms(&worker,60_000).await?;
    refresh(&worker,&root,&ketos).await?;
    let reference_cash=quantity*400_000_000/(YOCTO*100);
    tx(&root,&ketos,"rebalance_hedge",json!({"nonce":3,"side":"Sell","amount_in":quantity.to_string(),
        "min_out":((reference_cash*98+99)/100).to_string(),"expires_at_ms":now_ms(&worker).await?+30_000}),0).await?;
    let sold=sync(&root,&ketos).await?;
    let cash=ft_balance(&usdc,custody.as_account()).await?;
    assert!(cash<USD && cash>=USD*98/100);
    assert_eq!(sold["confirmed"]["inventory"],"0");
    assert_eq!(sold["confirmed"]["cost_basis"],"0");
    assert_eq!(integer(&sold["confirmed"]["realized_pnl"]),cash as i128-USD as i128);
    tx(&root,&ketos,"return_hedge_cash",json!({"nonce":4,"amount":cash.to_string()}),0).await?;
    let returned=sync(&root,&ketos).await?;
    assert_eq!(returned["confirmed"]["total_funded"],USD.to_string());
    assert_eq!(returned["confirmed"]["total_returned"],cash.to_string());
    assert_eq!(ft_balance(&usdc,custody.as_account()).await?,0);
    assert_eq!(ft_balance(&wrapped,custody.as_account()).await?,0);
    let deposits=view(&exchange,"get_deposits",json!({"account_id":custody.id()})).await?;
    assert!(deposits.as_object().unwrap().values().all(|value|integer(value)==0));
    let vault=view(&ketos,"get_vault",json!({"vault_id":"core"})).await?;
    let revenue=&vault["revenue"];
    let trading_revenue=["fees","funding","trader_pnl","liquidations","listing"].into_iter().map(|key|integer(&revenue[key])).sum::<i128>();
    assert_eq!(integer(&vault["balance"]),100*USD as i128+trading_revenue+cash as i128-USD as i128);
    assert_eq!(vault["nav"],vault["balance"]);
    assert_eq!(vault["hedge_assets"],"0");
    assert_eq!(ft_balance(&usdc,ketos.as_account()).await? as i128,integer(&vault["balance"])+margin(&ketos,&trader).await? as i128);
    let fills=view(&ketos,"get_hedge_fills",json!({})).await?;
    assert_eq!(fills.as_array().unwrap().iter().map(|row|row["fill"]["side"].as_str().unwrap()).collect::<Vec<_>>(),["Sell","Buy"]);
    Ok(())
}
