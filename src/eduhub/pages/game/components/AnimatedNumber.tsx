// AnimatedNumber.tsx — P0 Surgery D
//
// NEW standalone component. Replaces the setState-based AnimatedNumber
// currently inlined inside LuckySpin.tsx (lines 65-88), which calls
// setState ~42 times during a 700ms count animation and triggers React
// reconciliation through the entire top-bar tree on every tick.
//
// This implementation drives the visible text via a Framer-MotionValue
// piped through useTransform, then rendered as the children of a
// motion.span. Framer mutates the DOM text node directly on the
// compositor thread — ZERO React re-renders.
//
// Behavior contract (UNCHANGED):
//   • Same prop: { value: number }
//   • Same 700ms ease-out animation from previous value to new value
//   • Same one-shot per `value` change semantics
//   • Renders inside a <span> — drop-in replacement for the inline
//     AnimatedNumber used on the points pill in the LuckySpin top bar.
//
// USAGE — after dropping this file in:
//   1) In LuckySpin.tsx, remove the inline AnimatedNumber function
//      (lines 65-88 in v7.9.10).
//   2) Add the import at the top of LuckySpin.tsx:
//        import { AnimatedNumber } from "../components/AnimatedNumber";
//   3) The existing call site `<AnimatedNumber value={points} />`
//      continues to work unchanged.
//
// Optional: Add the `tnum` className helper to your global CSS for
// monospaced tabular numerals during the count animation:
//      .tnum { font-variant-numeric: tabular-nums; }
import { useEffect } from "react";
import { animate, motion, useMotionValue, useTransform } from "framer-motion";

interface AnimatedNumberProps {
  value: number;
  /** Optional duration in seconds (default: 0.7s, matching v7.9.10 behavior). */
  durationSec?: number;
  /** Optional formatter for international locales (default: en-US comma grouping). */
  format?: (n: number) => string;
  /** Optional className passthrough. */
  className?: string;
}

const defaultFormat = (n: number) => Math.round(n).toLocaleString();

export function AnimatedNumber({
  value,
  durationSec = 0.7,
  format = defaultFormat,
  className = "tnum",
}: AnimatedNumberProps) {
  const mv = useMotionValue(value);
  // useTransform returns a MotionValue<string> whose updates flow through
  // Framer's animation frame — never through React's reconciliation.
  const display = useTransform(mv, (v) => format(v));

  useEffect(() => {
    const ctrl = animate(mv, value, {
      duration: durationSec,
      ease: [0.25, 1, 0.5, 1], // matches the cubic-out feel of the v7.9.10 1-(1-t)^3
    });
    return () => ctrl.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, durationSec]);

  return <motion.span className={className}>{display}</motion.span>;
}

export default AnimatedNumber;
