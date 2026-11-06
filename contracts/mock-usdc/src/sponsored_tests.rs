use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::testing_env;

fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn ctx(predecessor: &str, timestamp: u64, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("usdc.testnet"))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .block_timestamp(timestamp)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(300))
        .build());
}

fn setup() -> MockUsdc {
    ctx("owner.testnet", 1_000, 0);
    MockUsdc::new(acc("owner.testnet"), None)
}

fn ip(index: usize) -> String {
    format!("{index:064x}")
}

fn sponsor(c: &mut MockUsdc, recipient: &str, timestamp: u64, deposit: u128, hash: String) -> U128 {
    ctx("faucet.owner.testnet", timestamp, deposit);
    c.faucet_for(acc(recipient), hash)
}

fn rejects_without_mutation(c: &mut MockUsdc, recipient: &str, hash: String, message: &str) {
    let supply = c.ft_total_supply();
    let spent = c.gas_spent;
    let day = c.gas_day;
    let previous = c.last_claim_ns.get(&acc(recipient)).copied();
    let claims = c.ip_claims_ns.get(&hash).cloned();
    let error = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.faucet_for(acc(recipient), hash.clone())
    })).expect_err("claim must fail");
    let text = error.downcast_ref::<String>().map(String::as_str)
        .or_else(|| error.downcast_ref::<&str>().copied()).unwrap_or("");
    assert!(text.contains(message), "unexpected refusal: {text}");
    assert_eq!(c.ft_total_supply(), supply);
    assert_eq!(c.gas_spent, spent);
    assert_eq!(c.gas_day, day);
    assert_eq!(c.last_claim_ns.get(&acc(recipient)).copied(), previous);
    assert_eq!(c.ip_claims_ns.get(&hash).cloned(), claims);
    assert!(get_created_receipts().is_empty());
}

#[test]
fn sponsored_zero_deposit_registers_and_half_near_schedules_exact_grant() {
    let mut c = setup();
    assert_eq!(c.faucet_config().faucet_id, acc("faucet.owner.testnet"));
    assert_eq!(sponsor(&mut c, "alice.testnet", 1_000, 0, ip(1)), U128(FAUCET_AMOUNT));
    assert_eq!(c.ft_balance_of(acc("alice.testnet")), U128(FAUCET_AMOUNT));
    assert!(c.storage_balance_of(acc("alice.testnet")).is_some());
    assert!(get_created_receipts().is_empty());
    assert_eq!(c.faucet_config().gas_spent, U128(0));
    sponsor(&mut c, "bob.testnet", 1_000, FAUCET_GAS_GRANT, ip(1));
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].receiver_id, acc("bob.testnet"));
    assert!(matches!(receipts[0].actions[0], MockAction::Transfer { deposit, .. }
        if deposit.as_yoctonear() == FAUCET_GAS_GRANT));
    assert_eq!(c.faucet_config().gas_spent, U128(FAUCET_GAS_GRANT));
    assert_eq!(c.ft_total_supply(), U128(2 * FAUCET_AMOUNT));
}

#[test]
fn sponsor_only_and_inputs_rejected_before_mutation() {
    let mut c = setup();
    for caller in ["owner.testnet", "alice.testnet"] {
        ctx(caller, 1_000, FAUCET_GAS_GRANT);
        rejects_without_mutation(&mut c, "alice.testnet", ip(1), "ERR_NOT_FAUCET");
    }
    for deposit in [1, FAUCET_GAS_GRANT - 1, FAUCET_GAS_GRANT + 1] {
        ctx("faucet.owner.testnet", 1_000, deposit);
        rejects_without_mutation(&mut c, "alice.testnet", ip(1), "ERR_FAUCET_DEPOSIT");
    }
    for hash in ["".to_string(), "a".repeat(63), "a".repeat(65), "G".repeat(64), "A".repeat(64)] {
        ctx("faucet.owner.testnet", 1_000, 0);
        rejects_without_mutation(&mut c, "alice.testnet", hash, "ERR_FAUCET_IP_HASH");
    }
}

#[test]
fn direct_and_sponsored_faucet_share_recipient_cooldown() {
    let mut c = setup();
    ctx("alice.testnet", 1_000, 0);
    c.faucet();
    ctx("faucet.owner.testnet", FAUCET_COOLDOWN_NS, 0);
    rejects_without_mutation(&mut c, "alice.testnet", ip(1), "ERR_FAUCET_COOLDOWN");
    sponsor(&mut c, "alice.testnet", FAUCET_COOLDOWN_NS + 1_000, 0, ip(1));
    ctx("alice.testnet", FAUCET_COOLDOWN_NS + 1_001, 0);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.faucet())).is_err());
    ctx("alice.testnet", 2 * FAUCET_COOLDOWN_NS + 1_000, 0);
    c.faucet();
    assert_eq!(c.ft_total_supply(), U128(3 * FAUCET_AMOUNT));
}

#[test]
fn ip_quota_is_sliding_serialized_and_bounded_at_exact_hour() {
    let mut c = setup();
    for index in 0..5_u64 {
        sponsor(&mut c, &format!("user{index}.testnet"), 1_000 + index * 1_000_000_000, 0, ip(1));
    }
    ctx("faucet.owner.testnet", 1_000 + FAUCET_COOLDOWN_NS - 1, 0);
    rejects_without_mutation(&mut c, "sixth.testnet", ip(1), "ERR_FAUCET_IP_LIMIT: retry in 1s");
    sponsor(&mut c, "sixth.testnet", 1_000 + FAUCET_COOLDOWN_NS, 0, ip(1));
    assert_eq!(c.ip_claims_ns.get(&ip(1)).unwrap().len(), 5);
    ctx("faucet.owner.testnet", 1_000 + FAUCET_COOLDOWN_NS, 0);
    rejects_without_mutation(&mut c, "seventh.testnet", ip(1), "ERR_FAUCET_IP_LIMIT");
    sponsor(&mut c, "seventh.testnet", 1_000 + FAUCET_COOLDOWN_NS + 1_000_000_000, 0, ip(1));
    sponsor(&mut c, "other-ip.testnet", 1_000 + FAUCET_COOLDOWN_NS, 0, ip(2));
    sponsor(&mut c, "fresh.testnet", 3 * FAUCET_COOLDOWN_NS, 0, ip(1));
    assert_eq!(c.ip_claims_ns.get(&ip(1)).unwrap(), &vec![3 * FAUCET_COOLDOWN_NS]);
}

#[test]
fn forty_grants_then_refusal_and_midnight_budget_reset() {
    let mut c = setup();
    for index in 0..40 {
        sponsor(&mut c, &format!("user{index}.testnet"), DAY_NS - 1, FAUCET_GAS_GRANT, ip(index));
    }
    assert_eq!(c.gas_spent, FAUCET_DAILY_GAS_LIMIT);
    ctx("faucet.owner.testnet", DAY_NS - 1, FAUCET_GAS_GRANT);
    rejects_without_mutation(&mut c, "fortyfirst.testnet", ip(40), "ERR_FAUCET_GAS_LIMIT");
    sponsor(&mut c, "no-gas.testnet", DAY_NS - 1, 0, ip(41));
    assert_eq!(c.gas_spent, FAUCET_DAILY_GAS_LIMIT);
    sponsor(&mut c, "fortyfirst.testnet", DAY_NS, FAUCET_GAS_GRANT, ip(40));
    assert_eq!(c.faucet_config().gas_day, 1);
    assert_eq!(c.faucet_config().gas_spent, U128(FAUCET_GAS_GRANT));
}

fn write_legacy_state() -> (u128, u64) {
    let mut c = setup();
    c.mint(acc("bob.testnet"), U128(42));
    ctx("alice.testnet", 5_000, 0);
    c.faucet();
    c.last_claim_ns.flush();
    let old = LegacyMockUsdc {
        owner_id: c.owner_id,
        token: c.token,
        last_claim_ns: c.last_claim_ns,
    };
    env::state_write(&old);
    (FAUCET_AMOUNT + 42, 5_000)
}

#[test]
fn migration_preserves_old_token_root_and_claim_handles() {
    let (supply, timestamp) = write_legacy_state();
    let old_bytes = env::storage_read(b"STATE").unwrap();
    ctx("usdc.testnet", 10_000, 0);
    let mut c = MockUsdc::migrate_faucet(acc("faucet.ketos.testnet"));
    assert_eq!(c.owner_id(), acc("owner.testnet"));
    assert_eq!(c.ft_total_supply(), U128(supply));
    assert_eq!(c.ft_balance_of(acc("bob.testnet")), U128(42));
    assert_eq!(c.ft_balance_of(acc("alice.testnet")), U128(FAUCET_AMOUNT));
    assert_eq!(c.last_claim_ns.get(&acc("alice.testnet")), Some(&timestamp));
    assert_eq!(c.faucet_available_at(acc("alice.testnet")), U64((timestamp + FAUCET_COOLDOWN_NS) / 1_000_000));
    assert!(c.storage_balance_of(acc("alice.testnet")).is_some());
    assert_eq!(c.faucet_config().faucet_id, acc("faucet.ketos.testnet"));
    let retained = LegacyMockUsdc {
        owner_id: c.owner_id.clone(),
        token: near_sdk::borsh::from_slice(&near_sdk::borsh::to_vec(&c.token).unwrap()).unwrap(),
        last_claim_ns: LookupMap::new(StorageKey::FaucetClaims),
    };
    assert_eq!(near_sdk::borsh::to_vec(&retained).unwrap(), old_bytes);
    ctx("faucet.ketos.testnet", 10_000, 0);
    rejects_without_mutation(&mut c, "alice.testnet", ip(1), "ERR_FAUCET_COOLDOWN");
}

#[test]
#[should_panic(expected = "ERR_PRIVATE")]
fn migration_rejects_owner_not_self() {
    write_legacy_state();
    ctx("owner.testnet", 10_000, 0);
    MockUsdc::migrate_faucet(acc("faucet.ketos.testnet"));
}

#[test]
#[should_panic(expected = "ERR_NOT_LEGACY_FAUCET_STATE")]
fn migration_cannot_redirect_faucet_again() {
    write_legacy_state();
    ctx("usdc.testnet", 10_000, 0);
    let c = MockUsdc::migrate_faucet(acc("faucet.ketos.testnet"));
    env::state_write(&c);
    MockUsdc::migrate_faucet(acc("attacker.testnet"));
}
