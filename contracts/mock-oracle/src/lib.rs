use near_sdk::near;

#[near(contract_state)]
#[derive(Default)]
pub struct MockOracle {}

#[near]
impl MockOracle {
    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}
