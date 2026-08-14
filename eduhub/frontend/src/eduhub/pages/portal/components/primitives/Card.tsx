import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Adds a slightly emphasised border / inner shadow. */
  emphasis?: boolean;
  /**
   * Drives the soft gradient wash + glow on this card.
   * Accepts either:
   *   - one of the accent family tokens: "teal" | "coral" | "violet"
   *   - a raw CSS color string (legacy callers); in that case we infer
   *     the family from common values and fall back to teal.
   * The PROP and its position in the API are unchanged from before —
   * only its visual treatment has been upgraded to the Aurora reskin.
   */
  accentEdge?: string;
  children?: ReactNode;
}

/** Map common legacy color strings to the new Aurora accent family. */
function inferAccent(raw?: string): "teal" | "coral" | "violet" | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "teal" || v === "coral" || v === "violet") return v;
  if (v.includes("accent-warm") || v.includes("needs") || v.includes("good")) return "coral";
  if (v.includes("violet") || v.includes("magenta") || v.includes("purple")) return "violet";
  // var(--color-accent), var(--color-excellent), anything else → teal.
  return "teal";
}

/**
 * The single Card primitive used everywhere on the dashboard.
 * Aurora reskin: glassy cream surface, soft gradient corner wash, warm
 * multi-layer shadow, translucent white border, 28px corners.
 *
 * The `accentEdge` API is preserved — only its visual treatment changed:
 *   - Before: hard 1.5px coloured strip on the left edge.
 *   - After:  soft radial gradient glow tinting the top-right corner,
 *             driven by the inferred accent family.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, emphasis, accentEdge, children, style, ...rest },
  ref,
) {
  const accent = inferAccent(accentEdge);
  return (
    <div
      ref={ref}
      data-accent={accent}
      className={cn(
        "aurora-card",
        emphasis && "ink-shadow-lg",
        className,
      )}
      style={style}
      {...rest}
    >
      {children}
    </div>
  );
});
