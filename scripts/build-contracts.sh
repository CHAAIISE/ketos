#!/usr/bin/env bash
# Builds every contract crate to wasm and collects the artifacts in contracts/res/.
set -euo pipefail
cd "$(dirname "$0")/../contracts"

# cargo-near loads (and may migrate) the near-cli config under $HOME; build with a
# throwaway home so the result never depends on the local CLI setup.
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
build_home="$(mktemp -d)"
trap 'rm -rf "$build_home"' EXIT

mkdir -p res
for crate in perps mock-usdc mock-oracle; do
  (cd "$crate" && HOME="$build_home" cargo near build non-reproducible-wasm --no-abi)
  name="${crate//-/_}"
  cp "target/near/$name/$name.wasm" "res/$name.wasm"
done
ls -1 res/*.wasm
