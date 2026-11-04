use anyhow::Result;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const USD: u128 = 1_000_000;
const KEEPER_METHODS: [&str; 7] = [
    "refresh_prices",
    "set_depth",
    "liquidate",
    "liquidate_cross",
    "execute_orders",
    "settle_funding",
    "snapshot_vaults",
];

/// Mock oracle values; the first four match the 2026-11-03 feed.
const PRICES: [(&str, u128); 16] = [
    ("nbtc.bridge.near", 7_756_150_000_000),
    ("aurora", 229_259_500_000),
    ("wrap.near", 400_000_000),
    ("zec.omft.near", 120_660_966_700),
    ("22.contract.portalbridge.near", 15_000_000_000),
    (
        "aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near",
        10_000_000,
    ),
    ("token.rhealab.near", 5_000_000),
    ("DOGE", 15_000_000),
    ("XRP", 50_000_000),
    ("LTC", 8_000_000_000),
    ("ADA", 40_000_000),
    ("SUI", 200_000_000),
    ("TRX", 10_000_000),
    ("BNB", 60_000_000_000),
    ("AVAX", 3_000_000_000),
    ("LINK", 1_500_000_000),
];
const WORKER_ASSETS: [&str; 9] = [
    "DOGE", "XRP", "LTC", "ADA", "SUI", "TRX", "BNB", "AVAX", "LINK",
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

async fn margin(ketos: &Contract, account: &Account) -> Result<u128> {
    let v = view(ketos, "get_account", json!({ "account_id": account.id() })).await?;
    Ok(v["margin"].as_str().unwrap().parse()?)
}

async fn transfer_call(
    from: &Account,
    usdc: &Contract,
    ketos: &Contract,
    amount: u128,
    msg: &str,
) -> Result<()> {
    ok(from
        .call(usdc.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": ketos.id(), "amount": amount.to_string(), "msg": msg }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?);
    Ok(())
}

async fn call(account: &Account, ketos: &Contract, method: &str, args: Value) -> Result<Value> {
    Ok(ok(account
        .call(ketos.id(), method)
        .args_json(args)
        .gas(Gas::from_tgas(200))
        .transact()
        .await?))
}

fn integer(value: &Value) -> i128 {
    value.as_str().unwrap().parse().unwrap()
}

async fn price(
    root: &Account,
    oracle: &Contract,
    bot: &Account,
    ketos: &Contract,
    asset: &str,
    value: u128,
) -> Result<()> {
    ok(root
        .call(oracle.id(), "set_price")
        .args_json(json!({ "asset_id": asset, "multiplier": value.to_string(), "decimals": 8 }))
        .transact()
        .await?);
    call(bot, ketos, "refresh_prices", json!({})).await?;
    Ok(())
}

async fn depth(
    worker: &Worker<Sandbox>,
    bot: &Account,
    ketos: &Contract,
    market: &str,
) -> Result<()> {
    call(
        bot,
        ketos,
        "set_depth",
        json!({
            "market_id": market,
            "samples": depth_fixture()["assets"]["NEAR"]["samples"],
            "measured_at_ms": now_ms(worker).await?,
        }),
    )
    .await?;
    Ok(())
}

/// Check executed trade economics independently of funding/order annotation events.
async fn assert_economics(ketos: &Contract, account: &Account, collateral: i128) -> Result<()> {
    let history = view(
        ketos,
        "get_history",
        json!({ "account_id": account.id(), "limit": 200 }),
    )
    .await?;
    let events = history.as_array().unwrap();
    let trades: Vec<&Value> = events
        .iter()
        .filter(|event| {
            matches!(
                event["kind"].as_str(),
                Some("open" | "close" | "liquidation")
            )
        })
        .collect();
    let realized: i128 = trades
        .iter()
        .map(|event| integer(&event["realized_pnl"]))
        .sum();
    let volume: i128 = trades.iter().map(|event| integer(&event["size"])).sum();
    let stats = view(
        ketos,
        "get_account_stats",
        json!({ "account_id": account.id() }),
    )
    .await?;
    assert_eq!(integer(&stats["realized_pnl"]), realized);
    assert_eq!(integer(&stats["volume"]), volume);
    assert_eq!(stats["trades"].as_u64().unwrap(), trades.len() as u64);
    assert_eq!(stats["event_count"].as_u64().unwrap(), events.len() as u64);
    assert_eq!(margin(ketos, account).await? as i128 - collateral, realized);
    for (sequence, event) in events.iter().enumerate() {
        assert_eq!(event["sequence"], sequence as u64);
        if event["kind"] == "funding" || event["kind"] == "order_fill" {
            assert_eq!(integer(&event["realized_pnl"]), 0);
        }
    }
    let mut paged = Vec::new();
    for from in (0..events.len()).step_by(2) {
        let page = view(
            ketos,
            "get_history",
            json!({ "account_id": account.id(), "from": from, "limit": 2 }),
        )
        .await?;
        paged.extend(page.as_array().unwrap().iter().cloned());
    }
    assert_eq!(json!(paged), history);
    for sort in ["pnl", "volume"] {
        let board = view(ketos, "get_leaderboard", json!({ "sort": sort })).await?;
        let rows = board.as_array().unwrap();
        let score = if sort == "pnl" {
            "realized_pnl"
        } else {
            "volume"
        };
        assert!(rows
            .windows(2)
            .all(|pair| integer(&pair[0][score]) >= integer(&pair[1][score])));
        let row = rows
            .iter()
            .find(|row| row["account_id"] == account.id().as_str())
            .unwrap();
        for field in ["realized_pnl", "volume", "trades", "committed_margin"] {
            assert_eq!(row[field], stats[field]);
        }
        let committed = integer(&stats["committed_margin"]);
        assert_eq!(integer(&row["roi_bps"]), realized * 10_000 / committed);
    }
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
    let ketos = sub(&root, "ketos", 20)
        .await?
        .deploy(&wasm("ketos"))
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
    ok(ketos
        .call("new")
        .args_json(
            json!({ "usdc_id": usdc.id(), "oracle_id": oracle.id(), "outlayer_id": oracle.id(), "keeper_id": keeper.id() }),
        )
        .transact()
        .await?);

    let markets = view(&ketos, "get_markets", json!({})).await?;
    assert_eq!(markets.as_array().unwrap().len(), PRICES.len());
    let mut paged = Vec::new();
    for from in (0..PRICES.len()).step_by(3) {
        let page = view(
            &ketos,
            "get_markets",
            json!({ "from_index": from, "limit": 3 }),
        )
        .await?;
        paged.extend(page.as_array().unwrap().iter().cloned());
    }
    assert_eq!(json!(paged), markets);
    assert!(markets
        .as_array()
        .unwrap()
        .iter()
        .all(|m| m["is_open"] == false));
    let config = view(&ketos, "get_config", json!({})).await?;
    assert_eq!(config["outlayer_id"], oracle.id().as_str());
    let private_callback = err(trader
        .call(ketos.id(), "on_worker_prices")
        .args_json(json!({ "asset_ids": WORKER_ASSETS }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await);
    assert!(private_callback.contains("private"), "{private_callback}");
    ok(root
        .call(usdc.id(), "storage_deposit")
        .args_json(json!({ "account_id": ketos.id() }))
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

    // The keeper signs with a function-call key limited to the seven keeper methods on Ketos.
    let keeper_sk = SecretKey::from_random(KeyType::ED25519);
    ok(keeper
        .batch(keeper.id())
        .add_key(
            keeper_sk.public_key(),
            AccessKey::function_call_access(
                ketos.id(),
                &KEEPER_METHODS,
                Some(NearToken::from_near(1)),
            ),
        )
        .transact()
        .await?);
    let bot = Account::from_secret_key(keeper.id().clone(), keeper_sk, &worker);

    // Prices: pulled from the oracle through `refresh_prices`.
    ok(bot
        .call(ketos.id(), "refresh_prices")
        .gas(Gas::from_tgas(100))
        .transact()
        .await?);
    let prices = view(&ketos, "get_prices", json!({})).await?;
    assert!(
        prices
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["is_fresh"] == true),
        "{prices}"
    );
    assert_eq!(prices.as_array().unwrap().len(), PRICES.len());
    for (asset, price) in PRICES {
        let stored = prices
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["oracle_asset_id"] == asset)
            .unwrap();
        assert_eq!(stored["price"], price.to_string());
    }

    // Worker prices arrive only through the async request and private callback. None,
    // a failed request, stale output, and omitted assets must preserve the last good feed.
    let worker_prices: Vec<Value> = prices
        .as_array()
        .unwrap()
        .iter()
        .filter(|price| {
            WORKER_ASSETS
                .iter()
                .any(|asset| price["oracle_asset_id"] == *asset)
        })
        .cloned()
        .collect();
    assert_eq!(worker_prices.len(), WORKER_ASSETS.len());
    let missing_at_ms = now_ms(&worker).await?;
    for (response, fail) in [
        (Value::Null, false),
        (Value::Null, true),
        (
            json!({ "timestamp_ms": 1, "prices": { "DOGE": ["1", ["coinbase", "kraken"]] } }),
            false,
        ),
        (
            json!({ "timestamp_ms": missing_at_ms, "prices": {} }),
            false,
        ),
    ] {
        ok(root
            .call(oracle.id(), "set_execution_response")
            .args_json(json!({ "use_canned_response": true, "result": response, "fail": fail }))
            .transact()
            .await?);
        ok(bot
            .call(ketos.id(), "refresh_prices")
            .gas(Gas::from_tgas(100))
            .transact()
            .await?);
        let after = view(&ketos, "get_prices", json!({})).await?;
        for expected in &worker_prices {
            let actual = after
                .as_array()
                .unwrap()
                .iter()
                .find(|price| price["oracle_asset_id"] == expected["oracle_asset_id"])
                .unwrap();
            assert_eq!(actual["price"], expected["price"]);
            assert_eq!(actual["timestamp_ms"], expected["timestamp_ms"]);
        }
    }
    ok(root
        .call(oracle.id(), "set_execution_response")
        .args_json(json!({ "use_canned_response": false, "result": null, "fail": false }))
        .transact()
        .await?);

    // Depth: the recorded 1Click curve, stamped at the current block time.
    let fixture = depth_fixture();
    let measured_at_ms = now_ms(&worker).await?;
    for market in ["BTC", "ETH", "NEAR", "ZEC"] {
        ok(bot
            .call(ketos.id(), "set_depth")
            .args_json(json!({
                "market_id": market,
                "samples": fixture["assets"][market]["samples"],
                "measured_at_ms": measured_at_ms,
            }))
            .transact()
            .await?);
    }
    let near_market = view(&ketos, "get_market", json!({ "market_id": "NEAR" })).await?;
    assert_eq!(near_market["is_open"], true);
    assert_eq!(near_market["max_leverage"], 5);
    assert_eq!(near_market["max_oi_per_side"], (100_000 * USD).to_string());
    for asset in WORKER_ASSETS {
        let market = view(&ketos, "get_market", json!({ "market_id": asset })).await?;
        assert_eq!(market["price_source"], "outlayer_worker");
        assert_eq!(
            market["is_open"], false,
            "worker market lacks measured depth: {asset}"
        );
    }

    // Funding: faucet for the trader, minted tUSDC for the LP.
    ok(trader.call(usdc.id(), "faucet").transact().await?);
    assert_eq!(ft_balance(&usdc, &trader).await?, 1_000 * USD);
    ok(root
        .call(usdc.id(), "mint")
        .args_json(json!({ "account_id": lp.id(), "amount": (10_000 * USD).to_string() }))
        .transact()
        .await?);
    transfer_call(&trader, &usdc, &ketos, 500 * USD, "deposit_margin").await?;
    transfer_call(&lp, &usdc, &ketos, 10_000 * USD, "deposit_vault:core").await?;
    assert_eq!(margin(&ketos, &trader).await?, 500 * USD);
    let vault = view(&ketos, "get_vault", json!({ "vault_id": "core" })).await?;
    assert_eq!(vault["nav"], (10_000 * USD).to_string());

    // Long NEAR 5x, then a ZEC short sized past the measured exit capacity.
    let long = ok(trader
        .call(ketos.id(), "open_position")
        .args_json(json!({ "market_id": "NEAR", "side": "long", "margin": (100 * USD).to_string(), "leverage": 5 }))
        .transact()
        .await?);
    assert_eq!(long["size"], (500 * USD).to_string());
    assert_eq!(long["entry_price"], "400000000");
    let refused = err(trader
        .call(ketos.id(), "open_position")
        .args_json(json!({ "market_id": "ZEC", "side": "short", "margin": (25_000 * USD).to_string(), "leverage": 5 }))
        .transact()
        .await);
    assert!(
        refused.contains("ERR_EXCEEDS_EXIT_LIQUIDITY: cap 100000000000"),
        "{refused}"
    );
    let short = ok(trader
        .call(ketos.id(), "open_position")
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
        .call(ketos.id(), "refresh_prices")
        .gas(Gas::from_tgas(100))
        .transact()
        .await?);
    let marked = view(&ketos, "get_position", json!({ "position_id": long["id"] })).await?;
    let liq_price: u128 = marked["liquidation_price"].as_str().unwrap().parse()?;
    assert!(liq_price > 350_000_000, "{marked}");

    let record = ok(bot
        .call(ketos.id(), "liquidate")
        .args_json(json!({ "position_id": long["id"] }))
        .transact()
        .await?);
    assert_eq!(record["liquidator"], keeper.id().as_str());
    assert_eq!(record["price"], "350000000");
    let liquidations = view(&ketos, "get_liquidations", json!({})).await?;
    assert_eq!(liquidations[0]["position_id"], long["id"]);
    let reward: u128 = record["reward"].as_str().unwrap().parse()?;
    assert!(reward > 0);
    assert_eq!(margin(&ketos, &keeper).await?, reward);
    assert!(
        view(&ketos, "get_position", json!({ "position_id": long["id"] }))
            .await?
            .is_null()
    );

    // The winning short is closed, then all free margin goes back to the wallet.
    let payout: u128 = ok(trader
        .call(ketos.id(), "close_position")
        .args_json(json!({ "position_id": short["id"] }))
        .transact()
        .await?)
    .as_str()
    .unwrap()
    .parse()?;
    assert!(payout > 50 * USD, "short payout {payout}");
    assert!(view(
        &ketos,
        "get_positions",
        json!({ "account_id": trader.id() })
    )
    .await?
    .as_array()
    .unwrap()
    .is_empty());
    let free = margin(&ketos, &trader).await?;
    ok(trader
        .call(ketos.id(), "withdraw_margin")
        .args_json(json!({ "amount": free.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?);
    assert_eq!(margin(&ketos, &trader).await?, 0);
    assert_eq!(ft_balance(&usdc, &trader).await?, 500 * USD + free);

    // The vault earned the trader's loss net of the short's gain, plus fees.
    let vault = view(&ketos, "get_vault", json!({ "vault_id": "core" })).await?;
    let nav: u128 = vault["nav"].as_str().unwrap().parse()?;
    assert!(nav > 10_000 * USD, "{vault}");

    // Separate vault shares and cash are backed by actual NEP-141 deposits.
    ok(root
        .call(usdc.id(), "mint")
        .args_json(json!({ "account_id": lp.id(), "amount": (10_000 * USD).to_string() }))
        .transact()
        .await?);
    transfer_call(&lp, &usdc, &ketos, 10_000 * USD, "deposit_vault:long-tail").await?;
    let tail_seed = view(&ketos, "get_vault", json!({ "vault_id": "long-tail" })).await?;
    assert_eq!(integer(&tail_seed["balance"]), (10_000 * USD) as i128);
    assert_eq!(integer(&tail_seed["nav"]), (10_000 * USD) as i128);
    assert_eq!(integer(&tail_seed["reserved"]), 0);
    let shares = view(
        &ketos,
        "get_vault_account",
        json!({ "vault_id": "long-tail", "account_id": lp.id() }),
    )
    .await?;
    assert_eq!(integer(&shares["shares"]), (10_000 * USD) as i128);
    assert_eq!(integer(&shares["value"]), (10_000 * USD) as i128);

    let v2 = sub(&root, "v2", 10).await?;
    ok(v2.call(usdc.id(), "faucet").transact().await?);
    transfer_call(&v2, &usdc, &ketos, 900 * USD, "deposit_margin").await?;
    price(&root, &oracle, &bot, &ketos, "wrap.near", 400_000_000).await?;
    depth(&worker, &bot, &ketos, "NEAR").await?;
    let funding_long = call(
        &v2,
        &ketos,
        "open_position",
        json!({
            "market_id": "NEAR", "side": "long", "margin": (100 * USD).to_string(), "leverage": 4
        }),
    )
    .await?;
    let funding_short = call(
        &v2,
        &ketos,
        "open_position",
        json!({
            "market_id": "NEAR", "side": "short", "margin": (50 * USD).to_string(), "leverage": 2
        }),
    )
    .await?;
    let initial_snapshots = call(&bot, &ketos, "snapshot_vaults", json!({})).await?;
    assert_eq!(initial_snapshots.as_array().unwrap().len(), 2);
    let too_soon = err(bot.call(ketos.id(), "snapshot_vaults").transact().await);
    assert!(too_soon.contains("ERR_SNAPSHOT_TOO_SOON"), "{too_soon}");
    let initial_time = initial_snapshots[0]["timestamp_ms"].as_u64().unwrap();
    while now_ms(&worker).await? < initial_time + 3_600_000 {
        worker.fast_forward(3_600).await?;
    }
    let margin_before_funding = margin(&ketos, &v2).await?;
    let token_before_funding = ft_balance(&usdc, &ketos.as_account()).await?;
    let accrual = call(
        &bot,
        &ketos,
        "settle_funding",
        json!({ "market_id": "NEAR" }),
    )
    .await?;
    assert!(accrual.is_null());
    assert_eq!(margin(&ketos, &v2).await?, margin_before_funding);
    assert_eq!(
        ft_balance(&usdc, &ketos.as_account()).await?,
        token_before_funding
    );
    let payer = view(
        &ketos,
        "get_position",
        json!({ "position_id": funding_long["id"] }),
    )
    .await?;
    let receiver = view(
        &ketos,
        "get_position",
        json!({ "position_id": funding_short["id"] }),
    )
    .await?;
    assert!(integer(&payer["funding_paid"]) > 0);
    assert_eq!(integer(&payer["funding_received"]), 0);
    assert!(integer(&receiver["funding_received"]) > 0);
    assert_eq!(integer(&receiver["funding_paid"]), 0);
    assert!(integer(&payer["funding_paid"]) > integer(&receiver["funding_received"]));
    assert_eq!(
        integer(&payer["funding_payment"]),
        integer(&payer["funding_paid"])
    );
    assert_eq!(
        integer(&receiver["funding_payment"]),
        -integer(&receiver["funding_received"])
    );
    let due = view(&ketos, "get_vault", json!({ "vault_id": "core" })).await?;
    assert!(integer(&due["funding_net_due"]) > 0);
    assert_eq!(
        view(&ketos, "get_vault", json!({ "vault_id": "long-tail" })).await?,
        tail_seed
    );
    // Funding remains checkpointable with stale prices; exits require fresh oracle receipts.
    call(&bot, &ketos, "refresh_prices", json!({})).await?;
    depth(&worker, &bot, &ketos, "NEAR").await?;
    for position in [&funding_long, &funding_short] {
        call(
            &v2,
            &ketos,
            "close_position",
            json!({ "position_id": position["id"] }),
        )
        .await?;
    }
    let settled_core = view(&ketos, "get_vault", json!({ "vault_id": "core" })).await?;
    assert!(integer(&settled_core["revenue"]["funding"]) > 0);
    assert_eq!(integer(&settled_core["funding_net_due"]), 0);
    let funding_history = view(
        &ketos,
        "get_history",
        json!({ "account_id": v2.id(), "limit": 200 }),
    )
    .await?;
    assert_eq!(
        funding_history
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["kind"] == "funding")
            .count(),
        2
    );
    assert_economics(&ketos, &v2, (900 * USD) as i128).await?;
    let snapshots = call(&bot, &ketos, "snapshot_vaults", json!({})).await?;
    for (index, vault_id) in ["core", "long-tail"].into_iter().enumerate() {
        let history = view(&ketos, "get_vault_history", json!({ "vault_id": vault_id })).await?;
        assert_eq!(history.as_array().unwrap().len(), 2);
        assert_eq!(history[0], initial_snapshots[index]);
        assert_eq!(history[1], snapshots[index]);
        assert!(history[1]["timestamp_ms"].as_u64().unwrap() >= initial_time + 3_600_000);
        let current = view(&ketos, "get_vault", json!({ "vault_id": vault_id })).await?;
        assert_eq!(history[1]["nav"], current["nav"]);
        assert_eq!(history[1]["tvl"], current["balance"]);
        assert_eq!(history[1]["share_price"], current["share_price"]);
        assert_eq!(history[1]["revenue"], current["revenue"]);
    }

    // Limit entry reserves collateral without trading, then creates linked TP/SL exits.
    let free_before_order = margin(&ketos, &v2).await?;
    let entry = call(
        &v2,
        &ketos,
        "place_order",
        json!({ "request": {
            "kind": "limit", "market_id": "NEAR", "side": "long",
            "margin": (40 * USD).to_string(), "leverage": 2, "trigger_price": "390000000",
            "brackets": { "take_profit": "420000000", "stop_loss": "370000000" }
        }}),
    )
    .await?;
    assert_eq!(margin(&ketos, &v2).await?, free_before_order - 40 * USD);
    let before_fill_stats = view(
        &ketos,
        "get_account_stats",
        json!({ "account_id": v2.id() }),
    )
    .await?;
    let skipped = call(
        &bot,
        &ketos,
        "execute_orders",
        json!({ "ids": [entry["id"]] }),
    )
    .await?;
    assert_eq!(skipped[0]["status"], "skipped");
    assert_eq!(
        view(
            &ketos,
            "get_account_stats",
            json!({ "account_id": v2.id() })
        )
        .await?,
        before_fill_stats
    );
    price(&root, &oracle, &bot, &ketos, "wrap.near", 390_000_000).await?;
    let filled = call(
        &bot,
        &ketos,
        "execute_orders",
        json!({ "ids": [entry["id"]] }),
    )
    .await?;
    assert_eq!(filled[0]["status"], "filled");
    assert_eq!(filled[0]["price"], "390000000");
    let bracketed = view(
        &ketos,
        "get_position",
        json!({ "position_id": filled[0]["position_id"] }),
    )
    .await?;
    assert_eq!(bracketed["entry_price"], "390000000");
    assert_eq!(margin(&ketos, &v2).await?, free_before_order - 40 * USD);
    let exits = view(&ketos, "get_orders", json!({ "account_id": v2.id() })).await?;
    assert_eq!(exits.as_array().unwrap().len(), 2);
    assert!(bracketed["take_profit"].is_number());
    assert!(bracketed["stop_loss"].is_number());
    price(&root, &oracle, &bot, &ketos, "wrap.near", 420_000_000).await?;
    let take_profit = call(
        &bot,
        &ketos,
        "execute_orders",
        json!({ "ids": [bracketed["take_profit"], bracketed["stop_loss"]] }),
    )
    .await?;
    assert_eq!(take_profit[0]["status"], "filled");
    assert_eq!(take_profit[1]["status"], "skipped");
    assert!(view(
        &ketos,
        "get_position",
        json!({ "position_id": bracketed["id"] })
    )
    .await?
    .is_null());
    assert!(view(&ketos, "get_orders", json!({ "account_id": v2.id() }))
        .await?
        .as_array()
        .unwrap()
        .is_empty());
    assert!(margin(&ketos, &v2).await? > free_before_order);

    // Stop-market entry fills on the opposite trigger direction; SL also cancels TP.
    let stop_entry = call(
        &v2,
        &ketos,
        "place_order",
        json!({ "request": {
            "kind": "stop_market", "market_id": "NEAR", "side": "long",
            "margin": (40 * USD).to_string(), "leverage": 2, "trigger_price": "430000000",
            "brackets": { "take_profit": "450000000", "stop_loss": "410000000" }
        }}),
    )
    .await?;
    let skipped = call(
        &bot,
        &ketos,
        "execute_orders",
        json!({ "ids": [stop_entry["id"]] }),
    )
    .await?;
    assert_eq!(skipped[0]["status"], "skipped");
    price(&root, &oracle, &bot, &ketos, "wrap.near", 430_000_000).await?;
    let filled = call(
        &bot,
        &ketos,
        "execute_orders",
        json!({ "ids": [stop_entry["id"]] }),
    )
    .await?;
    assert_eq!(filled[0]["status"], "filled");
    let stopped = view(
        &ketos,
        "get_position",
        json!({ "position_id": filled[0]["position_id"] }),
    )
    .await?;
    price(&root, &oracle, &bot, &ketos, "wrap.near", 410_000_000).await?;
    let stop_loss = call(
        &bot,
        &ketos,
        "execute_orders",
        json!({ "ids": [stopped["stop_loss"], stopped["take_profit"]] }),
    )
    .await?;
    assert_eq!(stop_loss[0]["status"], "filled");
    assert_eq!(stop_loss[1]["status"], "skipped");
    assert!(view(&ketos, "get_orders", json!({ "account_id": v2.id() }))
        .await?
        .as_array()
        .unwrap()
        .is_empty());
    assert_economics(&ketos, &v2, (900 * USD) as i128).await?;

    // Listing is paid by an ordinary wallet and its fee belongs only to Long-tail.
    let listing = format!(
        "list_market:{}",
        json!({
            "symbol": "TAIL", "oracle_asset_id": "tail.token.near",
            "intents_asset_id": "nep141:tail.token.near", "price_source": "tee"
        })
    );
    let core_before_listing = view(&ketos, "get_vault", json!({ "vault_id": "core" })).await?;
    let wallet_before_listing = ft_balance(&usdc, &v2).await?;
    transfer_call(&v2, &usdc, &ketos, 4 * USD, &listing).await?;
    assert_eq!(ft_balance(&usdc, &v2).await?, wallet_before_listing);
    assert!(view(&ketos, "get_market", json!({ "market_id": "TAIL" }))
        .await?
        .is_null());
    transfer_call(&v2, &usdc, &ketos, 5 * USD, &listing).await?;
    assert_eq!(
        ft_balance(&usdc, &v2).await?,
        wallet_before_listing - 5 * USD
    );
    let listed = view(&ketos, "get_market", json!({ "market_id": "TAIL" })).await?;
    assert_eq!(listed["vault_id"], "long-tail");
    assert_eq!(listed["is_open"], false);
    assert_eq!(listed["depth_measured_at_ms"], 0);
    let tail_listed = view(&ketos, "get_vault", json!({ "vault_id": "long-tail" })).await?;
    assert_eq!(integer(&tail_listed["balance"]), (10_005 * USD) as i128);
    assert_eq!(
        integer(&tail_listed["revenue"]["listing"]),
        (5 * USD) as i128
    );
    assert_eq!(
        view(&ketos, "get_vault", json!({ "vault_id": "core" })).await?,
        core_before_listing
    );
    // Duplicate registration refunds through ft_resolve_transfer rather than charging twice.
    transfer_call(&v2, &usdc, &ketos, 5 * USD, &listing).await?;
    assert_eq!(
        ft_balance(&usdc, &v2).await?,
        wallet_before_listing - 5 * USD
    );
    assert_eq!(
        view(&ketos, "get_vault", json!({ "vault_id": "long-tail" })).await?,
        tail_listed
    );
    price(&root, &oracle, &bot, &ketos, "tail.token.near", 100_000_000).await?;
    let gate = err(v2
        .call(ketos.id(), "open_position")
        .args_json(json!({
            "market_id": "TAIL", "side": "long", "margin": (20 * USD).to_string(), "leverage": 2
        }))
        .transact()
        .await);
    assert!(gate.contains("ERR_MARKET_CLOSED"), "{gate}");
    let free_before_rejection = margin(&ketos, &v2).await?;
    let gated_order = call(
        &v2,
        &ketos,
        "place_order",
        json!({ "request": {
            "kind": "limit", "market_id": "TAIL", "side": "long",
            "margin": (20 * USD).to_string(), "leverage": 2, "trigger_price": "100000000"
        }}),
    )
    .await?;
    assert_eq!(margin(&ketos, &v2).await?, free_before_rejection - 20 * USD);
    let rejection = call(
        &bot,
        &ketos,
        "execute_orders",
        json!({ "ids": [gated_order["id"]] }),
    )
    .await?;
    assert_eq!(rejection[0]["status"], "rejected");
    assert!(rejection[0]["reason"]
        .as_str()
        .unwrap()
        .contains("ERR_MARKET_CLOSED"));
    assert_eq!(margin(&ketos, &v2).await?, free_before_rejection);
    assert!(view(&ketos, "get_orders", json!({ "account_id": v2.id() }))
        .await?
        .as_array()
        .unwrap()
        .is_empty());
    depth(&worker, &bot, &ketos, "TAIL").await?;
    assert_eq!(
        view(&ketos, "get_market", json!({ "market_id": "TAIL" })).await?["is_open"],
        true
    );
    let tail_position = call(
        &v2,
        &ketos,
        "open_position",
        json!({
            "market_id": "TAIL", "side": "long", "margin": (20 * USD).to_string(), "leverage": 2
        }),
    )
    .await?;
    let tail_active = view(&ketos, "get_vault", json!({ "vault_id": "long-tail" })).await?;
    assert_eq!(integer(&tail_active["reserved"]), (40 * USD) as i128);
    assert!(integer(&tail_active["balance"]) > integer(&tail_listed["balance"]));
    assert_eq!(
        view(&ketos, "get_vault", json!({ "vault_id": "core" })).await?,
        core_before_listing
    );
    price(&root, &oracle, &bot, &ketos, "tail.token.near", 110_000_000).await?;
    let tail_payout = call(
        &v2,
        &ketos,
        "close_position",
        json!({ "position_id": tail_position["id"] }),
    )
    .await?;
    assert!(integer(&tail_payout) > (20 * USD) as i128);
    let tail_closed = view(&ketos, "get_vault", json!({ "vault_id": "long-tail" })).await?;
    assert_eq!(integer(&tail_closed["reserved"]), 0);
    assert!(integer(&tail_closed["balance"]) < integer(&tail_listed["balance"]));
    assert_eq!(
        view(&ketos, "get_vault", json!({ "vault_id": "core" })).await?,
        core_before_listing
    );
    assert_economics(&ketos, &v2, (900 * USD) as i128).await?;

    // An isolated position transitions without changing collateral, then shares account health.
    let cross = sub(&root, "cross", 10).await?;
    ok(cross.call(usdc.id(), "faucet").transact().await?);
    transfer_call(&cross, &usdc, &ketos, 500 * USD, "deposit_margin").await?;
    price(&root, &oracle, &bot, &ketos, "wrap.near", 400_000_000).await?;
    depth(&worker, &bot, &ketos, "NEAR").await?;
    let isolated = call(
        &cross,
        &ketos,
        "open_position",
        json!({
            "market_id": "NEAR", "side": "long", "margin": (100 * USD).to_string(), "leverage": 5
        }),
    )
    .await?;
    let before_switch = margin(&ketos, &cross).await?;
    let switched = call(
        &cross,
        &ketos,
        "switch_to_cross",
        json!({ "position_id": isolated["id"] }),
    )
    .await?;
    assert_eq!(switched["margin_mode"], "cross");
    assert_eq!(switched["margin"], isolated["margin"]);
    assert_eq!(switched["size"], isolated["size"]);
    assert_eq!(integer(&switched["liquidation_price"]), 0);
    assert_eq!(margin(&ketos, &cross).await?, before_switch);
    call(
        &cross,
        &ketos,
        "add_cross_margin",
        json!({ "amount": (20 * USD).to_string() }),
    )
    .await?;
    assert_eq!(margin(&ketos, &cross).await?, before_switch - 20 * USD);
    let survivor = call(
        &cross,
        &ketos,
        "open_position",
        json!({
            "market_id": "NEAR", "side": "long", "margin": (20 * USD).to_string(),
            "leverage": 2, "margin_mode": "cross"
        }),
    )
    .await?;
    assert_eq!(survivor["margin_mode"], "cross");
    let healthy = view(
        &ketos,
        "get_cross_account",
        json!({ "account_id": cross.id() }),
    )
    .await?;
    assert_eq!(integer(&healthy["cash"]), (20 * USD) as i128);
    assert_eq!(healthy["position_count"], 2);
    assert_eq!(healthy["liquidatable"], false);
    let wrong_liquidator = err(bot
        .call(ketos.id(), "liquidate")
        .args_json(json!({ "position_id": isolated["id"] }))
        .transact()
        .await);
    assert!(
        wrong_liquidator.contains("ERR_USE_CROSS_LIQUIDATION"),
        "{wrong_liquidator}"
    );
    let healthy_rejection = err(bot
        .call(ketos.id(), "liquidate_cross")
        .args_json(json!({ "account_id": cross.id() }))
        .transact()
        .await);
    assert!(
        healthy_rejection.contains("ERR_CROSS_HEALTHY"),
        "{healthy_rejection}"
    );
    price(&root, &oracle, &bot, &ketos, "wrap.near", 330_000_000).await?;
    let unhealthy = view(
        &ketos,
        "get_cross_account",
        json!({ "account_id": cross.id() }),
    )
    .await?;
    assert_eq!(unhealthy["liquidatable"], true);
    assert!(integer(&unhealthy["equity"]) <= integer(&unhealthy["maintenance_margin"]));
    let keeper_before_cross = margin(&ketos, &keeper).await?;
    let tail_before_cross = view(&ketos, "get_vault", json!({ "vault_id": "long-tail" })).await?;
    let cross_records = call(
        &bot,
        &ketos,
        "liquidate_cross",
        json!({ "account_id": cross.id() }),
    )
    .await?;
    assert_eq!(cross_records.as_array().unwrap().len(), 1);
    assert_eq!(cross_records[0]["position_id"], isolated["id"]);
    assert_eq!(cross_records[0]["liquidator"], keeper.id().as_str());
    assert_eq!(
        margin(&ketos, &keeper).await?,
        keeper_before_cross + integer(&cross_records[0]["reward"]) as u128
    );
    assert!(integer(&cross_records[0]["reward"]) > 0);
    assert!(view(
        &ketos,
        "get_position",
        json!({ "position_id": isolated["id"] })
    )
    .await?
    .is_null());
    let recovered = view(
        &ketos,
        "get_cross_account",
        json!({ "account_id": cross.id() }),
    )
    .await?;
    assert_eq!(recovered["position_count"], 1);
    assert_eq!(recovered["liquidatable"], false);
    assert_eq!(recovered["debt_by_vault"], json!(["0", "0"]));
    assert_eq!(
        view(&ketos, "get_vault", json!({ "vault_id": "long-tail" })).await?,
        tail_before_cross
    );
    // Account liquidation stops once the riskiest position is removed and health recovers.
    assert!(!view(
        &ketos,
        "get_position",
        json!({ "position_id": survivor["id"] })
    )
    .await?
    .is_null());
    let free_before_removal = margin(&ketos, &cross).await?;
    let cash_before_removal = integer(&recovered["cash"]);
    assert!(cash_before_removal >= USD as i128);
    call(
        &cross,
        &ketos,
        "remove_cross_margin",
        json!({ "amount": USD.to_string() }),
    )
    .await?;
    assert_eq!(margin(&ketos, &cross).await?, free_before_removal + USD);
    let before_final_exit = view(
        &ketos,
        "get_cross_account",
        json!({ "account_id": cross.id() }),
    )
    .await?;
    assert_eq!(
        integer(&before_final_exit["cash"]),
        cash_before_removal - USD as i128
    );
    let free_before_final_exit = margin(&ketos, &cross).await?;
    let final_credit = call(
        &cross,
        &ketos,
        "close_position",
        json!({ "position_id": survivor["id"] }),
    )
    .await?;
    let recovered = view(
        &ketos,
        "get_cross_account",
        json!({ "account_id": cross.id() }),
    )
    .await?;
    assert_eq!(recovered["position_count"], 0);
    assert_eq!(
        margin(&ketos, &cross).await? as i128,
        free_before_final_exit as i128
            + integer(&before_final_exit["cash"])
            + integer(&final_credit)
    );
    assert_eq!(
        view(
            &ketos,
            "get_cross_account",
            json!({ "account_id": cross.id() })
        )
        .await?["cash"],
        "0"
    );
    assert_economics(&ketos, &cross, (500 * USD) as i128).await?;
    // Rewards do not create leaderboard trading PnL or volume for the executor.
    assert!(view(
        &ketos,
        "get_account_stats",
        json!({ "account_id": keeper.id() })
    )
    .await?
    .is_null());
    let core_final = view(&ketos, "get_vault", json!({ "vault_id": "core" })).await?;
    let tail_final = view(&ketos, "get_vault", json!({ "vault_id": "long-tail" })).await?;
    let accounted = integer(&core_final["balance"])
        + integer(&tail_final["balance"])
        + margin(&ketos, &v2).await? as i128
        + margin(&ketos, &cross).await? as i128
        + margin(&ketos, &keeper).await? as i128;
    assert_eq!(
        ft_balance(&usdc, ketos.as_account()).await? as i128,
        accounted
    );

    // The keeper key cannot reach anything beyond its seven methods.
    let open = err(bot
        .call(ketos.id(), "open_position")
        .args_json(json!({ "market_id": "NEAR", "side": "long", "margin": USD.to_string(), "leverage": 2 }))
        .transact()
        .await);
    assert!(open.contains("MethodNameMismatch"), "{open}");
    let withdraw = err(bot
        .call(ketos.id(), "withdraw_margin")
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
    let transfer = err(bot
        .transfer_near(trader.id(), NearToken::from_yoctonear(1))
        .await);
    assert!(transfer.contains("RequiresFullAccess"), "{transfer}");
    Ok(())
}
