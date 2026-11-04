import { Account, KeyPairSigner, teraToGas, type KeyPairString } from "near-api-js";
import { sampleAsset } from "../intents/depth";
import { getTokens, ORIGIN_ASSETS } from "../intents/oneclick";
import { nearConfig } from "../near/config";
import { MARKET_IDS } from "../near/types";
import { KetosViews } from "../near/views";
import type { DepthSource, KeeperChain } from "./tick";

/**
 * Keeper transactions, signed with the function-call key restricted to `refresh_prices`,
 * `set_depth` and `liquidate` on the perps contract. The keeper account is read from the
 * contract config, so only the private key is needed.
 */
export async function keeperChain(privateKey: string): Promise<KeeperChain> {
  const { rpcUrl, ketosContract, usdcContract } = nearConfig();
  const views = new KetosViews(rpcUrl, ketosContract, usdcContract);
  const { keeper_id } = await views.config();
  const keeper = new Account(keeper_id, views.provider, KeyPairSigner.fromSecretKey(privateKey as KeyPairString));

  // Waits for every receipt (the oracle callback included) so the next read sees the result.
  const call = async (methodName: string, args: Record<string, unknown>, tgas: number) => {
    const outcome = await keeper.callFunctionRaw({
      contractId: ketosContract,
      methodName,
      args,
      gas: teraToGas(tgas),
      waitUntil: "EXECUTED_OPTIMISTIC",
    });
    return outcome.transaction.hash;
  };

  return {
    markets: () => views.markets(),
    openPositions: () => views.allOpenPositions(),
    ketosBalanceYocto: () => views.nearBalance(ketosContract),
    setDepth: (market, samples, measuredAtMs) =>
      call("set_depth", { market_id: market, samples, measured_at_ms: measuredAtMs }, 30),
    refreshPrices: () => call("refresh_prices", {}, 300),
    liquidate: (positionId) => call("liquidate", { position_id: positionId }, 50),
  };
}

/** Dry 1Click quotes (mainnet, read-only) into USDC on NEAR for every market. */
export function oneClickDepthSource(jwt: string | undefined): DepthSource {
  return {
    async sample() {
      let tokens;
      try {
        tokens = await getTokens({ jwt });
      } catch (e) {
        const error = `1Click token list unavailable: ${e instanceof Error ? e.message : String(e)}`;
        return MARKET_IDS.map((market) => ({ market, error }));
      }
      const results = await Promise.allSettled(MARKET_IDS.map((market) => sampleAsset(ORIGIN_ASSETS[market], { tokens, jwt })));
      return results.map((r, i) =>
        r.status === "fulfilled"
          ? { market: MARKET_IDS[i], samples: r.value.samples }
          : { market: MARKET_IDS[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) },
      );
    },
  };
}
