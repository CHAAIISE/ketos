import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Logo } from "@/components/logo";
import { buttonVariants } from "@/components/ui/button";
import { Container } from "@/components/ui/page-shell";
import { ExitLiquidity } from "./exit-liquidity";

export function Hero() {
  return (
    <section aria-labelledby="hero-title">
      <Container className="grid gap-16 pt-12 md:grid-cols-12 md:items-center md:gap-12 md:pt-20">
        <div className="flex flex-col items-start gap-8 md:col-span-5">
          <Logo height={72} className="hidden md:block" />
          <Logo height={48} className="md:hidden" />
          <div className="flex flex-col gap-5">
            <h1 id="hero-title" className="font-display text-title text-foreground">
              Perps on NEAR, sized by real liquidity.
            </h1>
            <p className="max-w-md text-body text-muted-foreground">
              Traders take leverage against an LP vault. New positions are limited by the latest{" "}
              <span className="text-foreground">NEAR Intents</span> quotes within{" "}
              <span className="text-foreground">1% price impact</span>, vault capital and protocol caps.
              Old measurements pause entries; trading actions fetch a fresh price when needed.
            </p>
          </div>
          <Link href="/trade" data-primary className={buttonVariants({ size: "pill", className: "mt-4" })}>
            Launch app
            <ArrowRight aria-hidden />
          </Link>
        </div>
        <div className="min-w-0 md:col-span-7">
          <ExitLiquidity />
        </div>
      </Container>
    </section>
  );
}
