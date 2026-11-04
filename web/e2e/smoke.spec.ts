import { expect, test } from "@playwright/test";

// Read-only checks that run against any deployment: `BASE_URL=… playwright test --grep @smoke`.

test.describe("deployment", { tag: "@smoke" }, () => {
  test("landing explains the product and leads into the app", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/^Ketos — /);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("sized by real liquidity");
    await expect(page.locator("[data-primary]:visible")).toHaveText(/Launch app/);
  });

  test("trade lists the four markets with live caps", async ({ page }) => {
    await page.goto("/trade");
    await expect(page.getByTestId("mark-price")).toHaveText(/\$\d/);
    await expect(page.getByTestId("max-oi")).toHaveText(/^\$[\d,]+$/);
    await page.getByTestId("market-selector").click();
    for (const id of ["BTC", "ETH", "NEAR", "ZEC"]) {
      await expect(page.getByTestId(`market-tab-${id}`)).toBeVisible();
    }
  });

  test("risk shows the registry and read-only stress controls", async ({ page }) => {
    await page.goto("/liquidity");
    await expect(page).toHaveURL(/\/risk$/);
    await expect(page.getByTestId("risk-market-NEAR")).toBeVisible();
    await expect(page.locator("#stress-market")).toBeVisible();
    await expect(page.getByRole("slider", { name: "Instant price drop" })).toBeVisible();
    await expect(page.locator("[data-primary]:visible")).toHaveText("Copy re-run command");
  });
});
