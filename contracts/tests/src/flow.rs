use anyhow::Result;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const USD: u128 = 1_000_000;
const KEEPER_METHODS: [&str; 3] = ["refresh_prices", "set_depth", "liquidate"];

/// OutLayer asset ids and 8-decimal prices for BTC, ETH, NEAR, ZEC.
const PRICES: [(&str, u128); 4] = [
    ("nbtc.bridge.near", 7_756_150_000_000),
    ("aurora", 229_259_500_000),
    ("wrap.near", 400_000_000),
    ("zec.omft.near", 120_660_966_700),
];

fn wasm(name: &str) -> Vec<u8> {
    let path = format!("{}/../res/{name}.wasm", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e} (run pnpm contracts:build)"))
}

fn depth_fixture() -> Value {
    let path = format!(
        "{}/../../web/e2e/fixtures/depth-2026-11-03.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Panics unless the transaction succeeded; returns its JSON value (if any).
fn ok(result: ExecutionFinalResult) -> Value {
    assert!(
        result.is_success(),
        "transaction failed: {:?}",
        result.failures()
    );
    result.json().unwrap_or(Value::Null)
}

/// Error text of a transaction that must fail, either rejected by the RPC (access key) or
/// failed during execution (contract panic).
fn err(result: near_workspaces::Result<ExecutionFinalResult>) -> String {
    match result {
        Err(e) => format!("{e:?}"),
        Ok(r) => match r.into_result() {
            Ok(_) => panic!("transaction should have failed"),
            Err(e) => format!("{e:?}"),
        },
    }
}

async fn sub(root: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

async fn view(contract: &Contract, method: &str, args: Value) -> Result<Value> {
    Ok(contract.view(method).args_json(args).await?.json()?)
}

async fn now_ms(worker: &Worker<Sandbox>) -> Result<u64> {
    Ok(worker.view_block().await?.timestamp() / 1_000_000)
}

async fn ft_balance(usdc: &Contract, account: &Account) -> Result<u128> {
    let v = view(usdc, "ft_balance_of", json!({ "account_id": account.id() })).await?;
    Ok(v.as_str().unwrap().parse()?)
}

async fn margin(perps: &Contract, account: &Account) -> Result<u128> {
    let v = view(perps, "get_account", json!({ "account_id": account.id() })).await?;
    Ok(v["margin"].as_str().unwrap().parse()?)
}

async fn transfer_call(
    from: &Account,
    usdc: &Contract,
    perps: &Contract,
    amount: u128,
    msg: &str,
) -> Result<()> {
    ok(from
        .call(usdc.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": perps.id(), "amount": amount.to_string(), "msg": msg }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?);
    Ok(())
}

#[tokio::test]
async fn trade_liquidate_and_settle_on_sandbox() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;

    let usdc = sub(&root, "usdc", 10)
        .await?
        .deploy(&wasm("mock_usdc"))
        .await?
        .into_result()?;
    let oracle = sub(&root, "oracle", 10)
        .await?
        .deploy(&wasm("mock_oracle"))
        .await?
        .into_result()?;
    let perps = sub(&root, "perps", 20)
        .await?
        .deploy(&wasm("perps"))
        .await?
        .into_result()?;
    let trader = sub(&root, "trader", 10).await?;
    let lp = sub(&root, "lp", 10).await?;
    let keeper = sub(&root, "keeper", 10).await?;

    ok(usdc
        .call("new")
        .args_json(json!({ "owner_id": root.id() }))
        .transact()
        .await?);
    ok(oracle
        .call("new")
        .args_json(json!({ "owner_id": root.id() }))
        .transact()
        .await?);
    ok(perps
        .call("new")
        .args_json(
            json!({ "usdc_id": usdc.id(), "oracle_id": oracle.id(), "keeper_id": keeper.id() }),
        )
        .transact()
        .await?);
    ok(root
        .call(usdc.id(), "storage_deposit")
        .args_json(json!({ "account_id": perps.id() }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?);
    for (asset_id, price) in PRICES {
        ok(root
            .call(oracle.id(), "set_price")
            .args_json(
                json!({ "asset_id": asset_id, "multiplier": price.to_string(), "decimals": 8 }),
            )
            .transact()
            .await?);
    }

    // The keeper signs with a function-call key limited to the three keeper methods on perps.
    let keeper_sk = SecretKey::from_random(KeyType::ED25519);
    ok(keeper
        .batch(keeper.id())
        .add_key(
            keeper_sk.public_key(),
            AccessKey::function_call_access(
                perps.id(),
                &KEEPER_METHODS,
                Some(NearToken::from_near(1)),
            ),
        )
        .transact()
        .await?);
    let bot = Account::from_secret_key(keeper.id().clone(), keeper_sk, &worker);

    // Prices: pulled from the oracle through `refresh_prices`.
    ok(bot
        .call(perps.id(), "refresh_prices")
        .gas(Gas::from_tgas(100))
        .transact()
        .await?);
    let prices = view(&perps, "get_prices", json!({})).await?;
    assert!(
        prices
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["is_fresh"] == true),
        "{prices}"
    );
    assert_eq!(prices[2]["price"], "400000000");

    // Depth: the recorded 1Click curve, stamped at the current block time.
    let fixture = depth_fixture();
    let measured_at_ms = now_ms(&worker).await?;
    for market in ["BTC", "ETH", "NEAR", "ZEC"] {
        ok(bot
            .call(perps.id(), "set_depth")
            .args_json(json!({
                "market_id": market,
                "samples": fixture["assets"][market]["samples"],
                "measured_at_ms": measured_at_ms,
            }))
            .transact()
            .await?);
    }
    let near_market = view(&perps, "get_market", json!({ "market_id": "NEAR" })).await?;
    assert_eq!(near_market["is_open"], true);
    assert_eq!(near_market["max_leverage"], 5);
    assert_eq!(near_market["max_oi_per_side"], (100_000 * USD).to_string());

    // Funding: faucet for the trader, minted tUSDC for the LP.
    ok(trader.call(usdc.id(), "faucet").transact().await?);
    assert_eq!(ft_balance(&usdc, &trader).await?, 1_000 * USD);
    ok(root
        .call(usdc.id(), "mint")
        .args_json(json!({ "account_id": lp.id(), "amount": (10_000 * USD).to_string() }))
        .transact()
        .await?);
    transfer_call(&trader, &usdc, &perps, 500 * USD, "deposit_margin").await?;
    transfer_call(&lp, &usdc, &perps, 10_000 * USD, "deposit_vault").await?;
    assert_eq!(margin(&perps, &trader).await?, 500 * USD);
    let vault = view(&perps, "get_vault", json!({})).await?;
    assert_eq!(vault["nav"], (10_000 * USD).to_string());

    // Long NEAR 5x, then a ZEC short sized past the measured exit capacity.
    let long = ok(trader
        .call(perps.id(), "open_position")
        .args_json(json!({ "market_id": "NEAR", "side": "long", "margin": (100 * USD).to_string(), "leverage": 5 }))
        .transact()
        .await?);
    assert_eq!(long["size"], (500 * USD).to_string());
    assert_eq!(long["entry_price"], "400000000");
    let refused = err(trader
        .call(perps.id(), "open_position")
        .args_json(json!({ "market_id": "ZEC", "side": "short", "margin": (25_000 * USD).to_string(), "leverage": 5 }))
        .transact()
        .await);
    assert!(
        refused.contains("ERR_EXCEEDS_EXIT_LIQUIDITY: cap 100000000000"),
        "{refused}"
    );
    let short = ok(trader
        .call(perps.id(), "open_position")
        .args_json(json!({ "market_id": "NEAR", "side": "short", "margin": (50 * USD).to_string(), "leverage": 2 }))
        .transact()
        .await?);

    // NEAR drops to $3.50, below the long's liquidation price.
    ok(root
        .call(oracle.id(), "set_price")
        .args_json(json!({ "asset_id": "wrap.near", "multiplier": "350000000", "decimals": 8 }))
        .transact()
        .await?);
    ok(bot
        .call(perps.id(), "refresh_prices")
        .gas(Gas::from_tgas(100))
        .transact()
        .await?);
    let marked = view(&perps, "get_position", json!({ "position_id": long["id"] })).await?;
    let liq_price: u128 = marked["liquidation_price"].as_str().unwrap().parse()?;
    assert!(liq_price > 350_000_000, "{marked}");

    let record = ok(bot
        .call(perps.id(), "liquidate")
        .args_json(json!({ "position_id": long["id"] }))
        .transact()
        .await?);
    assert_eq!(record["liquidator"], keeper.id().as_str());
    assert_eq!(record["price"], "350000000");
    let liquidations = view(&perps, "get_liquidations", json!({})).await?;
    assert_eq!(liquidations[0]["position_id"], long["id"]);
    let reward: u128 = record["reward"].as_str().unwrap().parse()?;
    assert!(reward > 0);
    assert_eq!(margin(&perps, &keeper).await?, reward);
    assert!(
        view(&perps, "get_position", json!({ "position_id": long["id"] }))
            .await?
            .is_null()
    );

    // The winning short is closed, then all free margin goes back to the wallet.
    let payout: u128 = ok(trader
        .call(perps.id(), "close_position")
        .args_json(json!({ "position_id": short["id"] }))
        .transact()
        .await?)
    .as_str()
    .unwrap()
    .parse()?;
    assert!(payout > 50 * USD, "short payout {payout}");
    assert!(view(
        &perps,
        "get_positions",
        json!({ "account_id": trader.id() })
    )
    .await?
    .as_array()
    .unwrap()
    .is_empty());
    let free = margin(&perps, &trader).await?;
    ok(trader
        .call(perps.id(), "withdraw_margin")
        .args_json(json!({ "amount": free.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?);
    assert_eq!(margin(&perps, &trader).await?, 0);
    assert_eq!(ft_balance(&usdc, &trader).await?, 500 * USD + free);

    // The vault earned the trader's loss net of the short's gain, plus fees.
    let vault = view(&perps, "get_vault", json!({})).await?;
    let nav: u128 = vault["nav"].as_str().unwrap().parse()?;
    assert!(nav > 10_000 * USD, "{vault}");

    // The keeper key cannot reach anything beyond its three methods.
    let open = err(bot
        .call(perps.id(), "open_position")
        .args_json(json!({ "market_id": "NEAR", "side": "long", "margin": USD.to_string(), "leverage": 2 }))
        .transact()
        .await);
    assert!(open.contains("MethodNameMismatch"), "{open}");
    let withdraw = err(bot
        .call(perps.id(), "withdraw_margin")
        .args_json(json!({ "amount": reward.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await);
    assert!(withdraw.contains("DepositWithFunctionCall"), "{withdraw}");
    let other_contract = err(bot.call(usdc.id(), "faucet").transact().await);
    assert!(
        other_contract.contains("ReceiverMismatch"),
        "{other_contract}"
    );
    Ok(())
}
