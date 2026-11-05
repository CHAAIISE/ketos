import { formatUsd } from "./format";

/** A failed wallet or contract action, with a message meant for the user. */
export class NearActionError extends Error {
  readonly code: string;
  /** Remaining notional (USDC units) allowed by the exit-liquidity or vault-capital limit. */
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
    case "ERR_EXCEEDS_VAULT_CAPITAL": {
      const cap = /cap\s+(\d+)/.exec(arg)?.[1];
      const capUsdc = cap === undefined ? undefined : BigInt(cap);
      return make(
        `The vault cannot back this position${capUsdc === undefined ? "" : ` (remaining size ${formatUsd(capUsdc)})`}. Reduce the size or wait for more vault capital.`,
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
      return make("Not enough free margin. Deposit more USDC or lower the amount.");
    case "ERR_MIN_POSITION_MARGIN":
      return make("A position needs at least $1 of margin.");
    case "ERR_MIN_FIRST_DEPOSIT":
      return make("Your first margin deposit must be at least 1 USDC.");
    case "ERR_MIN_VAULT_DEPOSIT":
      return make("Vault deposits must be at least 1 USDC.");
    case "ERR_ZERO_AMOUNT":
      return make("Enter an amount greater than zero.");
    case "ERR_NO_ACCOUNT":
      return make("You have no margin account yet. Deposit USDC as margin first.");
    case "ERR_NO_POSITION":
      return make("This position no longer exists: it was already closed or liquidated. Refresh to see the latest state.");
    case "ERR_NOT_OWNER":
      return make("This position or order belongs to another account.");
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
      return make("The deposit was refused by the perps contract and your USDC was refunded.");
    case "ERR_OVERFLOW":
      return make("The amount is too large.");
    case "ERR_NO_ORDER":
      return make("This order no longer exists: it was already filled or cancelled. Refresh to see the latest state.");
    case "ERR_TOO_MANY_ORDERS":
      return make("You have reached the limit of 50 open orders. Cancel one before placing another.");
    case "ERR_ZERO_TRIGGER_PRICE":
      return make("Enter a trigger price greater than zero.");
    case "ERR_INVALID_TAKE_PROFIT":
      return make("The take profit must be above the current price for a long and below it for a short.");
    case "ERR_INVALID_STOP_LOSS":
      return make("The stop loss must be below the current price for a long and above it for a short.");
    case "ERR_EXIT_ORDER_EXISTS":
      return make("This position already has that exit order. Cancel it first to set a new price.");
    case "ERR_INVALID_LEVERAGE":
      return make("Leverage must be a whole number between 1x and the market's limit.");
    case "ERR_ALREADY_CROSS":
      return make("This position already uses cross margin.");
    case "ERR_TOO_MANY_CROSS_POSITIONS":
      return make("Cross margin holds at most 16 positions. Close one or use isolated margin.");
    case "ERR_CROSS_UNDERMARGINED":
      return make("Your cross account would fall under its maintenance margin. Add cross margin or reduce the size.");
    case "ERR_INSUFFICIENT_CROSS_CASH":
      return make("Not enough cross cash to move out. Lower the amount.");
    case "ERR_STALE_CROSS_PRICE":
      return make("A price in your cross account is out of date. Wait for the next price update (about a minute) and retry.");
    case "ERR_LISTING_FEE":
      return make("Listing a market costs exactly 5 USDC. Your USDC was refunded.");
    case "ERR_INVALID_LISTING":
    case "ERR_INVALID_ASSET":
      return make("The listing details are not valid: pick an asset from the list and retry. Your USDC was refunded.");
    case "ERR_INVALID_SYMBOL":
      return make("Use an uppercase ticker of up to 16 letters or digits, starting with a letter. Your USDC was refunded.");
    case "ERR_MARKET_EXISTS":
      return make("A market with this ticker is already listed. Your USDC was refunded.");
    case "ERR_ASSET_EXISTS":
      return make("This asset is already listed under another ticker. Your USDC was refunded.");
    case "ERR_UNSUPPORTED_WORKER_ASSET":
      return make("Our price worker does not price this asset yet. Your USDC was refunded.");
    case "ERR_UNKNOWN_VAULT":
      return make("This vault does not exist.");
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
    message: "Your account holds no USDC yet. Use Fund in the top bar first.",
  },
  {
    re: /doesn't have enough balance|not enough balance to transfer|insufficient balance/i,
    code: "INSUFFICIENT_BALANCE",
    message: "Not enough USDC in your wallet. Lower the amount or use Fund in the top bar.",
  },
  {
    re: /NotEnoughBalance|LackBalanceForState|not enough (NEAR|tokens)|InsufficientFunds/i,
    code: "INSUFFICIENT_NEAR",
    message: "Your account does not have enough NEAR to pay for gas. Top it up with a NEAR faucet.",
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
