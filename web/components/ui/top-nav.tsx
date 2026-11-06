"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Logo } from "@/components/logo"
import { cn } from "@/lib/utils"

const appLinks = [
  { href: "/trade", label: "Trade" },
  { href: "/vaults", label: "Earn" },
  { href: "/markets", label: "Propose a market" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/risk", label: "Risk" },
] as const

function TopNav({
  actions,
  className,
  ...props
}: React.ComponentProps<"header"> & { actions?: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <header
      data-slot="top-nav"
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-3 border-b border-border bg-background px-3 lg:h-nav lg:flex-nowrap lg:gap-6 lg:px-4",
        className
      )}
      {...props}
    >
      <Link
        href="/"
        className="flex h-nav shrink-0 items-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:h-auto"
      >
        <Logo height={16} />
      </Link>
      <nav
        aria-label="App"
        className="order-last -mx-3 flex w-[calc(100%+1.5rem)] min-w-0 flex-wrap items-center gap-0.5 border-t border-border px-1.5 py-1 lg:order-none lg:mx-0 lg:w-auto lg:flex-nowrap lg:gap-2 lg:border-t-0 lg:px-0 lg:py-0"
      >
        {appLinks.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`)
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className="shrink-0 rounded-md px-1.5 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-[current=page]:text-foreground lg:px-2.5"
            >
              {link.label}
            </Link>
          )
        })}
      </nav>
      {actions ? (
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </header>
  )
}

export { TopNav }
