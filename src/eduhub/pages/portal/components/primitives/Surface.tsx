import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export type SurfaceAccent =
  | "teal"
  | "coral"
  | "violet"
  | "gold"
  | "green"
  | "rose"
  | "none";

export type SurfaceVariant = "solid" | "aurora" | "glass";

interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  /** Aurora accent family that drives the strip / wash / glow. */
  accent?: SurfaceAccent;
  /**
   * solid  -> calm cream surface + 1px line (default, content-friendly)
   * aurora -> existing .aurora-card gradient corner wash (hero chrome)
   * glass  -> translucent blurred surface (overlays / app bar)
   */
  variant?: SurfaceVariant;
  /** Thin gradient accent strip across the top edge (solid variant). */
  topStrip?: boolean;
  /** Adds hover lift + press affordance for tappable cards. */
  interactive?: boolean;
  children?: ReactNode;
}

/**
 * Surface -- the unified Lumio card primitive for /portal/me.
 *
 * It is purely presentational and composes the EXISTING Aurora token
 * system (portal-theme.css). It never changes data or behaviour.
 *
 *   - variant="solid"  : --color-surface + --color-line + --shadow-card
 *   - variant="aurora" : reuses .aurora-card (soft gradient corner wash)
 *   - variant="glass"  : --glass-bg + backdrop blur (app bar / overlays)
 *
 * Accent (teal | coral | violet | gold | green | rose) is forwarded via
 * the data-accent attribute so the matching gradient / glow tokens apply.
 */
export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  {
    accent = "teal",
    variant = "solid",
    topStrip = false,
    interactive = false,
    className,
    children,
    ...rest
  },
  ref,
) {
  const dataAccent = accent === "none" ? undefined : accent;
  return (
    <div
      ref={ref}
      data-accent={dataAccent}
      className={cn(
        variant === "aurora" && "aurora-card",
        variant === "solid" && "lumio-surface",
        variant === "glass" && "lumio-surface lumio-surface--glass",
        topStrip && variant !== "aurora" && "lumio-surface--strip",
        interactive && "lumio-surface--interactive",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
});
