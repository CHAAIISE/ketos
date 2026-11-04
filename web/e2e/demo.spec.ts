import { expect, test, type Locator, type Page } from "@playwright/test";
import { fundTraderMargin, getMarket, mintTraderUsdc, sandboxViews, setOraclePrice, traderAccountId } from "./sandbox";

// The demo journey on the local sandbox, as a first-time visitor walks it: every screen offers
// exactly one main action. Prices move through the mock oracle; triggered orders, listings and
// liquidations are handled by the keeper the open app pages call once a minute.

test.use({ viewport: { width: 1440, height: 900 } });

const USDC = 1_000_000n;
// A keeper pass runs at most once a minute and samples 1Click for up to twelve markets.
const KEEPER_WAIT = 180_000;

async function expectSinglePrimary(page: Page, label: RegExp): Promise<void> {
  const primary = page.locator("[data-primary]:visible");
  await expect(primary).toHaveCount(1);
  await expect(primary).toHaveText(label);
}

async function expectToast(page: Page, text: RegExp): Promise<void> {
  await expect(page.getByTestId("tx-toast").filter({ hasText: text })).toBeVisible({ timeout: 60_000 });
}

function parseUsd(text: string): number {
  return Number(text.replace(/[^0-9.]/g, ""));
}

async function openApp(page: Page, name: "Trade" | "Markets" | "Vaults" | "Risk" | "Portfolio" | "Leaderboard"): Promise<void> {
  await page.getByRole("navigation", { name: "App" }).getByRole("link", { name, exact: true }).click();
}

async function selectMarket(page: Page, id: string): Promise<void> {
  await page.getByTestId("market-selector").click();
  await page.getByTestId(`market-tab-${id}`).click();
  await expect(page.getByTestId("market-selector")).toContainText(`${id}-USD`);
}

async function setLeverage(page: Page, leverage: number): Promise<void> {
  await page.getByRole("button", { name: /^Leverage \d+×, adjust$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Adjust Leverage" });
  await dialog.locator("#order-leverage").fill(String(leverage));
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("leverage-value")).toHaveText(`${leverage}×`);
}

/** Fills the ticket for a market order; brackets are set only when given. */
async function fillMarketOrder(
  page: Page,
  ticket: Locator,
  order: { side: "long" | "short"; leverage: number; size: number; takeProfit?: number; stopLoss?: number },
): Promise<void> {
  await ticket.getByTestId("order-type-market").click();
  await ticket.getByTestId(`side-${order.side}`).click();
  await setLeverage(page, order.leverage);
  await ticket.locator('input[name="order-size"]').fill(String(order.size));
  const brackets = order.takeProfit !== undefined || order.stopLoss !== undefined;
  await ticket.getByTestId("tpsl-toggle").setChecked(brackets);
  if (order.takeProfit !== undefined) await ticket.getByLabel("TP Price").fill(String(order.takeProfit));
  if (order.stopLoss !== undefined) await ticket.getByLabel("SL Price").fill(String(order.stopLoss));
}

test("demo journey: fund, trade under live caps, list, LP, stress, keeper exits", async ({ page }) => {
  // Four scenes wait for a keeper pass (SOL measured, limit fill, listing, stop loss + liquidation).
  test.setTimeout(1_200_000);
  const trader = traderAccountId();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const steps = page.getByTestId("onboarding-steps");
  const currentStep = steps.locator('[aria-current="step"]');
  const ticket = page.getByRole("region", { name: "Open a position" });
  const positions = page.locator('[data-testid^="position-"]:visible');
  const openOrders = page.locator('[data-testid^="open-order-"]:visible');
  const accountPanel = page.locator("#account-panel");

  await test.step("1. landing: live liquidity across the registry, live stats, one way into the app", async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("sized by real liquidity");
    await expect(page.getByLabel("Measured exit liquidity on NEAR Intents")).toBeVisible();
    await expect(page.getByText(/measured \d{2}:\d{2}/).first()).toBeVisible();
    await expect(page.getByText("Markets open", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Open interest", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Vault TVL", { exact: false }).first()).toBeVisible();
    await expect(page.getByTestId("landing-volume-24h")).toBeVisible();
    await expectSinglePrimary(page, /Launch app/);
  });

  await test.step("2. trade: connect, fund 1,000 USDC, deposit 500 USDC of margin", async () => {
    await page.locator("[data-primary]").click();
    await expect(page).toHaveURL(/\/trade$/);
    await expect(steps).toBeVisible();
    await expect(currentStep).toContainText(/Connect wallet/);
    await expectSinglePrimary(page, /^Connect$/);

    await page.getByTestId("connect-button").click();
    const walletMenu = page.getByRole("dialog", { name: "Connect a wallet" });
    await expect(walletMenu).toBeVisible();
    await walletMenu.getByTestId("wallet-option-e2e").click();
    await expect(page.getByTestId("wallet-account")).toBeVisible();

    await expect(currentStep).toContainText(/Fund wallet/);
    // The ticket's main action follows the guide: claim USDC before anything else.
    await expectSinglePrimary(page, /^Get 1,000 USDC$/);
    await page.getByTestId("fund-button").click();
    await expectToast(page, /1,000 USDC added to your wallet/);
    await expect(page.getByTestId("fund-button")).toHaveText(/Fund in \d+ min/);

    await expect(currentStep).toContainText(/Deposit margin/);
    await expectSinglePrimary(page, /^Deposit margin$/);
    await page.locator("[data-primary]:visible").click();
    const dialog = page.getByRole("dialog", { name: "Margin" });
    await dialog.locator('input[name="deposit-margin"]').fill("500");
    await dialog.getByRole("button", { name: "Deposit margin" }).click();
    await expectToast(page, /\$500\.00 margin deposited/);
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("free-margin")).toHaveText("$500.00");
    await expect(currentStep).toContainText(/Open a position/);
  });

  await test.step("3. markets: every listed market with its live cap, search, open SOL", async () => {
    await openApp(page, "Markets");
    await expect(page).toHaveURL(/\/markets$/);
    const table = page.getByTestId("markets-table");
    for (const header of ["Price", "24h Change", "Open Interest / Cap", "Funding / h", "Max Leverage", "Vault"]) {
      await expect(table.getByRole("columnheader", { name: header })).toBeVisible();
    }
    await expect(table.locator('[data-testid^="market-row-"]')).toHaveCount(16);
    await expectSinglePrimary(page, /^List /);
    // SOL has no sandbox fixture: it opens once the keeper has measured it on NEAR Intents.
    await expect(page.getByTestId("market-status-SOL")).toHaveText("Open", { timeout: KEEPER_WAIT });
    await page.getByTestId("markets-search").fill("SOL");
    await expect(table.locator('[data-testid^="market-row-"]')).toHaveCount(1);
    const sol = page.getByTestId("market-row-SOL");
    await expect(sol).toContainText(/\$[\d,.]+/);
    await sol.click();
    await expect(page).toHaveURL(/\/trade\?market=SOL$/);
    await expect(page.getByTestId("market-selector")).toContainText("SOL-USD");
  });

  await test.step("4. trade SOL: market long 5x with take profit and stop loss", async () => {
    await expect(page.getByTestId("mark-price")).toHaveText("$150.00");
    await fillMarketOrder(page, ticket, { side: "long", leverage: 5, size: 500, takeProfit: 180, stopLoss: 130 });
    await expectSinglePrimary(page, /Buy \/ Long/);
    await page.locator("[data-primary]:visible").click();
    await expectToast(page, /Long SOL 5× opened · \$500\.00/);
    await expect(positions).toHaveCount(1);
    const row = positions.first();
    await expect(row).toContainText("SOL");
    await expect(row).toContainText("Long 5×");
    await expect(row.locator('[data-testid^="brackets-"]')).toContainText("180");
    await expect(row.locator('[data-testid^="brackets-"]')).toContainText("130");
    await expect(row).toContainText(/\$1[0-9]{2}\.\d{2}/); // liquidation price, below the $150 entry
    // The guide steps aside once the first position is open.
    await expect(steps).toBeHidden();

    await page.getByTestId("account-tab-orders").click();
    await expect(page.getByTestId("account-tab-orders")).toHaveText("Open Orders (2)");
    await expect(openOrders.filter({ hasText: "Take Profit" })).toContainText("SOL");
    await expect(openOrders.filter({ hasText: "Stop Loss" })).toContainText("SOL");
  });

  await test.step("5. trade BTC: a limit short fills when the oracle price reaches it", async () => {
    await selectMarket(page, "BTC");
    await ticket.getByTestId("order-type-limit").click();
    await ticket.getByTestId("side-short").click();
    await setLeverage(page, 5);
    // A sell limit rests above the $77,561.50 oracle price.
    await ticket.locator('input[name="order-trigger"]').fill("78000");
    await ticket.locator('input[name="order-size"]').fill("500");
    await expectSinglePrimary(page, /Short/);
    await page.locator("[data-primary]:visible").click();
    await expectToast(page, /Limit short BTC placed at \$78,000\.00/);
    const limit = openOrders.filter({ hasText: "Limit" });
    await expect(limit).toContainText("BTC");
    await expect(page.getByTestId("account-tab-orders")).toHaveText("Open Orders (3)");

    await setOraclePrice("nbtc.bridge.near", 78_200);
    await expect(limit).toHaveCount(0, { timeout: KEEPER_WAIT });
    await page.getByTestId("account-tab-positions").click();
    await expect(positions).toHaveCount(2);
    await expect(positions.filter({ hasText: "BTC" })).toContainText("Short 5×");
    await page.getByTestId("account-tab-trades").click();
    const fill = accountPanel.locator('[data-testid^="trade-"]').filter({ hasText: "BTC" });
    await expect(fill).toContainText("Open Short");
    await expect(fill).toContainText(/Order #\d+ · by keeper at oracle price/);
    await page.getByTestId("account-tab-positions").click();
    await ticket.getByTestId("order-type-market").click();
  });

  await test.step("6. trade ZEC: an oversized order is refused at the live exit-liquidity cap", async () => {
    await selectMarket(page, "ZEC");
    await ticket.getByTestId("side-short").click();
    const market = await getMarket("ZEC");
    const leverage = market.max_leverage;
    await setLeverage(page, leverage);

    // The keeper re-measures depth every minute, so size the order from the cap read just now,
    // well above it, and mint the margin that takes (the faucet's 1,000 USDC is not enough).
    const remaining = BigInt(market.max_oi_per_side) - BigInt(market.oi_short);
    const margin = ((remaining * 3n) / 2n / BigInt(leverage) / USDC + 1n) * USDC;
    const freeBefore = parseUsd(await page.getByTestId("free-margin").innerText());
    await fundTraderMargin(margin);
    await expect
      .poll(async () => parseUsd(await page.getByTestId("free-margin").innerText()), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(freeBefore + Number(margin / USDC));

    await ticket.locator('input[name="order-size"]').fill(String((margin / USDC) * BigInt(leverage)));
    await expectSinglePrimary(page, /Sell \/ Short/);
    await page.locator("[data-primary]:visible").click();
    const refusal = page.getByTestId("order-error");
    await expect(refusal).toContainText(/Exceeds live exit liquidity on NEAR Intents \(cap \$[\d,.]+\)/);
    await expect(positions).toHaveCount(2);

    const useMax = refusal.getByRole("button", { name: /Use max size/ });
    const cap = parseUsd((await useMax.innerText()).replace(/^Use max size/, ""));
    expect(cap).toBeGreaterThan(0);
    await useMax.click();
    await expect(refusal).toBeHidden();
    const fitted = Number(await ticket.locator('input[name="order-size"]').inputValue());
    // The order value now fits under the cap (formatting rounds the cap to whole dollars).
    expect(fitted).toBeLessThanOrEqual(cap + 1);
    expect(fitted).toBeGreaterThan(cap - leverage - 1);
  });

  await test.step("7. markets: permissionless listing, measuring, then open after a keeper pass", async () => {
    await openApp(page, "Markets");
    await expect(page).toHaveURL(/\/markets$/);
    // The search from the SOL scene is remembered; clear it to see the whole registry.
    await page.getByTestId("markets-search").fill("");
    const panel = page.getByTestId("list-market-panel");
    // The sandbox oracle prices one asset that NEAR Intents quotes and the registry lacks.
    const symbol = "CNEAR";
    const candidate = panel.getByTestId(`listable-${symbol}`);
    await expect(candidate).toBeVisible({ timeout: 60_000 });
    await candidate.click();
    await expect(panel).toContainText("Long-tail");
    await expectSinglePrimary(page, /^List /);
    await page.getByTestId("list-market-submit").click();
    await expectToast(page, /listed · measuring/);
    const status = page.getByTestId(`market-status-${symbol}`);
    await expect(status).toHaveText("Measuring");
    await expect(page.getByTestId("markets-table").locator('[data-testid^="market-row-"]')).toHaveCount(17);

    // Unmeasured listings are sampled on the very next keeper pass.
    await expect(status).toHaveText("Open", { timeout: KEEPER_WAIT });
    const listed = await getMarket(symbol);
    expect(BigInt(listed.max_oi_per_side)).toBeGreaterThan(0n);
    expect(listed.max_leverage).toBeLessThanOrEqual(5);
  });

  await test.step("8. vaults: Core and Long-tail, deposit 500 USDC into Core", async () => {
    await openApp(page, "Vaults");
    await expect(page).toHaveURL(/\/vaults$/);
    await expect(page.getByTestId("vault-row-core")).toBeVisible();
    await expect(page.getByTestId("vault-row-long-tail")).toBeVisible();
    await expect(page.locator("[data-primary]:visible")).toHaveCount(1);
    await page.getByTestId("vault-row-core").getByRole("link", { name: "Core" }).click();
    await expect(page).toHaveURL(/\/vaults\/core$/);
    await expect(page.getByTestId("vault-nav")).toHaveText(/\$[\d,]+/);
    await expect(page.getByText("APR", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Vault performance" })).toBeVisible();
    const revenue = page.getByRole("region", { name: "Revenue breakdown" });
    for (const source of ["Trading + borrow fees", "Net funding", "Counterparty PnL", "Liquidation penalties"]) {
      await expect(revenue).toContainText(source);
    }
    await expect(page.getByRole("region", { name: /exposure/i })).toContainText("SOL");

    // Cover both vaults after the 500 USDC margin deposit and the 5 USDC listing fee.
    await mintTraderUsdc(105n * USDC);
    await expectSinglePrimary(page, /Deposit/);
    await page.locator("#vault-deposit").fill("500");
    await page.locator("[data-primary]:visible").click();
    await expectToast(page, /Deposited 500\.00 USDC into the vault/);
    await expect(page.getByTestId("tx-toast").filter({ hasText: /shares minted at/ })).toBeVisible();
    await expect(page.getByText("You have no vault shares yet.")).toBeHidden();
    await page.getByRole("tab", { name: "Withdraw", exact: true }).click();
    await expectSinglePrimary(page, /^Withdraw$/);
    await page.getByRole("tab", { name: "Deposit", exact: true }).click();
    await expectSinglePrimary(page, /Deposit to vault/);
    const sharesRow = page.getByRole("region", { name: "Deposit or withdraw" }).getByText("Shares", { exact: true }).locator("..");
    const coreShares = await sharesRow.locator("span").last().innerText();
    await page.goto("/vaults/long-tail");
    await expect(page.getByText("You have no vault shares yet.")).toBeVisible();
    await expect(page.getByRole("region", { name: /exposure/i }).getByRole("link", { name: "SOL", exact: true })).toHaveCount(0);
    const views = sandboxViews();
    const before = await views.vault("long-tail");
    const expectedShares = 100n * USDC * before.total_shares / before.nav;
    await page.locator("#vault-deposit").fill("100");
    await page.locator("[data-primary]:visible").click();
    await expectToast(page, /Deposited 100\.00 USDC into the vault/);
    const after = await views.vault("long-tail");
    expect(after.total_shares - before.total_shares).toBe(expectedShares);
    expect((await views.vaultAccount("long-tail", trader)).shares).toBe(expectedShares);
    await expect(sharesRow.locator("span").last()).toHaveText((Number(expectedShares) / Number(USDC)).toFixed(2));
    await page.goto("/vaults/core");
    await expect(sharesRow.locator("span").last()).toHaveText(coreShares);
  });

  await test.step("9. risk: capacity heatmap, measurement history, stress test on SOL", async () => {
    await openApp(page, "Risk");
    await expect(page).toHaveURL(/\/risk$/);
    await expect(page.getByText("Last measurement", { exact: true }).first()).toBeVisible();
    await expect(page.locator('[data-testid^="risk-market-"]')).toHaveCount(17);
    for (const asset of ["BTC", "ETH", "NEAR", "ZEC"]) {
      await page.getByTestId(`risk-market-${asset}`).click();
      await expect(page.locator("#stress-market")).toHaveValue(asset);
      await page.locator("summary").filter({ hasText: "Latest measured impact curve" }).click();
      await expect(page.getByRole("img", { name: /^Price impact by sell size; exit capacity/ })).toBeVisible();
    }
    await page.getByTestId("risk-market-SOL").click();
    await expect(page.locator("#stress-market")).toHaveValue("SOL");
    await expect(page.getByRole("status").filter({ hasText: /Market tightened|No recent tightening observed/ })).toBeVisible();
    await page.locator("summary").filter({ hasText: "Latest measured impact curve" }).click();
    await expect(page.getByRole("img", { name: /^Price impact by sell size; exit capacity/ })).toBeVisible();

    await page.locator("#stress-shock").fill("50");
    const row = page.locator('[data-testid^="stress-position-"]').filter({ hasText: "SOL" });
    await expect(row).toContainText("Would liquidate");
    await expect(page.getByTestId("stress-notional")).toHaveText("$500.00");
    await expect(page.getByTestId("stress-debt-core")).toHaveText(/^\$150\./);
    await expect(page.getByTestId("stress-debt-long-tail")).toHaveText("$0.00");
    // The scenario is read-only.
    expect((await getMarket("SOL")).oi_long).toBe("500000000");
    await expect(page.getByText("pnpm depth:sample").first()).toBeVisible();
    await expectSinglePrimary(page, /Copy/);
  });

  await test.step("10. trade NEAR: the price crosses maintenance, the keeper fills a stop loss and liquidates", async () => {
    await openApp(page, "Trade");
    await expect(page).toHaveURL(/\/trade/);
    await selectMarket(page, "NEAR");
    await expect(page.getByTestId("mark-price")).toHaveText("$4.00");
    await fillMarketOrder(page, ticket, { side: "long", leverage: 5, size: 500 });
    await page.locator("[data-primary]:visible").click();
    await expectToast(page, /Long NEAR 5× opened · \$500\.00/);
    await fillMarketOrder(page, ticket, { side: "long", leverage: 2, size: 400, stopLoss: 3.8 });
    await page.locator("[data-primary]:visible").click();
    await expectToast(page, /Long NEAR 2× opened · \$400\.00/);
    await page.getByTestId("account-tab-positions").click();
    await expect(positions).toHaveCount(4);

    // Maintenance is locked at entry and varies with the live liquidity tier.
    const near = (await sandboxViews().positions(trader)).find((p) => p.market_id === "NEAR" && p.leverage === 5)!;
    await setOraclePrice("wrap.near", Number(near.liquidation_price * 999n / 1_000n) / 1e8);
    await page.getByTestId("account-tab-liquidations").click();
    const liquidation = page.locator('[data-testid^="liquidation-"]').filter({ hasText: "Yours" });
    await expect(liquidation).toHaveCount(1, { timeout: KEEPER_WAIT });
    await expect(liquidation).toContainText("NEAR");
    await expect(liquidation).toContainText("Long liquidated");
    await expect(liquidation).toContainText("Liquidated by keeper");
    await expect(liquidation).toContainText(/\+\$[1-9]/);
    await page.getByTestId("account-tab-trades").click();
    const stop = accountPanel.locator('[data-testid^="trade-"]').filter({ hasText: "NEAR" }).filter({ hasText: "Close Long" });
    await expect(stop).toContainText(/Order #\d+ · by keeper at oracle price/);
    await expect(stop).toContainText("$400.00");
    await page.getByTestId("account-tab-positions").click();
    await expect(positions).toHaveCount(2);
  });

  await test.step("11. portfolio: equity, PnL and histories, switch to cross, close, withdraw", async () => {
    await openApp(page, "Portfolio");
    await expect(page).toHaveURL(/\/portfolio$/);
    await expectSinglePrimary(page, /^Deposit$/);
    await expect(page.getByRole("complementary", { name: "Account equity breakdown" })).toContainText(/\$[\d,]+/);
    await expect(page.getByTestId("portfolio-realized")).toHaveText(/-\$/);
    await expect(positions).toHaveCount(2);

    await page.getByRole("tab", { name: "Trade History", exact: true }).click();
    await expect(page.getByRole("tabpanel")).toContainText("Liquidated by keeper");
    await expect(page.getByRole("tabpanel")).toContainText(/Order #\d+ · by keeper at oracle price/);
    await page.getByRole("tab", { name: "Funding History", exact: true }).click();
    await expect(page.getByRole("tabpanel").locator('[data-testid^="funding-"]').first()).toBeVisible();
    await page.getByRole("tab", { name: /^Positions/ }).click();

    const btc = positions.filter({ hasText: "BTC" });
    await btc.getByRole("button", { name: "Switch to Cross" }).click();
    const switchDialog = page.getByRole("dialog", { name: "Switch to Cross" });
    await expect(switchDialog).toContainText("cannot switch back");
    await switchDialog.getByRole("button", { name: "Confirm switch to Cross" }).click();
    await expectToast(page, /BTC now shares cross margin/);
    await expect(btc).toContainText("(Cross)");
    await expect(page.getByTestId("portfolio-cross-health")).toContainText("Above maintenance");
    await btc.getByRole("button", { name: "Close" }).click();
    await expectToast(page, /Short BTC closed · settled into cross margin/);
    await expect(positions).toHaveCount(1);
    await positions.first().getByRole("button", { name: "Close" }).click();
    await expectToast(page, /Long SOL closed/);
    await expect(positions).toHaveCount(0);

    await page.getByRole("button", { name: "Withdraw", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Margin" });
    await dialog.getByRole("button", { name: /Free \$[\d,.]+ · Max/ }).click();
    await dialog.getByRole("button", { name: "Withdraw to wallet" }).click();
    await expectToast(page, /sent back to your wallet/);
    await expect(page.getByTestId("portfolio-available")).toHaveText("$0.00");
    await page.getByRole("tab", { name: "Deposits & Withdrawals" }).click();
    await expect(page.locator('[data-testid^="transfer-"]').filter({ hasText: "Withdrawal" })).toHaveCount(1);
    // The opening deposit, not the larger ZEC top-up that may also end in 500.
    await expect(page.locator('[data-testid^="transfer-"]').filter({ hasText: /(^|[^\d,])\$500\.00/ })).toContainText("Deposit");
  });

  await test.step("12. leaderboard: the demo account ranks by realized PnL and volume", async () => {
    await openApp(page, "Leaderboard");
    await expect(page).toHaveURL(/\/leaderboard$/);
    const row = page.getByTestId(`leaderboard-row-${trader}`);
    await expectSinglePrimary(page, /^Trade$/);
    await expect(row).toContainText("You");
    await expect(row).toContainText(/-\$[\d,.]+/);
    await expect(page.getByTestId("leaderboard-your-rank")).toContainText(/#\d+/);
    await page.getByRole("columnheader", { name: /Volume/ }).click();
    await expect(row).toBeVisible();
    await page.goto("/");
    const volume = page.getByTestId("landing-volume-24h");
    await expect(volume).toContainText(/\$[1-9][\d,]*/);
    await expect(volume).toContainText(/[4-9] trades|\d{2,} trades/);
    await expect(page.getByTestId("landing-vault-core")).toContainText("TVL");
    await expect(page.getByTestId("landing-vault-long-tail")).toBeVisible();
    await expectSinglePrimary(page, /Launch app/);
    expect(pageErrors).toEqual([]);
  });
});
