import { KeyPair } from "near-api-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NearConfig } from "./config";
import { createE2EWallet, createWallet, parseE2ESigner } from "./wallet";

const SECRET = KeyPair.fromRandom("ed25519").toString();

const sandbox: NearConfig = {
  network: "sandbox",
  rpcUrl: "http://127.0.0.1:3030",
  ketosContract: "perps.test.near",
  usdcContract: "usdc.test.near",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseE2ESigner", () => {
  it("splits the account id from the key", () => {
    expect(parseE2ESigner(`alice.test.near:${SECRET}`)).toEqual({ accountId: "alice.test.near", secretKey: SECRET });
  });

  it("rejects malformed values", () => {
    for (const value of [undefined, "", SECRET, "alice.test.near:ed25519:not-base58!", "alice.test.near"]) {
      expect(() => parseE2ESigner(value)).toThrow(/NEXT_PUBLIC_E2E_SIGNER/);
    }
  });
});

describe("E2E signer guard", () => {
  it("refuses NEXT_PUBLIC_E2E=1 outside the sandbox network", async () => {
    vi.stubEnv("NEXT_PUBLIC_E2E", "1");
    vi.stubEnv("NEXT_PUBLIC_NEAR_NETWORK", "testnet");
    vi.stubEnv("NEXT_PUBLIC_E2E_SIGNER", `alice.test.near:${SECRET}`);
    await expect(createWallet({ ...sandbox, network: "testnet" })).rejects.toThrow(/sandbox/);
    expect(() => createE2EWallet({ ...sandbox, network: "testnet" }, parseE2ESigner(`a.near:${SECRET}`))).toThrow(
      /sandbox/,
    );
  });

  it("uses the local signer on sandbox", async () => {
    vi.stubEnv("NEXT_PUBLIC_E2E", "1");
    vi.stubEnv("NEXT_PUBLIC_NEAR_NETWORK", "sandbox");
    vi.stubEnv("NEXT_PUBLIC_E2E_SIGNER", `alice.test.near:${SECRET}`);
    const wallet = await createWallet(sandbox);
    expect(wallet.kind).toBe("e2e");
    expect(wallet.accountId).toBeNull();
    await wallet.signIn();
    expect(wallet.accountId).toBe("alice.test.near");
    await wallet.signOut();
    expect(wallet.accountId).toBeNull();
  });
});
