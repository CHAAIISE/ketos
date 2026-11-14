"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Popover } from "@base-ui/react/popover"
import { Menu } from "lucide-react"
import { Logo } from "@/components/logo"
import { cn } from "@/lib/utils"

const appLinks = [
  { href: "/trade", label: "Trade" },
  { href: "/vaults", label: "Earn" },
  { href: "/launch", label: "Launch" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/markets", label: "Markets" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/risk", label: "Risk" },
] as const

function TopNav({
  actions,
  className,
  ...props
}: React.ComponentProps<"header"> & { actions?: React.ReactNode }) {
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = React.useState(false)
  const links = appLinks.map((link, index) => {
    const active = pathname === link.href || pathname.startsWith(`${link.href}/`)
    return (
      <Link key={link.href} href={link.href} aria-current={active ? "page" : undefined}
        data-primary-link={index < 3 ? "" : undefined} onClick={() => setMenuOpen(false)}
        className="flex h-11 shrink-0 items-center rounded-md px-3 text-ui text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-[current=page]:bg-muted aria-[current=page]:text-foreground lg:h-8">
        {link.label}
      </Link>
    )
  })

  return (
    <header
      data-slot="top-nav"
      className={cn(
        "flex h-nav shrink-0 items-center gap-3 border-b border-border bg-background px-3 lg:gap-5 lg:px-6",
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
      <span data-testid="network-disclosure" title="NEAR testnet · No real funds" className="shrink-0 rounded-sm border border-border px-2 py-1 text-label text-muted-foreground">
        Testnet<span className="hidden xl:inline"> · No real funds</span>
      </span>
      <nav aria-label="App" className="hidden min-w-0 items-center gap-1 lg:flex">
        {links.slice(0, 3)}
      </nav>
      {actions ? (
        <div className="ml-auto flex min-w-0 items-center gap-2">{actions}</div>
      ) : null}
      <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Popover.Trigger aria-label="Navigation menu" className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring lg:h-8 lg:w-auto lg:px-3">
          <Menu className="size-5 lg:hidden" /><span className="hidden text-ui lg:inline">More</span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
            <Popover.Popup className="w-56 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover p-1 outline-none lg:[&_[data-primary-link]]:hidden">
              <nav aria-label="More navigation" className="flex flex-col gap-1">{links}</nav>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </header>
  )
}

export { TopNav }
