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

const TONE_COLOR: Record<NonNullable<PillProps["tone"]>, string> = {
  accent: "var(--color-accent)",
  excellent: "var(--color-excellent)",
  good: "var(--color-good)",
  needs: "var(--color-needs)",
  warm: "var(--color-accent-warm)",
  ink: "var(--color-ink)",
};

/* Aurora reskin: filled pills get a soft 2-stop gradient + matching glow.
   Unfilled pills keep the soft-tint background, just re-tuned. */
const TONE_GRADIENT: Record<NonNullable<PillProps["tone"]>, string> = {
  accent:    "var(--gradient-teal)",
  excellent: "var(--gradient-excellent)",
  good:      "var(--gradient-good)",
  needs:     "var(--gradient-needs)",
  warm:      "var(--gradient-coral)",
  ink:       "linear-gradient(135deg, #3b3a55 0%, var(--color-ink) 100%)",
};

const TONE_GLOW: Record<NonNullable<PillProps["tone"]>, string> = {
  accent:    "var(--glow-teal)",
  excellent: "0 6px 16px -6px rgba(47,163,122,0.45)",
  good:      "0 6px 16px -6px rgba(242,183,59,0.45)",
  needs:     "0 6px 16px -6px rgba(227,93,91,0.45)",
  warm:      "var(--glow-coral)",
  ink:       "0 6px 16px -6px rgba(27,26,46,0.35)",
};

export function Pill({
  children,
  tone = "ink",
  size = "sm",
  className,
  filled,
  ...rest
}: PillProps) {
  const color = TONE_COLOR[tone];
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
              background: TONE_GRADIENT[tone],
              color: "#fff",
              border: "1px solid rgba(255,255,255,0.35)",
              boxShadow: `${TONE_GLOW[tone]}, inset 0 1px 0 rgba(255,255,255,0.35)`,
            }
          : {
              background: `color-mix(in oklab, ${color} 16%, transparent)`,
              color,
              border: `1px solid color-mix(in oklab, ${color} 32%, transparent)`,
            }
      }
      {...rest}
    >
      {children}
    </span>
  );
}
