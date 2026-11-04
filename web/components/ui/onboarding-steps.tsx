import * as React from "react"
import { Check, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

type StepStatus = "done" | "current" | "todo"

type OnboardingStep = {
  id: string
  label: string
  status: StepStatus
}

/** One thin row of numbered steps; the current one is marked with aria-current="step". */
function OnboardingSteps({
  steps,
  className,
  ...props
}: React.ComponentProps<"ol"> & { steps: readonly OnboardingStep[] }) {
  return (
    <ol
      data-testid="onboarding-steps"
      aria-label="Getting started"
      className={cn(
        "flex h-8 items-center gap-1 overflow-x-auto rounded-md border border-border bg-card px-3 [scrollbar-width:none]",
        className
      )}
      {...props}
    >
      {steps.map((step, index) => (
        <li
          key={step.id}
          data-state={step.status}
          aria-current={step.status === "current" ? "step" : undefined}
          className="group/step flex shrink-0 items-center gap-1.5 text-label text-tertiary data-[state=current]:text-foreground data-[state=done]:text-success"
        >
          <span
            aria-hidden
            className="flex size-4 shrink-0 items-center justify-center rounded-pill border border-current text-[0.625rem] tabular-nums group-data-[state=current]/step:border-foreground group-data-[state=current]/step:bg-foreground group-data-[state=current]/step:text-background group-data-[state=done]/step:border-success"
          >
            {step.status === "done" ? <Check className="size-2.5" /> : index + 1}
          </span>
          <span>
            <span className="sr-only">
              {step.status === "done"
                ? "Completed: "
                : step.status === "current"
                  ? "Current step: "
                  : "Upcoming: "}
            </span>
            {step.label}
          </span>
          {index < steps.length - 1 ? (
            <ChevronRight aria-hidden className="mx-1 size-3 text-tertiary" />
          ) : null}
        </li>
      ))}
    </ol>
  )
}

export { OnboardingSteps, type OnboardingStep, type StepStatus }
