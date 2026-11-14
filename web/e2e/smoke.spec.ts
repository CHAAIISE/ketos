import { expect, test as base } from "@playwright/test";
import { formatUsdc } from "../lib/near/format";
import { routePreviewSchema } from "../lib/intents/route-preview";
import { refreshSandboxPrices } from "./sandbox";

const test = base.extend<{ browserErrors: void }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    const paidRequests: string[] = [];
    await page.route(/\/api\/(?:keeper\/tick|signed-prices)(?:[?#]|$)/, async (route) => {
      paidRequests.push(route.request().url());
      await route.abort();
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await use();
    expect(paidRequests, "Read-only visits must not request maintenance or paid prices").toEqual([]);
    expect(errors, "No uncaught exceptions or console errors").toEqual([]);
  }, { auto: true }],
});

// Read-only checks that run against any deployment: `BASE_URL=… playwright test --grep @smoke`.

test.describe("deployment", { tag: "@smoke" }, () => {
  test("markets admit entries from independently maintained prices", { tag: "@availability" }, async ({ page }) => {
    if (!process.env.BASE_URL) await refreshSandboxPrices();
    await page.goto("/markets");
    const statuses = page.locator('[data-testid^="market-status-"]');
    await expect(statuses.first()).toBeVisible();
    await expect(page.getByTestId("keeper-status")).toHaveText(
      /^(Active risk prices fresh · \d+ markets|No open interest · prices refreshed on trade)$/,
    );
    const open = (await statuses.allTextContents()).filter((status) => status === "Open").length;
    expect(open, "Run scheduled maintenance before smoke; stored marks must be fresh on first load").toBeGreaterThan(0);
    await expect(page.getByTestId("markets-count").locator("..")).toContainText(`· ${open} open`);
  });

  test("landing explains the product and leads into the app", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/^Ketos — /);
    await expect(page.getByTestId("landing-volume-24h")).toBeVisible();
    const primary = page.locator("[data-primary]:visible");
    await expect(primary).toHaveCount(1);
    await primary.click();
    await expect(page).toHaveURL(/\/trade$/);
  });

  test("markets lists the whole registry with live caps", async ({ page }) => {
    const registryResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.request().postDataJSON()?.params?.method_name === "get_markets"
      && response.ok());
    await page.goto("/markets");
    const registry: { id: string }[] = JSON.parse(
      Buffer.from((await (await registryResponse).json()).result.result).toString("utf8"),
    );
    await expect(page.getByTestId("markets-count")).toBeVisible();
    const closed = page.getByTestId("markets-closed-group");
    if (await closed.count()) await closed.locator("summary").click();
    const rows = page.locator('[data-testid^="market-row-"]');
    await expect(rows).toHaveCount(registry.length);
    expect(await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid")).sort()))
      .toEqual(registry.map((market) => `market-row-${market.id}`).sort());
    await expect(page.getByTestId("market-row-BTC")).toContainText(/\$[\d,.]+/);
    await page.locator('aside a[href="/launch"]').click();
    await expect(page).toHaveURL(/\/launch$/);
    await expect(page.getByTestId("list-market-panel")).toBeVisible();
  });

  test("trade shows the live price and exit-liquidity cap", async ({ page }) => {
    await page.goto("/trade");
    await expect(page.getByTestId("mark-price")).toHaveText(/\$\d/);
    await expect(page.getByTestId("max-oi")).toHaveText(/^\$[\d,]+$/);
    await page.getByTestId("market-selector").click();
    const showClosed = page.getByRole("button", { name: /Show thin \/ closed markets/ });
    if (await showClosed.isVisible()) await showClosed.click();
    for (const id of ["BTC", "ETH", "NEAR", "ZEC", "SOL"]) {
      await expect(page.getByTestId(`market-tab-${id}`)).toBeVisible();
    }
    await page.getByTestId("market-tab-ETH").click();
    await expect(page).toHaveTitle(/^ETH-USD.*\$/);
    await expect.poll(() => page.title()).toContain(await page.getByTestId("mark-price").innerText());
    const launch = page.getByRole("navigation", { name: "App", exact: true }).getByRole("link", { name: "Launch", exact: true });
    if (await launch.isVisible()) await launch.click();
    else {
      await page.getByRole("button", { name: "Navigation menu", exact: true }).click();
      await page.getByRole("navigation", { name: "More navigation" }).getByRole("link", { name: "Launch", exact: true }).click();
    }
    await expect(page).toHaveURL(/\/launch$/);
    await expect(page.getByTestId("list-market-panel")).toBeVisible();
  });

  test("route preview returns a live quote without connecting a wallet", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("wallet-account")).toHaveCount(0);
    const preview = page.getByTestId("public-route-preview");
    const response = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/route-preview" && url.searchParams.get("asset") === "SOL" && response.ok();
    });
    await preview.getByLabel("Amount (SOL)").fill("1");
    const quote = routePreviewSchema.parse(await (await response).json());
    expect(quote.status).toBe("ok");
    if (quote.status !== "ok") throw new Error("The live SOL route has no liquidity");
    expect(BigInt(quote.amountOut)).toBeGreaterThan(0n);
    expect(Date.now() - quote.quotedAtMs).toBeLessThan(60_000);
    await expect(preview.getByTestId("route-preview-quote")).toContainText(`${formatUsdc(BigInt(quote.amountOut))} USDC`);
    await expect(page.getByRole("dialog", { name: "Connect a wallet" })).toHaveCount(0);
    await expect(page.getByTestId("wallet-account")).toHaveCount(0);
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
