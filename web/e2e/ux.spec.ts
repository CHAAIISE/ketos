import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const screens = [
  ["landing", "/"],
  ["trade", "/trade?market=ETH"],
  ["markets", "/markets"],
  ["launch", "/launch"],
  ["vaults", "/vaults"],
  ["vault-core", "/vaults/core"],
  ["vault-long-tail", "/vaults/long-tail"],
  ["risk", "/risk"],
  ["portfolio", "/portfolio"],
  ["leaderboard", "/leaderboard"],
] as const;


async function capture(page: Page, name: string) {
  const phase = process.env.UX_CAPTURE_PHASE;
  const dir = process.env.UX_CAPTURE_DIR;
  if (!dir || (phase !== "avant" && phase !== "apres")) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `ux-v3-${name}-${phase}.png`), fullPage: true, caret: "initial" });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const size = viewport.width === 390 ? "mobile" : "desktop";
  test.describe(`guided UX at ${viewport.width}px`, () => {
    test.use({ viewport });

    test("navigation and wallet funding work across responsive layouts", async ({ page }) => {
      test.setTimeout(240_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const maintenanceRequests: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/keeper/tick") maintenanceRequests.push(request.url());
      });

      for (const [name, path] of screens) {
        await test.step(`fresh visitor: ${name}`, async () => {
          await page.goto(path);
          if (name === "trade") {
            await expect(page.getByTestId("onboarding-steps")).toBeVisible();
            await expect(page.getByTestId("onboarding-steps").locator('[aria-current="step"]')).toContainText("Connect");
            if (size === "mobile") {
              const long = page.getByRole("button", { name: "Long", exact: true });
              await expect(long).toBeInViewport();
              await expect(page.getByRole("button", { name: "Short", exact: true })).toBeInViewport();
              await long.click();
              await expect(page.getByRole("dialog", { name: "ETH-USD · Long", exact: true })).toBeVisible();
              await page.keyboard.press("Escape");
              await expect(long).toBeFocused();
              await page.getByRole("button", { name: "Short", exact: true }).click();
              await expect(page.getByRole("radio", { name: "Short", exact: true })).toBeChecked();
            }
          }
          if (name === "launch") {
            await expect(page.getByTestId("listable-AAVE")).toBeVisible();
            await expect(page.getByTestId("listable-AURORA")).toHaveCount(0);
            await expect(page.getByTestId("listable-RHEA")).toHaveCount(0);
          }
          if (name === "markets") {
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
        if (size === "mobile") await page.getByRole("button", { name: "Long", exact: true }).click();
        if (await page.getByTestId("ticket-fund-button").isVisible()) {
          await page.getByTestId("ticket-fund-button").click();
          await expect(page.getByTestId("tx-toast").filter({ hasText: "1,000 USDC added" })).toBeVisible();
        }
        await expect(page.getByTestId("open-position").or(page.getByTestId("review-entry-price"))).toBeVisible();
        await expect(page.getByTestId("free-margin")).toContainText("USDC");
      });

      for (const [name, path] of screens.filter(([name]) => name !== "landing")) {
        await test.step(`funded wallet: ${name}`, async () => {
          await page.goto(path);
          if (name === "trade" && size === "mobile") await page.getByRole("button", { name: "Long", exact: true }).click();
          await capture(page, `${name}-${size}-funded`);
        });
      }
      expect(errors).toEqual([]);
      expect(maintenanceRequests).toEqual([]);
    });
  });
}
