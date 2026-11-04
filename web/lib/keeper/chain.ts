import { Account, KeyPairSigner, teraToGas, type KeyPairString } from "near-api-js";
import { z } from "zod";
import { sampleAsset } from "../intents/depth";
import { getTokens } from "../intents/oneclick";
import { nearConfig } from "../near/config";
import { orderExecutionSchema } from "../near/types";
import { settleOutcome } from "../near/tx";
import { KetosViews } from "../near/views";
import type { DepthSource, KeeperChain } from "./tick";

/** The signer is restricted to the seven maintenance methods on the configured contract. */
export async function keeperChain(privateKey: string): Promise<KeeperChain> {
  const { rpcUrl, ketosContract, usdcContract } = nearConfig();
  const views = new KetosViews(rpcUrl, ketosContract, usdcContract);
  const { keeper_id } = await views.config();
  const keeper = new Account(keeper_id, views.provider, KeyPairSigner.fromSecretKey(privateKey as KeyPairString));

  const call = async (methodName: string, args: Record<string, unknown>, tgas: number) => {
    const outcome = await keeper.callFunctionRaw({
      contractId: ketosContract,
      methodName,
      args,
      gas: teraToGas(tgas),
      waitUntil: "EXECUTED_OPTIMISTIC",
    });
    // A successful outer transaction can hide a failed oracle receipt.
    const result = settleOutcome(outcome);
    return { tx: outcome.transaction.hash, value: result.value };
  };

  return {
    markets: () => views.markets(),
    openPositions: () => views.allOpenPositions(),
    openOrders: () => views.allOpenOrders(),
    crossAccount: (accountId) => views.crossAccount(accountId),
    lastSnapshotMs: async () => (await views.vaultHistory("core")).at(-1)?.timestamp_ms ?? null,
    ketosBalanceYocto: async () => {
      const state = await views.provider.viewAccount({ accountId: ketosContract });
      const spendable = BigInt(state.amount) - BigInt(state.storage_usage) * 10n ** 19n;
      return spendable > 0n ? spendable : 0n;
    },
    setDepth: async (market, samples, measuredAtMs) =>
      (await call("set_depth", { market_id: market, samples, measured_at_ms: measuredAtMs }, 30)).tx,
    refreshPrices: async () => (await call("refresh_prices", {}, 300)).tx,
    executeOrders: async (ids) => {
      const { tx, value } = await call("execute_orders", { ids }, 250);
      return { tx, results: z.array(orderExecutionSchema).parse(value) };
    },
    liquidate: async (positionId) => (await call("liquidate", { position_id: positionId }, 50)).tx,
    liquidateCross: async (accountId) => (await call("liquidate_cross", { account_id: accountId }, 150)).tx,
    settleFunding: async (marketId) => (await call("settle_funding", { market_id: marketId }, 10)).tx,
    snapshotVaults: async () => (await call("snapshot_vaults", {}, 50)).tx,
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
        const error = `1Click token list unavailable: ${e instanceof Error ? e.message : String(e)}`;
        return markets.map(({ id: market }) => ({ market, error }));
      }
      return Promise.all(markets.map(async (market) => {
        const measuredAtMs = Date.now();
        try {
          const curve = await sampleAsset(market.intents_asset_id, { tokens, jwt, fetchImpl: fetchWithDeadline });
          return { market: market.id, samples: curve.samples, measuredAtMs };
        } catch (e) {
          return { market: market.id, error: e instanceof Error ? e.message : String(e) };
        }
      }));
    },
  };
}
