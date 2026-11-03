import * as React from "react"
import { Check, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

type StepStatus = "done" | "current" | "todo"

type OnboardingStep = {
  id: string
  label: string
  status: StepStatus
}

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
        "flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3 md:flex-row md:items-center md:gap-2",
        className
      )}
      {...props}
    >
      {steps.map((step, index) => (
        <li
          key={step.id}
          data-state={step.status}
          aria-current={step.status === "current" ? "step" : undefined}
          className="group/step flex items-center gap-2 text-ui font-medium text-tertiary data-[state=current]:text-foreground data-[state=done]:text-success"
        >
          <span
            aria-hidden
            className="flex size-5 shrink-0 items-center justify-center rounded-pill border border-current text-label tabular-nums group-data-[state=current]/step:border-foreground group-data-[state=current]/step:bg-foreground group-data-[state=current]/step:text-background group-data-[state=done]/step:border-success"
          >
            {step.status === "done" ? <Check className="size-3" /> : index + 1}
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
            <ChevronRight aria-hidden className="ml-2 hidden size-4 text-tertiary md:block" />
          ) : null}
        </li>
      ))}
    </ol>
  )
}

export { OnboardingSteps, type OnboardingStep, type StepStatus }
