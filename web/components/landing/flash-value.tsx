"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import styles from "./landing.module.css";

interface Shown {
  text: string;
  order: number;
  direction: "up" | "down" | null;
}

/** Live number that flashes green or red for 400 ms when it goes up or down. */
export function FlashValue({ text, order, className }: { text: string; order: number; className?: string }) {
  const [shown, setShown] = useState<Shown>({ text, order, direction: null });
  let current = shown;
  if (shown.text !== text) {
    current = { text, order, direction: order > shown.order ? "up" : order < shown.order ? "down" : null };
    setShown(current);
  }
  return (
    <span
      key={current.text}
      className={cn(
        current.direction === "up" && styles.flashUp,
        current.direction === "down" && styles.flashDown,
        className,
      )}
    >
      {current.text}
    </span>
  );
}
