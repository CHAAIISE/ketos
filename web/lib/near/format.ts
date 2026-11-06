/** tUSDC and every USDC amount on the perps contract use 6 decimals. */
export const USDC_DECIMALS = 6;
/** Oracle and position prices use 8 decimals. */
export const PRICE_DECIMALS = 8;

export const USDC_UNIT = 10n ** BigInt(USDC_DECIMALS);

export interface FormatUnitsOptions {
  /** Digits kept after the decimal point; extra digits are truncated, never rounded. */
  maxFractionDigits?: number;
  /** Pads with zeros up to this many digits. Defaults to `maxFractionDigits`. */
  minFractionDigits?: number;
  /** Thousands separators in the integer part. Defaults to true. */
  grouping?: boolean;
  /** Prefix positive values with "+", for PnL. */
  signed?: boolean;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Fixed-point integer to a decimal string. Truncates toward zero so a balance is never shown
 * larger than what is actually on chain.
 */
export function formatUnits(value: bigint, decimals: number, options: FormatUnitsOptions = {}): string {
  const maxFraction = Math.min(options.maxFractionDigits ?? decimals, decimals);
  const minFraction = Math.min(options.minFractionDigits ?? maxFraction, maxFraction);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = (abs / scale).toString();
  let fraction = (abs % scale).toString().padStart(decimals, "0").slice(0, maxFraction);
  while (fraction.length > minFraction && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  const integer = options.grouping === false ? whole : groupThousands(whole);
  const body = fraction ? `${integer}.${fraction}` : integer;
  const isZero = /^[0,.]*$/.test(body);
  const sign = negative && !isZero ? "-" : options.signed && !negative && !isZero ? "+" : "";
  return `${sign}${body}`;
}

/** USDC units to "1,234.56". */
export function formatUsdc(units: bigint, options: FormatUnitsOptions = {}): string {
  return formatUnits(units, USDC_DECIMALS, { maxFractionDigits: 2, ...options });
}

/** USDC units to "$1,234.56" / "-$12.30". */
export function formatUsd(units: bigint, options: FormatUnitsOptions = {}): string {
  const text = formatUsdc(units, options);
  const sign = text.startsWith("-") || text.startsWith("+") ? text[0] : "";
  return `${sign}$${sign ? text.slice(1) : text}`;
}

/** Whole-dollar USDC display shared by compact market and vault summaries. */
export const usd0 = (units: bigint): string => formatUsd(units, { maxFractionDigits: 0 });

/** 8-decimal price to "$97,123.45"; prices under $1 keep 4 decimals. */
export function formatPrice(price: bigint, options: FormatUnitsOptions = {}): string {
  const digits = price >= 10n ** BigInt(PRICE_DECIMALS) ? 2 : 4;
  return `$${formatUnits(price, PRICE_DECIMALS, { maxFractionDigits: digits, ...options })}`;
}

/** Basis points to "12.34%". */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * Hourly funding rate (1e12 = 100%) to "+0.0125%": positive means longs pay shorts. The contract
 * caps it at ±0.05% per hour, so 4 decimals keep every step visible.
 */
export function formatFundingRate(ratePerHour: bigint): string {
  return `${formatUnits(ratePerHour, 10, { maxFractionDigits: 4, minFractionDigits: 4, signed: true })}%`;
}

/**
 * User input like "1,234.5" to fixed-point units. Returns null for anything that is not a plain
 * non-negative decimal or that has more fraction digits than the token supports.
 */
export function parseUnits(input: string, decimals: number): bigint | null {
  const text = input.trim().replace(/,/g, "");
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[1] === "" && !match[2])) return null;
  const [, whole, fraction = ""] = match;
  if (fraction.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** "12.5" to 12_500_000n USDC units. */
export function parseUsdc(input: string): bigint | null {
  return parseUnits(input, USDC_DECIMALS);
}

/** USDC units to a plain number of dollars, for charts and sliders only (loses precision past 2^53). */
export function usdcToNumber(units: bigint): number {
  return Number(units) / Number(USDC_UNIT);
}
