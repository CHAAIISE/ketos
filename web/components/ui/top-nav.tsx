"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Logo } from "@/components/logo"
import { cn } from "@/lib/utils"

const appLinks = [
  { href: "/trade", label: "Trade" },
  { href: "/markets", label: "Markets" },
  { href: "/vaults", label: "Vaults" },
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
        "flex shrink-0 flex-wrap items-center gap-x-3 border-b border-border bg-background px-3 md:h-nav md:flex-nowrap md:gap-6 md:px-4",
        className
      )}
      {...props}
    >
      <Link
        href="/"
        className="flex h-nav shrink-0 items-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-auto"
      >
        <Logo height={16} />
      </Link>
      <nav
        aria-label="App"
        className="order-last -mx-3 flex h-9 w-[calc(100%+1.5rem)] min-w-0 items-center gap-0.5 overflow-x-auto border-t border-border px-1.5 [scrollbar-width:none] md:order-none md:mx-0 md:h-auto md:w-auto md:gap-2 md:border-t-0 md:px-0"
      >
        {appLinks.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`)
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className="shrink-0 rounded-md px-1.5 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-[current=page]:text-foreground md:px-2.5"
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
