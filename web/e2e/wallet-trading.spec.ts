import { expect, test } from "@playwright/test";
import { KeyPair } from "near-api-js";
import { parseUsdc } from "../lib/near/format";
import { clearTraderTrading, mintTraderUsdc, sandboxViews, traderAccountId } from "./sandbox";

const USDC = 1_000_000n;

async function walletNonce(): Promise<number> {
  const signer = process.env.NEXT_PUBLIC_E2E_SIGNER!;
  const key = KeyPair.fromString(signer.slice(signer.indexOf(":") + 1) as `ed25519:${string}`);
  const response = await fetch(process.env.NEXT_PUBLIC_RPC_URL!, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: {
      request_type: "view_access_key", finality: "final", account_id: traderAccountId(), public_key: key.getPublicKey().toString(),
    } }),
  });
  const body = await response.json();
  if (body.error) throw new Error("Could not read the sandbox wallet nonce");
  return body.result.nonce;
}

test("wallet trading: one confirmation, no margin deposit, wallet payouts and order refunds", async ({ page }) => {
  test.setTimeout(180_000);
  const views = sandboxViews();
  const trader = traderAccountId();
  await clearTraderTrading();
  const marginBefore = (await views.account(trader))?.margin ?? 0n;
  expect(marginBefore).toBe(0n);
  const initialPositions = await views.positions(trader);
  expect(initialPositions).toEqual([]);
  await mintTraderUsdc(1_000n * USDC);
  await page.route("**/api/keeper/tick", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, state: "throttled" }),
  }));
  await page.goto("/trade?market=ETH");
  await page.locator("[data-primary]").click();
  const ticket = page.getByRole("region", { name: "Open a position" });
  await expect(ticket.getByTestId("free-margin")).toContainText("USDC");
  await expect(page.getByTestId("onboarding-steps").locator('[aria-current="step"]')).toContainText("Trade");
  await page.locator("#order-leverage").fill("2");
  await page.locator("#order-size").fill("100");
  await ticket.getByTestId("tpsl-toggle").check();
  await ticket.getByLabel("TP Price").fill("3000");
  await ticket.getByLabel("SL Price").fill("1000");
  const walletBefore = await views.usdcBalance(trader);
  await ticket.getByRole("button", { name: "Max", exact: true }).click();
  const maxValue = parseUsdc(await page.locator("#order-size").inputValue())!;
  const proportionalReward = (maxValue * 5n + 9_999n) / 10_000n;
  const reward = proportionalReward > 100_000n ? proportionalReward : 100_000n;
  const unused = walletBefore - maxValue / 2n - 2n * reward;
  expect(unused).toBeGreaterThanOrEqual(0n);
  expect(unused).toBeLessThanOrEqual(2n);
  await page.locator("#order-size").fill("100");
  await expect(ticket.getByText("Keeper budget", { exact: true }).locator("..").locator("..").locator("dd")).toHaveText("$0.20");
  const cached = (await views.markets()).find((market) => market.id === "ETH")!;
  await expect.poll(async () => (await views.markets()).find((market) => market.id === "ETH")!.close_only, {
    timeout: 60_000,
    message: "The stored oracle mark becomes close-only after 30 seconds",
  }).toBe(true);
  await expect(page.getByTestId("close-only-notice")).toBeVisible();
  await expect(page.getByTestId("open-position")).toBeEnabled();
  const nonceBefore = await walletNonce();
  await page.getByTestId("open-position").click();
  await expect(page.getByTestId("tx-toast").filter({ hasText: "Long ETH 2× opened" })).toBeVisible();
  const [position] = await views.positions(trader);
  expect(position.size).toBe(100n * USDC);
  expect(position.margin_mode).toBe("isolated");
  expect(await walletNonce()).toBe(nonceBefore + 1);
  expect((await views.account(trader))?.margin).toBe(0n);
  expect(walletBefore - await views.usdcBalance(trader)).toBe(50_200_000n);
  expect(await views.orders(trader)).toHaveLength(2);
  const refreshed = (await views.markets()).find((market) => market.id === "ETH")!;
  expect(refreshed.price_timestamp_ms).toBeGreaterThan(cached.price_timestamp_ms);
  expect(refreshed.close_only).toBe(false);
  await expect(page.getByTestId("close-only-notice")).toBeHidden();

  const walletAtClose = await views.usdcBalance(trader);
  await page.getByTestId(`position-${position.id}`).getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("tx-toast").filter({ hasText: /ETH closed.*returned to wallet/ })).toBeVisible();
  expect(await views.positions(trader)).toEqual([]);
  expect(await views.orders(trader)).toEqual([]);
  expect((await views.account(trader))?.margin).toBe(0n);
  expect(await views.usdcBalance(trader)).toBeGreaterThan(walletAtClose);

  await ticket.getByTestId("order-type-limit").click();
  await ticket.getByTestId("tpsl-toggle").uncheck();
  await page.locator("#order-trigger").fill("1000");
  await page.locator("#order-size").fill("100");
  const walletBeforeLimit = await views.usdcBalance(trader);
  await expect(ticket.getByText("Keeper budget", { exact: true }).locator("..").locator("..").locator("dd")).toHaveText("$0.10");
  const nonceBeforeLimit = await walletNonce();
  await page.getByTestId("open-position").click();
  await expect(page.getByTestId("tx-toast").filter({ hasText: /Limit long ETH placed/ })).toBeVisible();
  expect(await walletNonce()).toBe(nonceBeforeLimit + 1);
  const [order] = await views.orders(trader);
  expect(walletBeforeLimit - await views.usdcBalance(trader)).toBe(50_100_000n);
  await page.getByTestId("account-tab-orders").click();
  await page.getByTestId(`open-order-${order.id}`).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(async () => (await views.orders(trader)).length).toBe(0);
  await expect.poll(() => views.usdcBalance(trader)).toBe(walletBeforeLimit);
  expect((await views.account(trader))?.margin).toBe(0n);

  await ticket.getByTestId("order-type-market").click();
  await page.locator("#order-size").fill("100");
  await page.getByTestId("open-position").click();
  await expect.poll(async () => (await views.positions(trader)).length).toBe(1);
  await page.getByTestId("account-tab-positions").click();
  await page.getByLabel("Keep on Ketos").check();
  const [kept] = await views.positions(trader);
  const walletBeforeKeep = await views.usdcBalance(trader);
  await page.getByTestId(`position-${kept.id}`).getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("tx-toast").filter({ hasText: /ETH closed.*kept on Ketos/ })).toBeVisible();
  expect(await views.usdcBalance(trader)).toBe(walletBeforeKeep);
  expect((await views.account(trader))!.margin).toBeGreaterThan(0n);
});
