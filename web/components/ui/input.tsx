import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-control w-full min-w-0 rounded-md border border-border bg-input px-3 text-sm text-foreground tabular-nums transition-colors outline-none placeholder:text-tertiary hover:border-tertiary/40 focus-visible:border-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

function Field({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field"
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    />
  )
}

function FieldLabel({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="field-label"
      className={cn("text-label text-tertiary", className)}
      {...props}
    />
  )
}

function FieldMessage({
  className,
  tone = "hint",
  ...props
}: React.ComponentProps<"p"> & { tone?: "hint" | "error" }) {
  return (
    <p
      data-slot="field-message"
      data-tone={tone}
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "text-label text-tertiary data-[tone=error]:text-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input, Field, FieldLabel, FieldMessage }
