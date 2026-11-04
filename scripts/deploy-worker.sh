#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --manifest-path workers/ketos-prices/Cargo.toml --target wasm32-wasip2 --release --locked
pnpm exec tsx scripts/deploy-worker.ts
