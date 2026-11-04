import { HowItWorks } from "@/components/landing/how-it-works";
import { Hero } from "@/components/landing/hero";
import { LandingFooter, LandingNav } from "@/components/landing/landing-chrome";
import { LiveStrip } from "@/components/landing/live-strip";
import { MarketsPreview } from "@/components/landing/markets-preview";
import { RiskSection } from "@/components/landing/risk-section";
import { VaultsSection } from "@/components/landing/vaults-section";
import { Why } from "@/components/landing/why";
import { Container, Eyebrow } from "@/components/ui/page-shell";
import { networkName } from "@/lib/near/config";
import { NearProvider } from "@/hooks/near-provider";

export default function Home() {
  return (
    <NearProvider>
      <div className="flex min-h-dvh flex-1 flex-col">
        <LandingNav />
        <main className="flex flex-1 flex-col gap-24 pb-24 md:gap-section md:pb-section">
          <Hero />
          <section aria-labelledby="live-title">
            <Container className="flex flex-col gap-8">
              <Eyebrow id="live-title">Live on {networkName()}</Eyebrow>
              <LiveStrip />
            </Container>
          </section>
          <MarketsPreview />
          <Why />
          <HowItWorks />
          <VaultsSection />
          <RiskSection />
        </main>
        <LandingFooter />
      </div>
    </NearProvider>
  );
}
