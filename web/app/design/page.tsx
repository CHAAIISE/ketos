import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { ArrowRight, Wallet } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldLabel, FieldMessage, Input } from "@/components/ui/input"
import { OnboardingSteps, type OnboardingStep } from "@/components/ui/onboarding-steps"
import { AppShell, Eyebrow, PageHeader } from "@/components/ui/page-shell"
import { cn } from "@/lib/utils"

export const metadata: Metadata = {
  title: "Design system",
  robots: { index: false, follow: false },
}

const swatches = [
  { name: "Background", token: "--background", hex: "#000000", className: "bg-background" },
  { name: "Card", token: "--card", hex: "#0B0B0C", className: "bg-card" },
  { name: "Muted / input", token: "--muted", hex: "#151517", className: "bg-muted" },
  { name: "Border", token: "--border", hex: "#1F1F22", className: "bg-border" },
  { name: "Foreground", token: "--foreground", hex: "#FFFFFF", className: "bg-foreground" },
  {
    name: "Muted foreground",
    token: "--muted-foreground",
    hex: "#A3A3A3",
    className: "bg-muted-foreground",
  },
  { name: "Tertiary", token: "--tertiary", hex: "#7A7A7A", className: "bg-tertiary" },
  { name: "Primary", token: "--primary", hex: "#FFFFFF", className: "bg-primary" },
  { name: "Accent / ring", token: "--accent", hex: "#F5B83D", className: "bg-accent" },
  { name: "Success", token: "--success", hex: "#2DBE8C", className: "bg-success" },
  { name: "Destructive", token: "--destructive", hex: "#F0506E", className: "bg-destructive" },
  { name: "Warning", token: "--warning", hex: "#F5B83D", className: "bg-warning" },
] as const

const stepLabels = [
  { id: "wallet", label: "Connect wallet" },
  { id: "faucet", label: "Get USDC" },
  { id: "deposit", label: "Deposit margin" },
  { id: "trade", label: "Open a position" },
] as const

function stepsAt(currentIndex: number): OnboardingStep[] {
  return stepLabels.map((step, index) => ({
    ...step,
    status: index < currentIndex ? "done" : index === currentIndex ? "current" : "todo",
  }))
}

function GallerySection({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-4 rounded-lg border border-border bg-card p-4 md:p-6",
        className
      )}
    >
      <Eyebrow>{label}</Eyebrow>
      {children}
    </section>
  )
}

export default function DesignPage() {
  if (process.env.NODE_ENV === 'production') notFound()

  return (
    <AppShell
      navActions={
        <Button size="sm" data-primary>
          <Wallet />
          Connect wallet
        </Button>
      }
    >
      <PageHeader
        title="Design system"
        description="Tokens and base components. Development only."
        actions={<Badge variant="outline">dev</Badge>}
      />

      <GallerySection label="Onboarding">
        <div className="flex flex-col gap-2">
          <OnboardingSteps steps={stepsAt(0)} />
          <OnboardingSteps steps={stepsAt(2)} />
          <OnboardingSteps steps={stepsAt(4)} />
        </div>
      </GallerySection>

      <div className="grid gap-1 lg:grid-cols-12">
        <GallerySection label="Landing" className="gap-8 bg-background lg:col-span-7">
          <div className="flex flex-col gap-6">
            <h2 className="font-display text-display-sm md:text-display">ketos</h2>
            <p className="font-display text-title">Perps on NEAR, sized by real liquidity.</p>
            <p className="max-w-reading text-body text-muted-foreground">
              Every market&apos;s size limit comes from what can actually be sold on NEAR
              Intents right now. Positions that the market{" "}
              <span className="text-foreground">cannot exit</span> are never opened.
            </p>
            <div>
              <Button size="pill" data-primary>
                Launch app
                <ArrowRight />
              </Button>
            </div>
          </div>
        </GallerySection>

        <GallerySection label="Typography" className="lg:col-span-5">
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-4">
            <dt className="text-label text-tertiary">Title</dt>
            <dd className="font-display text-title">How it works</dd>
            <dt className="text-label text-tertiary">Heading</dt>
            <dd className="font-display text-heading">Vault</dd>
            <dt className="text-label text-tertiary">Subtitle</dt>
            <dd className="text-subtitle">Measure, cap, trade</dd>
            <dt className="text-label text-tertiary">Body</dt>
            <dd className="text-body text-muted-foreground">
              Grey by default, <span className="text-foreground">key words in white</span>.
            </dd>
            <dt className="text-label text-tertiary">Interface</dt>
            <dd className="text-ui">Available to trade</dd>
            <dt className="text-label text-tertiary">Price</dt>
            <dd className="text-price tabular-nums">3.9042</dd>
            <dt className="text-label text-tertiary">Eyebrow</dt>
            <dd>
              <Eyebrow>How it works</Eyebrow>
            </dd>
            <dt className="text-label text-tertiary">Mono</dt>
            <dd className="font-mono text-label text-muted-foreground">
              nep141:wrap.near
            </dd>
          </dl>
        </GallerySection>
      </div>

      <GallerySection label="Palette">
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {swatches.map((swatch) => (
            <li key={swatch.token} className="flex flex-col gap-2">
              <span
                aria-hidden
                className={`h-12 rounded-md border border-border ${swatch.className}`}
              />
              <span className="text-ui text-foreground">{swatch.name}</span>
              <span className="flex justify-between gap-2 text-label text-tertiary">
                <span>{swatch.token}</span>
                <span className="uppercase">{swatch.hex}</span>
              </span>
            </li>
          ))}
        </ul>
      </GallerySection>

      <div className="grid gap-1 lg:grid-cols-2">
        <GallerySection label="Buttons">
          <div className="flex flex-wrap items-center gap-3">
            <Button>Deposit margin</Button>
            <Button variant="secondary">Withdraw</Button>
            <Button variant="outline">Max</Button>
            <Button variant="ghost">Details</Button>
            <Button variant="link">View on explorer</Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="long">Open long</Button>
            <Button variant="short">Open short</Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg">Large</Button>
            <Button size="sm">Small</Button>
            <Button size="xs" variant="secondary">
              Extra small
            </Button>
            <Button variant="destructive">Close position</Button>
            <Button disabled>Disabled</Button>
          </div>
        </GallerySection>

        <GallerySection label="Badges and form">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>10x</Badge>
            <Badge variant="outline">Live</Badge>
            <Badge variant="success">Long</Badge>
            <Badge variant="destructive">Short</Badge>
            <Badge variant="warning">Measurement 34 min old</Badge>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="design-amount">Amount (USDC)</FieldLabel>
              <Input id="design-amount" inputMode="decimal" placeholder="0.00" />
              <FieldMessage>Available in wallet appears here once connected.</FieldMessage>
            </Field>
            <Field>
              <FieldLabel htmlFor="design-size">Size (USD)</FieldLabel>
              <Input id="design-size" inputMode="decimal" defaultValue="250000" aria-invalid />
              <FieldMessage tone="error">
                Above the market cap. Use max size instead.
              </FieldMessage>
            </Field>
          </div>
        </GallerySection>
      </div>

      <div className="grid gap-1 lg:grid-cols-12">
        <Card className="lg:col-span-8">
          <CardHeader className="border-b pb-4">
            <CardTitle>Positions</CardTitle>
            <CardDescription>Open positions on this account.</CardDescription>
            <CardAction>
              <Badge variant="outline">0</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="overflow-x-auto px-0">
            <table className="w-full text-left text-ui tabular-nums">
              <thead className="bg-muted text-label text-tertiary">
                <tr className="h-row">
                  <th className="px-4 font-normal">Market</th>
                  <th className="px-4 text-right font-normal">Size</th>
                  <th className="px-4 text-right font-normal">Entry price</th>
                  <th className="px-4 text-right font-normal">PnL</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-muted-foreground">
                    No positions yet.
                  </td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card size="sm" className="lg:col-span-4">
          <CardHeader>
            <CardTitle>Liquidity cap</CardTitle>
            <CardDescription>
              Open interest (total size of open positions) against the measured cap.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="h-1 overflow-hidden rounded-pill bg-muted">
              <div className="h-full w-1/3 bg-foreground" />
            </div>
            <div className="flex justify-between text-label text-tertiary">
              <span>Used</span>
              <span>Cap</span>
            </div>
          </CardContent>
          <CardFooter className="justify-between text-label text-tertiary">
            <span>Last measurement</span>
            <Badge variant="warning">stale</Badge>
          </CardFooter>
        </Card>
      </div>
    </AppShell>
  )
}
