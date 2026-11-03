import { cn } from "@/lib/utils";

/** Share of a side's cap already used by open positions; amber past 80%. */
export function OiBar({ used, cap, className }: { used: bigint; cap: bigint; className?: string }) {
  const ratio = cap > 0n ? Math.min(1, Number((used * 10_000n) / cap) / 10_000) : used > 0n ? 1 : 0;
  return (
    <span
      aria-hidden
      className={cn("relative block h-1 w-full overflow-hidden rounded-pill bg-muted", className)}
    >
      <span
        className={cn("absolute inset-y-0 left-0 rounded-pill bg-foreground", ratio >= 0.8 && "bg-warning")}
        style={{ width: `${Math.max(ratio > 0 ? 2 : 0, ratio * 100)}%` }}
      />
    </span>
  );
}
