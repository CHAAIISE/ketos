import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Container } from "@/components/ui/page-shell";

export function Hero() {
  return (
    <section aria-labelledby="hero-title">
      <Container className="max-w-landing py-12 md:px-landing-gutter md:py-landing-hero">
        <div className="flex flex-col items-start gap-6">
          <h1 id="hero-title" className="font-display text-display-sm text-foreground md:text-display">
            Perps on NEAR.<br />Sized by real liquidity.
          </h1>
          <p className="max-w-reading text-body text-muted-foreground">
            Trade with leverage. Every market is capped by measured exit liquidity and vault capital.
          </p>
          <div className="flex flex-wrap items-center gap-6">
            <Link href="/trade" data-primary className={buttonVariants({ size: "pill" })}>
              Start trading <ArrowRight aria-hidden />
            </Link>
            <Link href="#how-it-works" className="rounded-sm text-ui text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              How it works
            </Link>
          </div>
        </div>
      </Container>
    </section>
  );
}
