import { expect, test } from "@playwright/test";

// Read-only checks that run against any deployment: `BASE_URL=… playwright test --grep @smoke`.

test.describe("deployment", { tag: "@smoke" }, () => {
  test.beforeEach(async ({ page }) => {
    // App pages normally request maintenance; a deployment smoke must never send transactions.
    await page.route("**/api/keeper/tick", (route) => route.abort("blockedbyclient"));
  });

  test("landing explains the product and leads into the app", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/^Ketos — /);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("sized by real liquidity");
    await expect(page.getByTestId("landing-volume-24h")).toBeVisible();
    await expect(page.locator("[data-primary]:visible")).toHaveText(/Launch app/);
  });

  test("markets lists the whole registry with live caps", async ({ page }) => {
    await page.goto("/markets");
    const rows = page.getByTestId("markets-table").locator('[data-testid^="market-row-"]');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(7);
    await expect(page.getByTestId("market-row-BTC")).toContainText(/\$[\d,.]+/);
    await expect(page.getByTestId("list-market-panel")).toBeVisible();
  });

  test("trade shows the live price and exit-liquidity cap", async ({ page }) => {
    await page.goto("/trade");
    await expect(page.getByTestId("mark-price")).toHaveText(/\$\d/);
    await expect(page.getByTestId("max-oi")).toHaveText(/^\$[\d,]+$/);
    await page.getByTestId("market-selector").click();
    for (const id of ["BTC", "ETH", "NEAR", "ZEC", "SOL"]) {
      await expect(page.getByTestId(`market-tab-${id}`)).toBeVisible();
    }
  });

  test("vaults shows Core and Long-tail with their NAV", async ({ page }) => {
    await page.goto("/vaults");
    await expect(page.getByTestId("vault-row-core")).toContainText(/\$[\d,]+/);
    await expect(page.getByTestId("vault-row-long-tail")).toContainText(/\$[\d,]+/);
  });

  test("risk shows the registry and read-only stress controls", async ({ page }) => {
    await page.goto("/liquidity");
    await expect(page).toHaveURL(/\/risk$/);
    await expect(page.getByTestId("risk-market-NEAR")).toBeVisible();
    await expect(page.locator("#stress-market")).toBeVisible();
    await expect(page.getByRole("slider", { name: "Instant price drop" })).toBeVisible();
    await expect(page.locator("[data-primary]:visible")).toHaveText("Copy re-run command");
  });

  test("leaderboard loads the ranked cohort", async ({ page }) => {
    await page.goto("/leaderboard");
    await expect(page.getByTestId("leaderboard-count")).toHaveText(/\d/);
    await expect(page.locator("[data-primary]:visible")).toHaveCount(1);
  });
});
