import { expect, test, type Page } from "@playwright/test";

// A first-time visitor walks the demo journey on the local sandbox. Every screen must offer exactly
// one main action, and the trade screen must always show where the user is in the onboarding.

test.use({ viewport: { width: 1440, height: 900 } });

async function expectSinglePrimary(page: Page, label: RegExp): Promise<void> {
  const primary = page.locator("[data-primary]:visible");
  await expect(primary).toHaveCount(1);
  await expect(primary).toHaveText(label);
}

async function snapshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`ux-${name}.png`), fullPage: true });
}

async function expectToast(page: Page, text: RegExp): Promise<void> {
  await expect(page.getByTestId("tx-toast").filter({ hasText: text })).toBeVisible({ timeout: 60_000 });
}

test("each screen of the demo journey has one main action", async ({ page }) => {
  const steps = page.getByTestId("onboarding-steps");

  await test.step("landing explains, then sends to the app", async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("sized by real liquidity");
    await expectSinglePrimary(page, /Launch app/);
    await snapshot(page, "landing");
  });

  await test.step("trade: connect wallet", async () => {
    await page.locator("[data-primary]").click();
    await expect(page).toHaveURL(/\/trade$/);
    await expect(steps).toBeVisible();
    await expect(steps.locator('[aria-current="step"]')).toContainText(/Connect wallet/);
    await expectSinglePrimary(page, /Connect wallet/);
    await snapshot(page, "trade-connect");
    await page.locator("[data-primary]:visible").click();
    await expect(page.getByTestId("wallet-account")).toBeVisible();
  });

  await test.step("trade: get test USDC", async () => {
    await expect(steps.locator('[aria-current="step"]')).toContainText(/Get test USDC/);
    await expectSinglePrimary(page, /Get 1,000 test USDC/);
    await snapshot(page, "trade-fund");
    await page.locator("[data-primary]:visible").click();
    await expectToast(page, /1,000 test USDC added/);
  });

  await test.step("trade: deposit margin", async () => {
    await expect(steps.locator('[aria-current="step"]')).toContainText(/Deposit margin/);
    await expectSinglePrimary(page, /Deposit margin/);
    await page.locator('input[name="deposit-margin"]').fill("200");
    await snapshot(page, "trade-deposit");
    await page.locator("[data-primary]:visible").click();
    await expectToast(page, /\$200\.00 margin deposited/);
  });

  await test.step("trade: open a position", async () => {
    await expect(steps.locator('[aria-current="step"]')).toContainText(/Open a position/);
    await expectSinglePrimary(page, /Open long NEAR/);
    await page.locator('input[name="order-margin"]').fill("100");
    await snapshot(page, "trade-open");
    await page.locator("[data-primary]:visible").click();
    await expectToast(page, /Long NEAR \d+× opened/);
    await expect(page.locator('[data-testid^="position-"]:visible')).toHaveCount(1);
    // The guide steps aside once the first position is open, and stays one click away.
    await expect(steps).toBeHidden();
    await expect(page.getByRole("button", { name: "Getting started" })).toBeVisible();
    await expectSinglePrimary(page, /Open long NEAR/);
    await snapshot(page, "trade-positions");
  });

  await test.step("vault: deposit", async () => {
    await page.getByRole("navigation", { name: "App" }).getByRole("link", { name: "Vault" }).click();
    await expect(page).toHaveURL(/\/vault$/);
    await expect(page.getByTestId("vault-nav")).toBeVisible();
    await expectSinglePrimary(page, /Deposit/);
    await snapshot(page, "vault");
  });

  await test.step("liquidity: measured depth", async () => {
    await page.getByRole("navigation", { name: "App" }).getByRole("link", { name: "Liquidity" }).click();
    await expect(page).toHaveURL(/\/liquidity/);
    await expectSinglePrimary(page, /Copy/);
    await snapshot(page, "liquidity");
  });
});
