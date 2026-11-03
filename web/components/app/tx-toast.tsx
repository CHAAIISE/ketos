"use client";

import { createContext, use, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ExternalLink, Loader2, X } from "lucide-react";
import { useNear } from "@/hooks/near-provider";
import type { TxReceipt } from "@/hooks/use-perps-mutations";
import { txExplorerUrl } from "@/lib/near/explorer";
import { toNearActionError } from "@/lib/near/errors";
import { cn } from "@/lib/utils";

type ToastTone = "pending" | "success" | "error";

interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
  href?: string | null;
}

interface TrackLabels<T> {
  /** Shown while the wallet signs and the transaction executes, e.g. "Opening long NEAR…". */
  pending: string;
  /** Title once the transaction succeeded; may depend on the parsed result. */
  success: string | ((result: T) => string);
  /** Optional second line on success. */
  successDescription?: (result: T) => string | undefined;
  /** The caller shows the error next to the form, so no error toast. */
  errorInline?: boolean;
}

interface TxToastValue {
  /**
   * Shows a pending toast for `run`, then a success toast with the explorer link or an error
   * toast with the contract error in plain words. Resolves to the result, or null on failure.
   */
  track<T extends TxReceipt>(run: () => Promise<T>, labels: TrackLabels<T>): Promise<T | null>;
  dismiss(id: number): void;
}

const TxToastContext = createContext<TxToastValue | null>(null);

const SUCCESS_MS = 8_000;
const ERROR_MS = 12_000;

export function TxToastProvider({ children }: { children: ReactNode }) {
  const { config } = useNear();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);

  const track = useCallback<TxToastValue["track"]>(
    async (run, labels) => {
      const id = nextId.current++;
      setToasts((all) => [...all, { id, tone: "pending", title: labels.pending }]);
      const settle = (toast: Omit<Toast, "id">, ms: number) => {
        setToasts((all) => all.map((t) => (t.id === id ? { id, ...toast } : t)));
        setTimeout(() => dismiss(id), ms);
      };
      try {
        const result = await run();
        settle(
          {
            tone: "success",
            title: typeof labels.success === "function" ? labels.success(result) : labels.success,
            description: labels.successDescription?.(result),
            href: txExplorerUrl(config.network, result.txHash),
          },
          SUCCESS_MS,
        );
        return result;
      } catch (error) {
        if (labels.errorInline) dismiss(id);
        else settle({ tone: "error", title: toNearActionError(error).message }, ERROR_MS);
        return null;
      }
    },
    [config.network, dismiss],
  );

  const value = useMemo(() => ({ track, dismiss }), [track, dismiss]);

  return (
    <TxToastContext value={value}>
      {children}
      <ol
        aria-live="polite"
        aria-label="Transactions"
        className="pointer-events-none fixed right-3 bottom-3 left-3 z-50 flex flex-col items-start gap-2 md:right-auto md:w-96"
      >
        {toasts.map((toast) => (
          <li
            key={toast.id}
            data-testid="tx-toast"
            data-tone={toast.tone}
            className={cn(
              "pointer-events-auto flex w-full animate-in items-start gap-3 rounded-lg border border-border bg-card p-3 text-ui fade-in slide-in-from-bottom-2 duration-200",
              "data-[tone=error]:border-destructive/50 data-[tone=success]:border-success/40",
            )}
          >
            <span aria-hidden className="mt-0.5 shrink-0">
              {toast.tone === "pending" ? (
                <Loader2 strokeWidth={1.5} className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
              ) : toast.tone === "success" ? (
                <Check strokeWidth={1.5} className="size-4 text-success" />
              ) : (
                <X strokeWidth={1.5} className="size-4 text-destructive" />
              )}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="text-foreground">{toast.title}</p>
              {toast.description ? <p className="text-muted-foreground">{toast.description}</p> : null}
              {toast.href ? (
                <a
                  href={toast.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex w-fit items-center gap-1 text-label text-tertiary hover:text-foreground"
                >
                  View on explorer <ExternalLink strokeWidth={1.5} className="size-3" />
                </a>
              ) : null}
            </div>
            {toast.tone !== "pending" ? (
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => dismiss(toast.id)}
                className="shrink-0 rounded-sm text-tertiary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                <X strokeWidth={1.5} className="size-3.5" />
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </TxToastContext>
  );
}

export function useTxToast(): TxToastValue {
  const value = use(TxToastContext);
  if (!value) throw new Error("useTxToast must be used inside <TxToastProvider>");
  return value;
}
