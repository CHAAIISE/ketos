use super::*;

async fn wallet_transfer(
    trader: &Account, usdc: &Contract, ketos: &Contract, amount: u128, message: String, funding: u128,
) -> Result<Value> {
    let outcome = trader.call(usdc.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": ketos.id(), "amount": amount.to_string(), "msg": message }))
        .deposit(NearToken::from_yoctonear(funding + 1))
        .gas(Gas::from_tgas(300)).transact().await?;
    Ok(ok(outcome))
}

#[tokio::test]
async fn wallet_funded_trades_and_refunds_on_sandbox() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let usdc = sub(&root, "usdc", 10).await?.deploy(&wasm("mock_usdc")).await?.into_result()?;
    let oracle = sub(&root, "oracle", 10).await?.deploy(&wasm("mock_oracle")).await?.into_result()?;
    let ketos = sub(&root, "ketos", 20).await?.deploy(&wasm("ketos")).await?.into_result()?;
    let trader = sub(&root, "wallet", 10).await?;
    let lp = sub(&root, "lp", 10).await?;
    let keeper = sub(&root, "keeper", 10).await?;
    ok(usdc.call("new").args_json(json!({ "owner_id": root.id() })).transact().await?);
    ok(oracle.call("new").args_json(json!({ "owner_id": root.id() })).transact().await?);
    ok(ketos.call("new").args_json(json!({
        "usdc_id": usdc.id(), "oracle_id": oracle.id(), "outlayer_id": oracle.id(), "keeper_id": keeper.id(),
        "hedge_config": null,
    })).transact().await?);
    ok(root.call(usdc.id(), "storage_deposit").args_json(json!({ "account_id": ketos.id() }))
        .deposit(NearToken::from_millinear(10)).transact().await?);
    for (asset_id, price) in PRICES {
        ok(root.call(oracle.id(), "set_price").args_json(json!({
            "asset_id": asset_id, "multiplier": price.to_string(), "decimals": 8,
        })).transact().await?);
    }
    call(&keeper, &ketos, "refresh_prices", json!({})).await?;
    ok(root.call(usdc.id(), "mint").args_json(json!({ "account_id": lp.id(), "amount": (10_000 * USD).to_string() }))
        .transact().await?);
    transfer_call(&lp, &usdc, &ketos, 10_000 * USD, "deposit_vault:core").await?;
    for _ in 0..5 { depth(&worker, &keeper, &ketos, "NEAR").await?; }
    ok(trader.call(usdc.id(), "faucet").transact().await?);
    assert!(view(&ketos, "get_account", json!({ "account_id": trader.id() })).await?.is_null());
    let funding = NearToken::from_millinear(20).as_yoctonear();

    // A cold price is funded inside the same top-level token transaction, without deposit_margin.
    advance_ms(&worker, 16_000).await?;
    let cached = view(&ketos, "get_market", json!({ "market_id": "NEAR" })).await?;
    let before = ft_balance(&usdc, &trader).await?;
    let mut open = json!({ "market_id": "NEAR", "side": "long", "margin": (50 * USD).to_string(), "leverage": 2,
        "brackets": { "take_profit": "500000000", "stop_loss": "300000000" },
        "execution": execution(&worker, 400_000_000, 120_000).await?,
        "bracket_bounds": {
            "take_profit": execution(&worker, 500_000_000, 86_400_000).await?,
            "stop_loss": execution(&worker, 300_000_000, 86_400_000).await?,
        } });
    let accepted = wallet_transfer(&trader, &usdc, &ketos, 60 * USD, format!("open:{open}"), funding).await?;
    assert_eq!(integer(&accepted), 50_200_000);
    assert_eq!(ft_balance(&usdc, &trader).await?, before - 50_200_000);
    assert_eq!(margin(&ketos, &trader).await?, 0);
    assert_eq!(view(&ketos, "get_price_deposit", json!({ "account_id": trader.id() })).await?, "0");
    let market = view(&ketos, "get_market", json!({ "market_id": "NEAR" })).await?;
    assert!(market["price_timestamp_ms"].as_u64() > cached["price_timestamp_ms"].as_u64());
    let positions = view(&ketos, "get_positions", json!({ "account_id": trader.id() })).await?;
    assert_eq!(positions.as_array().unwrap().len(), 1);
    let position_id = positions[0]["id"].clone();
    let payout = call(&trader, &ketos, "close_position", json!({ "position_id": position_id,
        "execution": execution(&worker, 400_000_000, 120_000).await? })).await?;
    assert_eq!(ft_balance(&usdc, &trader).await? as i128, before as i128 - 50_200_000 + integer(&payout));
    assert_eq!(margin(&ketos, &trader).await?, 0);
    assert!(view(&ketos, "get_orders", json!({ "account_id": trader.id() })).await?.as_array().unwrap().is_empty());

    // A resting entry carries its future bracket rewards and cancellation returns every reservation.
    let before_cancel = ft_balance(&usdc, &trader).await?;
    let mut order = open.clone();
    order["kind"] = json!("limit");
    order["trigger_price"] = json!("390000000");
    order["execution"] = execution(&worker, 390_000_000, 86_400_000).await?;
    let accepted = wallet_transfer(&trader, &usdc, &ketos, 57 * USD, format!("order:{order}"), 0).await?;
    assert_eq!(integer(&accepted), 50_300_000);
    let orders = view(&ketos, "get_orders", json!({ "account_id": trader.id() })).await?;
    assert_eq!(orders[0]["bracket_reserve"], "200000");
    let cancelled = call(&trader, &ketos, "cancel_order", json!({ "order_id": orders[0]["id"] })).await?;
    assert_eq!(integer(&cancelled), 50_300_000);
    assert_eq!(ft_balance(&usdc, &trader).await?, before_cancel);
    assert_eq!(margin(&ketos, &trader).await?, 0);

    // A cap refusal refunds the entire transferred amount; it cannot leave spendable phantom margin.
    ok(root.call(usdc.id(), "mint").args_json(json!({ "account_id": trader.id(), "amount": (20_000 * USD).to_string() }))
        .transact().await?);
    let before_refusal = ft_balance(&usdc, &trader).await?;
    let contract_before = ft_balance(&usdc, ketos.as_account()).await?;
    let history_before = view(&ketos, "get_history", json!({ "account_id": trader.id() })).await?;
    let excessive = json!({ "market_id": "NEAR", "side": "long", "leverage": 2,
        "execution": execution(&worker, 400_000_000, 120_000).await? });
    let accepted = wallet_transfer(&trader, &usdc, &ketos, 11_000 * USD, format!("open:{excessive}"), funding).await?;
    assert_eq!(accepted, "0");
    assert_eq!(ft_balance(&usdc, &trader).await?, before_refusal);
    assert_eq!(ft_balance(&usdc, ketos.as_account()).await?, contract_before);
    assert_eq!(margin(&ketos, &trader).await?, 0);
    assert_eq!(view(&ketos, "get_history", json!({ "account_id": trader.id() })).await?, history_before);

    // A fresh callback price above the authorization refunds the real NEP-141 transfer.
    advance_ms(&worker, 16_000).await?;
    ok(root.call(oracle.id(), "set_price").args_json(json!({
        "asset_id": "wrap.near", "multiplier": "410000000", "decimals": 8,
    })).transact().await?);
    open["execution"] = execution(&worker, 400_000_000, 120_000).await?;
    let accepted = wallet_transfer(&trader, &usdc, &ketos, 60 * USD, format!("open:{open}"), funding).await?;
    assert_eq!(accepted, "0");
    assert_eq!(ft_balance(&usdc, &trader).await?, before_refusal);
    assert_eq!(ft_balance(&usdc, ketos.as_account()).await?, contract_before);
    assert_eq!(margin(&ketos, &trader).await?, 0);
    assert_eq!(view(&ketos, "get_history", json!({ "account_id": trader.id() })).await?, history_before);
    let rejected_market = view(&ketos, "get_market", json!({ "market_id": "NEAR" })).await?;
    assert_eq!(rejected_market["price"], "410000000");
    assert_eq!(rejected_market["oi_long"], "0");
    assert_eq!(rejected_market["oi_short"], "0");
    ok(root.call(oracle.id(), "set_price").args_json(json!({
        "asset_id": "wrap.near", "multiplier": "400000000", "decimals": 8,
    })).transact().await?);

    // A failed cold pull takes no USDC, even though the adapter fee has been spent.
    advance_ms(&worker, 16_000).await?;
    ok(root.call(oracle.id(), "set_tee_failure").args_json(json!({ "fail": true })).transact().await?);
    open["execution"] = execution(&worker, 400_000_000, 120_000).await?;
    let accepted = wallet_transfer(&trader, &usdc, &ketos, 60 * USD, format!("open:{open}"), funding).await?;
    assert_eq!(accepted, "0");
    assert_eq!(ft_balance(&usdc, &trader).await?, before_refusal);
    assert_eq!(margin(&ketos, &trader).await?, 0);
    assert_eq!(view(&ketos, "get_history", json!({ "account_id": trader.id() })).await?, history_before);

    // A valid signed batch also opens from a cold cache with only NEP-141's one yocto deposit.
    use base64::Engine as _;
    use ed25519_dalek::{Signer as _, SigningKey};
    let key = SigningKey::from_bytes(&[17; 32]);
    let public_key = format!("ed25519:{}", bs58::encode(key.verifying_key().as_bytes()).into_string());
    ok(ketos.call("set_price_signer").args_json(json!({ "public_key": public_key })).transact().await?);
    let payload = json!({ "domain": "ketos:prices:v1", "prices": { "NEAR": {
        "price": "400000000", "publish_time": now_ms(&worker).await? / 1_000, "sources": ["coinbase", "kraken"],
    }}}).to_string();
    let signature = base64::engine::general_purpose::STANDARD.encode(key.sign(payload.as_bytes()).to_bytes());
    let signed = json!({ "market_id": "NEAR", "side": "short", "leverage": 2,
        "signed_prices": { "payload": payload, "signature": signature, "public_key": public_key },
        "execution": execution(&worker, 400_000_000, 120_000).await? });
    let accepted = wallet_transfer(&trader, &usdc, &ketos, 25 * USD, format!("open:{signed}"), 0).await?;
    assert_eq!(integer(&accepted), (25 * USD) as i128);
    assert_eq!(ft_balance(&usdc, &trader).await?, before_refusal - 25 * USD);
    assert_eq!(margin(&ketos, &trader).await?, 0);
    let positions = view(&ketos, "get_positions", json!({ "account_id": trader.id() })).await?;
    assert_eq!(positions[0]["size"], (50 * USD).to_string());
    assert_eq!(positions[0]["entry_price"], "400000000");
    let payout = call(&trader, &ketos, "close_position", json!({ "position_id": positions[0]["id"],
        "execution": execution(&worker, 400_000_000, 120_000).await? })).await?;
    assert_eq!(ft_balance(&usdc, &trader).await? as i128,
        before_refusal as i128 - (25 * USD) as i128 + integer(&payout));
    assert_eq!(margin(&ketos, &trader).await?, 0);

    // A receiver without the funding extension refunds the original USDC transfer.
    ok(root.call(usdc.id(), "storage_deposit").args_json(json!({ "account_id": oracle.id() }))
        .deposit(NearToken::from_millinear(10)).transact().await?);
    let before_unsupported = ft_balance(&usdc, &trader).await?;
    let unsupported = trader.call(usdc.id(), "ft_transfer_call").args_json(json!({
        "receiver_id": oracle.id(), "amount": USD.to_string(), "msg": "open:{}",
    })).deposit(NearToken::from_yoctonear(funding + 1)).gas(Gas::from_tgas(300)).transact().await?;
    assert_eq!(ok(unsupported), "0");
    assert_eq!(ft_balance(&usdc, &trader).await?, before_unsupported);
    assert_eq!(ft_balance(&usdc, oracle.as_account()).await?, 0);
    Ok(())
}
