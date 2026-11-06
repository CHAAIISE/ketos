import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Container, Eyebrow } from "@/components/ui/page-shell";

const incidents = [
  {
    title: "Hyperliquid HLP / JELLY · March 2025",
    body: "A thin JELLYJELLY market left HLP with about $13.5M of unrealized loss before validators voted to delist and force-close positions.",
    source: "CoinDesk, 26 March 2025",
    href: "https://www.coindesk.com/markets/2025/03/26/hyperliquid-delists-jellyjelly-after-vault-squeezed-in-usd13m-tussle",
  },
  {
    title: "GMX / AVAX · September 2022",
    body: "Price manipulation on GMX v1’s AVAX/USD market took around $565,000. The loss fell on GLP holders, the trading counterparty.",
    source: "Cointelegraph",
    href: "https://cointelegraph.com/news/decentralized-exchange-gmx-suffers-565k-price-manipulation-exploit",
  },
];

export function RiskSection() {
  return (
    <section id="risk" aria-labelledby="risk-title" className="scroll-mt-8">
      <Container className="grid max-w-landing gap-8 md:grid-cols-2 md:gap-12 md:px-12">
        <div className="flex flex-col items-start gap-4">
          <Eyebrow>Why liquidity limits matter</Eyebrow>
          <h2 id="risk-title" className="font-display text-title">A price is not an exit.</h2>
          <p className="text-body text-muted-foreground">Ketos caps new positions against measured exits and vault capital. Limits reduce exposure; they do not guarantee fills or vault solvency.</p>
          <p className="text-ui text-muted-foreground">Quotes are nonbinding. The contract trusts keeper reports, not proof of hedging liquidity. Existing positions keep their size when a cap falls. Leverage and vault deposits can lose money.</p>
          <Link href="/risk" className="rounded-sm text-ui underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Explore the risks →</Link>
        </div>
        <div className="flex flex-col gap-6">
          {incidents.map((incident) => <article key={incident.title} className="flex flex-col gap-3 border-l border-border pl-5"><h3 className="text-ui font-medium">{incident.title}</h3><p className="text-ui text-muted-foreground">{incident.body}</p><a href={incident.href} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1 rounded-sm text-label text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">{incident.source}<ArrowUpRight aria-hidden className="size-3.5" /></a></article>)}
        </div>
      </Container>
    </section>
  );
}
