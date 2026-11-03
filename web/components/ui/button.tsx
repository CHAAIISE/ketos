import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/85",
        secondary:
          "border-border bg-muted text-foreground hover:border-tertiary/40 aria-expanded:border-tertiary/40",
        outline:
          "border-border bg-transparent text-foreground hover:bg-muted aria-expanded:bg-muted",
        ghost:
          "text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        long: "bg-success text-success-foreground hover:bg-success/85",
        short: "bg-destructive text-destructive-foreground hover:bg-destructive/85",
        destructive:
          "border-destructive/40 bg-transparent text-destructive hover:bg-destructive/10",
        link: "h-auto px-0 text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default: "h-control px-4 text-sm",
        sm: "h-8 px-3 text-ui",
        xs: "h-6 gap-1 rounded-sm px-2 text-label [&_svg:not([class*='size-'])]:size-3",
        lg: "h-12 px-6 text-body",
        pill: "h-pill gap-3 rounded-pill px-8 text-body",
        icon: "size-control",
        "icon-sm": "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
