import { motion } from "framer-motion";
import { useReducedMotion } from "../../hooks/useReducedMotion";

interface Props {
  /** 0 – 100 */
  value: number;
  color: string;
  delay?: number;
  /** Show the shimmer sweep on top */
  shimmer?: boolean;
  className?: string;
  height?: number;
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
        style={{ background: color }}
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
