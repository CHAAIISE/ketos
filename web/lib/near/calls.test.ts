import { describe, expect, it } from "vitest";
import {
  depositVaultTx,
  LISTING_FEE,
  listMarketTx,
  openPositionTx,
  placeOrderTx,
  withdrawVaultTx,
} from "./calls";
import type { NearTransaction } from "./tx";

const c = { ketosContract: "ketos.testnet", usdcContract: "usdc.ketos.testnet" };
const USD = 1_000_000n;

function only(tx: NearTransaction) {
  expect(tx.actions).toHaveLength(1);
  return tx.actions[0];
}

describe("trading calls", () => {
  it("opens an isolated market order without brackets by default", () => {
    const action = only(openPositionTx(c, { marketId: "NEAR", side: "long", margin: 50n * USD, leverage: 3 }));
    expect(action.deposit).toBe(0n);
    expect(action.args).toEqual({
      market_id: "NEAR",
      side: "long",
      margin: "50000000",
      leverage: 3,
      brackets: null,
      margin_mode: "isolated",
    });
  });

  it("sends only the bracket legs that are set, as U128 strings", () => {
    const action = only(
      openPositionTx(c, {
        marketId: "BTC",
        side: "short",
        margin: 10n * USD,
        leverage: 2,
        marginMode: "cross",
        brackets: { stopLoss: 10_500_000_000_000n },
      }),
    );
    expect(action.args.brackets).toEqual({ take_profit: null, stop_loss: "10500000000000" });
    expect(action.args.margin_mode).toBe("cross");
  });

  it("builds entry and exit order requests tagged by kind", () => {
    const entry = only(
      placeOrderTx(c, {
        kind: "stop_market",
        marketId: "ETH",
        side: "long",
        margin: 20n * USD,
        leverage: 5,
        triggerPrice: 350_000_000_000n,
        brackets: { takeProfit: 400_000_000_000n, stopLoss: null },
      }),
    );
    expect(entry.methodName).toBe("place_order");
    expect(entry.args.request).toEqual({
      kind: "stop_market",
      market_id: "ETH",
      side: "long",
      margin: "20000000",
      leverage: 5,
      trigger_price: "350000000000",
      brackets: { take_profit: "400000000000", stop_loss: null },
      margin_mode: "isolated",
    });

    const exit = only(placeOrderTx(c, { kind: "stop_loss", positionId: 7, triggerPrice: 300_000_000n }));
    expect(exit.args.request).toEqual({ kind: "stop_loss", position_id: 7, trigger_price: "300000000" });
  });
});

describe("vault and listing calls", () => {
  it("routes vault deposits by kebab-case vault id through the token", () => {
    const tx = depositVaultTx(c, "long-tail", 100n * USD);
    expect(tx.receiverId).toBe(c.usdcContract);
    expect(only(tx).args).toEqual({ receiver_id: c.ketosContract, amount: "100000000", msg: "deposit_vault:long-tail" });
    expect(only(withdrawVaultTx(c, "long-tail", 5n)).args).toEqual({ vault_id: "long-tail", shares: "5" });
  });

  it("pays exactly the listing fee with the request as JSON after the prefix", () => {
    const tx = listMarketTx(c, {
      symbol: "PEPE",
      oracleAssetId: "PEPE",
      intentsAssetId: "nep141:pepe.near",
      priceSource: "outlayer_worker",
    });
    const action = only(tx);
    expect(tx.receiverId).toBe(c.usdcContract);
    expect(action.deposit).toBe(1n);
    expect(action.args.amount).toBe(LISTING_FEE.toString());
    const msg = String(action.args.msg);
    expect(msg.startsWith("list_market:")).toBe(true);
    // The contract rejects unknown fields, so the payload must carry exactly these four.
    expect(JSON.parse(msg.slice("list_market:".length))).toEqual({
      symbol: "PEPE",
      oracle_asset_id: "PEPE",
      intents_asset_id: "nep141:pepe.near",
      price_source: "outlayer_worker",
    });
  });
});
