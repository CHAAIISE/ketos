import { z } from "zod";

const networkSchema = z.enum(["testnet", "sandbox"]);
export type NearNetwork = z.infer<typeof networkSchema>;

export interface NearConfig {
  network: NearNetwork;
  rpcUrl: string;
  ketosContract: string;
  usdcContract: string;
}

/**
 * Public network settings. Each variable is read by its literal name so Next.js inlines it
 * into the client bundle; the keeper script loads `web/.env.local` before calling this.
 */
export function nearConfig(): NearConfig {
  const config = z
    .object({
      network: networkSchema,
      rpcUrl: z.url(),
      ketosContract: z.string().min(2),
      usdcContract: z.string().min(2),
    })
    .safeParse({
      network: process.env.NEXT_PUBLIC_NEAR_NETWORK ?? "testnet",
      rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? "https://near-testnet.drpc.org",
      ketosContract: process.env.NEXT_PUBLIC_KETOS_CONTRACT,
      usdcContract: process.env.NEXT_PUBLIC_USDC_CONTRACT,
    });
  if (!config.success) {
    const fields = config.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid NEAR configuration (${fields}): check NEXT_PUBLIC_* in web/.env.local`);
  }
  return config.data;
}

/** How screens name the chain they read from. */
export function networkName(): string {
  return "NEAR";
}
