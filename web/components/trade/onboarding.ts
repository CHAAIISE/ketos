import type { OnboardingStep } from "@/components/ui/onboarding-steps";
import type { AccountSummary } from "@/hooks/use-perps-queries";

export type TradeStep = "connect" | "fund" | "deposit" | "trade";

const STEPS: ReadonlyArray<{ id: TradeStep; label: string }> = [
  { id: "connect", label: "Connect wallet" },
  { id: "fund", label: "Get test USDC" },
  { id: "deposit", label: "Deposit margin" },
  { id: "trade", label: "Open a position" },
];

/** Where the user is in the getting-started flow; null while their balances load. */
export function tradeStep(
  accountId: string | null,
  account: AccountSummary | undefined,
  openPositions: number,
): TradeStep | null {
  if (!accountId) return "connect";
  if (!account) return null;
  if (account.margin > 0n || openPositions > 0) return "trade";
  if (account.usdcBalance > 0n) return "deposit";
  return "fund";
}

/** Stepper rows; "Open a position" turns done once a position exists. */
export function onboardingSteps(step: TradeStep | null, openPositions: number): OnboardingStep[] {
  const current = step ? STEPS.findIndex((s) => s.id === step) : -1;
  return STEPS.map((s, index) => ({
    id: s.id,
    label: s.label,
    status:
      index < current || (s.id === "trade" && openPositions > 0)
        ? "done"
        : index === current
          ? "current"
          : "todo",
  }));
}
