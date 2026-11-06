import { createCn } from "cn/config"

export const cn = createCn({
  extend: {
    theme: {
      text: [
        "display",
        "display-sm",
        "title",
        "heading",
        "subtitle",
        "body",
        "ui",
        "label",
        "eyebrow",
        "price",
      ],
      radius: ["pill"],
      tracking: ["wordmark"],
      spacing: ["nav", "control", "pill", "row", "gutter", "gutter-sm", "section"],
      container: ["content", "reading"],
    },
  },
})

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
