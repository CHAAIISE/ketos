import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

export const NEAR = 10n ** 24n;
export const GAS_TOP_UP = NEAR / 2n;
export const LOW_BALANCE = NEAR / 10n;
export const MIN_FAUCET_BALANCE = 2n * NEAR;
export const DAILY_GAS_LIMIT = 20n * NEAR;
const DAY_MS = 86_400_000;
const MINT_AMOUNT = "1000000000";

export function validAccountId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 2 && value.length <= 64
    && /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(value);
}

export interface FaucetResult { usdc_tx: string; gas_tx?: string }
export interface FaucetErrorBody {
  error: string;
  code: string;
  retryAfterSeconds?: number;
  tx_hash?: string;
  usdc_tx?: string;
  gas_tx?: string;
  partial?: true;
  gas_failed?: true;
}

export class FaucetError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly evidence: Partial<Omit<FaucetErrorBody, "error" | "code" | "retryAfterSeconds">> = {},
  ) { super(message); }

  body(): FaucetErrorBody {
    return { error: this.message, code: this.code,
      ...(this.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: this.retryAfterSeconds }),
      ...this.evidence };
  }
}

export interface FaucetConfig { faucet_id: string; gas_day: number; gas_spent: string }
export interface FaucetChain {
  availableBalance(accountId: string): Promise<bigint>;
  authorized(): Promise<boolean>;
  availableAt(accountId: string): Promise<bigint>;
  config(): Promise<FaucetConfig>;
  claim(accountId: string, ipHash: string, deposit: bigint): Promise<{ outcome: unknown; txHash: string }>;
}

/** Vercel overwrites this ingress header. Never trust a caller's alternate header on Vercel. */
export function ingressIp(request: Request, vercel: boolean): string {
  const value = (vercel ? request.headers.get("x-vercel-forwarded-for")
    : request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip"))?.split(",")[0].trim();
  if (!value || value.length > 128) return "unknown";
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6 || value.includes("%")) return "unknown";
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  // IPv4-mapped addresses must share the same quota as their IPv4 spelling.
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function hashIp(ip: string, privateKey: string): string {
  return createHmac("sha256", privateKey).update(ip).digest("hex");
}

function secondsUntilDay(now: number): number {
  return Math.max(1, Math.ceil(((Math.floor(now / DAY_MS) + 1) * DAY_MS - now) / 1000));
}

/** Recognise contract codes only; RPC messages and signer details never enter the HTTP body. */
export function chainError(error: unknown, now: number): FaucetError {
  if (error instanceof FaucetError) return error;
  let text = "";
  try { text = error instanceof Error ? error.message : JSON.stringify(error) ?? ""; } catch { /* Unknown RPC failure. */ }
  for (const code of ["ERR_FAUCET_COOLDOWN", "ERR_FAUCET_IP_LIMIT"]) {
    const match = new RegExp(`${code}[^\\n]{0,80}?retry in (\\d+)s`).exec(text);
    if (match || text.includes(code)) {
      const seconds = Math.min(3600, Math.max(1, Number(match?.[1] ?? 3600)));
      return new FaucetError(429, code, code === "ERR_FAUCET_COOLDOWN"
        ? `This account already claimed 1,000 USDC this hour. Retry in ${seconds}s.`
        : `This IP has reached the five-claims-per-hour limit. Retry in ${seconds}s.`, seconds);
    }
  }
  if (text.includes("ERR_FAUCET_GAS_LIMIT")) return new FaucetError(429, "ERR_FAUCET_GAS_LIMIT",
    "The faucet's 20 NEAR daily gas budget is exhausted. Try again after midnight UTC.", secondsUntilDay(now));
  if (/ERR_NOT_FAUCET|ERR_FAUCET_(DEPOSIT|IP_HASH)|MethodNotFound|MethodResolveError/.test(text)) return new FaucetError(503, "FAUCET_CONFIG",
    "The faucet signer or contract configuration is unavailable.");
  return new FaucetError(502, "FAUCET_RPC", "NEAR could not confirm funding. Please check your balances before trying again.");
}

const executionStatus = z.union([z.string(), z.object({ SuccessValue: z.string().optional(), Failure: z.unknown().optional() }).loose()]);
const outcomeSchema = z.object({
  status: executionStatus,
  transaction_outcome: z.object({ outcome: z.object({ status: executionStatus }).loose() }).loose(),
  receipts_outcome: z.array(z.object({ outcome: z.object({ status: executionStatus }).loose() }).loose()),
}).loose();

export function fundingOutcome(raw: unknown, txHash: string, deposit: bigint, now: number): FaucetResult {
  const parsed = outcomeSchema.safeParse(raw);
  if (!parsed.success) throw new FaucetError(502, "FAUCET_TX_UNCERTAIN",
    "The funding transaction was submitted but its result is unconfirmed. Check the transaction before retrying.",
    undefined, { tx_hash: txHash });
  const { status, transaction_outcome, receipts_outcome } = parsed.data;
  const statuses = [status, transaction_outcome.outcome.status, ...receipts_outcome.map((r) => r.outcome.status)];
  const failures = statuses.flatMap((s) => typeof s === "object" && s.Failure !== undefined ? [s.Failure] : []);
  let minted = false;
  if (typeof status === "object" && status.SuccessValue !== undefined) {
    try { minted = JSON.parse(Buffer.from(status.SuccessValue, "base64").toString("utf8")) === MINT_AMOUNT; } catch { /* Unconfirmed mint. */ }
  }
  if (failures.length) {
    if (minted) throw new FaucetError(502, "FAUCET_PARTIAL_SUCCESS",
      deposit > 0n ? "1,000 USDC was minted, but the NEAR gas transfer failed. Do not repeat the USDC claim."
        : "1,000 USDC was minted, but another transaction receipt failed. Check the transaction before retrying.",
      undefined, { partial: true, usdc_tx: txHash,
        ...(deposit > 0n ? { gas_tx: txHash, gas_failed: true as const } : {}) });
    throw chainError(failures, now);
  }
  const complete = statuses.every((s) => typeof s === "object"
    && (s.SuccessValue !== undefined || typeof s.SuccessReceiptId === "string"));
  if (!minted || !complete) throw new FaucetError(502, "FAUCET_TX_UNCERTAIN",
    "The funding transaction was submitted but its result is unconfirmed. Check the transaction before retrying.",
    undefined, { tx_hash: txHash });
  return { usdc_tx: txHash, ...(deposit > 0n ? { gas_tx: txHash } : {}) };
}

/** One in-flight signer operation per process; the contract remains the cross-instance quota authority. */
export class FaucetService {
  private busy = false;
  constructor(private readonly chain: FaucetChain, private readonly faucetId: string, private readonly now = Date.now) {}

  async fund(accountId: string, ipHash: string): Promise<FaucetResult> {
    if (!validAccountId(accountId)) throw new FaucetError(400, "INVALID_ACCOUNT", "Enter a valid NEAR account ID (2–64 lowercase characters).");
    if (this.busy) throw new FaucetError(503, "FAUCET_BUSY", "The faucet is funding another account. Retry shortly.", 2);
    this.busy = true;
    try {
      const [recipient, reserve, availableAt, config, authorized] = await Promise.all([
        this.chain.availableBalance(accountId), this.chain.availableBalance(this.faucetId),
        this.chain.availableAt(accountId), this.chain.config(), this.chain.authorized(),
      ]);
      const now = this.now();
      if (!authorized || config.faucet_id !== this.faucetId) throw new FaucetError(503, "FAUCET_CONFIG",
        "The faucet requires its authorized full-access signer. Funding is unavailable.");
      if (reserve < MIN_FAUCET_BALANCE) throw new FaucetError(503, "FAUCET_LOW_RESERVE",
        "The faucet has less than 2 NEAR available. Funding is paused until its reserve is replenished.");
      if (availableAt > BigInt(now)) {
        const seconds = Math.max(1, Number((availableAt - BigInt(now) + 999n) / 1000n));
        throw new FaucetError(429, "ERR_FAUCET_COOLDOWN", `This account already claimed 1,000 USDC this hour. Retry in ${seconds}s.`, seconds);
      }
      const deposit = recipient < LOW_BALANCE ? GAS_TOP_UP : 0n;
      const spent = config.gas_day === Math.floor(now / DAY_MS) ? BigInt(config.gas_spent) : 0n;
      if (spent + deposit > DAILY_GAS_LIMIT) throw chainError("ERR_FAUCET_GAS_LIMIT", now);
      const { outcome, txHash } = await this.chain.claim(accountId, ipHash, deposit);
      return fundingOutcome(outcome, txHash, deposit, this.now());
    } catch (error) {
      throw chainError(error, this.now());
    } finally {
      this.busy = false;
    }
  }
}
