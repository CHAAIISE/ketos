//! Offline upgrade regression against the complete public V2 storage captured in the fixture.
//! Sandbox-only signing keys derive from a public seed, never from testnet access keys.

use std::collections::HashMap;

use anyhow::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::types::{AccessKey, AccountDetailsPatch, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{err, now_ms, ok, view, wasm};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/ketos-v2-testnet.json")).unwrap()
}

fn raw_state(state: &Value) -> HashMap<Vec<u8>, Vec<u8>> {
    state["values"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                STANDARD.decode(row["storage_path_base64"].as_str().unwrap()).unwrap(),
                STANDARD.decode(row["value"].as_str().unwrap()).unwrap(),
            )
        })
        .collect()
}

async fn patch_public_account(
    worker: &Worker<Sandbox>,
    account_id: &str,
    seed: &str,
    state: &HashMap<Vec<u8>, Vec<u8>>,
) -> Result<Contract> {
    let account_id = account_id.parse()?;
    let key = SecretKey::from_seed(KeyType::ED25519, seed);
    let storage_usage = state.iter().map(|(key, value)| (key.len() + value.len() + 40) as u64).sum();
    // Patching the account itself preserves the real account IDs without needing a
    // testnet registrar or changing any IDs inside the captured Borsh state.
    worker
        .patch(&account_id)
        .account(
            AccountDetailsPatch::default()
                .balance(NearToken::from_near(100))
                .storage_usage(storage_usage),
        )
        .access_key(key.public_key(), AccessKey::full_access())
        .states(state.iter().map(|(key, value)| (key.as_slice(), value.as_slice())))
        .transact()
        .await?;
    Ok(Contract::from_secret_key(account_id, key, worker))
}

fn migration(holders: Value) -> Function {
    Function::new("migrate")
        .args_json(json!({ "share_holders": holders }))
        .gas(Gas::from_tgas(300))
}

async fn assert_token_accounting(token: &Contract, expected: &Value) -> Result<()> {
    assert_eq!(view(token, "ft_total_supply", json!({})).await?, expected["ft_total_supply"]);
    for (account_id, balance) in expected["balances"].as_object().unwrap() {
        assert_eq!(
            view(token, "ft_balance_of", json!({ "account_id": account_id })).await?,
            *balance,
            "wallet/custody balance changed for {account_id}",
        );
    }
    Ok(())
}

fn borsh_string(value: &str) -> Vec<u8> {
    let mut bytes = (value.len() as u32).to_le_bytes().to_vec();
    bytes.extend_from_slice(value.as_bytes());
    bytes
}

fn lookup_key(prefix: &[u8], value: &str) -> Vec<u8> {
    let mut bytes = prefix.to_vec();
    bytes.extend_from_slice(&borsh_string(value));
    Sha256::digest(bytes).to_vec()
}

/// Predict the exact schema-3 store::IterableMap swap_remove writes. No market
/// payload bytes may change: the moved entry changes only its trailing u32 index.
fn retired_state_expected(
    state: &HashMap<Vec<u8>, Vec<u8>>,
    markets: &Value,
) -> HashMap<Vec<u8>, Vec<u8>> {
    let mut expected = state.clone();
    let mut ids = markets.as_array().unwrap().iter()
        .map(|market| market["id"].as_str().unwrap()).collect::<Vec<_>>();
    let root = expected.get_mut(b"STATE".as_slice()).unwrap();
    let mut market_count_offset = 0;
    // The unchanged schema-3 root begins with the four configured AccountIds.
    for _ in 0..4 {
        let len = u32::from_le_bytes(root[market_count_offset..market_count_offset + 4]
            .try_into().unwrap()) as usize;
        market_count_offset += 4 + len;
    }
    assert_eq!(u32::from_le_bytes(root[market_count_offset..market_count_offset + 4]
        .try_into().unwrap()) as usize, ids.len());
    for symbol in ["AURORA", "RHEA"] {
        let Some(index) = ids.iter().position(|id| *id == symbol) else { continue };
        let market = markets.as_array().unwrap().iter()
            .find(|market| market["id"] == symbol).unwrap();
        let last = ids.len() - 1;
        let vector_key = |index: usize| {
            let mut key = vec![15, b'v'];
            key.extend_from_slice(&(index as u32).to_le_bytes());
            key
        };
        let removed = expected.remove(&lookup_key(&[15, b'm'], symbol)).unwrap();
        assert!(removed.starts_with(&borsh_string(symbol)));
        assert_eq!(&removed[removed.len() - 4..], &(index as u32).to_le_bytes());
        if index != last {
            let moved_symbol = ids[last];
            let moved_key = vector_key(last);
            let moved_id = expected.get(&moved_key).unwrap().clone();
            assert_eq!(moved_id, borsh_string(moved_symbol));
            expected.insert(vector_key(index), moved_id);
            let moved = expected.get_mut(&lookup_key(&[15, b'm'], moved_symbol)).unwrap();
            assert!(moved.starts_with(&borsh_string(moved_symbol)));
            let index_offset = moved.len() - 4;
            assert_eq!(&moved[index_offset..], &(last as u32).to_le_bytes());
            moved[index_offset..].copy_from_slice(&(index as u32).to_le_bytes());
        }
        expected.remove(&vector_key(last));
        // Standalone LookupMaps use Identity; only IterableMap values use SHA-256.
        let oracle_key = [vec![6], borsh_string(market["oracle_asset_id"].as_str().unwrap())].concat();
        assert!(expected.remove(&oracle_key).is_some());
        expected.remove(&[vec![3], borsh_string(symbol)].concat());
        ids.swap_remove(index);
    }
    expected.get_mut(b"STATE".as_slice()).unwrap()[market_count_offset..market_count_offset + 4]
        .copy_from_slice(&(ids.len() as u32).to_le_bytes());
    expected
}

#[tokio::test]
async fn migrates_captured_v2_state_atomically_without_losing_claims() -> Result<()> {
    let fixture = fixture();
    let original = raw_state(&fixture["state"]);
    let worker = near_workspaces::sandbox().await?;
    let seed = fixture["sandbox_key_seed"].as_str().unwrap();
    let ketos = patch_public_account(&worker, "ketos.testnet", seed, &original).await?;
    let token_original = raw_state(&fixture["token"]["state"]);
    let token = patch_public_account(&worker, "usdc.ketos.testnet", seed, &token_original).await?;
    let new_wasm = wasm("ketos");
    let holders = fixture["share_holders"].clone();

    // No old WASM is checked in: a no-code account is the previous-code sentinel.
    // The failed second action must roll back BOTH deployment and all storage writes.
    let previous_code = worker.view_account(ketos.id()).await?.contract_state;
    let incomplete = err(ketos.batch().deploy(&new_wasm).call(migration(json!([]))).transact().await);
    assert!(incomplete.contains("ERR_INCOMPLETE_SHARE_HOLDERS"), "{incomplete}");
    assert_eq!(worker.view_account(ketos.id()).await?.contract_state, previous_code);
    assert_eq!(ketos.view_state().await?, original);

    let duplicate_holders = json!(["ketos-dev.testnet", "ketos-dev.testnet"]);
    let duplicate = err(ketos.batch().deploy(&new_wasm).call(migration(duplicate_holders)).transact().await);
    assert!(duplicate.contains("ERR_DUPLICATE_SHARE_HOLDER"), "{duplicate}");
    assert_eq!(worker.view_account(ketos.id()).await?.contract_state, previous_code);
    assert_eq!(ketos.view_state().await?, original);

    // Exercise the actual generated private wrapper on the legacy state, not only
    // an unrelated deserialization failure after migration has already completed.
    ketos.as_account().deploy(&new_wasm).await?.into_result()?;
    let outsider = worker.root_account()?;
    let external = err(outsider
        .call(ketos.id(), "migrate")
        .args_json(json!({ "share_holders": holders }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await);
    assert!(external.to_lowercase().contains("private"), "{external}");
    assert_eq!(ketos.view_state().await?, original);

    let token_wasm = wasm("mock_usdc");
    let token_previous_code = worker.view_account(token.id()).await?.contract_state;
    let _ = err(token.batch().deploy(&token_wasm).call(
        Function::new("migrate_faucet").args_json(json!({ "faucet_id": "Invalid..near" })),
    ).transact().await);
    assert_eq!(worker.view_account(token.id()).await?.contract_state, token_previous_code);
    assert_eq!(token.view_state().await?, token_original);
    token.as_account().deploy(&token_wasm).await?.into_result()?;
    let faucet_id = "faucet.ketos.testnet";
    let external = err(outsider.call(token.id(), "migrate_faucet")
        .args_json(json!({ "faucet_id": faucet_id }))
        .gas(Gas::from_tgas(100)).transact().await);
    assert!(external.to_lowercase().contains("private"), "{external}");
    assert_eq!(token.view_state().await?, token_original);
    ok(token.batch().deploy(&token_wasm).call(
        Function::new("migrate_faucet").args_json(json!({ "faucet_id": faucet_id }))
            .gas(Gas::from_tgas(100)),
    ).transact().await?);
    assert_token_accounting(&token, &fixture["token"]["views"]).await?;
    let token_migrated = token.view_state().await?;
    assert_eq!(token_migrated.len(), token_original.len());
    for (key, value) in &token_original {
        if key == b"STATE" {
            assert!(token_migrated[key].starts_with(value), "legacy token root fields changed");
        } else {
            assert_eq!(token_migrated.get(key), Some(value), "token balance or cooldown lost");
        }
    }
    assert_eq!(view(&token, "faucet_config", json!({})).await?["faucet_id"], faucet_id);
    let _ = err(token.batch().deploy(&token_wasm).call(
        Function::new("migrate_faucet").args_json(json!({ "faucet_id": "attacker.testnet" }))
            .gas(Gas::from_tgas(100)),
    ).transact().await);
    assert_eq!(token.view_state().await?, token_migrated);

    let before_ms = now_ms(&worker).await?;
    ok(ketos.batch().deploy(&new_wasm).call(migration(holders.clone())).transact().await?);
    let after_ms = now_ms(&worker).await?;
    assert_eq!(view(&ketos, "get_config", json!({})).await?, fixture["views"]["get_config"]);

    for (account_id, expected) in fixture["views"]["accounts"].as_object().unwrap() {
        for method in ["get_account", "get_account_stats", "get_history", "get_positions", "get_orders"] {
            assert_eq!(
                view(&ketos, method, json!({ "account_id": account_id, "limit": 200 })).await?,
                expected[method],
                "{method} changed for {account_id}",
            );
        }
        assert_eq!(
            view(&ketos, "get_price_deposit", json!({ "account_id": account_id })).await?,
            json!("0"),
        );
    }
    // This live snapshot predates any open trade/order. Nonempty legacy variants
    // are covered by the migration unit tests, rather than fabricated as live state.
    assert_eq!(view(&ketos, "get_open_positions", json!({})).await?, fixture["views"]["get_open_positions"]);
    assert_eq!(view(&ketos, "get_open_orders", json!({})).await?, fixture["views"]["get_open_orders"]);
    assert_eq!(view(&ketos, "get_leaderboard", json!({})).await?, fixture["views"]["get_leaderboard"]);

    let vaults = view(&ketos, "get_vaults", json!({})).await?;
    assert_eq!(vaults.as_array().unwrap().len(), 2);
    for expected in fixture["views"]["get_vaults"].as_array().unwrap() {
        let vault_id = expected["id"].as_str().unwrap();
        let actual = vaults.as_array().unwrap().iter().find(|vault| vault["id"] == vault_id).unwrap();
        for (field, value) in expected.as_object().unwrap() {
            assert_eq!(actual[field], *value, "{vault_id}.{field} changed");
        }
        assert_eq!(actual["available_to_withdraw"], expected["available"]);
        let expected_vault = &fixture["views"]["vaults"][vault_id];
        assert!(!expected_vault["history"].as_array().unwrap().is_empty());
        assert_eq!(
            view(&ketos, "get_vault_history", json!({ "vault_id": vault_id })).await?,
            expected_vault["history"],
        );
        let mut total_shares = 0u128;
        for (holder, expected_claim) in expected_vault["holders"].as_object().unwrap() {
            let claim = view(&ketos, "get_vault_account", json!({ "vault_id": vault_id, "account_id": holder })).await?;
            assert_eq!(claim, *expected_claim);
            total_shares += claim["shares"].as_str().unwrap().parse::<u128>()?;
        }
        assert_eq!(total_shares, expected["total_shares"].as_str().unwrap().parse::<u128>()?);
        assert!(total_shares > 0);
        assert_eq!(
            view(&ketos, "get_vault_account", json!({ "vault_id": vault_id, "account_id": outsider.id() })).await?["shares"],
            json!("0"),
        );
    }

    let markets = view(&ketos, "get_markets", json!({ "limit": 100 })).await?;
    assert_eq!(markets.as_array().unwrap().len(), 16);
    for expected in fixture["views"]["get_markets"].as_array().unwrap() {
        let actual = markets.as_array().unwrap().iter().find(|market| market["id"] == expected["id"]).unwrap();
        for (field, value) in expected.as_object().unwrap() {
            let expected_value = match field.as_str() {
                "is_open" | "funding_rate_per_hour" => continue,
                "max_leverage_cap" | "max_leverage" if expected["vault_id"] == "long-tail" => json!(value.as_u64().unwrap().min(5)),
                _ => value.clone(),
            };
            assert_eq!(actual[field], expected_value, "{}.{} changed", expected["id"], field);
        }
        let created = actual["created_at_ms"].as_u64().unwrap();
        assert!((before_ms..=after_ms).contains(&created));
        assert_eq!(actual["leverage_increased_at_ms"], actual["created_at_ms"]);
        let vault_cap = if expected["vault_id"] == "core" { 20_000_000_000u128 } else { 10_000_000_000u128 };
        assert_eq!(actual["vault_backed_cap_usd"], json!(vault_cap.to_string()));
        let exit_cap: u128 = expected["max_oi_per_side"].as_str().unwrap().parse()?;
        assert_eq!(actual["effective_max_oi_per_side"], json!(vault_cap.min(exit_cap).to_string()));
        assert!(actual["measured_cap_is_grid_max"].is_boolean());
        assert!(actual["close_only"].is_boolean());
        assert!(actual["stale_close_spread_bps"].is_u64());
    }

    // Unchanged collection bytes prove depth, account collateral, stats and both
    // history rings were retained, in addition to their public-view assertions.
    let migrated = ketos.view_state().await?;
    for (key, value) in &original {
        if matches!(key.first(), Some(1 | 2 | 3 | 4 | 6 | 8 | 9 | 10 | 11 | 12 | 13 | 14)) {
            assert_eq!(migrated.get(key), Some(value), "unchanged storage key lost: {key:?}");
        }
    }
    assert_token_accounting(&token, &fixture["token"]["views"]).await?;
    assert_eq!(token.view_state().await?, token_migrated);
    let migrated_code = worker.view_account(ketos.id()).await?.contract_state;
    let _ = err(ketos.batch().deploy(&new_wasm).call(migration(holders)).transact().await);
    assert_eq!(ketos.view_state().await?, migrated);
    assert_eq!(worker.view_account(ketos.id()).await?.contract_state, migrated_code);

    // Schema 3 is upgraded without invoking migrate again. A later failed action
    // must roll back the deployment AND both registry removals.
    let external = err(outsider.call(ketos.id(), "retire_unsupported_markets")
        .args_json(json!({})).gas(Gas::from_tgas(100)).transact().await);
    assert!(external.to_lowercase().contains("private"), "{external}");
    assert_eq!(ketos.view_state().await?, migrated);
    let failed_retirement = err(ketos.batch().deploy(&new_wasm)
        .call(Function::new("retire_unsupported_markets").args_json(json!({}))
            .gas(Gas::from_tgas(100)))
        .call(Function::new("nonexistent_retirement_rollback_probe").args_json(json!({}))
            .gas(Gas::from_tgas(10)))
        .transact().await);
    assert!(failed_retirement.to_lowercase().contains("method"), "{failed_retirement}");
    assert_eq!(ketos.view_state().await?, migrated);
    assert_eq!(worker.view_account(ketos.id()).await?.contract_state, migrated_code);

    let retired = ok(ketos.batch().deploy(&new_wasm)
        .call(Function::new("retire_unsupported_markets").args_json(json!({}))
            .gas(Gas::from_tgas(250)))
        .transact().await?);
    assert_eq!(retired, json!(["AURORA", "RHEA"]));
    let retired_state = ketos.view_state().await?;
    assert_eq!(retired_state, retired_state_expected(&migrated, &markets),
        "retirement changed storage outside exact registry/oracle/depth removal and swap indexes");
    for symbol in ["AURORA", "RHEA"] {
        assert!(view(&ketos, "get_market", json!({ "market_id": symbol })).await?.is_null());
        assert!(view(&ketos, "get_depth", json!({ "market_id": symbol })).await?.is_null());
    }
    assert_eq!(view(&ketos, "get_markets", json!({ "limit": 100 })).await?.as_array().unwrap().len(), 14);
    for (account_id, expected) in fixture["views"]["accounts"].as_object().unwrap() {
        for method in ["get_account", "get_account_stats", "get_history", "get_positions", "get_orders"] {
            assert_eq!(view(&ketos, method, json!({ "account_id": account_id, "limit": 200 })).await?,
                expected[method], "retirement changed {method} for {account_id}");
        }
    }
    for vault_id in ["core", "long-tail"] {
        let expected = &fixture["views"]["vaults"][vault_id];
        assert_eq!(view(&ketos, "get_vault_history", json!({ "vault_id": vault_id })).await?,
            expected["history"]);
        for (holder, claim) in expected["holders"].as_object().unwrap() {
            assert_eq!(view(&ketos, "get_vault_account",
                json!({ "vault_id": vault_id, "account_id": holder })).await?, *claim);
        }
    }
    assert_token_accounting(&token, &fixture["token"]["views"]).await?;
    assert_eq!(ok(ketos.call("retire_unsupported_markets").args_json(json!({}))
        .gas(Gas::from_tgas(100)).transact().await?), json!([]));
    assert_eq!(ketos.view_state().await?, retired_state);

    // Real FT resolution after a failed asynchronous oracle pull returns the entire
    // transfer. The captured oracle has no sandbox code; no fake price is supplied.
    let holder_id = fixture["share_holders"][0].as_str().unwrap();
    let holder = patch_public_account(&worker, holder_id, seed, &HashMap::new()).await?;
    let wallet_before = view(&token, "ft_balance_of", json!({ "account_id": holder_id })).await?;
    let custody_before = view(&token, "ft_balance_of", json!({ "account_id": ketos.id() })).await?;
    let claim_before = view(&ketos, "get_vault_account",
        json!({ "vault_id": "long-tail", "account_id": holder_id })).await?;
    let cost = view(&ketos, "get_vault_price_request_deposit",
        json!({ "vault_id": "long-tail" })).await?.as_str().unwrap().parse::<u128>()?;
    ok(holder.as_account().call(ketos.id(), "fund_price_requests").args_json(json!({}))
        .deposit(NearToken::from_yoctonear(cost)).gas(Gas::from_tgas(100)).transact().await?);
    let refund = holder.as_account().call(token.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": ketos.id(), "amount": "1000000",
            "msg": "deposit_vault:long-tail" }))
        .deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(300)).transact().await?;
    assert!(refund.is_success(), "FT resolution failed: {:?}", refund.failures());
    assert_eq!(view(&token, "ft_balance_of", json!({ "account_id": holder_id })).await?, wallet_before);
    assert_eq!(view(&token, "ft_balance_of", json!({ "account_id": ketos.id() })).await?, custody_before);
    assert_eq!(view(&ketos, "get_vault_account",
        json!({ "vault_id": "long-tail", "account_id": holder_id })).await?, claim_before);
    assert!(view(&ketos, "get_market", json!({ "market_id": "AURORA" })).await?.is_null());
    assert!(view(&ketos, "get_market", json!({ "market_id": "RHEA" })).await?.is_null());
    Ok(())
}
