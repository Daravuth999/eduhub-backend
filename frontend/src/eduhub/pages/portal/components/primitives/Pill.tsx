import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface PillProps {
  children: ReactNode;
  /** Primary tonal colour (e.g. accent / excellent / good / needs / inkSoft). */
  tone?: "accent" | "excellent" | "good" | "needs" | "warm" | "ink";
  size?: "sm" | "md";
  className?: string;
  filled?: boolean;
  "data-testid"?: string;
}

const TONE_MAP: Record<NonNullable<PillProps["tone"]>, string> = {
  accent: "var(--color-accent)",
  excellent: "var(--color-excellent)",
  good: "var(--color-good)",
  needs: "var(--color-needs)",
  warm: "var(--color-accent-warm)",
  ink: "var(--color-ink)",
};

export function Pill({
  children,
  tone = "ink",
  size = "sm",
  className,
  filled,
  ...rest
}: PillProps) {
  const color = TONE_MAP[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-semibold uppercase tracking-wider whitespace-nowrap",
        size === "sm" ? "text-[10px] px-2 py-0.5" : "text-xs px-3 py-1",
        className,
      )}
      style={
        filled
          ? {
              background: color,
              color: "var(--color-surface)",
              border: `1px solid ${color}`,
            }
          : {
              background: `color-mix(in oklab, ${color} 14%, transparent)`,
              color,
              border: `1px solid color-mix(in oklab, ${color} 30%, transparent)`,
            }
      }
      {...rest}
    >
      {children}
    </span>
  );
}
