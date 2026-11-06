import { PublicRoutePreview } from "@/components/app/route-preview";
import { ExitLiquidity } from "@/components/landing/exit-liquidity";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Hero } from "@/components/landing/hero";
import { LandingFooter, LandingNav } from "@/components/landing/landing-chrome";
import { LiveStrip } from "@/components/landing/live-strip";
import { MarketsPreview } from "@/components/landing/markets-preview";
import { RiskSection } from "@/components/landing/risk-section";
import { VaultsSection } from "@/components/landing/vaults-section";
import { Container, Eyebrow } from "@/components/ui/page-shell";
import { networkName } from "@/lib/near/config";
import { ReadOnlyNearProvider } from "@/hooks/near-provider";

export default function Home() {
  return (
    <ReadOnlyNearProvider>
      <div className="flex min-h-dvh flex-1 flex-col">
        <LandingNav />
        <main className="flex flex-1 flex-col pb-16 md:pb-24">
          <Hero />
          <div className="flex flex-col gap-16 md:gap-24">
            <MarketsPreview />
            <ExitLiquidity />
            <Container className="max-w-landing md:px-12"><PublicRoutePreview /></Container>
            <HowItWorks />
            <RiskSection />
            <VaultsSection />
            <section aria-labelledby="live-title">
              <Container className="flex max-w-landing flex-col gap-6 md:px-12">
                <Eyebrow id="live-title">Activity on {networkName()}</Eyebrow>
                <LiveStrip />
              </Container>
            </section>
          </div>
        </main>
        <LandingFooter />
      </div>
    </ReadOnlyNearProvider>
  );
}
