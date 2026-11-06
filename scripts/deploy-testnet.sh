#!/usr/bin/env bash
# Builds the contracts and deploys (or updates) Ketos on NEAR testnet. Idempotent.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
if ! build_log="$(pnpm contracts:build 2>&1)"; then
  echo "$build_log" >&2
  exit 1
fi
exec pnpm exec tsx scripts/deploy-testnet.ts "$@"
