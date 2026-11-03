"use client";

import type { ReactNode } from "react";
import { Tooltip } from "@base-ui/react/tooltip";

/** A label with a dotted underline that explains itself on hover or focus. */
export function Term({ children, hint }: { children: ReactNode; hint: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={150}
        render={<span tabIndex={0} />}
        className="cursor-help rounded-sm underline decoration-tertiary/70 decoration-dotted underline-offset-4 outline-none focus-visible:outline-2 focus-visible:outline-ring"
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6} className="z-50">
          <Tooltip.Popup className="max-w-64 rounded-md border border-border bg-popover px-3 py-2 text-label font-normal text-muted-foreground normal-case">
            {hint}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
