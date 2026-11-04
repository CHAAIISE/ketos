import * as React from "react"
import { cn } from "@/lib/utils"

type PanelTab<T extends string> = {
  id: T
  label: React.ReactNode
  /** Extra attributes for the tab button, e.g. a test id. */
  testId?: string
}

/**
 * Underlined tab row at the top of a panel. Renders the tablist only; the caller renders the
 * panel with `id={`${idPrefix}-panel`}` and `aria-labelledby={`${idPrefix}-tab-${value}`}`.
 */
function PanelTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
  className,
  children,
}: {
  tabs: readonly PanelTab<T>[]
  value: T
  onChange: (id: T) => void
  label: string
  idPrefix: string
  className?: string
  /** Content aligned to the right end of the tab row. */
  children?: React.ReactNode
}) {
  return (
    <div className={cn("flex h-9 shrink-0 items-stretch justify-between gap-2 border-b border-border", className)}>
      <div role="tablist" aria-label={label} className="flex min-w-0 items-stretch overflow-x-auto [scrollbar-width:none]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={value === tab.id}
            aria-controls={`${idPrefix}-panel`}
            data-testid={tab.testId}
            onClick={() => onChange(tab.id)}
            className="relative shrink-0 px-3 text-ui whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-selected:text-foreground aria-selected:after:absolute aria-selected:after:inset-x-0 aria-selected:after:bottom-0 aria-selected:after:h-px aria-selected:after:bg-foreground"
          >
            {tab.label}
          </button>
        ))}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2 pr-3">{children}</div> : null}
    </div>
  )
}

export { PanelTabs, type PanelTab }
