import { describe, expect, it } from "vitest";
import { listableAssets } from "./listing";
import type { OneClickToken } from "./oneclick";

const token = (assetId: string, symbol: string, blockchain = "near"): OneClickToken => ({
  assetId, symbol, blockchain, decimals: 8, price: 1,
});
const market = (id: string, oracle_asset_id: string, intents_asset_id: string) => ({
  id, oracle_asset_id, intents_asset_id,
});
const uni = "nep141:eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near";

describe("listableAssets", () => {
  it("requires the canonical TEE oracle and exact Intents asset rather than a ticker match", () => {
    const inputs = {
      markets: [], oracleAssetIds: ["nbtc.bridge.near", "aurora"],
      tokens: [token("nep141:btc.omft.near", "BTC"), token("nep141:eth.omft.near", "ETH")],
    };
    expect(listableAssets(inputs)).toEqual([
      { symbol: "BTC", oracleAssetId: "nbtc.bridge.near", intentsAssetId: "nep141:btc.omft.near", priceSource: "tee", referencePriceUsd: 1 },
      { symbol: "ETH", oracleAssetId: "aurora", intentsAssetId: "nep141:eth.omft.near", priceSource: "tee", referencePriceUsd: 1 },
    ]);
    expect(listableAssets({ ...inputs, oracleAssetIds: ["btc.alias.near", "eth.alias.near"] })).toEqual([]);
    expect(listableAssets({ ...inputs, tokens: [token("nep141:nbtc.bridge.near", "BTC"), token("nep141:aurora", "ETH")] })).toEqual([]);
  });

  it("does not offer arbitrary, stablecoin, wrapped or retired oracle/route pairs", () => {
    const ids = ["unknown.near", "stable.near", "wrapped.near", "token.rhealab.near"];
    expect(listableAssets({
      markets: [], oracleAssetIds: ids, workerSymbols: ["NEW", "USDC", "WBTC", "RHEA"],
      tokens: ids.map((id, index) => token(`nep141:${id}`, ["NEW", "USDC", "WBTC", "RHEA"][index])),
    })).toEqual([]);
  });

  it.each([
    market("UNI", "different", "nep141:different.near"),
    market("ALIAS", "UNI", "nep141:different.near"),
    market("ALIAS", "different", uni),
  ])("refuses a duplicate registry identity %j", (existing) => {
    expect(listableAssets({ markets: [existing], oracleAssetIds: [], workerSymbols: ["UNI"], tokens: [token(uni, "UNI")] })).toEqual([]);
  });

  it("requires worker support and the exact route and never advertises a mismatched asset", () => {
    const args = { markets: [], oracleAssetIds: [], tokens: [token(uni, "UNI", "eth"), token("nep141:other.near", "UNI")] };
    expect(listableAssets(args)).toEqual([]);
    expect(listableAssets({ ...args, workerSymbols: ["UNI"] })).toEqual([
      { symbol: "UNI", oracleAssetId: "UNI", intentsAssetId: uni, priceSource: "outlayer_worker", referencePriceUsd: 1 },
    ]);
    expect(listableAssets({ ...args, workerSymbols: ["UNI"], tokens: [token("nep141:other.near", "UNI")] })).toEqual([]);
  });

  it("offers one source per identity when both supported sources can price it", () => {
    expect(listableAssets({ markets: [], oracleAssetIds: ["wrap.near"], workerSymbols: ["NEAR"],
      tokens: [token("nep141:wrap.near", "NEAR")] })).toEqual([
      { symbol: "NEAR", oracleAssetId: "wrap.near", intentsAssetId: "nep141:wrap.near", priceSource: "tee", referencePriceUsd: 1 },
    ]);
  });
});
