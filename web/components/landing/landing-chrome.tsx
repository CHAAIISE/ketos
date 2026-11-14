import Link from "next/link";
import { Logo } from "@/components/logo";
import { buttonVariants } from "@/components/ui/button";
import { Container } from "@/components/ui/page-shell";
import { networkName } from "@/lib/near/config";

const linkClass = "inline-flex min-h-11 items-center rounded-sm text-label text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-0 md:text-ui";
const navLinks = [
  { href: "/#markets", label: "Markets" },
  { href: "/#vaults", label: "Earn" },
  { href: "/launch", label: "Launch" },
  { href: "/#risk", label: "Risk" },
] as const;

export function LandingNav() {
  return (
    <header className="border-b border-border">
      <Container className="flex min-h-16 max-w-landing flex-wrap items-center justify-between gap-x-4 gap-y-3 py-4 md:flex-nowrap md:px-12">
        <Link href="/" aria-label="Ketos home" className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <Logo height={20} />
        </Link>
        <span data-testid="network-disclosure" className="shrink-0 rounded-sm border border-border px-2 py-1 text-label text-muted-foreground">
          Testnet · No real funds
        </span>
        <nav aria-label="Site" className="order-3 flex w-full items-center justify-between gap-3 md:order-none md:ml-auto md:w-auto md:justify-start md:gap-8">
          {navLinks.map((link) => <Link key={link.href} href={link.href} className={linkClass}>{link.label}</Link>)}
        </nav>
        <Link href="/trade" className={buttonVariants({ size: "sm", className: "rounded-full md:ml-4" })}>Trade</Link>
      </Container>
    </header>
  );
}

export function LandingFooter() {
  return (
    <footer className="border-t border-border">
      <Container className="flex max-w-landing flex-col gap-6 py-8 md:flex-row md:items-center md:justify-between md:px-12">
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-3">
          <Link href="/trade" className={linkClass}>Trade</Link>
          <Link href="/markets" className={linkClass}>Markets</Link>
          <Link href="/vaults" className={linkClass}>Earn</Link>
          <Link href="/portfolio" className={linkClass}>Portfolio</Link>
          <Link href="/risk" className={linkClass}>Risk</Link>
        </nav>
        <p className="text-label text-tertiary">Built at NEAR HACKATHON · {networkName()}</p>
      </Container>
    </footer>
  );
}
