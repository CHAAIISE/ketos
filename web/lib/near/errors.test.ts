import { ContractExecutionError, HostGuestPanicError } from "near-api-js/rpc-errors";
import { describe, expect, it } from "vitest";
import { NearActionError, extractPanic, toNearActionError } from "./errors";
import { TxFailureError } from "./tx";

const BLOCK = "8XhSaKXiBbC9cC5WkcWj7JDbSL5WM1R1Pdh6x3aW2EMo";

/** near-api-js wraps a contract panic of a submitted transaction like this. */
function panicked(panic: string) {
  return new ContractExecutionError(`Smart contract panicked: ${panic}`, BLOCK, 190_000_123);
}

describe("extractPanic", () => {
  it("finds the panic in near-api-js errors", () => {
    expect(extractPanic(panicked("ERR_STALE_PRICE"))).toBe("ERR_STALE_PRICE");
    expect(extractPanic(new HostGuestPanicError("ERR_LEVERAGE_TOO_HIGH: max 12", BLOCK, 1))).toBe(
      "ERR_LEVERAGE_TOO_HIGH: max 12",
    );
  });

  it("finds the panic in raw RPC failure JSON", () => {
    const failure = {
      ActionError: {
        index: 0,
        kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_VAULT_RESERVED: available 1250000" } },
      },
    };
    expect(extractPanic(new TxFailureError(failure, "tx"))).toBe("ERR_VAULT_RESERVED: available 1250000");
    expect(extractPanic({ error: failure })).toBe("ERR_VAULT_RESERVED: available 1250000");
  });

  it("finds the panic in a wallet error that only carries a message string", () => {
    expect(extractPanic(new Error('{"kind":{"ExecutionError":"Smart contract panicked: ERR_NO_PRICE"}}'))).toBe(
      "ERR_NO_PRICE",
    );
  });

  it("returns null without a panic", () => {
    expect(extractPanic(new Error("User rejected"))).toBeNull();
    expect(extractPanic(undefined)).toBeNull();
  });
});

describe("toNearActionError", () => {
  it("parses the exit liquidity cap as USDC units", () => {
    const error = toNearActionError(panicked("ERR_EXCEEDS_EXIT_LIQUIDITY: cap 4500000000"));
    expect(error).toBeInstanceOf(NearActionError);
    expect(error.code).toBe("ERR_EXCEEDS_EXIT_LIQUIDITY");
    expect(error.capUsdc).toBe(4_500_000_000n);
    expect(error.message).toBe(
      "Exceeds live exit liquidity on NEAR Intents (cap $4,500.00). Reduce the size or use the max size.",
    );
  });
  it("distinguishes vault capital from measured exit liquidity", () => {
    const error = toNearActionError(panicked("ERR_EXCEEDS_VAULT_CAPITAL: cap 1250000000"));
    expect(error.code).toBe("ERR_EXCEEDS_VAULT_CAPITAL");
    expect(error.capUsdc).toBe(1_250_000_000n);
  });

  it("parses the available vault amount, the leverage limit and the faucet cooldown", () => {
    const reserved = toNearActionError(panicked("ERR_VAULT_RESERVED: available 1250000"));
    expect(reserved.availableUsdc).toBe(1_250_000n);
    expect(reserved.message).toContain("$1.25");

    const leverage = toNearActionError(panicked("ERR_LEVERAGE_TOO_HIGH: max 12"));
    expect(leverage.maxLeverage).toBe(12);
    expect(leverage.message).toContain("12x");

    const faucet = toNearActionError(panicked("ERR_FAUCET_COOLDOWN: retry in 1790s"));
    expect(faucet.code).toBe("ERR_FAUCET_COOLDOWN");
    expect(faucet.retryInSeconds).toBe(1790);
    expect(faucet.message).toContain("30 min");
  });

  it("keeps the market closed reason", () => {
    const error = toNearActionError(panicked("ERR_MARKET_CLOSED: exit liquidity below $10,000"));
    expect(error.code).toBe("ERR_MARKET_CLOSED");
    expect(error.message).toContain("exit liquidity below $10,000");
  });

  it.each([
    ["ERR_NO_PRICE", /no oracle price/],
    ["ERR_INSUFFICIENT_MARGIN", /Not enough free margin/],
    ["ERR_MIN_POSITION_MARGIN: 1 USDC", /at least \$1/],
    ["ERR_MIN_VAULT_DEPOSIT: 1 USDC", /at least 1 USDC/],
    ["ERR_LEVERAGE_TOO_LOW", /at least 1x/],
    ["ERR_ZERO_AMOUNT", /greater than zero/],
    ["ERR_NO_ACCOUNT", /no margin account/],
    ["ERR_NO_POSITION", /no longer exists/],
    ["ERR_NOT_OWNER", /another account/],
    ["ERR_UNKNOWN_MARKET", /does not exist/],
    ["ERR_INSUFFICIENT_SHARES", /vault shares/],
    ["ERR_ZERO_SHARES", /too small/],
    ["ERR_INVALID_MSG", /refunded/],
    ["ERR_NO_ORDER", /already filled or cancelled/],
    ["ERR_INVALID_TAKE_PROFIT", /above the current price for a long/],
    ["ERR_INVALID_STOP_LOSS", /below the current price for a long/],
    ["ERR_CROSS_UNDERMARGINED", /maintenance margin/],
    ["ERR_MARKET_EXISTS", /already listed.*refunded/],
    ["ERR_UNSUPPORTED_WORKER_ASSET", /refunded/],
  ])("maps %s", (panic, message) => {
    const error = toNearActionError(panicked(panic));
    expect(error.code).toBe(panic.split(":")[0]);
    expect(error.message).toMatch(message);
    expect(error.details).toContain(panic);
  });

  it("names unlisted contract codes", () => {
    const error = toNearActionError(panicked("ERR_NOT_KEEPER"));
    expect(error.code).toBe("ERR_NOT_KEEPER");
    expect(error.message).toContain("ERR_NOT_KEEPER");
  });

  it.each([
    [new Error("User rejected"), "WALLET_REJECTED"],
    [new Error("Wallet closed"), "WALLET_REJECTED"],
    [new Error("No accounts found"), "NOT_SIGNED_IN"],
    [panicked("Requires attached deposit of exactly 1 yoctoNEAR"), "ONE_YOCTO_REQUIRED"],
    [panicked("The account alice.testnet is not registered"), "NOT_REGISTERED"],
    [panicked("The account doesn't have enough balance"), "INSUFFICIENT_BALANCE"],
    [new TxFailureError({ InvalidTxError: { NotEnoughBalance: { balance: "1" } } }, null), "INSUFFICIENT_NEAR"],
    [new TypeError("Failed to fetch"), "NETWORK"],
    [new Error("Timeout error"), "NETWORK"],
    [{ error: { cause: { name: "TIMEOUT_ERROR" } } }, "NETWORK"],
  ])("maps wallet and runtime errors (%s)", (raw, code) => {
    expect(toNearActionError(raw).code).toBe(code);
  });

  it("falls back to a generic message and keeps the raw text", () => {
    const error = toNearActionError(new Error("Something odd: 0xdeadbeef"));
    expect(error.code).toBe("UNKNOWN");
    expect(error.details).toBe("Something odd: 0xdeadbeef");
  });

  it("preserves a confirmed contract rejection when transport context also timed out", () => {
    const error = toNearActionError({
      cause: new Error("Timeout error"),
      failure: { ExecutionError: "Smart contract panicked: ERR_STALE_PRICE" },
    });
    expect(error.code).toBe("ERR_STALE_PRICE");
  });

  it("returns already mapped errors unchanged", () => {
    const mapped = toNearActionError(panicked("ERR_STALE_PRICE"));
    expect(toNearActionError(mapped)).toBe(mapped);
  });
});
