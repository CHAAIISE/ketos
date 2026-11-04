# Ketos — Perps on NEAR, sized by real liquidity

Ketos is a native perps exchange on NEAR testnet for Unstoppable DeFi. An LP vault takes the other side of every trade, and the size of each market (open interest per side, max leverage) is set by a contract rule from the exit liquidity measured on NEAR Intents, not by a listing committee. Margin, positions, liquidations and fees all live in one NEAR contract that has no admin method able to freeze or seize funds.

Live demo: **https://ketos-three.vercel.app** (NEAR testnet, test USDC from a faucet).

## The problem

NEAR has no active native perpetual futures market. The perpetuals on near.com are a front end on Hyperliquid: positions, prices, liquidations and fees settle there. Vault-backed exchanges elsewhere have a known failure mode: the vault holds positions larger than the market can unwind.

- Hyperliquid HLP and JELLY, March 2025: a thin market squeezed the HLP vault in a dispute of about $13M ([CoinDesk](https://www.coindesk.com/markets/2025/03/26/hyperliquid-delists-jellyjelly-after-vault-squeezed-in-usd13m-tussle)).
- GMX and AVAX, September 2022: around $565,000 lost to GLP holders through a market larger than its real liquidity ([Cointelegraph](https://cointelegraph.com/news/decentralized-exchange-gmx-suffers-565k-price-manipulation-exploit)).

How much can actually be sold for USDC on NEAR? Measured on 2026-11-04 at 11:01 UTC with 1Click `dry` quotes on mainnet (`pnpm depth:sample`), net price impact after the 1Click fee:

| Asset | $1k | $10k | $50k | $100k | $250k | $500k | $1M |
|---|---|---|---|---|---|---|---|
| BTC | 12 bps | 16 bps | 18 bps | 12 bps | No liquidity | No liquidity | No liquidity |
| ETH | 3 bps | 4 bps | 8 bps | 8 bps | No liquidity | No liquidity | No liquidity |
| NEAR | 9 bps | 13 bps | 20 bps | 23 bps | No liquidity | No liquidity | No liquidity |
| ZEC | 2 bps | 14 bps | 24 bps | 32 bps | No liquidity | No liquidity | No liquidity |

Above $100k, no solver quotes the trade at all. A market that lets traders open $1M of BTC exposure against a vault on NEAR is offering a position nobody can exit. Ketos reads this table every minute and writes it onchain, and the contract refuses anything bigger.

## Demo

- App: https://ketos-three.vercel.app — `/trade`, `/vault`, `/liquidity`, all reading the testnet contracts live.
- Full journey, replayed on a local chain: `pnpm --dir web exec playwright test` runs the nine steps below on a seeded NEAR sandbox with a test wallet, including a mock price drop and a keeper liquidation.

### Try it (NEAR testnet)

1. Open https://ketos-three.vercel.app - see live exit capacity for BTC, ETH, NEAR and ZEC, with the time of the last measurement.
2. Click **Launch app**, then **Connect** in the top bar and pick a NEAR testnet wallet - see the 4-step onboarding row: Connect wallet, Fund wallet, Deposit margin, Open a position.
3. Click **Fund** in the top bar - 1,000 test USDC land in the wallet (faucet, once per hour; the button then shows when it opens again).
4. Click **Enable trading** in the order panel and deposit 200 as margin - see Available to Trade update.
5. Pick NEAR-USD in the market selector, Buy / Long, size 500 USDC at 5× - see Max OI (set by live exit liquidity) in the market bar, the Exit Liquidity ladder with its 100 bps cap line, then the position with PnL, liquidation price and fees.
6. Pick ZEC-USD, Sell / Short, a size above the cap - the contract refuses the order and the app shows "Exceeds live exit liquidity … (cap $X)"; **Use max size** fits the order under the cap.
7. Open **Vaults** and deposit 500 - see shares minted at the share price, TVL, fee APR, and the vault's net exposure per market next to each market's capacity.
8. Open **Liquidity** - see the impact curve per asset (size against bps, 100 bps line, capacity marked) and the last 48 onchain samples.
9. Back on **Trade**, close the position - see realized PnL return to margin; then open the account menu in the top bar and **Withdraw** margin to the wallet.

The page calls the keeper endpoint at most once a minute while it is open, so depth and prices stay fresh and unhealthy positions get liquidated; liquidations show up as "Liquidated by keeper" in the **Liquidations** tab.

## How it works

```mermaid
flowchart LR
  Q["NEAR Intents 1Click<br/>dry quotes, mainnet"] --> K["Keeper<br/>function-call key"]
  O["OutLayer<br/>price-oracle.testnet"] -->|oracle_on_call| C
  K -->|set_depth · refresh_prices · liquidate| C["Ketos contract<br/>margin · positions · vault · depth"]
  T["Traders"] -->|ft_transfer_call tUSDC| C
  L["LP vault depositors"] -->|ft_transfer_call tUSDC| C
```

1. **Measure.** The keeper asks 1Click for `dry` quotes selling each asset for USDC on NEAR at $1k, $10k, $50k, $100k, $250k, $500k and $1M ([`web/lib/intents/oneclick.ts`](web/lib/intents/oneclick.ts)). Each quote becomes a net impact in bps, `max(0, ⌈(1 − out/in) × 10000⌉ − fee)`, or "No liquidity" when no solver answers ([`web/lib/intents/depth.ts`](web/lib/intents/depth.ts)).
2. **Cap.** `set_depth` stores the samples onchain (48-sample history per asset). The contract then derives, per market:
   - exit capacity = largest sampled size with impact ≤ 100 bps;
   - max open interest per side = `min(hard cap $500,000, exit capacity)`;
   - max leverage: 20× from $1M of capacity, 10× from $250k, 5× from $50k, 2× below;
   - market closed to new positions when capacity is under $10k or the measurement is older than 30 minutes.

   `open_position` panics with `ERR_EXCEEDS_EXIT_LIQUIDITY: cap <amount>` when a trade would push open interest past the cap.
3. **Trade.** Isolated margin in a NEP-141 test USDC. Entry and mark prices come from the OutLayer price oracle (refused if older than 120 s). 0.1% fee to open and to close, plus an hourly borrow fee of 0.001% + 0.009% × utilization of the cap. Maintenance margin = notional / (2 × market max leverage).
4. **Liquidate.** `liquidate` is permissionless. Below maintenance, the position closes at the oracle price; 1% of notional goes to the vault and 0.2% to the liquidator (capped at remaining equity), the rest back to the trader. Negative equity is absorbed by the vault.
5. **Vault.** LPs deposit tUSDC for shares at NAV. NAV = vault USDC − traders' unrealized PnL + borrow fees due. Withdrawals are limited to what is not reserved for the maximum payout of open positions.

### Market registry

Fresh contract deployments initialize BTC, ETH, NEAR, ZEC, SOL, AURORA and RHEA. Each entry stores its oracle asset id, Intents asset id, price source (`tee` or `signed`), vault assignment, hard cap, trading fee and leverage ceiling ([`market.rs`](contracts/ketos/src/market.rs)). `id` is the market symbol. Duplicate symbols or assets cannot replace an existing market.

`get_markets({ "from_index": 0, "limit": 100 })` returns markets in listing order (default 50, maximum 100 per page). The client reads every page. A new market has no exit capacity and cannot accept positions until measured; its leverage is the lower of its configured ceiling and the live liquidity tier. Oracle callbacks match asset ids rather than ticker order and update only TEE-priced entries.

The deployed demo still uses the four-market contract listed below. The new registry changes the serialized state: deploy it to a **fresh contract account**, not over that existing account. Core / Long-tail assignments are registry metadata; settlement currently uses the single LP vault.

### Funding on fresh deployments

[`funding.rs`](contracts/ketos/src/funding.rs) adds hourly funding based on open interest:

`rate = 0.05% × (long OI − short OI) / max(total OI, 1)`.

Positive rates charge longs and credit shorts; negative rates reverse the direction. Both sides use the same notional rate, capped at ±0.05%/hour. The unmatched amount accrues to the vault. For example, $300 long and $100 short at unchanged OI produce a +0.025%/hour rate: over 10 hours the long pays $0.75, the short receives $0.25, and the vault earns $0.50 before rounding.

Separate cumulative debit and credit indexes preserve past payments when the imbalance changes direction. Opening, closing and liquidating checkpoint the old OI before changing it; new positions never inherit prior funding. Anyone can call `settle_funding({ "market_id": "NEAR" })`, even with stale prices or depth. This checkpoints indexes, not every account: funding already affects equity and is transferred into free margin at close or liquidation. Repeated checkpoints preserve fractional index growth and do not change borrow accrual.

- `get_market` returns `funding_rate_per_hour` as a signed integer string at 1e12 scale (`"250000000"` = +0.025%/hour).
- `get_position` returns accrued `funding_paid`, `funding_received` and signed `funding_payment` in USDC units; positive payment reduces equity. These amounts also affect liquidation prices.
- `get_vault` includes `funding_net_due` in NAV and reserves gross funding credits in addition to maximum price gains. Funding losses from insolvent positions are borne by the vault, like price losses. The fee APR still covers trading fees, borrow fees and liquidation penalties, not funding.
- `funding_accrued` events report public checkpoints; `funding_settled` events and close/liquidation records report the assessed position debits and credits included in settlement.

The deployed four-market demo does **not** have funding yet. The new fields change serialized state and require the same fresh-account deployment described above; the live keeper and funding UI have not been cut over.

### Triggered orders on fresh deployments

[`orders.rs`](contracts/ketos/src/orders.rs) stores Limit and Stop Market entries, plus full-position Take Profit and Stop Loss exits. `place_order({ "request": ... })` uses a `kind` tag: `limit`, `stop_market`, `take_profit` or `stop_loss`. Entry requests contain `market_id`, `side`, `margin`, `leverage`, `trigger_price` and optional `brackets`; exit requests contain `position_id` and `trigger_price`. USDC amounts and 8-decimal prices are integer strings.

- A long limit triggers at or below its price; a short limit at or above. Stop Market entries reverse those conditions. Long TP / short SL trigger at or above; short TP / long SL at or below. Equality counts.
- Entry collateral moves from free `margin` to `reserved_margin` immediately, so it cannot be spent or withdrawn twice. Placement does not consume open interest or charge fees. Owner-only `cancel_order({ "order_id": 0 })` releases the full reservation.
- Anyone can call `execute_orders({ "ids": [0, 1] })`. Execution uses the **current oracle price**, not a guaranteed limit or stop price. Missing ids, duplicate ids after a fill, untriggered orders and prices older than 120 s are skipped. Triggered entries recheck live depth, remaining OI, leverage and bracket validity; rejection releases all reserved collateral without charging an opening fee. Each result is `filled`, `rejected` (with reason), or `skipped`.
- `open_position` and entry orders accept optional `brackets: { "take_profit": "...", "stop_loss": "..." }`. Targets must be on the appropriate side of the entry price. Pending entries create exits only after filling; a price gap past an attached target rejects the entry. Each position allows one TP and one SL. Closing or liquidating a position cancels both; executing either exit cancels its sibling.
- `get_orders({ "account_id": "..." })` returns active orders; `get_open_orders({ "from_index": 0, "limit": 100 })` supports executor discovery. Accounts hold at most 50 active orders, execution batches at most 50 ids. Order placement, cancellation, fill and rejection emit onchain events.

These methods require a fresh contract account. The deployed demo, order controls and existing keeper have not been switched to this contract yet.

All math is integer (USDC 6 decimals, prices 8 decimals) and rounds in the vault's favour. The contract code is in [the contract crate](contracts/ketos/src/) (`position.rs`, `funding.rs`, `depth.rs`, `liquidation.rs`, `vault.rs`, `oracle.rs`).

The keeper signs with a function-call key limited to `refresh_prices`, `set_depth` and `liquidate` ([`scripts/deploy-testnet.ts`](scripts/deploy-testnet.ts), [`web/lib/keeper/`](web/lib/keeper/)); it cannot move funds. The integration tests check that the key is refused on any other method.

## Why it matters

The vault is the counterparty, so its worst case is an exposure it cannot hedge or unwind. Here that worst case is bounded by a number anyone can re-measure: each market can hold at most what 1Click solvers can sell within 1% right now, and it shrinks on its own when liquidity leaves. For LPs on NEAR, that is a fee yield whose risk comes with a published, dated limit. For traders, the funds sit in a contract they can always withdraw from: no custodian, no admin key over positions, and every listing parameter is derived from data, not voted. That is what Unstoppable DeFi means here: no committee decides which market is safe, and no key can stop a withdrawal.

The trading fees, borrow fees and liquidation penalties stay on NEAR, with the LPs who carry the risk.

## What's new

- Listing and sizing as a pure function of measured exit liquidity: open interest and leverage caps recomputed onchain from 1Click quotes, with the history kept in the contract and shown on `/liquidity`.
- Refusal at the contract level, not in the UI: the order ticket only warns, so the onchain refusal and its cap are visible.
- A keeper that is safe to hand out: one function-call key, three methods, throttled HTTP endpoint on the deployment.

## Built with

- **NEAR Intents 1Click API** — `dry` quotes on mainnet, read-only, server-side, as the liquidity measurement: [`web/lib/intents/oneclick.ts`](web/lib/intents/oneclick.ts), [`scripts/depth-sample.ts`](scripts/depth-sample.ts).
- **OutLayer price oracle** (`price-oracle.testnet`, a TEE oracle) — `oracle_call` / `oracle_on_call` for BTC, ETH, NEAR and ZEC prices: [`oracle.rs`](contracts/ketos/src/oracle.rs).
- **near-sdk 5.29** and `near-contract-standards` — the trading contract and the NEP-141 test USDC with a faucet: [`contracts/mock-usdc/src/lib.rs`](contracts/mock-usdc/src/lib.rs).
- **@hot-labs/near-connect** — wallet connection and transaction signing in the app: [`web/lib/near/wallet.ts`](web/lib/near/wallet.ts).
- **Coinbase Exchange public candles** (no key, proxied and cached 30 s server-side) and **TradingView Lightweight Charts** (Apache-2.0) — the spot price chart and 24h change on `/trade`: [`web/app/api/candles/route.ts`](web/app/api/candles/route.ts), [`web/components/trade/price-chart.tsx`](web/components/trade/price-chart.tsx).
- near-workspaces (integration tests on a sandbox), Next.js 16, TanStack Query, Tailwind v4, Playwright.

### Testnet contracts

| Contract | Account |
|---|---|
| Trading, margin, vault | [view on NearBlocks](https://testnet.nearblocks.io/address/perps.ketos-dev.testnet) |
| Test USDC (tUSDC, NEP-141) | [usdc.ketos-dev.testnet](https://testnet.nearblocks.io/address/usdc.ketos-dev.testnet) |
| Price oracle (OutLayer) | [price-oracle.testnet](https://testnet.nearblocks.io/address/price-oracle.testnet) |

Ids are also in [`deployments/testnet.json`](deployments/testnet.json), under the `ketos`, `usdc`, `oracle` and `keeper` keys. They still identify the deployed four-market version. The deployment script now targets `ketos.testnet`, `usdc.ketos.testnet` and `keeper.ketos.testnet`, using `KETOS_PRIVATE_KEY`; it does not upgrade the old accounts. The `owner` field retains the funding account used with `NEAR_PRIVATE_KEY`.

## Run locally

Requirements: Node 20.9+, pnpm, Rust stable ≥ 1.95 with `wasm32-unknown-unknown`, `cargo-near` 0.22.

```bash
pnpm install
pnpm contracts:build            # builds the three wasm into contracts/res/
pnpm contracts:test             # unit tests + near-workspaces integration tests
pnpm --dir web exec playwright install chromium
pnpm --dir web exec playwright test   # local sandbox + app in test-wallet mode, full journey
```

The contract crate is `ketos` (`cargo test -p ketos` from `contracts/`), producing `contracts/res/ketos.wasm`. The web package is `ketos-web`; its typed RPC client is `KetosViews`, with `use-ketos-queries` and `use-ketos-mutations` hooks. Configure its contract address with `NEXT_PUBLIC_KETOS_CONTRACT` in `web/.env.local`.

Against testnet:

```bash
cp .env.example .env.local      # KETOS_PRIVATE_KEY for ketos.testnet; optional ONECLICK_JWT
bash scripts/deploy-testnet.sh  # idempotent: ketos.testnet, token/keeper subaccounts, vault seed
pnpm depth:sample               # print today's exit-liquidity table and save it as JSON
pnpm keeper --once              # one keeper tick: depth, prices, liquidations
pnpm --dir web dev
```

## Limitations

- Testnet only. Margin is a test USDC (tUSDC) minted by a faucet, not real USDC.
- No cross-chain deposits or settlement: everything settles in one NEAR contract. NEAR Intents is used only to measure liquidity.
- Liquidity is measured on mainnet 1Click quotes while trading runs on testnet, so caps reflect real markets but trades do not touch them.
- The local sandbox and the end-to-end tests use a mock oracle with the same interface as the OutLayer one; prices there are set by the test.
- The deployed demo and keeper measure four markets (BTC, ETH, NEAR, ZEC); fresh local deployments list seven, with SOL, AURORA and RHEA closed until measured. Capacity uses a fixed size grid ($100k in the recorded sample means "fine at $100k, no quote at $250k"), not interpolation.
- The keeper runs from the app's tick endpoint or `pnpm keeper`; with nobody online, depth goes stale and markets close to new positions after 30 minutes. Closing an existing position needs an oracle price under 120 s old, and `refresh_prices` is open to any account.
