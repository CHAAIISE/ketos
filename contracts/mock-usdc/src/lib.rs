use near_sdk::near;

#[near(contract_state)]
#[derive(Default)]
pub struct MockUsdc {}

#[near]
impl MockUsdc {
    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}
