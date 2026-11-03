"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Logo } from "@/components/logo"
import { cn } from "@/lib/utils"

const appLinks = [
  { href: "/trade", label: "Trade" },
  { href: "/vault", label: "Vault" },
  { href: "/liquidity", label: "Liquidity" },
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
        "flex h-nav shrink-0 items-center gap-3 border-b border-border bg-background px-3 md:gap-8 md:px-4",
        className
      )}
      {...props}
    >
      <Link
        href="/"
        className="shrink-0 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Logo height={14} />
      </Link>
      <nav
        aria-label="App"
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] md:gap-1"
      >
        {appLinks.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`)
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className="shrink-0 rounded-md px-1.5 py-1.5 text-ui font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-[current=page]:text-foreground md:px-3"
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
