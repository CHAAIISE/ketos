import type { ComponentProps, ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { networkName } from "@/lib/near/config";
import { cn } from "@/lib/utils";

/** Loading placeholder; size it to the final content so nothing jumps when data arrives. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

/** A read that failed: what happened and a retry. */
export function ErrorState({
  title = `Could not reach ${networkName()}.`,
  error,
  onRetry,
  className,
}: {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-destructive/50 bg-card p-4 text-ui sm:flex-row sm:items-center",
        className,
      )}
    >
      <AlertTriangle aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-destructive" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-foreground">{title}</p>
        {error instanceof Error ? <p className="truncate text-tertiary">{error.message}</p> : null}
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/** Nothing to show yet: one sentence and, when there is one, the action that fills it. */
export function EmptyState({
  children,
  action,
  className,
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-start gap-3 px-4 py-8 text-ui text-muted-foreground", className)}>
      <p>{children}</p>
      {action}
    </div>
  );
}
