import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const screens = [
  ["landing", "/"],
  ["trade", "/trade?market=ETH"],
  ["markets", "/markets"],
  ["vaults", "/vaults"],
  ["vault-core", "/vaults/core"],
  ["vault-long-tail", "/vaults/long-tail"],
  ["risk", "/risk"],
  ["portfolio", "/portfolio"],
  ["leaderboard", "/leaderboard"],
] as const;

async function singlePrimary(page: Page) {
  const primary = page.locator("[data-primary]:visible");
  await expect(primary).toHaveCount(1);
  await expect(primary).not.toHaveText(/Loading/);
  return primary;
}

async function capture(page: Page, name: string) {
  const phase = process.env.UX_CAPTURE_PHASE;
  const dir = process.env.UX_CAPTURE_DIR;
  if (!dir || (phase !== "avant" && phase !== "apres")) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `ux-v3-${name}-${phase}.png`), fullPage: true });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const size = viewport.width === 390 ? "mobile" : "desktop";
  test.describe(`guided UX at ${viewport.width}px`, () => {
    test.use({ viewport });

    test("one main action on every demo screen, signed out and funded", async ({ page }) => {
      test.setTimeout(240_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // This navigation check must not race a background keeper transaction.
      await page.route("**/api/keeper/tick", (route) => route.fulfill({
        status: 200, contentType: "application/json", headers: { "Retry-After": "60" },
        body: JSON.stringify({ ok: true, state: "throttled" }),
      }));

      for (const [name, path] of screens) {
        await test.step(`fresh visitor: ${name}`, async () => {
          await page.goto(path);
          await singlePrimary(page);
          if (name === "trade") {
            await expect(page.getByTestId("onboarding-steps")).toBeVisible();
            await expect(page.getByTestId("onboarding-steps").locator('[aria-current="step"]')).toContainText("Connect");
            if (size === "mobile") {
              const shortcut = page.getByRole("link", { name: "Order ticket ↓", exact: true });
              await expect(shortcut).toBeInViewport();
              await shortcut.click();
              await expect(page.getByRole("region", { name: "Open a position" })).toBeInViewport();
              await expect(page.getByRole("region", { name: "Open a position" })).toBeFocused();
            }
          }
          if (name === "markets") {
            await expect(page.getByTestId("listable-AURORA")).toHaveCount(0);
            await expect(page.getByTestId("listable-RHEA")).toHaveCount(0);
            await page.getByTestId("markets-search").fill("ETH");
            await expect(page.getByTestId("market-row-ETH")).toBeVisible();
            await page.getByTestId("markets-search").clear();
          }
          if (name === "risk") {
            const shock = page.getByRole("slider", { name: "Instant price drop" });
            await shock.fill("40");
            await expect(shock).toHaveValue("40");
          }
          await capture(page, `${name}-${size}-signed-out`);
        });
      }

      await test.step("connect and follow the next action without a margin deposit", async () => {
        await page.goto("/trade?market=ETH");
        await page.getByTestId("connect-button").click();
        await page.getByTestId("wallet-option-e2e").click();
        await expect(page.getByTestId("wallet-account")).toBeVisible();
        const primary = await singlePrimary(page);
        if (await page.getByTestId("ticket-fund-button").isVisible()) {
          await primary.click();
          await expect(page.getByTestId("tx-toast").filter({ hasText: "1,000 USDC added" })).toBeVisible();
        }
        await expect(page.getByTestId("open-position")).toBeVisible();
        await expect(page.getByTestId("free-margin")).toContainText("USDC");
      });

      for (const [name, path] of screens.filter(([name]) => name !== "landing")) {
        await test.step(`funded wallet: ${name}`, async () => {
          await page.goto(path);
          await singlePrimary(page);
          await capture(page, `${name}-${size}-funded`);
        });
      }
      expect(errors).toEqual([]);
    });
  });
}
