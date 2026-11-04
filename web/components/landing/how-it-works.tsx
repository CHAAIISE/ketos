import type { ReactNode } from "react";
import { Container, Eyebrow } from "@/components/ui/page-shell";
import { nearConfig, networkName } from "@/lib/near/config";
import { cn } from "@/lib/utils";

function Block({ title, detail, className }: { title: string; detail: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "relative flex min-h-20 min-w-0 flex-col justify-center gap-1 rounded-lg border border-foreground/10 bg-background px-4 py-3 md:h-20",
        className,
      )}
    >
      <span className="text-sm font-medium text-foreground md:truncate">{title}</span>
      <span className="text-label wrap-anywhere text-tertiary md:truncate">{detail}</span>
    </div>
  );
}

const dash = "border-dashed border-accent";

function Diagram() {
  const intents = <Block title="NEAR Intents" detail="1Click dry quotes, mainnet" />;
  const depth = <Block title="Depth" detail="set_depth · 48 samples per asset" />;
  const ketos = <Block title="Perps contract" detail="markets · margin · orders · vaults" />;
  const traders = <Block title="Traders" detail="long / short, isolated or cross" />;
  const vault = <Block title="Vaults" detail="Core and Long-tail, counterparty" />;
  const oracleDetail = `${nearConfig().network === "testnet" ? "OutLayer" : "price oracle"} on ${networkName()}`;

  return (
    <>
      {/* Wide screens: one row from quotes to contract, the oracle below it, a fork to traders and vault. */}
      <div
        className="hidden grid-cols-[minmax(0,1fr)_2.5rem_minmax(0,1fr)_2.5rem_minmax(0,1fr)_3.5rem_minmax(0,1fr)] grid-rows-[5rem_5rem_5rem] gap-y-6 md:grid"
        role="img"
        aria-label="NEAR Intents 1Click quotes feed Depth, Depth feeds the Perps contract, the OutLayer price oracle feeds the Perps contract, and the Perps contract serves Traders and the Vaults."
      >
        <div className="col-start-1 row-start-2">{intents}</div>
        <div className={cn("col-start-2 row-start-2 self-center border-t", dash)} />
        <div className="col-start-3 row-start-2">{depth}</div>
        <div className={cn("col-start-4 row-start-2 self-center border-t", dash)} />
        <div className="col-start-5 row-start-2">{ketos}</div>
        <div className="col-start-5 row-start-3">
          <Block
            title="OutLayer price oracle"
            detail={oracleDetail}
            className={cn("before:absolute before:-top-6.5 before:left-1/2 before:h-6 before:border-l", "before:border-dashed before:border-accent")}
          />
        </div>
        <div className="relative col-start-6 row-span-3 row-start-1">
          <div className={cn("absolute top-1/2 left-0 w-1/2 border-t", dash)} />
          <div className={cn("absolute top-10 bottom-10 left-1/2 border-l", dash)} />
          <div className={cn("absolute top-10 right-0 left-1/2 border-t", dash)} />
          <div className={cn("absolute right-0 bottom-10 left-1/2 border-t", dash)} />
        </div>
        <div className="col-start-7 row-start-1">{traders}</div>
        <div className="col-start-7 row-start-3">{vault}</div>
      </div>

      {/* Narrow screens: the chain runs down the left column, oracle and vault sit on the right. */}
      <div
        className="grid grid-cols-2 gap-x-6 md:hidden"
        role="img"
        aria-label="NEAR Intents 1Click quotes feed Depth, Depth feeds the Perps contract, the OutLayer price oracle feeds the Perps contract, and the Perps contract serves Traders and the Vaults."
      >
        <div className="col-start-1">{intents}</div>
        <div className={cn("col-start-1 mx-auto h-6 border-l", dash)} />
        <div className="col-start-1">{depth}</div>
        <div className={cn("col-start-1 mx-auto h-6 border-l", dash)} />
        <div className="col-start-1">{ketos}</div>
        <div className="col-start-2">
          <Block
            title="OutLayer oracle"
            detail={oracleDetail}
            className={cn("before:absolute before:top-1/2 before:-left-6.5 before:w-6 before:border-t", "before:border-dashed before:border-accent")}
          />
        </div>
        <div className="relative col-span-2 h-8">
          <div className={cn("absolute top-0 bottom-0 left-[calc((100%-1.5rem)/4)] border-l", dash)} />
          <div
            className={cn("absolute top-1/2 right-[calc((100%-1.5rem)/4)] left-[calc((100%-1.5rem)/4)] border-t", dash)}
          />
          <div className={cn("absolute top-1/2 right-[calc((100%-1.5rem)/4)] bottom-0 border-l", dash)} />
        </div>
        <div className="col-start-1">{traders}</div>
        <div className="col-start-2">{vault}</div>
      </div>
    </>
  );
}

const steps = [
  {
    number: "01",
    title: "Measure",
    body: (
      <>
        A keeper asks NEAR Intents 1Click for dry quotes to sell <span className="text-foreground">$1k to $1M</span>{" "}
        of every listed token into USDC, and writes the price impact of each size to the contract.
      </>
    ),
  },
  {
    number: "02",
    title: "Cap",
    body: (
      <>
        Exit capacity is the largest size that moves the price <span className="text-foreground">1% or less</span>.
        Open interest (total size of open positions) per side is capped at it, and max leverage steps from 2× to
        20× with depth. A sample older than 30 minutes pauses new positions.
      </>
    ),
  },
  {
    number: "03",
    title: "Trade",
    body: (
      <>
        Traders go long or short against an LP vault at OutLayer oracle prices, with market, limit, stop, take
        profit and stop loss orders. Anything above the cap is{" "}
        <span className="text-foreground">refused on chain</span>, triggered orders included, so a vault never
        takes on more than the measured exit.
      </>
    ),
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-it-works-title" className="scroll-mt-8">
      <Container className="flex flex-col gap-16">
        <div className="flex flex-col items-center gap-4 text-center">
          <Eyebrow>How it works</Eyebrow>
          <h2 id="how-it-works-title" className="font-display text-title">
            Measure. Cap. Trade.
          </h2>
        </div>
        <div className="mx-auto w-full max-w-5xl">
          <Diagram />
        </div>
        <ol className="mx-auto grid w-full max-w-5xl gap-10 md:grid-cols-3 md:gap-12">
          {steps.map((step) => (
            <li key={step.number} className="flex flex-col gap-3">
              <span className="text-label text-tertiary tabular-nums">{step.number}</span>
              <h3 className="text-subtitle text-foreground">{step.title}</h3>
              <p className="text-body text-muted-foreground">{step.body}</p>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}
