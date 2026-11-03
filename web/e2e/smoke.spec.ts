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
    for (const id of ["BTC", "ETH", "NEAR", "ZEC"]) {
      await expect(page.getByTestId(`market-tab-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId("mark-price")).toHaveText(/\$\d/);
    await expect(page.getByTestId("max-oi")).toHaveText(/^\$[\d,]+$/);
  });

  test("liquidity shows a timestamped measurement and its impact curve", async ({ page }) => {
    await page.goto("/liquidity");
    await expect(page.getByText("Last measurement").filter({ visible: true })).toBeVisible();
    await expect(page.getByText(/\d{2}:\d{2}(:\d{2})? UTC/).first()).toBeVisible();
    await expect(page.getByRole("img", { name: /^Price impact by sell size; exit capacity/ })).toBeVisible();
  });
});
