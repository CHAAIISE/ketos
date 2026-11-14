import testnetDeployment from "../../../deployments/testnet.json";
import hedgeDeployment from "../../../deployments/hedge-testnet.json";
import { Account, KeyPairSigner, teraToGas, type KeyPairString } from "near-api-js";
import { z } from "zod";
import { sampleAsset } from "../intents/depth";
import { getTokens } from "../intents/oneclick";
import { nearConfig } from "../near/config";
import { MAX_SIGNED_PRICE_ASSETS, priceSigner, signedPricesArg, signedPricesFor, verifySignedObservations, type SignedPriceRequest } from "../near/signed-prices";
import { workerSignedObservations, workerSignedPrices } from "../near/signed-prices-server";
import { orderExecutionSchema, type MarketId } from "../near/types";
import { settleOutcome } from "../near/tx";
import { KetosViews } from "../near/views";
import { errorMessage } from "../utils";
import type { DepthSource, KeeperChain, MarketDepth } from "./tick";
import type { KeeperPriceFeed } from "./price-feed";
import { runHedge } from "./hedge";
import { resolve } from "node:path";
import { HedgeSubmissions } from "./hedge-submission";

/** One process owns this restricted signer; fast and slow cycles serialize transactions. */
export async function keeperChain(privateKey: string, priceFeed?: KeeperPriceFeed): Promise<KeeperChain> {
  const config = nearConfig();
  if (config.network === "testnet") config.rpcUrl = process.env.KEEPER_RPC_URL?.trim() || testnetDeployment.rpc;
  const { rpcUrl, ketosContract, usdcContract } = config;
  const views = new KetosViews(rpcUrl, ketosContract, usdcContract);
  const { keeper_id } = await views.config();
  const keeper = new Account(keeper_id, views.provider, KeyPairSigner.fromSecretKey(privateKey as KeyPairString));
  const hedgeSubmissions = new HedgeSubmissions(
    process.env.KEEPER_HEDGE_JOURNAL || resolve("out/keeper/hedge-submissions.json"), keeper, ketosContract,
  );

  let pending: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  };
  const call = (methodName: string, args: Record<string, unknown>, tgas: number) =>
    enqueue(() => send(methodName, args, tgas));
  const send = async (methodName: string, args: Record<string, unknown>, tgas: number) => {
    const outcome = await keeper.callFunctionRaw({
      contractId: ketosContract,
      methodName,
      args,
      gas: teraToGas(tgas),
      waitUntil: "FINAL",
    });
    // A callback can recover an oracle failure; a final null is an unapplied liquidation.
    const result = settleOutcome(outcome);
    if (methodName === "liquidate" || methodName === "liquidate_cross") {
      if (result.value === null) throw new Error("Liquidation cancelled: price unavailable or conditions changed");
      if (result.value === undefined) throw new Error("Liquidation result was not confirmed");
    }
    return { tx: outcome.transaction.hash, value: result.value };
  };

  const executionPrices = async (request: SignedPriceRequest) => {
    const prices = await signedPricesFor(config, request, priceFeed
      ? async (assets, signer) => priceFeed.get(assets, signer)
      : workerSignedPrices);
    if (priceFeed && config.network !== "sandbox" && !prices) {
      throw new Error("Fresh signed observations unavailable for execution");
    }
    return signedPricesArg(prices);
  };

  return {
    markets: () => views.markets(),
    hedge: () => views.hedge(),
    rebalanceHedge: () => enqueue(() => runHedge({
      state: () => views.hedge(),
      market: async (id) => {
        const market = await views.market(id);
        if (!market) throw new Error("Hedge market is unavailable");
        return market;
      },
      vault: async (id) => {
        const vault = await views.vault(id);
        if (!vault) throw new Error("Hedge vault is unavailable");
        return vault;
      },
      send: async (method, args, gas) => {
        if (method !== "sync_hedge") return hedgeSubmissions.send(method, args, gas);
        const state = await views.hedge();
        const original = state?.pending ? hedgeSubmissions.locator(state.pending.nonce) : null;
        return send(method, { ...args, reported_transaction_hash: args.reported_transaction_hash ?? original }, gas);
      },
      verify: async (state) => {
        if (config.network !== "testnet") throw new Error("External hedge keeper requires pinned testnet contracts");
        if (ketosContract !== hedgeDeployment.controller || usdcContract !== hedgeDeployment.usdc ||
            Object.entries(hedgeDeployment.config).some(([key, value]) => state.config[key as keyof typeof state.config] !== value)) {
          throw new Error("Hedge deployment configuration mismatch");
        }
        for (const [accountId, expected] of [
          [ketosContract, testnetDeployment.code_hashes.ketos],
          [state.config.custody_id, hedgeDeployment.expected_custody_code_hash],
          [state.config.exchange_id, hedgeDeployment.exchange_code_hash],
          [state.config.wrapped_near_id, hedgeDeployment.wrapped_near_code_hash],
        ]) {
          const account = await views.provider.viewAccount({ accountId });
          if (account.code_hash !== expected) throw new Error(`Hedge code changed: ${accountId}`);
          if (accountId === state.config.custody_id &&
              BigInt(account.amount) - BigInt(account.storage_usage) * 10n ** 19n < 2n * 10n ** 24n) {
            throw new Error("Hedge custody below its 2 NEAR spendable reserve");
          }
        }
      },
      quote: async (state, side, amount) => z.string().regex(/^[0-9]+$/).transform(BigInt).parse(
        await views.provider.callFunction({
          contractId: state.config.exchange_id, method: "get_return",
          args: { pool_id: state.config.pool_id, token_in: side === "Buy" ? usdcContract : state.config.wrapped_near_id,
            token_out: side === "Buy" ? state.config.wrapped_near_id : usdcContract, amount_in: amount.toString() },
        })),
    })),
    openPositions: () => views.allOpenPositions(),
    openOrders: () => views.allOpenOrders(),
    crossAccount: (accountId) => views.crossAccount(accountId),
    vaults: () => views.vaults(),
    ketosBalanceYocto: async () => {
      const state = await views.provider.viewAccount({ accountId: ketosContract });
      const spendable = BigInt(state.amount) - BigInt(state.storage_usage) * 10n ** 19n;
      return spendable > 0n ? spendable : 0n;
    },
    setDepth: async (market, samples, measuredAtMs) =>
      (await call("set_depth", { market_id: market, samples, measured_at_ms: measuredAtMs }, 30)).tx,
    refreshPrices: async (markets) => {
      if (config.network === "sandbox") return (await call("refresh_prices", {}, 300)).tx;
      const marketIds = markets.map((market) => market.id);
      const signer = await priceSigner(config, views);
      if (!signer) throw new Error("Attested price signer unavailable");
      if (priceFeed) {
        for (let offset = 0; offset < marketIds.length; offset += MAX_SIGNED_PRICE_ASSETS) {
          priceFeed.request(marketIds.slice(offset, offset + MAX_SIGNED_PRICE_ASSETS), signer);
        }
      }
      let tx: string | null = null;
      for (let offset = 0; offset < marketIds.length; offset += MAX_SIGNED_PRICE_ASSETS) {
        const ids = marketIds.slice(offset, offset + MAX_SIGNED_PRICE_ASSETS);
        const requested = markets.slice(offset, offset + MAX_SIGNED_PRICE_ASSETS);
        const fetched = priceFeed ? null : await workerSignedObservations(ids, signer);
        const published = await enqueue(async () => {
          const candidates = priceFeed ? priceFeed.available(ids, signer) : fetched ? [fetched] : [];
          let latest: Awaited<ReturnType<typeof send>> | null = null;
          for (const candidate of candidates) {
            // Recheck after acquiring the signer and before each transaction.
            const observations = verifySignedObservations(candidate.signedPrices, signer, candidate.assets);
            if (!observations) continue;
            const payload = JSON.parse(observations.signedPrices.payload) as { prices: Record<string, { publish_time: number }> };
            const advancing = requested.filter((market) => observations.assets.includes(market.id)
              && payload.prices[market.id].publish_time * 1000 > market.price_timestamp_ms);
            if (advancing.length === 0) continue;
            latest = await send("submit_signed_prices", {
              market_ids: advancing.map((market) => market.id), signed_prices: observations.signedPrices,
            }, 50);
          }
          return latest;
        });
        if (published) tx = published.tx;
      }
      return tx;
    },
    executeOrders: (ids) => enqueue(async () => {
      const prices = await executionPrices({ kind: "orders", ids });
      const { tx, value } = await send("execute_orders", { ids, ...prices }, 300);
      return { tx, results: z.array(orderExecutionSchema).parse(value) };
    }),
    liquidate: (positionId) => enqueue(async () => {
      const prices = await executionPrices({ kind: "position", positionId });
      return (await send("liquidate", { position_id: positionId, ...prices }, 300)).tx;
    }),
    liquidateCross: (accountId) => enqueue(async () => {
      const prices = await executionPrices({ kind: "cross", accountId });
      return (await send("liquidate_cross", { account_id: accountId, ...prices }, 300)).tx;
    }),
    settleFunding: async (marketId) => (await call("settle_funding", { market_id: marketId }, 10)).tx,
    snapshotVaults: async (vaultIds) => (await call("snapshot_vaults", { vault_ids: vaultIds }, 50)).tx,
  };
}

/** Dry mainnet quotes. Registry asset IDs include permissionless listings and NEP-245 routes. */
export function oneClickDepthSource(jwt: string | undefined): DepthSource {
  const fetchWithDeadline: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) });
  return {
    async sample(markets) {
      let tokens;
      try {
        tokens = await getTokens({ jwt, fetchImpl: fetchWithDeadline });
      } catch (e) {
        const error = `1Click token list unavailable: ${errorMessage(e)}`;
        return markets.map(({ id: market }) => ({ market, error }));
      }
      const results: (MarketDepth | { market: MarketId; error: string })[] = [];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(6, markets.length) }, async () => {
        while (next < markets.length) {
          const index = next++;
          const market = markets[index];
          const measuredAtMs = Date.now();
          try {
            const curve = await sampleAsset(market.intents_asset_id, { tokens, jwt, fetchImpl: fetchWithDeadline });
            results[index] = { market: market.id, samples: curve.samples, measuredAtMs };
          } catch (e) {
            results[index] = { market: market.id, error: errorMessage(e) };
          }
        }
      }));
      return results;
    },
  };
}
