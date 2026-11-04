import Link from "next/link";
import { Logo } from "@/components/logo";
import { Container } from "@/components/ui/page-shell";
import { networkName } from "@/lib/near/config";

const linkClass =
  "rounded-sm text-ui text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const navLinks = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#why", label: "Why" },
  { href: "/liquidity", label: "Liquidity" },
] as const;

const footerLinks = [
  { href: "/trade", label: "Trade" },
  { href: "/vault", label: "Vault" },
  { href: "/liquidity", label: "Liquidity" },
  { href: "/#how-it-works", label: "How it works" },
] as const;

export function LandingNav() {
  return (
    <header>
      <Container className="flex h-16 items-center justify-between gap-6">
        <Link href="/" className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <Logo height={16} />
        </Link>
        <nav aria-label="Site" className="flex items-center gap-5 md:gap-8">
          {navLinks.map((link) => (
            <Link key={link.href} href={link.href} className={linkClass}>
              {link.label}
            </Link>
          ))}
        </nav>
      </Container>
    </header>
  );
}

const FADE_ID = "ketos-footer-fade";

export function LandingFooter() {
  return (
    <footer className="overflow-hidden border-t border-border">
      <Container className="flex flex-col gap-6 pt-16 md:flex-row md:items-center md:justify-between">
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-3">
          {footerLinks.map((link) => (
            <Link key={link.href} href={link.href} className={linkClass}>
              {link.label}
            </Link>
          ))}
        </nav>
        <p className="text-label text-tertiary">Built at NEAR HACKATHON · {networkName()}</p>
      </Container>
      <Container className="pt-16">
        <svg aria-hidden width="0" height="0" className="absolute">
          <defs>
            <linearGradient id={FADE_ID} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style={{ stopColor: "var(--foreground)", stopOpacity: 0.25 }} />
              <stop offset="1" style={{ stopColor: "var(--foreground)", stopOpacity: 0 }} />
            </linearGradient>
          </defs>
        </svg>
        <Logo aria-hidden role="presentation" fill={`url(#${FADE_ID})`} className="-mb-[4%] h-auto w-full" />
      </Container>
    </footer>
  );
}
