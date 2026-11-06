import { Container, Eyebrow } from "@/components/ui/page-shell";

const steps = [
  { title: "Measure", body: "A keeper requests real NEAR Intents sell quotes into USDC. The measured exit is the largest size before a missing quote or impact above 1%." },
  { title: "Cap", body: "The contract limits each market by admitted exit liquidity, vault capital and protocol limits. Depth older than 30 minutes pauses new positions." },
  { title: "Trade", body: "Go long or short against a vault at oracle prices. Execution checks fresh prices and effective limits. Existing positions are not resized when a cap falls." },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-it-works-title" className="scroll-mt-8">
      <Container className="flex max-w-landing flex-col gap-8 md:px-12">
        <div className="flex flex-col gap-4"><Eyebrow>How it works</Eyebrow><h2 id="how-it-works-title" className="font-display text-title">Measure → Cap → Trade</h2></div>
        <ol className="grid gap-8 border-t border-border pt-8 md:grid-cols-3">
          {steps.map((step, i) => <li key={step.title} className="flex flex-col gap-3"><span className="text-label text-tertiary">0{i + 1}</span><h3 className="text-subtitle">{step.title}</h3><p className="text-body text-muted-foreground">{step.body}</p></li>)}
        </ol>
      </Container>
    </section>
  );
}
