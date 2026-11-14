import { expect, test } from "@playwright/test";
import { clearTraderTrading, mintTraderUsdc, refreshSandboxPrices, sandboxViews, traderAccountId } from "./sandbox";

const USD = 1_000_000n;

test("launch: create, fund isolated capital, trade and withdraw without shared-pool contagion", async ({ page }) => {
  test.setTimeout(900_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await clearTraderTrading();
  await mintTraderUsdc(500n * USD);
  const views = sandboxViews();
  const trader = traderAccountId();
  const cash = await views.usdcBalance(trader);
  const custody = await views.usdcBalance(views.ketosContract);
  const core = await views.vault("core");
  const tail = await views.vault("long-tail");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/launch");
  const panel = page.getByTestId("list-market-panel");
  await panel.getByRole("button", { name: /Connect/i }).click();
  await expect(panel.getByTestId("listable-BCH")).toBeVisible({ timeout: 60_000 });
  await panel.getByTestId("listable-BCH").click();
  await panel.getByLabel("Planned LP capital · separate signature").fill("100");
  await page.screenshot({ path: test.info().outputPath("launch-desktop.png") });
  await panel.getByTestId("list-market-submit").click();
  await expect(page.getByTestId("launch-confirmed")).toBeVisible({ timeout: 60_000 });
  const market = (await views.markets()).find((entry) => entry.id === "BCH")!;
  expect(market.isolated_only).toBe(true);
  expect(market.vault_id).toMatch(/^market-/);
  expect(market.is_open).toBe(false);
  expect((await views.vault(market.vault_id)).balance).toBe(0n);
  expect(await views.usdcBalance(trader)).toBe(cash - 25n * USD);
  await panel.getByTestId("launch-fund").click();
  await expect(page.getByTestId("tx-toast").filter({ hasText: "BCH LP deposit confirmed" })).toBeVisible({ timeout: 60_000 });
  expect((await views.vaultAccount(market.vault_id, trader)).shares).toBe(100n * USD);
  expect(await views.usdcBalance(trader)).toBe(cash - 125n * USD);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath("launch-mobile-funded.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

  // The independently running sandbox keeper discovers and measures the new route.
  // A route created just after discovery waits one 10-minute interval plus the quote batch.
  // Controlled mock execution prices are local only; no browser-triggered price maintenance.
  await expect.poll(async () => (await views.markets()).find((entry) => entry.id === "BCH")!.is_open,
    { timeout: 780_000 }).toBe(true);
  await page.screenshot({ path: test.info().outputPath("launch-mobile-measured.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/trade?market=BCH");
  const ticket = page.getByRole("region", { name: "Open a position" });
  await expect(ticket.getByTestId("margin-mode-cross")).toBeDisabled();
  await page.locator("#order-leverage").fill("2");
  await page.locator("#order-size").fill("40");
  await ticket.getByTestId("tpsl-toggle").uncheck();
  await refreshSandboxPrices();
  await expect(page.getByTestId("open-position")).toBeEnabled();
  await page.getByTestId("open-position").click();
  await expect(page.getByTestId("tx-toast").filter({ hasText: "Long BCH 2× opened" })).toBeVisible({ timeout: 60_000 });
  const [position] = await views.positions(trader);
  expect(position.market_id).toBe("BCH");
  expect(position.size).toBe(40n * USD);
  expect(position.margin_mode).toBe("isolated");
  expect((await views.vault("core")).balance).toBe(core.balance);
  expect((await views.vault("long-tail")).balance).toBe(tail.balance + 25n * USD);
  await page.screenshot({ path: test.info().outputPath("isolated-trade-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId(`position-card-${position.id}`).getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("dialog", { name: "BCH · Close position", exact: true }).getByRole("button", { name: "Confirm close", exact: true }).click();
  await expect.poll(() => views.positions(trader)).toEqual([]);
  await page.goto(`/vaults/${market.vault_id}`);
  await page.getByRole("tab", { name: "Withdraw", exact: true }).click();
  const vaultTicket = page.getByRole("region", { name: "Deposit or withdraw" });
  await expect(vaultTicket.getByRole("button", { name: "Max", exact: true })).toBeEnabled();
  await vaultTicket.getByRole("button", { name: "Max", exact: true }).click();
  await page.screenshot({ path: test.info().outputPath("isolated-withdraw-mobile.png") });
  await vaultTicket.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(page.getByTestId("tx-toast").filter({ hasText: /Withdrew .* from the vault/ })).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await views.vaultAccount(market.vault_id, trader)).shares).toBe(0n);
  expect((await views.vault(market.vault_id)).balance).toBe(0n);
  expect(await views.usdcBalance(trader)).toBe(cash - 25n * USD);
  expect(await views.usdcBalance(views.ketosContract)).toBe(custody + 25n * USD);
  expect((await views.vault("core")).balance).toBe(core.balance);
  expect((await views.vault("long-tail")).balance).toBe(tail.balance + 25n * USD);
  expect(errors).toEqual([]);
});
