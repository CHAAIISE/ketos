//! Offline upgrades against captured public storage; sandbox keys are never live keys.
use std::collections::HashMap;
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::types::{AccessKey, AccountDetailsPatch, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Contract, Worker};
use serde_json::{json, Value};
use super::{err, integer, ok, view, wasm};

fn raw_state(state: &Value) -> HashMap<Vec<u8>, Vec<u8>> {
    state["values"].as_array().unwrap().iter().map(|row| {
        let key = row["storage_path_base64"].as_str().unwrap();
        (STANDARD.decode(key).unwrap(), STANDARD.decode(row["value"].as_str().unwrap()).unwrap())
    }).collect()
}

async fn patch_public_account(worker: &Worker<Sandbox>, account_id: &str, seed: &str,
    state: &HashMap<Vec<u8>, Vec<u8>>) -> Result<Contract> {
    let account_id = account_id.parse()?;
    let key = SecretKey::from_seed(KeyType::ED25519, seed);
    let storage_usage = state.iter().map(|(key, value)| (key.len() + value.len() + 40) as u64).sum();
    worker.patch(&account_id)
        .account(AccountDetailsPatch::default().balance(NearToken::from_near(100)).storage_usage(storage_usage))
        .access_key(key.public_key(), AccessKey::full_access())
        .states(state.iter().map(|(key, value)| (key.as_slice(), value.as_slice())))
        .transact().await?;
    Ok(Contract::from_secret_key(account_id, key, worker))
}

fn hedge_config() -> Value {
    json!({"custody_id":"hedge.testnet","exchange_id":"ref.testnet","wrapped_near_id":"wrap.testnet","pool_id":7})
}

fn migration() -> Function {
    Function::new("migrate").args_json(json!({"hedge_config":hedge_config()})).gas(Gas::from_tgas(250))
}


#[tokio::test]
async fn migrates_schema5_state_atomically_without_losing_claims() -> Result<()> {
    let fixture: Value = serde_json::from_str(include_str!("../fixtures/ketos-v5-derived.json"))?;
    let original = raw_state(&fixture["state"]);
    let sandbox = near_sandbox::Sandbox::start_sandbox_with_config(near_sandbox::SandboxConfig {
        additional_config: Some(json!({ "trie_viewer_state_size_limit": 1_048_576 })),
        ..Default::default()
    }).await?;
    let worker = near_workspaces::sandbox().rpc_addr(&sandbox.rpc_addr)
        .validator_key(near_workspaces::network::ValidatorKey::HomeDir(sandbox.home_dir.path().to_path_buf()))
        .await?;
    let seed = fixture["sandbox_key_seed"].as_str().unwrap();
    let ketos = patch_public_account(&worker, "ketos.testnet", seed, &original).await?;
    let new_wasm = wasm("ketos");
    let previous_code = worker.view_account(ketos.id()).await?.contract_state;
    // A failed trailing action must roll back both the entire migration and deployment.
    let failed = err(ketos.batch().deploy(&new_wasm).call(migration())
        .call(Function::new("nonexistent_migration_rollback_probe").args_json(json!({})).gas(Gas::from_tgas(10)))
        .transact().await);
    assert!(failed.to_lowercase().contains("method"), "{failed}");
    assert_eq!(ketos.view_state().await?, original);
    assert_eq!(worker.view_account(ketos.id()).await?.contract_state, previous_code);

    ketos.as_account().deploy(&new_wasm).await?.into_result()?;
    let outsider = worker.root_account()?;
    let external = err(outsider.call(ketos.id(), "migrate").args_json(json!({"hedge_config":hedge_config()}))
        .gas(Gas::from_tgas(250)).transact().await);
    assert!(external.to_lowercase().contains("private"), "{external}");
    assert_eq!(ketos.view_state().await?, original);
    ok(ketos.batch().deploy(&new_wasm).call(migration()).transact().await?);
    assert_eq!(view(&ketos, "get_schema_version", json!({})).await?, 6);
    let actual = ketos.view_state().await?;
    let old_root = original.get(b"STATE".as_slice()).unwrap();
    let new_root = actual.get(b"STATE".as_slice()).unwrap();
    let version_offset = old_root.len() - 4;
    assert_eq!(&old_root[version_offset..], &5u32.to_le_bytes());
    assert_eq!(&new_root[..version_offset], &old_root[..version_offset], "legacy collection handles changed");
    assert_eq!(&new_root[version_offset..version_offset + 4], &6u32.to_le_bytes());
    let mut expected = original.clone();
    expected.insert(b"STATE".to_vec(), new_root.clone());
    assert_eq!(actual, expected, "migration changed collateral, claims or unrelated storage");
    let hedge = view(&ketos, "get_hedge", json!({})).await?;
    assert_eq!(hedge["recognized_value"], "0");
    assert!(hedge["confirmed"].is_null());
    assert!(hedge["pending"].is_null());
    assert_eq!(hedge["config"], hedge_config());

    for (vault_index, vault_id) in ["core", "long-tail"].into_iter().enumerate() {
        let mut total = 0;
        for holder in fixture["share_holders"].as_array().unwrap() {
            let holder = holder.as_str().unwrap();
            let mut key = vec![17, vault_index as u8];
            key.extend_from_slice(&(holder.len() as u32).to_le_bytes());
            key.extend_from_slice(holder.as_bytes());
            let balance = original.get(&key).unwrap();
            let shares = u128::from_le_bytes(balance[8..24].try_into().unwrap());
            let claim = view(&ketos, "get_vault_account", json!({"vault_id": vault_id, "account_id": holder})).await?;
            assert_eq!(claim["shares"], shares.to_string());
            total += shares;
        }
        let vault = view(&ketos, "get_vault", json!({"vault_id": vault_id})).await?;
        assert_eq!(vault["total_shares"], total.to_string());
    }

    let orders = view(&ketos, "get_open_orders", json!({})).await?;
    let orders = orders.as_array().unwrap();
    let first = orders.first().expect("captured fixture has live bracket orders");

    let code = worker.view_account(ketos.id()).await?.contract_state;
    let replay = err(ketos.batch().deploy(&new_wasm).call(migration()).transact().await);
    assert!(replay.contains("ERR_INCOMPATIBLE_V5_STATE"), "{replay}");
    assert_eq!(ketos.view_state().await?, expected);
    assert_eq!(worker.view_account(ketos.id()).await?.contract_state, code);

    let owner_id = first["account_id"].as_str().unwrap();
    let owner = patch_public_account(&worker, owner_id, seed, &HashMap::new()).await?;
    let before = view(&ketos, "get_account", json!({"account_id": owner_id})).await?;
    let returned = ok(owner.as_account().call(ketos.id(), "cancel_order")
        .args_json(json!({"order_id": first["id"], "to_wallet": false}))
        .gas(Gas::from_tgas(100)).transact().await?);
    let after = view(&ketos, "get_account", json!({"account_id": owner_id})).await?;
    assert_eq!(integer(&after["margin"]), integer(&before["margin"]) + integer(&returned));
    assert_eq!(integer(&after["reserved_margin"]), integer(&before["reserved_margin"]) - integer(&returned));
    Ok(())
}

async fn assert_token_accounting(token: &Contract, expected: &Value) -> Result<()> {
    assert_eq!(view(token, "ft_total_supply", json!({})).await?, expected["ft_total_supply"]);
    for (account_id, balance) in expected["balances"].as_object().unwrap() {
        assert_eq!(view(token, "ft_balance_of", json!({"account_id": account_id})).await?, *balance);
    }
    Ok(())
}

#[tokio::test]
async fn token_faucet_migration_preserves_historical_wallet_and_custody_balances() -> Result<()> {
    // Token migration is independent of Ketos's schema and retains its original V2 fixture.
    let fixture: Value = serde_json::from_str(include_str!("../fixtures/ketos-v2-testnet.json"))?;
    let original = raw_state(&fixture["token"]["state"]);
    let worker = near_workspaces::sandbox().await?;
    let seed = fixture["sandbox_key_seed"].as_str().unwrap();
    let token = patch_public_account(&worker, "usdc.ketos.testnet", seed, &original).await?;
    let token_wasm = wasm("mock_usdc");
    let previous_code = worker.view_account(token.id()).await?.contract_state;
    let _ = err(token.batch().deploy(&token_wasm).call(
        Function::new("migrate_faucet").args_json(json!({"faucet_id": "Invalid..near"})),
    ).transact().await);
    assert_eq!(worker.view_account(token.id()).await?.contract_state, previous_code);
    assert_eq!(token.view_state().await?, original);
    token.as_account().deploy(&token_wasm).await?.into_result()?;
    let outsider = worker.root_account()?;
    let faucet_id = "faucet.ketos.testnet";
    let external = err(outsider.call(token.id(), "migrate_faucet").args_json(json!({"faucet_id": faucet_id}))
        .gas(Gas::from_tgas(100)).transact().await);
    assert!(external.to_lowercase().contains("private"), "{external}");
    assert_eq!(token.view_state().await?, original);
    ok(token.batch().deploy(&token_wasm).call(
        Function::new("migrate_faucet").args_json(json!({"faucet_id": faucet_id})).gas(Gas::from_tgas(100)),
    ).transact().await?);
    assert_token_accounting(&token, &fixture["token"]["views"]).await?;
    let migrated = token.view_state().await?;
    assert_eq!(migrated.len(), original.len());
    for (key, value) in &original {
        if key == b"STATE" {
            assert!(migrated[key].starts_with(value));
        } else {
            assert_eq!(migrated.get(key), Some(value));
        }
    }
    assert_eq!(view(&token, "faucet_config", json!({})).await?["faucet_id"], faucet_id);
    let _ = err(token.batch().deploy(&token_wasm).call(
        Function::new("migrate_faucet").args_json(json!({"faucet_id": "attacker.testnet"})).gas(Gas::from_tgas(100)),
    ).transact().await);
    assert_eq!(token.view_state().await?, migrated);
    Ok(())
}
