// Measures exit liquidity on NEAR Intents: dry 1Click quotes selling each market's
// asset into USDC on NEAR at increasing USD sizes, reported as price impact in bps.
import { optionalEnv } from "./lib/env.ts";

const ONECLICK = "https://1click.chaindefuser.com/v0";
const USER_AGENT = "ketos-depth-sampler/0.1 (+https://github.com)";
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const MARKETS = {
  BTC: "nep141:btc.omft.near",
  ETH: "nep141:eth.omft.near",
  NEAR: "nep141:wrap.near",
  ZEC: "nep141:zec.omft.near",
} as const;
const SIZES_USD = [1_000, 10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];
// Without a partner key 1Click charges a 25 bps platform fee inside the quote.
const UNAUTHENTICATED_FEE_BPS = 25;

type Token = { assetId: string; decimals: number; price: number };
type Sample = { sizeUsd: number; impactBps: number | null; note?: string };

const apiKey = optionalEnv("ONECLICK_JWT");
const headers: Record<string, string> = { "content-type": "application/json", "user-agent": USER_AGENT };
if (apiKey) headers["x-api-key"] = apiKey;

async function getTokens(): Promise<Map<string, Token>> {
  const res = await fetch(`${ONECLICK}/tokens`, { headers });
  if (!res.ok) throw new Error(`GET /tokens → HTTP ${res.status}`);
  const list = (await res.json()) as Token[];
  return new Map(list.map((t) => [t.assetId, t]));
}

function toBaseUnits(amount: number, decimals: number): string {
  const [whole, frac = ""] = amount.toFixed(Math.min(decimals, 12)).split(".");
  return BigInt(whole + frac.padEnd(decimals, "0").slice(0, decimals)).toString();
}

async function quote(token: Token, sizeUsd: number): Promise<Sample> {
  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: token.assetId,
    depositType: "INTENTS",
    destinationAsset: USDC_NEAR,
    amount: toBaseUnits(sizeUsd / token.price, token.decimals),
    refundTo: "intents.near",
    refundType: "INTENTS",
    recipient: "intents.near",
    recipientType: "INTENTS",
    deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  const res = await fetch(`${ONECLICK}/quote`, { method: "POST", headers, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as {
    message?: string;
    quote?: { amountInUsd: string; amountOutUsd: string };
    quoteRequest?: { appFees?: { fee: number }[] };
  };
  if (!res.ok || !json.quote) {
    return { sizeUsd, impactBps: null, note: json.message ?? `HTTP ${res.status}` };
  }
  const inUsd = Number(json.quote.amountInUsd);
  const outUsd = Number(json.quote.amountOutUsd);
  const feeBps = json.quoteRequest?.appFees?.reduce((sum, f) => sum + f.fee, 0) ?? (apiKey ? 0 : UNAUTHENTICATED_FEE_BPS);
  const grossBps = ((inUsd - outUsd) / inUsd) * 10_000;
  return { sizeUsd, impactBps: Math.max(0, Math.round(grossBps - feeBps)), note: `gross ${grossBps.toFixed(1)} bps, fee ${feeBps} bps` };
}

const tokens = await getTokens();
const measuredAt = new Date().toISOString();
console.log(`1Click dry quotes → USDC (NEAR), ${apiKey ? "partner key" : "no key"}, ${measuredAt}\n`);

const results = await Promise.all(
  Object.entries(MARKETS).map(async ([symbol, assetId]) => {
    const token = tokens.get(assetId);
    if (!token) throw new Error(`${assetId} not listed by 1Click`);
    const samples: Sample[] = [];
    for (const size of SIZES_USD) samples.push(await quote(token, size));
    return { symbol, assetId, priceUsd: token.price, samples };
  }),
);

const sizeHeader = SIZES_USD.map((s) => `$${s >= 1e6 ? `${s / 1e6}M` : `${s / 1e3}k`}`.padStart(15)).join("");
console.log(`${"asset".padEnd(6)}${sizeHeader}`);
for (const r of results) {
  const cells = r.samples.map((s) => (s.impactBps === null ? "No liquidity" : `${s.impactBps} bps`).padStart(15)).join("");
  console.log(`${r.symbol.padEnd(6)}${cells}`);
}
console.log("\nDetails:");
for (const r of results) {
  for (const s of r.samples) console.log(`  ${r.symbol.padEnd(5)} $${String(s.sizeUsd).padEnd(8)} ${s.impactBps ?? "null"}  (${s.note})`);
}
