import { expect, test } from "@playwright/test";
import { KeyPair } from "near-api-js";
import { formatUnits, parseUnits, parseUsdc, PRICE_DECIMALS } from "../lib/near/format";
import { clearTraderTrading, mintTraderUsdc, refreshSandboxPrices, sandboxViews, traderAccountId } from "./sandbox";

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
  test.setTimeout(240_000);
  const views = sandboxViews();
  const trader = traderAccountId();
  await clearTraderTrading();
  const marginBefore = (await views.account(trader))?.margin ?? 0n;
  expect(marginBefore).toBe(0n);
  const initialPositions = await views.positions(trader);
  expect(initialPositions).toEqual([]);
  await mintTraderUsdc(1_000n * USDC);
  await page.goto("/trade?market=ETH");
  await page.locator("[data-primary]").click();
  const ticket = page.getByRole("region", { name: "Open a position" });
  await expect(ticket.getByTestId("free-margin")).toContainText("USDC");
  await expect(page.getByTestId("onboarding-steps").locator('[aria-current="step"]')).toContainText("Trade");
  await page.locator("#order-leverage").fill("2");
  await page.locator("#order-size").fill("500");
  await ticket.getByTestId("tpsl-toggle").check();
  const cached = (await views.markets()).find((market) => market.id === "ETH")!;
  await ticket.getByLabel("TP Price").fill(formatUnits(cached.price * 1005n / 1000n, PRICE_DECIMALS));
  await ticket.getByLabel("SL Price").fill(formatUnits(cached.price * 995n / 1000n, PRICE_DECIMALS));
  const walletBefore = await views.usdcBalance(trader);
  await ticket.getByRole("button", { name: "Max", exact: true }).click();
  const maxValue = parseUsdc(await page.locator("#order-size").inputValue())!;
  const proportionalReward = (maxValue * 5n + 9_999n) / 10_000n;
  const reward = proportionalReward > 100_000n ? proportionalReward : 100_000n;
  const unused = walletBefore - maxValue / 2n - 2n * reward;
  expect(unused).toBeGreaterThanOrEqual(0n);
  expect(unused).toBeLessThanOrEqual(2n);
  await page.locator("#order-size").fill("500");
  await expect(ticket.getByText("Keeper budget", { exact: true }).locator("..").locator("..").locator("dd")).toHaveText("$0.50");
  await expect.poll(async () => (await views.markets()).find((market) => market.id === "ETH")!.close_only, {
    timeout: 60_000,
    message: "The stored oracle mark becomes close-only after 30 seconds",
  }).toBe(true);
  await expect(page.getByTestId("review-entry-price")).toBeVisible();
  await expect(page.getByTestId("open-position")).toHaveCount(0);
  const nonceBefore = await walletNonce();
  await page.getByTestId("review-entry-price").click();
  await expect(page.getByTestId("review-entry-price")).toBeEnabled();
  await expect(page.getByTestId("price-review-error")).toBeVisible();
  expect(await walletNonce()).toBe(nonceBefore);
  expect(await views.positions(trader)).toEqual([]);
  expect(await views.usdcBalance(trader)).toBe(walletBefore);
  // The native sandbox has no signed-price worker. Its keeper publishes the real mock-oracle observation.
  await refreshSandboxPrices();
  await expect(page.getByTestId("open-position")).toBeEnabled();
  await page.getByTestId("open-position").click();
  await expect(page.getByTestId("tx-toast").filter({ hasText: "Long ETH 2× opened" })).toBeVisible();
  await expect(page.getByTestId("price-review-error")).toHaveCount(0);
  const [position] = await views.positions(trader);
  expect(position.size).toBe(500n * USDC);
  expect(position.margin_mode).toBe("isolated");
  expect(await walletNonce()).toBe(nonceBefore + 1);
  expect((await views.account(trader))?.margin).toBe(0n);
  expect(walletBefore - await views.usdcBalance(trader)).toBe(250_500_000n);
  expect(await views.orders(trader)).toHaveLength(2);
  const refreshed = (await views.markets()).find((market) => market.id === "ETH")!;
  expect(refreshed.price_timestamp_ms).toBeGreaterThan(cached.price_timestamp_ms);
  expect(refreshed.close_only).toBe(false);

  const originalOrders = await views.orders(trader);
  await expect(page.getByTestId(`position-${position.id}`)).toBeVisible();
  const chart = page.getByRole("img", { name: /^ETH-USD .* spot candles/ });
  const box = (await chart.boundingBox())!;
  const x = box.x + box.width / 2;
  let lineY: number | null = null;
  for (let y = box.y + 8; y < box.y + box.height - 30; y += 4) {
    await page.mouse.move(x, y);
    if (await chart.evaluate((element) => getComputedStyle(element).cursor) === "grab") { lineY = y; break; }
  }
  expect(lineY, "A TP/SL line near the mark must be draggable").not.toBeNull();
  await page.screenshot({ path: test.info().outputPath("position-lines.png") });
  await page.mouse.move(x, lineY!);
  await page.mouse.down();
  await page.mouse.move(x, lineY! - 12, { steps: 4 });
  await page.mouse.up();
  const dragReview = page.getByRole("dialog", { name: "ETH · Edit TP/SL", exact: true });
  await expect(dragReview).toBeVisible();
  expect(await views.orders(trader)).toEqual(originalOrders);
  await page.screenshot({ path: test.info().outputPath("bracket-review.png") });
  const reviewedTp = parseUnits(await dragReview.getByLabel("Take profit price", { exact: true }).inputValue(), PRICE_DECIMALS)!;
  await dragReview.getByRole("button", { name: "Confirm TP/SL", exact: true }).click();
  await expect(dragReview).toBeHidden();
  expect((await views.orders(trader)).find((order) => order.request.kind === "take_profit")?.request.trigger_price).toBe(reviewedTp);
  const walletBeforeAmend = await views.usdcBalance(trader);
  const nonceBeforeAmend = await walletNonce();
  await page.getByTestId(`position-${position.id}`).getByRole("button", { name: `Edit TP/SL for ETH position ${position.id}`, exact: true }).click();
  const editor = page.getByRole("dialog", { name: "ETH · Edit TP/SL", exact: true });
  await editor.getByLabel("Take profit price", { exact: true }).fill("3100");
  await editor.getByLabel("Stop loss price", { exact: true }).fill("1100");
  await editor.getByRole("button", { name: "Confirm TP/SL", exact: true }).click();
  await expect(editor).toBeHidden();
  const amendedOrders = await views.orders(trader);
  expect(amendedOrders.map((order) => [order.request.kind, order.request.trigger_price])).toEqual([
    ["take_profit", 3100n * 100_000_000n], ["stop_loss", 1100n * 100_000_000n],
  ]);
  expect(amendedOrders.every((order) => originalOrders.every((old) => old.id !== order.id))).toBe(true);
  expect(await views.usdcBalance(trader)).toBe(walletBeforeAmend);
  expect((await views.account(trader))?.margin).toBe(0n);
  expect(await walletNonce()).toBe(nonceBeforeAmend + 1);

  await page.getByTestId(`position-${position.id}`).getByRole("button", { name: `Edit TP/SL for ETH position ${position.id}`, exact: true }).click();
  await editor.getByLabel("Stop loss price", { exact: true }).fill("");
  await editor.getByRole("button", { name: "Confirm TP/SL", exact: true }).click();
  await expect(editor).toBeHidden();
  expect(await views.usdcBalance(trader)).toBe(walletBeforeAmend + 250_000n);
  expect((await views.account(trader))?.margin).toBe(0n);
  const remainingOrders = await views.orders(trader);
  expect(remainingOrders.map((order) => order.request.kind)).toEqual(["take_profit"]);

  const closeReview = page.getByRole("dialog", { name: "ETH · Close position", exact: true });
  for (const device of ["desktop", "mobile"] as const) {
    if (device === "mobile") await page.setViewportSize({ width: 390, height: 844 });
    const [before] = await views.positions(trader);
    const accountBefore = (await views.account(trader))!;
    const oldOrders = await views.orders(trader);
    const vaultBefore = await views.vault("core");
    const cashBefore = await views.usdcBalance(trader);
    const custodyBefore = await views.usdcBalance(views.ketosContract);
    const row = page.getByTestId(`${device === "mobile" ? "position-card" : "position"}-${before.id}`);
    await row.getByRole("button", { name: "Close", exact: true }).click();
    await closeReview.getByRole("button", { name: "50%", exact: true }).click();
    expect((await views.positions(trader))[0].size).toBe(before.size);
    await page.screenshot({ path: test.info().outputPath(`reduction-${device}.png`) });
    await closeReview.getByRole("button", { name: "Confirm reduction", exact: true }).click();
    await expect(closeReview).toBeHidden();
    const [after] = await views.positions(trader);
    const size = before.size / 2n;
    const collateral = before.margin * size / before.size;
    expect(after.size).toBe(before.size - size);
    expect(after.margin).toBe(before.margin - collateral);
    expect(after.entry_price).toBe(before.entry_price);
    expect(after.opened_at_ms).toBe(before.opened_at_ms);
    const newOrders = await views.orders(trader);
    expect(newOrders.map((order) => [order.request, order.execution])).toEqual(oldOrders.map((order) => [order.request, order.execution]));
    expect(newOrders.every((order) => oldOrders.every((old) => old.id !== order.id))).toBe(true);
    const accountAfter = (await views.account(trader))!;
    const rewardRefund = accountBefore.reserved_margin - accountAfter.reserved_margin;
    const event = (await views.history(trader)).filter((entry) => entry.kind === "reduce" && entry.position_id === position.id).at(-1)!;
    expect(event.size).toBe(size);
    const payout = collateral + event.pnl - event.fees - event.funding_payment;
    const walletDelta = await views.usdcBalance(trader) - cashBefore;
    expect(walletDelta).toBe(payout + rewardRefund);
    expect(event.realized_pnl).toBe(payout - collateral);
    expect((await views.vault("core")).balance - vaultBefore.balance).toBe(collateral - payout);
    expect(custodyBefore - await views.usdcBalance(views.ketosContract)).toBe(walletDelta);
    expect(accountAfter.margin).toBe(0n);
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  const walletAtClose = await views.usdcBalance(trader);
  await page.getByTestId(`position-${position.id}`).getByRole("button", { name: "Close", exact: true }).click();
  await closeReview.getByRole("button", { name: "Confirm close", exact: true }).click();
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
  await refreshSandboxPrices();
  await expect(page.getByTestId("open-position")).toBeEnabled();
  await page.getByTestId("open-position").click();
  await expect.poll(async () => (await views.positions(trader)).length).toBe(1);
  await page.getByTestId("account-tab-positions").click();
  const [kept] = await views.positions(trader);
  const walletBeforeKeep = await views.usdcBalance(trader);
  await page.getByTestId(`position-${kept.id}`).getByRole("button", { name: "Close", exact: true }).click();
  await closeReview.getByLabel("Keep on Ketos").check();
  await closeReview.getByRole("button", { name: "Confirm close", exact: true }).click();
  await expect(page.getByTestId("tx-toast").filter({ hasText: /ETH closed.*kept on Ketos/ })).toBeVisible();
  expect(await views.usdcBalance(trader)).toBe(walletBeforeKeep);
  expect((await views.account(trader))!.margin).toBeGreaterThan(0n);
});
