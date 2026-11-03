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

async function openApp(page: Page, name: "Trade" | "Vault" | "Liquidity"): Promise<void> {
  await page.getByRole("navigation", { name: "App" }).getByRole("link", { name }).click();
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

  await test.step("2. trade: connect the wallet and get test USDC", async () => {
    await page.locator("[data-primary]").click();
    await expect(page).toHaveURL(/\/trade$/);
    await expect(steps).toBeVisible();
    await expect(currentStep).toContainText(/Connect wallet/);
    await expectSinglePrimary(page, /Connect wallet/);
    await page.locator("[data-primary]:visible").click();
    await expect(page.getByTestId("wallet-account")).toBeVisible();

    await expect(currentStep).toContainText(/Get test USDC/);
    await expectSinglePrimary(page, /Get 1,000 test USDC/);
    await page.locator("[data-primary]:visible").click();
    await expectToast(page, /1,000 test USDC added/);
  });

  await test.step("3. trade: deposit 200 USDC of margin", async () => {
    await expect(currentStep).toContainText(/Deposit margin/);
    await expectSinglePrimary(page, /Deposit margin/);
    await page.locator('input[name="deposit-margin"]').fill("200");
    await page.locator("[data-primary]:visible").click();
    await expectToast(page, /\$200\.00 margin deposited/);
    await expect(page.getByTestId("free-margin")).toHaveText("$200.00");
  });

  await test.step("4. trade: NEAR long 5x with 100 USDC under the live open interest cap", async () => {
    await expect(currentStep).toContainText(/Open a position/);
    await page.getByTestId("market-tab-NEAR").click();
    await expect(page.getByTestId("mark-price")).toHaveText(/\$\d/);
    await expect(page.getByText("set by live exit liquidity")).toBeVisible();
    await expect(page.getByTestId("max-oi")).toHaveText(/^\$[\d,]+$/);
    await expect(page.getByTestId("max-leverage")).toHaveText(/^\d+×$/);

    await expectSinglePrimary(page, /Open long NEAR/);
    await ticket.locator('input[name="order-margin"]').fill("100");
    await page.locator("[data-primary]:visible").click();
    await expectToast(page, /Long NEAR 5× opened · \$500\.00/);
    await expect(positions).toHaveCount(1);
    const row = positions.first();
    await expect(row).toContainText("NEAR");
    await expect(row).toContainText("Long 5×");
    // The guide steps aside once the first position is open, and stays one click away.
    await expect(steps).toBeHidden();
    await expect(page.getByRole("button", { name: "Getting started" })).toBeVisible();
  });

  await test.step("5. trade: an oversized ZEC short is refused onchain at the exit-liquidity cap", async () => {
    await page.getByTestId("market-tab-ZEC").click();
    await ticket.getByTestId("side-short").click();
    const market = await getMarket("ZEC");
    const leverage = market.max_leverage;
    await ticket.locator("#order-leverage").fill(String(leverage));
    await expect(ticket.getByTestId("leverage-value")).toHaveText(`${leverage}×`);

    // The keeper re-measures depth every minute, so size the order from the cap read just now,
    // well above it, and mint the margin that takes (the faucet's 1,000 tUSDC is not enough).
    const remaining = BigInt(market.max_oi_per_side) - BigInt(market.oi_short);
    const margin = ((remaining * 3n) / 2n / BigInt(leverage) / USDC + 1n) * USDC;
    const freeBefore = parseUsd(await page.getByTestId("free-margin").innerText());
    await fundTraderMargin(margin);
    await expect
      .poll(async () => parseUsd(await page.getByTestId("free-margin").innerText()), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(freeBefore + Number(margin / USDC));

    await ticket.locator('input[name="order-margin"]').fill(String(margin / USDC));
    await expectSinglePrimary(page, /Open short ZEC/);
    await page.locator("[data-primary]:visible").click();
    const refusal = page.getByTestId("order-error");
    await expect(refusal).toContainText(/Exceeds live exit liquidity on NEAR Intents \(cap \$[\d,.]+\)/);
    await expect(positions).toHaveCount(1);

    const useMax = refusal.getByRole("button", { name: /Use max size/ });
    const cap = parseUsd((await useMax.innerText()).replace(/^Use max size/, ""));
    expect(cap).toBeGreaterThan(0);
    await useMax.click();
    await expect(refusal).toBeHidden();
    const fitted = Number(await ticket.locator('input[name="order-margin"]').inputValue());
    // Margin × leverage now fits under the cap (formatting rounds the cap to whole dollars).
    expect(fitted * leverage).toBeLessThanOrEqual(cap + 1);
    expect(fitted * leverage).toBeGreaterThan(cap - leverage - 1);
  });

  await test.step("6. vault: deposit 500 USDC as LP against live exposure", async () => {
    await openApp(page, "Vault");
    await expect(page).toHaveURL(/\/vault$/);
    await expect(page.getByTestId("vault-nav")).toHaveText(/\$[\d,]+/);
    await expect(page.getByText("APR", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("region", { name: /exposure/i })).toContainText("NEAR");
    await expectSinglePrimary(page, /Deposit/);
    await page.locator("#vault-deposit").fill("500");
    await page.locator("[data-primary]:visible").click();
    await expectToast(page, /Deposited 500\.00 tUSDC into the vault/);
    await expect(page.getByTestId("tx-toast").filter({ hasText: /shares minted at/ })).toBeVisible();
    await expect(page.getByText("You have no vault shares yet.")).toBeHidden();
  });

  await test.step("7. liquidity: measured impact curves for the four assets", async () => {
    await openApp(page, "Liquidity");
    await expect(page).toHaveURL(/\/liquidity/);
    await expect(page.getByText("Last measurement").filter({ visible: true })).toBeVisible();
    const tabs = page.getByRole("tablist", { name: "Asset" });
    for (const asset of ["BTC", "ETH", "NEAR", "ZEC"]) {
      await tabs.getByRole("tab", { name: asset }).click();
      await expect(page.getByRole("img", { name: /^Price impact by sell size; exit capacity/ })).toBeVisible();
    }
    await expect(page.getByText("Derived parameters")).toBeVisible();
    await expect(page.getByText("pnpm depth:sample").first()).toBeVisible();
    await expectSinglePrimary(page, /Copy/);
  });

  await test.step("8. trade: NEAR drops 15%, the keeper liquidates the NEAR long", async () => {
    await openApp(page, "Trade");
    await expect(page).toHaveURL(/\/trade$/);
    // A BTC long that the NEAR move leaves untouched.
    await page.getByTestId("market-tab-BTC").click();
    await ticket.getByTestId("side-long").click();
    await ticket.locator("#order-leverage").fill("5");
    await ticket.locator('input[name="order-margin"]').fill("100");
    await expectSinglePrimary(page, /Open long BTC/);
    await page.locator("[data-primary]:visible").click();
    await expectToast(page, /Long BTC 5× opened/);
    await expect(positions).toHaveCount(2);

    // Entry was $4.00: 15% down leaves the 5x long below its 10% maintenance margin.
    await setOraclePrice("wrap.near", 3.4);
    await page.getByTestId("account-tab-liquidations").click();
    const liquidation = page.locator('[data-testid^="liquidation-"]').filter({ hasText: "Yours" });
    await expect(liquidation).toHaveCount(1, { timeout: 180_000 });
    await expect(liquidation).toContainText("NEAR-PERP");
    await expect(liquidation).toContainText("Liquidated by keeper");
    // The penalty paid to the vault.
    await expect(liquidation).toContainText(/\+\$[1-9]/);
  });

  await test.step("9. trade: close the remaining long and withdraw margin to the wallet", async () => {
    await page.getByTestId("account-tab-positions").click();
    await expect(positions).toHaveCount(1);
    await expect(positions.first()).toContainText("BTC");
    await positions.first().getByRole("button", { name: "Close" }).click();
    await expectToast(page, /Long BTC closed · \$[\d,.]+ back to margin/);
    await expect(positions).toHaveCount(0);

    await page.getByTestId("account-tab-margin").click();
    await page.getByRole("button", { name: /Free \$[\d,.]+ · Max/ }).click();
    await page.getByRole("button", { name: "Withdraw to wallet" }).click();
    await expectToast(page, /sent back to your wallet/);
    await expect(page.getByTestId("margin-free")).toHaveText("$0.00");
  });
});
