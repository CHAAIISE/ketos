import * as React from "react"
import { cn } from "@/lib/utils"
import { TopNav } from "@/components/ui/top-nav"

function AppShell({
  navActions,
  footer,
  className,
  children,
  ...props
}: React.ComponentProps<"main"> & { navActions?: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div data-slot="app-shell" className="flex min-h-dvh flex-1 flex-col bg-background">
      <TopNav actions={navActions} />
      <main
        className={cn("flex flex-1 flex-col gap-1 p-1 text-sm", className)}
        {...props}
      >
        {children}
      </main>
      {footer}
    </div>
  )
}

function PageHeader({
  title,
  description,
  actions,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div
      data-slot="page-header"
      className={cn(
        "flex flex-col gap-4 rounded-lg border border-border bg-card p-4 md:flex-row md:items-center md:justify-between",
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="font-display text-heading text-foreground">{title}</h1>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

function Container({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="container"
      className={cn("mx-auto w-full max-w-content px-gutter-sm md:px-gutter", className)}
      {...props}
    />
  )
}

function Eyebrow({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="eyebrow"
      className={cn("text-eyebrow text-tertiary uppercase", className)}
      {...props}
    />
  )
}

export { AppShell, PageHeader, Container, Eyebrow }
