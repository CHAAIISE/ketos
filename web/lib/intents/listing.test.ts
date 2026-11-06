import { describe, expect, it } from "vitest";
import { listableAssets } from "./listing";
import { USDC_NEAR_ASSET_ID, type OneClickToken } from "./oneclick";

const WBTC = "2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near";
const USDC = USDC_NEAR_ASSET_ID.slice("nep141:".length);

const token = (assetId: string, symbol: string, blockchain = "near"): OneClickToken => ({
  assetId,
  symbol,
  blockchain,
  decimals: 8,
  price: 1,
});

const market = (id: string, oracle: string, intents: string) => ({
  id,
  oracle_asset_id: oracle,
  intents_asset_id: intents,
});

const registry = [
  market("BTC", "nbtc.bridge.near", "nep141:btc.omft.near"),
  market("NEAR", "wrap.near", "nep141:wrap.near"),
];

describe("listableAssets", () => {
  it("offers an oracle asset quoted by NEAR Intents, uppercased, when its underlying is not listed", () => {
    const assets = listableAssets({
      markets: registry.filter((market) => market.id !== "BTC"),
      oracleAssetIds: [WBTC],
      tokens: [token(`nep141:${WBTC}`, "wBTC")],
    });
    expect(assets).toEqual([
      { symbol: "WBTC", oracleAssetId: WBTC, intentsAssetId: `nep141:${WBTC}`, priceSource: "tee", referencePriceUsd: 1 },
    ]);
  });

  it("excludes wrapped duplicates of existing market underlyings even with different oracle and Intents ids", () => {
    expect(listableAssets({
      markets: [...registry, market("ETH", "eth.near", "nep141:eth.near")],
      oracleAssetIds: [WBTC, "weth.near", "wnear.near"],
      tokens: [
        token(`nep141:${WBTC}`, "wBTC"),
        token("nep141:weth.near", "WETH"),
        token("nep141:wnear.near", "WNEAR"),
      ],
    })).toEqual([]);
  });

  it.each(["USDC", "USDT", "FRAX", "DAI", "USDE", "USDS", "PYUSD", "EURC"])("excludes %s even away from its peg", (symbol) => {
    expect(listableAssets({
      markets: registry,
      oracleAssetIds: ["stable.near"],
      tokens: [{ ...token("nep141:stable.near", symbol), price: 0.8 }],
    })).toEqual([]);
  });

  it("excludes retired symbols and route aliases without excluding ETH's aurora oracle", () => {
    const auroraToken = "aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near";
    const rheaToken = "token.rhealab.near";
    const assets = listableAssets({
      markets: [],
      oracleAssetIds: [auroraToken, rheaToken, "alias-a.near", "alias-r.near", "aurora"],
      tokens: [
        token(`nep141:${auroraToken}`, "NEWALIAS"),
        token(`nep141:${rheaToken}`, "OTHERALIAS"),
        token("nep141:alias-a.near", "AURORA"),
        token("nep141:alias-r.near", "RHEA"),
        token("nep141:aurora", "ETH"),
      ],
    });
    expect(assets).toEqual([
      { symbol: "ETH", oracleAssetId: "aurora", intentsAssetId: "nep141:aurora", priceSource: "tee", referencePriceUsd: 1 },
    ]);
  });

  it.each([["btc.near", WBTC], [WBTC, "btc.near"]])("prefers the native candidate when oracle order starts with %s", (first, second) => {
    const assets = listableAssets({
      markets: [],
      oracleAssetIds: [first, second],
      tokens: [token("nep141:btc.near", "BTC"), token(`nep141:${WBTC}`, "WBTC")],
    });
    expect(assets.map((asset) => asset.symbol)).toEqual(["BTC"]);
  });

  it("skips assets already listed by oracle id, Intents id or ticker", () => {
    const assets = listableAssets({
      markets: [...registry, market("WBTC", "other.near", "nep141:other.near")],
      oracleAssetIds: ["wrap.near", "btc.omft.near", WBTC],
      tokens: [token("nep141:wrap.near", "WNEAR"), token("nep141:btc.omft.near", "XBTC"), token(`nep141:${WBTC}`, "wBTC")],
    });
    expect(assets).toEqual([]);
  });

  it("skips the USDC collateral, tokens on other chains and tickers the contract would refuse", () => {
    const assets = listableAssets({
      markets: registry,
      oracleAssetIds: [USDC, WBTC, "usdt.tether-token.near", "aurora"],
      tokens: [
        token(USDC_NEAR_ASSET_ID, "USDC"),
        token(`nep141:${WBTC}`, "WBTC", "eth"),
        token("nep141:usdt.tether-token.near", "USDT.e"),
      ],
    });
    expect(assets).toEqual([]);
  });

  it("keeps one candidate per ticker", () => {
    const assets = listableAssets({
      markets: registry,
      oracleAssetIds: ["a.near", "b.near"],
      tokens: [token("nep141:a.near", "DUP"), token("nep141:b.near", "DUP")],
    });
    expect(assets.map((a) => a.oracleAssetId)).toEqual(["a.near"]);
  });

  it("offers UNI only with pinned worker support and the exact NEAR route, then removes it once listed", () => {
    const intents = "nep141:eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near";
    const args = { markets: registry, oracleAssetIds: [], tokens: [token(intents, "UNI", "eth"), token("nep141:other.near", "UNI")] };
    expect(listableAssets(args)).toEqual([]);
    expect(listableAssets({ ...args, workerSymbols: ["UNI"] })).toEqual([
      { symbol: "UNI", oracleAssetId: "UNI", intentsAssetId: intents, priceSource: "outlayer_worker", referencePriceUsd: 1 },
    ]);
    expect(listableAssets({ ...args, workerSymbols: ["UNI"], markets: [...registry, market("UNI", "UNI", intents)] })).toEqual([]);
    expect(listableAssets({ ...args, workerSymbols: ["UNI"], tokens: [token("nep141:other.near", "UNI")] })).toEqual([]);
  });
});
