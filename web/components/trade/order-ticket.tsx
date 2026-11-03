"use client";

import { useState, type ReactNode } from "react";
import { useNow } from "@/components/landing/live-time";
import { useTxToast } from "@/components/app/tx-toast";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldMessage, Input } from "@/components/ui/input";
import { Skeleton } from "@/components/app/states";
import { useWallet } from "@/hooks/near-provider";
import type { AccountSummary } from "@/hooks/use-perps-queries";
import { useOpenPosition } from "@/hooks/use-perps-mutations";
import { formatPrice, formatUsd, formatUsdc, parseUsdc } from "@/lib/near/format";
import type { Market, Side } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { DepositMarginForm, FaucetButton } from "./funding";
import { isPriceFresh, marketStatus } from "./market-status";
import type { TradeStep } from "./onboarding";
import { borrowRatePercent, MIN_POSITION_MARGIN, previewOrder } from "./order-math";

const LEVERAGE_PRESETS = [1, 2, 5, 10, 20];

function Row({ label, children, tone }: { label: ReactNode; children: ReactNode; tone?: "warning" }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-label text-tertiary">{label}</dt>
      <dd className={cn("text-ui tabular-nums text-foreground", tone === "warning" && "text-warning")}>{children}</dd>
    </div>
  );
}

function SideToggle({ side, onChange }: { side: Side; onChange: (side: Side) => void }) {
  return (
    <div role="radiogroup" aria-label="Side" className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1">
      {(["long", "short"] as const).map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={side === s}
          data-testid={`side-${s}`}
          onClick={() => onChange(s)}
          className={cn(
            "h-8 rounded-sm text-ui font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
            side === s && s === "long" && "bg-success text-success-foreground hover:text-success-foreground",
            side === s && s === "short" && "bg-destructive text-destructive-foreground hover:text-destructive-foreground",
          )}
        >
          {s === "long" ? "Long" : "Short"}
        </button>
      ))}
    </div>
  );
}

/**
 * Order form for one market. The submit slot follows the getting-started flow: connect, claim
 * test USDC, deposit margin, then open long / open short.
 */
export function OrderTicket({
  market,
  step,
  account,
}: {
  market: Market;
  step: TradeStep | null;
  account: AccountSummary | undefined;
}) {
  const wallet = useWallet();
  const open = useOpenPosition();
  const { track } = useTxToast();
  const nowMs = useNow();
  const [side, setSide] = useState<Side>("long");
  const [marginInput, setMarginInput] = useState("");
  const [leverageChoice, setLeverageChoice] = useState(5);
  const [showDeposit, setShowDeposit] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const leverage = Math.min(Math.max(1, leverageChoice), market.max_leverage);
  const margin = parseUsdc(marginInput);
  const preview = previewOrder(market, side, margin ?? 0n, leverage);
  const status = marketStatus(market, nowMs);
  const freeMargin = account?.margin ?? 0n;
  const priceFresh = isPriceFresh(market, nowMs);

  const marginError =
    marginInput.trim() === ""
      ? null
      : margin === null
        ? "Enter an amount like 100 or 12.50."
        : margin < MIN_POSITION_MARGIN
          ? "The smallest position uses 1 USDC of margin."
          : step === "trade" && margin > freeMargin
            ? `You have ${formatUsd(freeMargin)} of free margin. Deposit more or lower the amount.`
            : null;

  const refusal = open.error;
  const capUsdc = refusal?.capUsdc;
  const sideLabel = side === "long" ? "long" : "short";

  function applyMaxSize(capUnits: bigint) {
    // Largest margin whose notional (margin × leverage) still fits under the cap.
    const maxMargin = capUnits / BigInt(leverage);
    const fitted = maxMargin < freeMargin || step !== "trade" ? maxMargin : freeMargin;
    setMarginInput(formatUsdc(fitted, { grouping: false }));
    open.reset();
  }

  async function submit() {
    if (!margin || marginError) return;
    const result = await track(
      () => open.mutateAsync({ marketId: market.id, side, margin, leverage }),
      {
        pending: `Opening ${sideLabel} ${market.id} ${leverage}×…`,
        success: `${side === "long" ? "Long" : "Short"} ${market.id} ${leverage}× opened · ${formatUsd(preview.size)}`,
        errorInline: true,
      },
    );
    if (result) setMarginInput("");
  }

  let action: ReactNode;
  if (step === null || (step !== "connect" && !account)) {
    action = <Skeleton className="h-12 w-full" />;
  } else if (step === "connect") {
    action = (
      <div className="flex flex-col gap-2">
        <p className="text-ui text-muted-foreground">Connect a NEAR testnet wallet to start.</p>
        <Button
          data-primary=""
          size="lg"
          className="w-full"
          disabled={!wallet.isReady}
          onClick={async () => {
            setConnectError(null);
            try {
              await wallet.signIn();
            } catch (e) {
              setConnectError(e instanceof Error ? e.message : "Could not open the wallet. Try again.");
            }
          }}
        >
          {wallet.isReady ? "Connect wallet" : "Loading wallet…"}
        </Button>
        {connectError ?? wallet.error ? (
          <FieldMessage tone="error">{connectError ?? wallet.error?.message}</FieldMessage>
        ) : null}
      </div>
    );
  } else if (step === "fund" && account) {
    action = (
      <div className="flex flex-col gap-2">
        <p className="text-ui text-muted-foreground">You need test USDC to trade. It&apos;s free.</p>
        <FaucetButton account={account} primary />
      </div>
    );
  } else if (step === "deposit" && account) {
    action = (
      <div className="flex flex-col gap-2">
        <p className="text-ui text-muted-foreground">Move test USDC into your margin account.</p>
        <DepositMarginForm account={account} primary />
      </div>
    );
  } else {
    action = (
      <div className="flex flex-col gap-2">
        <Button
          data-primary=""
          data-testid="open-position"
          variant={side}
          size="lg"
          className="w-full"
          disabled={!margin || Boolean(marginError) || open.isPending || !status.open}
          onClick={submit}
        >
          {open.isPending ? "Opening…" : `Open ${sideLabel} ${market.id}`}
        </Button>
        {!status.open ? (
          <FieldMessage tone="error">{status.label}: this market takes no new positions right now.</FieldMessage>
        ) : null}
        {refusal ? (
          <div role="alert" data-testid="order-error" className="flex flex-col gap-2 rounded-md border border-destructive/50 p-3">
            <p className="text-ui text-destructive">{refusal.message}</p>
            {capUsdc !== undefined && capUsdc > 0n ? (
              <Button variant="outline" size="sm" className="w-fit" onClick={() => applyMaxSize(capUsdc)}>
                Use max size ({formatUsd(capUsdc, { maxFractionDigits: 0 })})
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section aria-labelledby="ticket-title" className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="ticket-title" className="text-ui font-medium text-foreground">
          Open a position
        </h2>
        <span className="text-label text-tertiary">Isolated margin · vault is the counterparty</span>
      </div>

      {account && step === "trade" ? (
        <div className="flex flex-col gap-3 rounded-md bg-muted px-3 py-2.5">
          <dl className="grid grid-cols-2 gap-2">
            <div className="flex flex-col">
              <dt className="text-label text-tertiary">Free margin</dt>
              <dd className="text-ui font-medium tabular-nums text-foreground" data-testid="free-margin">
                {formatUsd(freeMargin)}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-label text-tertiary">Wallet tUSDC</dt>
              <dd className="text-ui tabular-nums text-muted-foreground">{formatUsd(account.usdcBalance)}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap items-center gap-1">
            <Button variant="ghost" size="sm" aria-expanded={showDeposit} onClick={() => setShowDeposit((v) => !v)}>
              Deposit margin
            </Button>
            <FaucetButton account={account} primary={false} />
          </div>
          {showDeposit ? <DepositMarginForm account={account} primary={false} /> : null}
        </div>
      ) : null}

      <p className="text-ui text-muted-foreground">
        Long if you think the price goes up, short if it goes down.
      </p>

      <SideToggle
        side={side}
        onChange={(next) => {
          setSide(next);
          open.reset();
        }}
      />

      <Field>
        <div className="flex items-baseline justify-between">
          <FieldLabel htmlFor="order-margin">Margin (USDC)</FieldLabel>
          {step === "trade" ? (
            <button
              type="button"
              onClick={() => setMarginInput(formatUsdc(freeMargin, { grouping: false }))}
              className="rounded-sm text-label text-tertiary tabular-nums hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              Max {formatUsd(freeMargin)}
            </button>
          ) : null}
        </div>
        <Input
          id="order-margin"
          name="order-margin"
          inputMode="decimal"
          autoComplete="off"
          placeholder="100"
          value={marginInput}
          aria-invalid={marginError ? true : undefined}
          onChange={(event) => {
            setMarginInput(event.target.value);
            open.reset();
          }}
        />
        {marginError ? <FieldMessage tone="error">{marginError}</FieldMessage> : null}
      </Field>

      <Field>
        <div className="flex items-baseline justify-between">
          <FieldLabel htmlFor="order-leverage">Leverage</FieldLabel>
          <span className="text-ui font-medium tabular-nums text-foreground" data-testid="leverage-value">
            {leverage}×
          </span>
        </div>
        <input
          id="order-leverage"
          type="range"
          min={1}
          max={market.max_leverage}
          step={1}
          value={leverage}
          onChange={(event) => {
            setLeverageChoice(Number(event.target.value));
            open.reset();
          }}
          className="h-5 w-full accent-foreground"
        />
        <div className="flex gap-1">
          {LEVERAGE_PRESETS.filter((x) => x <= market.max_leverage).map((x) => (
            <Button
              key={x}
              variant={x === leverage ? "secondary" : "ghost"}
              size="xs"
              onClick={() => {
                setLeverageChoice(x);
                open.reset();
              }}
            >
              {x}×
            </Button>
          ))}
          <span className="ml-auto self-center text-label text-tertiary">max {market.max_leverage}× today</span>
        </div>
      </Field>

      <dl className="flex flex-col gap-2 border-t border-border pt-3">
        <Row label="Position size">{formatUsd(preview.size)}</Row>
        <Row label="Entry price (oracle)">
          {market.price > 0n ? formatPrice(market.price) : "—"}
          {!priceFresh && market.price > 0n ? <span className="text-warning"> · refreshing</span> : null}
        </Row>
        <Row label="Liquidation price">
          {preview.size > 0n && preview.liquidationPrice > 0n ? formatPrice(preview.liquidationPrice) : "—"}
        </Row>
        <Row label="Opening fee (0.1%)">{formatUsd(preview.openFee)}</Row>
        <Row label="Borrow fee">{borrowRatePercent(preview.borrowRatePerHour)} / hour</Row>
        <Row label={`Cap left for ${sideLabel}s`} tone={preview.exceedsCap ? "warning" : undefined}>
          {formatUsd(preview.capRoom, { maxFractionDigits: 0 })}
        </Row>
      </dl>
      {preview.exceedsCap && preview.size > 0n ? (
        <p className="text-label text-warning">
          This size is above what NEAR Intents can absorb on exit right now; the contract will refuse it.
        </p>
      ) : null}

      {action}
    </section>
  );
}
