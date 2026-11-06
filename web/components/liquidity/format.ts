/** Whole-dollar sizes as "$1k", "$250k", "$1M". */
export function formatSizeUsd(usd: number): string {
  if (usd >= 1_000_000) return `$${trim(usd / 1_000_000)}M`;
  if (usd >= 1_000) return `$${trim(usd / 1_000)}k`;
  return `$${usd}`;
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

