import { formatUsd } from "./format";

/** A failed wallet or contract action, with a message meant for the user. */
export class NearActionError extends Error {
  readonly code: string;
  /** ERR_EXCEEDS_EXIT_LIQUIDITY: notional (USDC units) still open on that side; the UI can offer it as max size. */
  readonly capUsdc?: bigint;
  /** ERR_VAULT_RESERVED: USDC units the vault can pay out right now. */
  readonly availableUsdc?: bigint;
  /** ERR_LEVERAGE_TOO_HIGH: current leverage limit of the market. */
  readonly maxLeverage?: number;
  /** ERR_FAUCET_COOLDOWN: seconds until the next claim. */
  readonly retryInSeconds?: number;
  /** Raw error text, kept for debugging. */
  readonly details?: string;

  constructor(fields: {
    code: string;
    message: string;
    capUsdc?: bigint;
    availableUsdc?: bigint;
    maxLeverage?: number;
    retryInSeconds?: number;
    details?: string;
  }) {
    super(fields.message);
    this.name = "NearActionError";
    this.code = fields.code;
    this.capUsdc = fields.capUsdc;
    this.availableUsdc = fields.availableUsdc;
    this.maxLeverage = fields.maxLeverage;
    this.retryInSeconds = fields.retryInSeconds;
    this.details = fields.details;
  }
}

const PANIC_RE = /ERR_[A-Z0-9_]+(?::[^"\\\n]*)?/;

function jsonReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Every piece of text an error from near-api-js, near-connect or the RPC may carry. */
function errorTexts(error: unknown, depth = 0): string[] {
  if (error == null || depth > 4) return [];
  if (typeof error === "string") return [error];
  if (typeof error !== "object") return [String(error)];
  const texts: string[] = [];
  if (error instanceof Error) texts.push(error.message);
  const record = error as Record<string, unknown>;
  for (const key of ["panicMessage", "failure", "cause", "error", "data"] as const) {
    if (key in record && record[key] !== error) texts.push(...errorTexts(record[key], depth + 1));
  }
  const transactionResult = record.transactionResult as Record<string, unknown> | undefined;
  if (transactionResult) texts.push(...errorTexts(transactionResult.status, depth + 1));
  if (!(error instanceof Error)) {
    try {
      texts.push(JSON.stringify(error, jsonReplacer));
    } catch {
      // Circular structures: the fields above are all we can read.
    }
  }
  return texts;
}

/** The contract panic string, e.g. `ERR_LEVERAGE_TOO_HIGH: max 20`, if the error carries one. */
export function extractPanic(error: unknown): string | null {
  for (const text of errorTexts(error)) {
    const match = PANIC_RE.exec(text);
    if (match) return match[0].trim();
  }
  return null;
}

function durationText(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function fromPanic(panic: string, details: string): NearActionError {
  const [code, ...rest] = panic.split(":");
  const arg = rest.join(":").trim();
  const make = (message: string, extra: Partial<ConstructorParameters<typeof NearActionError>[0]> = {}) =>
    new NearActionError({ code, message, details, ...extra });

  switch (code) {
    case "ERR_EXCEEDS_EXIT_LIQUIDITY": {
      const cap = /cap\s+(\d+)/.exec(arg)?.[1];
      if (cap === undefined) return make("Exceeds live exit liquidity on NEAR Intents. Reduce the position size.");
      const capUsdc = BigInt(cap);
      return make(
        `Exceeds live exit liquidity on NEAR Intents (cap ${formatUsd(capUsdc)}). Reduce the size or use the max size.`,
        { capUsdc },
      );
    }
    case "ERR_MARKET_CLOSED":
      return make(
        `This market is closed to new positions${arg ? ` (${arg})` : ""}. Open positions can still be closed; try again once liquidity recovers.`,
      );
    case "ERR_STALE_PRICE":
      return make("The oracle price is out of date. Wait for the next price update (about a minute) and retry.");
    case "ERR_NO_PRICE":
      return make("This market has no oracle price yet. Try again in a minute.");
    case "ERR_LEVERAGE_TOO_HIGH": {
      const max = /max\s+(\d+)/.exec(arg)?.[1];
      if (max === undefined) return make("Leverage is above this market's current limit. Lower it and retry.");
      const maxLeverage = Number(max);
      return make(`Leverage is above this market's current limit of ${maxLeverage}x. Lower it and retry.`, {
        maxLeverage,
      });
    }
    case "ERR_LEVERAGE_TOO_LOW":
      return make("Leverage must be at least 1x.");
    case "ERR_INSUFFICIENT_MARGIN":
      return make("Not enough free margin. Deposit more tUSDC or lower the amount.");
    case "ERR_MIN_POSITION_MARGIN":
      return make("A position needs at least $1 of margin.");
    case "ERR_MIN_FIRST_DEPOSIT":
      return make("Your first margin deposit must be at least 1 tUSDC.");
    case "ERR_MIN_VAULT_DEPOSIT":
      return make("Vault deposits must be at least 1 tUSDC.");
    case "ERR_ZERO_AMOUNT":
      return make("Enter an amount greater than zero.");
    case "ERR_NO_ACCOUNT":
      return make("You have no margin account yet. Deposit tUSDC as margin first.");
    case "ERR_NO_POSITION":
      return make("This position no longer exists: it was already closed or liquidated. Refresh to see the latest state.");
    case "ERR_NOT_OWNER":
      return make("This position belongs to another account.");
    case "ERR_UNKNOWN_MARKET":
      return make("This market does not exist.");
    case "ERR_POSITION_HEALTHY":
      return make("This position is healthy and cannot be liquidated.");
    case "ERR_VAULT_RESERVED": {
      const available = /available\s+(\d+)/.exec(arg)?.[1];
      if (available === undefined) {
        return make("Part of the vault backs open positions and cannot be withdrawn yet. Withdraw a smaller amount.");
      }
      const availableUsdc = BigInt(available);
      return make(
        `Only ${formatUsd(availableUsdc)} can be withdrawn right now; the rest backs open positions. Withdraw less or retry later.`,
        { availableUsdc },
      );
    }
    case "ERR_INSUFFICIENT_SHARES":
      return make("You do not hold that many vault shares.");
    case "ERR_ZERO_SHARES":
      return make("The amount is too small to mint or burn a vault share. Use a larger amount.");
    case "ERR_VAULT_EMPTY":
      return make("The vault has no net value right now, so deposits are paused. Try again later.");
    case "ERR_FAUCET_COOLDOWN": {
      const seconds = /(\d+)\s*s/.exec(arg)?.[1];
      if (seconds === undefined) return make("You already claimed from the faucet this hour. Try again later.");
      const retryInSeconds = Number(seconds);
      return make(`You already claimed from the faucet this hour. Try again in ${durationText(retryInSeconds)}.`, {
        retryInSeconds,
      });
    }
    case "ERR_WRONG_TOKEN":
    case "ERR_INVALID_MSG":
      return make("The deposit was refused by the perps contract and your tUSDC was refunded.");
    case "ERR_OVERFLOW":
      return make("The amount is too large.");
    default:
      return make(`The contract rejected the transaction (${code}).`);
  }
}

const PATTERNS: Array<{ re: RegExp; code: string; message: string }> = [
  {
    re: /user rejected|rejected by (the )?user|user (cancel|denied|declined)|request rejected|wallet closed|cancelled|canceled/i,
    code: "WALLET_REJECTED",
    message: "The transaction was cancelled in your wallet.",
  },
  {
    re: /no accounts found|no wallet selected|not signed in/i,
    code: "NOT_SIGNED_IN",
    message: "Connect a wallet first.",
  },
  {
    re: /requires attached deposit of exactly 1 yocto/i,
    code: "ONE_YOCTO_REQUIRED",
    message: "This action must be approved with your wallet's full-access key. Reconnect your wallet and retry.",
  },
  {
    re: /account \S+ is not registered/i,
    code: "NOT_REGISTERED",
    message: "Your account holds no tUSDC yet. Claim tUSDC from the faucet first.",
  },
  {
    re: /doesn't have enough balance|not enough balance to transfer|insufficient balance/i,
    code: "INSUFFICIENT_BALANCE",
    message: "Not enough tUSDC in your wallet. Lower the amount or claim from the faucet.",
  },
  {
    re: /NotEnoughBalance|LackBalanceForState|not enough (NEAR|tokens)|InsufficientFunds/i,
    code: "INSUFFICIENT_NEAR",
    message: "Your account does not have enough NEAR to pay for gas. Top it up with the testnet NEAR faucet.",
  },
  {
    re: /Exceeded the prepaid gas|GasExceeded|GasLimitExceeded/i,
    code: "OUT_OF_GAS",
    message: "The transaction ran out of gas. Retry; if it keeps failing, the contract may be under load.",
  },
  {
    re: /failed to fetch|network ?error|fetch failed|ECONNREFUSED|timed? ?out|TimeoutError|ETIMEDOUT/i,
    code: "NETWORK",
    message: "Could not reach the NEAR network. Check your connection and retry.",
  },
];

/** Maps any wallet, RPC or contract error to a user-facing NearActionError. */
export function toNearActionError(error: unknown): NearActionError {
  if (error instanceof NearActionError) return error;
  const texts = errorTexts(error);
  const details = texts.find((t) => t.length > 0) ?? "Unknown error";
  const panic = extractPanic(error);
  if (panic) return fromPanic(panic, texts.join("\n"));
  const all = texts.join("\n");
  for (const { re, code, message } of PATTERNS) {
    if (re.test(all)) return new NearActionError({ code, message, details: all });
  }
  return new NearActionError({
    code: "UNKNOWN",
    message: "Something went wrong and the transaction did not go through. Please retry.",
    details,
  });
}
