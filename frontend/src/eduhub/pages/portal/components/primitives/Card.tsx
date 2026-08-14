import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Adds a slightly emphasised border / inner shadow. */
  emphasis?: boolean;
  /** Use a full-bleed coloured strip on the left edge. */
  accentEdge?: string;
  children?: ReactNode;
}

/**
 * The single Card primitive used everywhere on the dashboard.
 * Flat, paper-like, with a 1px ink border and ink-shadow for depth.
 * No gradients on the card surface itself — gradients are reserved for
 * accent strips and badges (avoiding the AI-slop pattern).
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, emphasis, accentEdge, children, style, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "relative rounded-[var(--radius-card)]",
        "bg-[color:var(--color-surface)]",
        "border border-[color:var(--color-line)]",
        "ink-shadow",
        emphasis && "ink-shadow-lg",
        accentEdge && "overflow-hidden",
        className,
      )}
      style={style}
      {...rest}
    >
      {accentEdge && (
        <span
          aria-hidden
          className="absolute left-0 top-0 bottom-0 w-1.5"
          style={{ background: accentEdge }}
        />
      )}
      {children}
    </div>
  );
});
