use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::receiver::ext_ft_receiver;
use near_contract_standards::fungible_token::resolver::{
    ext_ft_resolver, FungibleTokenResolver,
};
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken,
    PanicOnDefault, Promise, PromiseOrValue,
};

pub const FAUCET_AMOUNT: u128 = 1_000_000_000;
pub const FAUCET_COOLDOWN_NS: u64 = 3_600 * 1_000_000_000;

const GAS_FOR_TRANSFER_FUNDING: Gas = Gas::from_tgas(10);
const GAS_FOR_FUNDED_CALLBACK: Gas = Gas::from_tgas(15);
const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(5);


const ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%232775CA'/%3E%3Ctext x='16' y='22' font-size='16' text-anchor='middle' fill='white' font-family='sans-serif'%3E$%3C/text%3E%3C/svg%3E";

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Accounts,
    FaucetClaims,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockUsdc {
    owner_id: AccountId,
    token: FungibleToken,
    last_claim_ns: LookupMap<AccountId, u64>,
}

#[near]
impl MockUsdc {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            token: FungibleToken::new(StorageKey::Accounts),
            last_claim_ns: LookupMap::new(StorageKey::FaucetClaims),
        }
    }

    pub fn faucet(&mut self) -> U128 {
        let account_id = env::predecessor_account_id();
        let now = env::block_timestamp();
        if let Some(last) = self.last_claim_ns.get(&account_id) {
            let next = last.saturating_add(FAUCET_COOLDOWN_NS);
            if now < next {
                let wait_s = (next - now).div_ceil(1_000_000_000);
                env::panic_str(&format!("ERR_FAUCET_COOLDOWN: retry in {wait_s}s"));
            }
        }
        self.last_claim_ns.insert(account_id.clone(), now);
        self.internal_mint(&account_id, FAUCET_AMOUNT, "faucet");
        U128(FAUCET_AMOUNT)
    }

    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(env::predecessor_account_id() == self.owner_id, "ERR_NOT_OWNER");
        self.internal_mint(&account_id, amount.0, "mint");
    }

    pub fn faucet_available_at(&self, account_id: AccountId) -> U64 {
        let now = env::block_timestamp();
        match self.last_claim_ns.get(&account_id) {
            Some(last) if last.saturating_add(FAUCET_COOLDOWN_NS) > now => {
                U64((last + FAUCET_COOLDOWN_NS) / 1_000_000)
            }
            _ => U64(0),
        }
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    #[private]
    pub fn on_transfer_funded(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
        msg: String,
        price_deposit: U128,
    ) -> PromiseOrValue<U128> {
        // Only inspect status: a successful funding call need not return JSON.
        if !near_sdk::is_promise_success() {
            Promise::new(sender_id.clone())
                .transfer(NearToken::from_yoctonear(price_deposit.0)).detach();
            return PromiseOrValue::Value(amount);
        }

        ext_ft_receiver::ext(receiver_id)
            .with_unused_gas_weight(1)
            .ft_on_transfer(sender_id, amount, msg)
            .into()
    }
}

impl MockUsdc {
    // Storage for auto-registered accounts is paid from the contract balance:
    // this is a testnet token, frictionless onboarding matters more than cost.
    fn internal_mint(&mut self, account_id: &AccountId, amount: u128, memo: &str) {
        if !self.token.accounts.contains_key(account_id) {
            self.token.internal_register_account(account_id);
        }
        self.token.internal_deposit(account_id, amount);
        FtMint {
            owner_id: account_id,
            amount: U128(amount),
            memo: Some(memo),
        }
        .emit();
    }
}

#[near]
impl FungibleTokenCore for MockUsdc {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let attached = env::attached_deposit().as_yoctonear();
        if attached <= 1 {
            return self.token.ft_transfer_call(receiver_id, amount, memo, msg);
        }

        let sender_id = env::predecessor_account_id();
        let price_deposit = attached - 1;
        self.token
            .internal_transfer(&sender_id, &receiver_id, amount.0, memo);
        Promise::new(receiver_id.clone())
            .function_call_weight(
                "fund_transfer_price_requests",
                near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({ "account_id": sender_id })).unwrap(),
                NearToken::from_yoctonear(price_deposit),
                GAS_FOR_TRANSFER_FUNDING,
                GasWeight(0),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_FUNDED_CALLBACK)
                    // Preserve the remaining budget for ft_on_transfer and its oracle chain.
                    .with_unused_gas_weight(1)
                    .on_transfer_funded(
                        sender_id.clone(),
                        receiver_id.clone(),
                        amount,
                        msg,
                        U128(price_deposit),
                    ),
            )
            .then(
                ext_ft_resolver::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                    .with_unused_gas_weight(0)
                    .ft_resolve_transfer(sender_id, receiver_id, amount),
            )
            .into()
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for MockUsdc {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used_amount, burned_amount) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned_amount > 0 {
            log!("Account @{} burned {}", sender_id, burned_amount);
        }
        used_amount.into()
    }
}

#[near]
impl StorageManagement for MockUsdc {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        if let Some((account_id, balance)) = self.token.internal_storage_unregister(force) {
            log!("Closed @{} with {}", account_id, balance);
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for MockUsdc {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Test USDC".to_string(),
            symbol: "tUSDC".to_string(),
            icon: Some(ICON.to_string()),
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult};

    const HOUR_NS: u64 = 3_600 * 1_000_000_000;

    fn acc(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn ctx(predecessor: &str, ts: u64, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("usdc.testnet"))
            .predecessor_account_id(acc(predecessor))
            .block_timestamp(ts)
            .signer_account_id(acc(predecessor))
            .prepaid_gas(Gas::from_tgas(300))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build());
    }

    fn setup() -> MockUsdc {
        ctx("owner.testnet", 1_000, 0);
        MockUsdc::new(acc("owner.testnet"))
    }

    fn transfer_setup() -> MockUsdc {
        let mut contract = setup();
        ctx("alice.testnet", 1_000, 0);
        contract.faucet();
        contract.mint_for_test_registration("ketos.testnet");
        contract
    }

    fn callback_ctx(result: PromiseResult) {
        let context = VMContextBuilder::new()
            .current_account_id(acc("usdc.testnet"))
            .predecessor_account_id(acc("usdc.testnet"))
            .signer_account_id(acc("relayer.testnet"))
            .block_timestamp(1_000)
            .attached_deposit(NearToken::from_yoctonear(0))
            .prepaid_gas(Gas::from_tgas(280))
            .build();
        testing_env!(
            context,
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
    }


    fn funded_transfer(contract: &mut MockUsdc, price_deposit: u128) {
        ctx("alice.testnet", 1_000, price_deposit + 1);
        drop(contract.ft_transfer_call(
            acc("ketos.testnet"),
            U128(100_000_000),
            Some("wallet open".to_string()),
            "open".to_string(),
        ));
    }

    fn funded_callback(contract: &mut MockUsdc, price_deposit: u128) -> PromiseOrValue<U128> {
        contract.on_transfer_funded(
            acc("alice.testnet"),
            acc("ketos.testnet"),
            U128(100_000_000),
            "open".to_string(),
            U128(price_deposit),
        )
    }

    #[test]
    fn faucet_credits_and_registers() {
        let mut c = setup();
        ctx("alice.testnet", 1_000, 0);
        assert!(c.storage_balance_of(acc("alice.testnet")).is_none());
        c.faucet();
        assert_eq!(c.ft_balance_of(acc("alice.testnet")).0, 1_000_000_000);
        assert!(c.storage_balance_of(acc("alice.testnet")).is_some());
        assert_eq!(c.ft_total_supply().0, 1_000_000_000);
        assert_eq!(
            c.faucet_available_at(acc("alice.testnet")).0,
            (1_000 + HOUR_NS) / 1_000_000
        );
        assert_eq!(c.faucet_available_at(acc("bob.testnet")).0, 0);
    }

    #[test]
    #[should_panic(expected = "ERR_FAUCET_COOLDOWN: retry in")]
    fn faucet_cooldown() {
        let mut c = setup();
        ctx("alice.testnet", 1_000, 0);
        c.faucet();
        ctx("alice.testnet", 1_000 + HOUR_NS / 2, 0);
        c.faucet();
    }

    #[test]
    fn faucet_after_hour() {
        let mut c = setup();
        ctx("alice.testnet", 1_000, 0);
        c.faucet();
        ctx("alice.testnet", 1_000 + HOUR_NS + 1, 0);
        c.faucet();
        assert_eq!(c.ft_balance_of(acc("alice.testnet")).0, 2_000_000_000);
        assert_eq!(c.faucet_available_at(acc("alice.testnet")).0 > 0, true);
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_OWNER")]
    fn mint_non_owner() {
        let mut c = setup();
        ctx("alice.testnet", 1_000, 0);
        c.mint(acc("alice.testnet"), U128(1));
    }

    #[test]
    fn mint_owner_registers() {
        let mut c = setup();
        c.mint(acc("bob.testnet"), U128(42));
        assert_eq!(c.ft_balance_of(acc("bob.testnet")).0, 42);
    }

    #[test]
    fn ft_transfer_between_accounts() {
        let mut c = setup();
        ctx("alice.testnet", 1_000, 0);
        c.faucet();
        ctx("bob.testnet", 1_000, 0);
        c.faucet();
        ctx("alice.testnet", 1_000, 1);
        c.ft_transfer(acc("bob.testnet"), U128(250_000_000), None);
        assert_eq!(c.ft_balance_of(acc("alice.testnet")).0, 750_000_000);
        assert_eq!(c.ft_balance_of(acc("bob.testnet")).0, 1_250_000_000);
    }

    #[test]
    fn ft_transfer_call_exact_yocto_resolves_unused_balance() {
        let mut c = transfer_setup();
        ctx("alice.testnet", 1_000, 1);
        drop(c.ft_transfer_call(
            acc("ketos.testnet"),
            U128(100_000_000),
            None,
            "deposit".to_string(),
        ));
        assert_eq!(c.ft_balance_of(acc("alice.testnet")).0, 900_000_000);
        assert_eq!(c.ft_balance_of(acc("ketos.testnet")).0, 100_000_000);


        callback_ctx(PromiseResult::Successful(b"\"25000000\"".to_vec()));
        assert_eq!(
            c.ft_resolve_transfer(
                acc("alice.testnet"),
                acc("ketos.testnet"),
                U128(100_000_000),
            ),
            U128(75_000_000)
        );
        assert_eq!(c.ft_balance_of(acc("alice.testnet")).0, 925_000_000);
        assert_eq!(c.ft_balance_of(acc("ketos.testnet")).0, 75_000_000);
        assert_eq!(c.ft_total_supply(), U128(FAUCET_AMOUNT));
        assert!(get_created_receipts().is_empty());
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn ft_transfer_call_zero_deposit_refused() {
        let mut c = transfer_setup();
        ctx("alice.testnet", 1_000, 0);
        drop(c.ft_transfer_call(
            acc("ketos.testnet"),
            U128(100_000_000),
            None,
            "open".to_string(),
        ));
    }


    #[test]
    fn rejected_funding_refunds_tokens_and_near_to_sender_without_receiver_call() {
        let mut c = transfer_setup();
        let price_deposit = 10_000_000_000_000_000_000_000;
        funded_transfer(&mut c, price_deposit);
        callback_ctx(PromiseResult::Failed);
        let PromiseOrValue::Value(unused) = funded_callback(&mut c, price_deposit) else {
            panic!("failed funding must return unused tokens");
        };
        assert_eq!(unused, U128(100_000_000));
        let refunds = get_created_receipts();
        callback_ctx(PromiseResult::Successful(near_sdk::serde_json::to_vec(&unused).unwrap()));
        assert_eq!(c.ft_resolve_transfer(acc("alice.testnet"), acc("ketos.testnet"), U128(100_000_000)), U128(0));
        assert_eq!(c.ft_balance_of(acc("alice.testnet")), U128(FAUCET_AMOUNT));
        assert_eq!(c.ft_balance_of(acc("ketos.testnet")), U128(0));
        assert_eq!(c.ft_total_supply(), U128(FAUCET_AMOUNT));

        let receipts = refunds;
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receiver_id, acc("alice.testnet"));
        assert_eq!(receipts[0].actions.len(), 1);
        assert!(matches!(
            receipts[0].actions[0],
            MockAction::Transfer { deposit, .. }
                if deposit.as_yoctonear() == price_deposit
        ));
    }

    #[test]
    fn successful_funding_resolves_receiver_unused_tokens_without_near_refund() {
        let mut c = transfer_setup();
        let price_deposit = 10_000_000_000_000_000_000_000;
        funded_transfer(&mut c, price_deposit);
        // Funding success is a promise status, not a particular JSON return value.
        callback_ctx(PromiseResult::Successful(b"credited".to_vec()));
        drop(funded_callback(&mut c, price_deposit));
        assert_eq!(c.ft_balance_of(acc("alice.testnet")), U128(900_000_000));
        assert_eq!(c.ft_balance_of(acc("ketos.testnet")), U128(100_000_000));

        callback_ctx(PromiseResult::Successful(b"\"40000000\"".to_vec()));
        assert_eq!(
            c.ft_resolve_transfer(
                acc("alice.testnet"),
                acc("ketos.testnet"),
                U128(100_000_000),
            ),
            U128(60_000_000)
        );
        assert_eq!(c.ft_balance_of(acc("alice.testnet")), U128(940_000_000));
        assert_eq!(c.ft_balance_of(acc("ketos.testnet")), U128(60_000_000));
        assert_eq!(c.ft_total_supply(), U128(FAUCET_AMOUNT));
        assert!(get_created_receipts().is_empty());
    }

    #[test]
    fn receiver_failure_after_funding_refunds_only_usdc_not_token_owned_near() {
        let mut c = transfer_setup();
        let price_deposit = 10_000_000_000_000_000_000_000;
        funded_transfer(&mut c, price_deposit);
        callback_ctx(PromiseResult::Successful(Vec::new()));
        drop(funded_callback(&mut c, price_deposit));

        callback_ctx(PromiseResult::Failed);
        assert_eq!(
            c.ft_resolve_transfer(
                acc("alice.testnet"),
                acc("ketos.testnet"),
                U128(100_000_000),
            ),
            U128(0)
        );
        assert_eq!(c.ft_balance_of(acc("alice.testnet")), U128(FAUCET_AMOUNT));
        assert_eq!(c.ft_balance_of(acc("ketos.testnet")), U128(0));
        assert_eq!(c.ft_total_supply(), U128(FAUCET_AMOUNT));
        assert!(get_created_receipts().is_empty());
    }

    impl MockUsdc {
        fn mint_for_test_registration(&mut self, account: &str) {
            self.token.internal_register_account(&acc(account));
        }
    }
}
