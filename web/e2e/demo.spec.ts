import { expect, test, type Page } from "@playwright/test";
import { fundTraderMargin, getMarket, setOraclePrice } from "./sandbox";

// The demo journey on the local sandbox, as a first-time visitor walks it: every screen offers
// exactly one main action, and the trade screen always shows where the user is in the onboarding.

test.use({ viewport: { width: 1440, height: 900 } });

const USDC = 1_000_000n;

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

async function openApp(page: Page, name: "Trade" | "Vaults" | "Risk"): Promise<void> {
  await page.getByRole("navigation", { name: "App" }).getByRole("link", { name }).click();
}

async function selectMarket(page: Page, id: "BTC" | "ETH" | "NEAR" | "ZEC"): Promise<void> {
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

test("demo journey: fund, trade under live caps, LP, liquidation, exit", async ({ page }) => {
  // Two keeper ticks (one minute apart, each sampling 1Click) sit on the liquidation path.
  test.setTimeout(480_000);
  const steps = page.getByTestId("onboarding-steps");
  const currentStep = steps.locator('[aria-current="step"]');
  const ticket = page.getByRole("region", { name: "Open a position" });
  const positions = page.locator('[data-testid^="position-"]:visible');

  await test.step("1. landing: live exit capacity, one way into the app", async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("sized by real liquidity");
    await expect(page.getByText(/measured \d{2}:\d{2}/).first()).toBeVisible();
    await expectSinglePrimary(page, /Launch app/);
  });

  await test.step("2. trade: connect the wallet from the top bar and fund it", async () => {
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
    await page.getByTestId("fund-button").click();
    await expectToast(page, /1,000 USDC added to your wallet/);
    await expect(page.getByTestId("fund-button")).toHaveText(/Available in \d+ min/);
  });

  await test.step("3. trade: enable trading with 200 USDC of margin", async () => {
    await expect(currentStep).toContainText(/Deposit margin/);
    await expectSinglePrimary(page, /Enable trading/);
    await page.locator("[data-primary]:visible").click();
    const dialog = page.getByRole("dialog", { name: "Margin" });
    await dialog.locator('input[name="deposit-margin"]').fill("200");
    await dialog.getByRole("button", { name: "Deposit margin" }).click();
    await expectToast(page, /\$200\.00 margin deposited/);
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("free-margin")).toHaveText("$200.00");
  });

  await test.step("4. trade: NEAR long 5x with a $500 order under the live open interest cap", async () => {
    await expect(currentStep).toContainText(/Open a position/);
    await selectMarket(page, "NEAR");
    await expect(page.getByTestId("mark-price")).toHaveText(/\$\d/);
    await expect(page.getByTestId("max-oi")).toHaveText(/^\$[\d,]+$/);
    await expect(page.getByTestId("max-leverage")).toHaveText(/^\d+×$/);
    // The exit-liquidity ladder shows the measured sizes and where the 100 bps cap falls.
    await expect(page.getByTestId("cap-line")).toBeVisible();
    await expect(page.getByTestId("chart-source")).toContainText("Prices: Coinbase");

    await expect(page.getByTestId("leverage-value")).toHaveText("5×");
    await expectSinglePrimary(page, /Buy \/ Long/);
    await ticket.locator('input[name="order-size"]').fill("500");
    await page.locator("[data-primary]:visible").click();
    await expectToast(page, /Long NEAR 5× opened · \$500\.00/);
    await expect(positions).toHaveCount(1);
    const row = positions.first();
    await expect(row).toContainText("NEAR");
    await expect(row).toContainText("Long 5×");
    // The guide steps aside once the first position is open.
    await expect(steps).toBeHidden();
  });

  await test.step("5. trade: an oversized ZEC short is refused onchain at the exit-liquidity cap", async () => {
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
    await expect(positions).toHaveCount(1);

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

  await test.step("6. vault: deposit 500 USDC as LP against live exposure", async () => {
    await openApp(page, "Vaults");
    await expect(page).toHaveURL(/\/vaults$/);
    await expect(page.getByTestId("vault-row-core")).toBeVisible();
    await expect(page.getByTestId("vault-row-long-tail")).toBeVisible();
    await page.getByTestId("vault-row-core").getByRole("link", { name: "Core" }).click();
    await expect(page).toHaveURL(/\/vaults\/core$/);
    await expect(page.getByTestId("vault-nav")).toHaveText(/\$[\d,]+/);
    await expect(page.getByText("APR", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("region", { name: /exposure/i })).toContainText("NEAR");
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
    await expect(page.getByRole("region", { name: /exposure/i }).getByRole("link", { name: "NEAR", exact: true })).toHaveCount(0);
    await page.locator("#vault-deposit").fill("100");
    await page.locator("[data-primary]:visible").click();
    await expectToast(page, /Deposited 100\.00 USDC into the vault/);
    await expect(sharesRow).toContainText("100.00");
    await page.goto("/vaults/core");
    await expect(sharesRow.locator("span").last()).toHaveText(coreShares);
  });

  await test.step("7. risk: measured liquidity and a read-only shock on the real NEAR position", async () => {
    await openApp(page, "Risk");
    await expect(page).toHaveURL(/\/risk$/);
    await expect(page.getByText("Last measurement", { exact: true })).toBeVisible();
    for (const asset of ["BTC", "ETH", "NEAR", "ZEC"]) {
      await page.getByTestId(`risk-market-${asset}`).click();
      await expect(page.locator("#stress-market")).toHaveValue(asset);
      await page.locator("summary").filter({ hasText: "Latest measured impact curve" }).click();
      await expect(page.getByRole("img", { name: /^Price impact by sell size; exit capacity/ })).toBeVisible();
    }
    await page.getByTestId("risk-market-NEAR").click();
    const row = page.locator('[data-testid^="stress-position-"]').filter({ hasText: "NEAR" });
    await expect(row).toContainText("Would liquidate");
    await expect(page.getByTestId("stress-notional")).toHaveText("$500.00");
    await page.locator("#stress-shock").fill("50");
    await expect(page.getByTestId("stress-debt-core")).toHaveText(/^\$150\./);
    await expect(page.getByTestId("stress-debt-long-tail")).toHaveText("$0.00");
    const oracleAfterScenario = await getMarket("NEAR");
    expect(oracleAfterScenario.oi_long).toBe("500000000");
    await expect(page.getByText("pnpm depth:sample").first()).toBeVisible();
    await expectSinglePrimary(page, /Copy/);
  });

  await test.step("8. trade: NEAR drops 15%, the keeper liquidates the NEAR long", async () => {
    await openApp(page, "Trade");
    await expect(page).toHaveURL(/\/trade$/);
    // A BTC long that the NEAR move leaves untouched.
    await selectMarket(page, "BTC");
    await ticket.getByTestId("side-long").click();
    await setLeverage(page, 5);
    await ticket.locator('input[name="order-size"]').fill("500");
    await expectSinglePrimary(page, /Buy \/ Long/);
    await page.locator("[data-primary]:visible").click();
    await expectToast(page, /Long BTC 5× opened/);
    await expect(positions).toHaveCount(2);

    // Entry was $4.00: 15% down leaves the 5x long below its 10% maintenance margin.
    await setOraclePrice("wrap.near", 3.4);
    await page.getByTestId("account-tab-liquidations").click();
    const liquidation = page.locator('[data-testid^="liquidation-"]').filter({ hasText: "Yours" });
    await expect(liquidation).toHaveCount(1, { timeout: 180_000 });
    await expect(liquidation).toContainText("NEAR");
    await expect(liquidation).toContainText("Long liquidated");
    await expect(liquidation).toContainText("Liquidated by keeper");
    // The penalty paid to the vault.
    await expect(liquidation).toContainText(/\+\$[1-9]/);
  });

  await test.step("9. trade: close the remaining long and withdraw margin from the account menu", async () => {
    await page.getByTestId("account-tab-positions").click();
    await expect(positions).toHaveCount(1);
    await expect(positions.first()).toContainText("BTC");
    await positions.first().getByRole("button", { name: "Close" }).click();
    await expectToast(page, /Long BTC closed · \$[\d,.]+ back to margin/);
    await expect(positions).toHaveCount(0);

    await page.getByTestId("wallet-account").click();
    const menu = page.getByRole("dialog", { name: "Account" });
    await expect(menu).toContainText("Wallet USDC");
    await menu.getByRole("button", { name: "Withdraw" }).click();
    const dialog = page.getByRole("dialog", { name: "Margin" });
    await dialog.getByRole("button", { name: /Free \$[\d,.]+ · Max/ }).click();
    await dialog.getByRole("button", { name: "Withdraw to wallet" }).click();
    await expectToast(page, /sent back to your wallet/);
    await page.getByTestId("account-tab-balances").click();
    await expect(page.getByTestId("margin-free")).toHaveText("$0.00");
  });
});
