import { faucetChain, faucetServerConfig } from "@/lib/faucet/chain";
import { createFaucetHandler } from "@/lib/faucet/http";
import { FaucetService } from "@/lib/faucet/service";

export const maxDuration = 60;

let configured: { service: FaucetService; privateKey: string } | undefined;

export const POST = createFaucetHandler({
  getService() {
    if (!configured) {
      const config = faucetServerConfig();
      configured = { service: new FaucetService(faucetChain(config), config.faucetId), privateKey: config.privateKey };
    }
    return configured;
  },
  vercel: () => process.env.VERCEL === "1",
});
