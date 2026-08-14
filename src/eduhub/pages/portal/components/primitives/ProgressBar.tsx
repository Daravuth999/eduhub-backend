import { motion } from "framer-motion";
import { useReducedMotion } from "../../hooks/useReducedMotion";

interface Props {
  /** 0 – 100 */
  value: number;
  /** Flat colour (kept for back-compat as a fallback / override). */
  color: string;
  delay?: number;
  /** Show the shimmer sweep on top */
  shimmer?: boolean;
  className?: string;
  height?: number;
}

/**
 * Map a flat CSS-var color to its matching Aurora gradient. Falls back
 * to a single-color "gradient" (same color start → end) so callers that
 * pass a raw hex still render visibly.
 */
function gradientFor(color: string): string {
  const v = color.trim();
  if (v.includes("--color-excellent")) return "var(--gradient-excellent)";
  if (v.includes("--color-good"))      return "var(--gradient-good)";
  if (v.includes("--color-needs"))     return "var(--gradient-needs)";
  if (v.includes("--color-accent-warm")) return "var(--gradient-coral)";
  if (v.includes("--color-accent"))    return "var(--gradient-teal)";
  return `linear-gradient(135deg, ${v} 0%, ${v} 100%)`;
}

export function ProgressBar({
  value,
  color,
  delay = 0,
  shimmer = true,
  className = "",
  height = 8,
}: Props) {
  const reduced = useReducedMotion();
  const pct = Math.max(0, Math.min(100, value));
  const fill = gradientFor(color);

  return (
    <div
      className={
        "relative w-full overflow-hidden rounded-full bg-[color:var(--color-line)] " +
        className
      }
      style={{ height }}
    >
      <motion.div
        className="relative h-full rounded-full"
        style={{ background: fill }}
        initial={{ width: reduced ? `${pct}%` : 0 }}
        animate={{ width: `${pct}%` }}
        transition={{
          duration: reduced ? 0 : 1.1,
          ease: [0.22, 1, 0.36, 1],
          delay: reduced ? 0 : delay,
        }}
      >
        {shimmer && !reduced && pct > 0 && (
          <span className="absolute inset-0 sweep pointer-events-none" />
        )}
      </motion.div>
    </div>
  );
}
