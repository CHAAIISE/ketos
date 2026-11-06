import { ArrowUpRight } from "lucide-react";
import { Container, Eyebrow } from "@/components/ui/page-shell";

const incidents = [
  {
    when: "March 2025",
    title: "Hyperliquid HLP and JELLY",
    body: "A thin JELLYJELLY market left the HLP vault with about $13.5M of unrealized loss before delisting. Validators voted to delist the token and force-close positions.",
    source: {
      label: "CoinDesk, 26 March 2025",
      href: "https://www.coindesk.com/markets/2025/03/26/hyperliquid-delists-jellyjelly-after-vault-squeezed-in-usd13m-tussle",
    },
  },
  {
    when: "September 2022",
    title: "GMX and AVAX",
    body: "Price manipulation on the GMX v1 AVAX/USD market took around $565,000, and the loss landed on GLP holders, the pool on the other side of every trade.",
    source: {
      label: "Cointelegraph",
      href: "https://cointelegraph.com/news/decentralized-exchange-gmx-suffers-565k-price-manipulation-exploit",
    },
  },
];

export function Why() {
  return (
    <section id="why" aria-labelledby="why-title" className="scroll-mt-8">
      <Container className="flex flex-col gap-16">
        <div className="flex flex-col items-center gap-4 text-center">
          <Eyebrow>Why limits come from liquidity</Eyebrow>
          <h2 id="why-title" className="max-w-2xl font-display text-title">
            Vaults break when positions outgrow the exit.
          </h2>
        </div>
        <div className="mx-auto flex w-full max-w-reading flex-col gap-12">
          {incidents.map((incident) => (
            <article key={incident.title} className="flex flex-col gap-3 border-l border-border pl-6">
              <p className="text-label text-tertiary">{incident.when}</p>
              <h3 className="text-subtitle text-foreground">{incident.title}</h3>
              <p className="text-body text-muted-foreground">{incident.body}</p>
              <a
                href={incident.source.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-fit items-center gap-1 rounded-sm text-ui text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Source: {incident.source.label}
                <ArrowUpRight aria-hidden className="size-3.5" />
              </a>
            </article>
          ))}
          <p className="text-body text-muted-foreground">
            In both cases the vault was exposed to more than the market behind the price could absorb.{" "}
            <span className="text-foreground">
              Ketos limits new positions using what NEAR Intents solvers quote within 1%, measured off chain
              by the keeper and enforced by the contract alongside vault-capital and protocol limits.
            </span>
          </p>
          <p className="text-body text-muted-foreground">
            Quotes are nonbinding and the contract trusts the keeper&apos;s reports. They are a proxy for exit
            liquidity, not proof that solvers can hedge on the oracle&apos;s reference venues. Existing positions
            are not forcibly resized when a limit falls.
          </p>
        </div>
      </Container>
    </section>
  );
}
