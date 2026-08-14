import { useEffect, useRef } from "react";
import { useMotionValue, useTransform, animate, useReducedMotion } from "framer-motion";
import { formatPointsGrouped } from "./formatPoints";

/**
 * useAnimatedPoints.js — the shared count-up-to-real-value animation for
 * any EduHub Points display, extracted from DashboardHeader.jsx's
 * previously-local `usePointsCountUp` (RC2 dashboard header) so
 * EduHubPointsPill and DashboardHeader.jsx use the exact same tween
 * instead of two parallel implementations. Never invents an intermediate
 * value beyond a straight ease-out tween toward the real, already-fetched
 * number; on first mount it counts up from 0 for a bit of arrival
 * delight, on later updates it tweens from wherever it currently sits.
 * Skips the animation entirely (jumps straight to the final value) when
 * the OS requests reduced motion.
 *
 * Returns a MotionValue<string> — already run through
 * formatPointsGrouped, so no consumer needs to re-derive display text
 * from the raw animated number (and can never accidentally render a raw
 * float mid-animation).
 */
export function useAnimatedPoints(points, { duration = 0.9 } = {}) {
  const reducedMotion = useReducedMotion();
  const safePoints = Number.isFinite(Number(points)) ? Number(points) : 0;
  const count = useMotionValue(safePoints);
  const display = useTransform(count, (v) => formatPointsGrouped(v));
  const first = useRef(true);

  useEffect(() => {
    if (reducedMotion) {
      count.set(safePoints);
      return undefined;
    }
    const from = first.current ? 0 : count.get();
    first.current = false;
    const controls = animate(from, safePoints, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => count.set(v),
    });
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safePoints, reducedMotion, duration]);

  return display;
}

export default useAnimatedPoints;
