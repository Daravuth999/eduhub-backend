/**
 * EduHubPointsPill.jsx — the ONE reusable EduHub Points display component
 * for the whole PWA (Video Library, Dashboard, Portal, Wallet, Books, and
 * any future product). Built to replace ad-hoc `{points} pts` interpolation
 * — the exact pattern that leaked a raw JS float ("154.15999999999988 pts")
 * into the Video Library dashboard — with a single, tested, premium
 * component every surface can drop in.
 *
 * Deliberately NOT a replacement for the two existing, already-elaborate,
 * purpose-built wallet widgets in this codebase:
 *   - src/eduhub/pages/portal/components/dashboard/PointsPill.tsx — a
 *     P2P send/receive transaction feed with a progress ring, confetti,
 *     and floating +N/-N badges. Portal-specific business logic, not a
 *     generic display primitive.
 *   - src/eduhub/components/dashboard/DashboardHeader.jsx's wallet pill —
 *     an already-shipped, already-iterated (RC2–RC3.2) premium header
 *     component with its own bespoke ambient-particle treatment.
 * Both of those keep their own visuals; this component is for every
 * OTHER place a points value is shown (starting with Video Library),
 * and both now share this file's formatPoints/useAnimatedPoints
 * primitives so there is exactly one place that owns "how do we format
 * and animate a points number," even though there remain two specialized
 * wallet widgets with their own bespoke chrome around that shared core.
 *
 * Visual language: soft gold glass capsule (Apple Wallet / Vision Pro
 * register, not gaming/neon/RGB) — icon in its own circular gold badge,
 * animated count-up via the shared useAnimatedPoints hook, a very slow
 * idle gradient sweep + breathing scale, and a one-pass shimmer + gentle
 * spring bump on increase / a soft fade on decrease. Every animation is a
 * GPU-safe transform/opacity change (no layout-affecting properties), and
 * every one is skipped in favor of the final value when the OS requests
 * reduced motion (framer-motion's useReducedMotion — the same convention
 * DashboardHeader.jsx already uses).
 */
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Coins } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAnimatedPoints } from "../../lib/useAnimatedPoints";

const SIZES = {
  sm: { pad: "pl-1 pr-2.5 py-1", icon: "w-6 h-6", iconSize: 11, text: "text-[11px]", gap: "gap-1.5" },
  md: { pad: "pl-1.5 pr-3 py-1.5", icon: "w-7 h-7", iconSize: 13, text: "text-[13px]", gap: "gap-2" },
  lg: { pad: "pl-2 pr-4 py-2", icon: "w-9 h-9", iconSize: 16, text: "text-[16px]", gap: "gap-2.5" },
};

export default function EduHubPointsPill({
  value,
  size = "md",
  suffix = "pts",
  className = "",
  testId = "eduhub-points-pill",
}) {
  const reduced = useReducedMotion();
  const dims = SIZES[size] || SIZES.md;
  const display = useAnimatedPoints(value);
  const safeValue = Number.isFinite(Number(value)) ? Number(value) : 0;

  // Direction-aware micro-interaction: compares only against the
  // previously RENDERED value (never fabricates an intermediate delta —
  // if the value jumps from 100 to 250, that is one "increase", not
  // several synthetic ticks).
  const prevRef = useRef(safeValue);
  const [pulse, setPulse] = useState(null); // "up" | "down" | null
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = safeValue;
    if (safeValue === prev) return undefined;
    const dir = safeValue > prev ? "up" : "down";
    setPulse(dir);
    const t = setTimeout(() => setPulse(null), dir === "up" ? 900 : 500);
    return () => clearTimeout(t);
  }, [safeValue]);

  const idleOrBump = pulse === "up" && !reduced
    ? { scale: [1, 1.06, 1] }
    : !reduced
      ? { scale: [1, 1.015, 1] }
      : { scale: 1 };
  const idleOrBumpTransition = pulse === "up"
    ? { duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }
    : { duration: 5, repeat: Infinity, ease: "easeInOut" };

  return (
    <motion.span
      data-testid={testId}
      className={`relative inline-flex items-center overflow-hidden rounded-full ${dims.pad} ${dims.gap} ${className}`}
      style={{
        background:
          "linear-gradient(135deg, rgba(255,241,214,0.9) 0%, rgba(212,168,67,0.22) 55%, rgba(255,241,214,0.9) 100%)",
        border: "1px solid rgba(212,168,67,0.45)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(120,90,20,0.12), 0 4px 14px -6px rgba(180,140,40,0.35)",
        backdropFilter: "blur(6px) saturate(140%)",
        WebkitBackdropFilter: "blur(6px) saturate(140%)",
      }}
      animate={idleOrBump}
      transition={idleOrBumpTransition}
    >
      {/* Idle ambient sweep — very slow, GPU-only (transform, not
          background-position, which is paint-heavy). */}
      {!reduced && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2"
          style={{
            background: "linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.35) 50%, transparent 80%)",
          }}
          animate={{ x: ["0%", "260%"] }}
          transition={{ duration: 6, ease: "easeInOut", repeat: Infinity, repeatDelay: 3.5 }}
        />
      )}

      {/* One-pass gold shimmer sweep on increase. */}
      <AnimatePresence>
        {pulse === "up" && !reduced && (
          <motion.span
            aria-hidden
            key="shimmer"
            className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2"
            style={{
              background: "linear-gradient(100deg, transparent 15%, rgba(255,255,255,0.85) 50%, transparent 85%)",
            }}
            initial={{ x: "0%" }}
            animate={{ x: "260%" }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.7, ease: "easeOut" }}
          />
        )}
      </AnimatePresence>

      {/* Soft ambient glow on increase. */}
      <AnimatePresence>
        {pulse === "up" && (
          <motion.span
            aria-hidden
            key="glow"
            className="pointer-events-none absolute inset-0 rounded-full"
            initial={{ opacity: 0.65 }}
            animate={{ opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.9 }}
            style={{ boxShadow: "0 0 0 3px rgba(212,168,67,0.35), 0 0 18px 4px rgba(212,168,67,0.35)" }}
          />
        )}
      </AnimatePresence>

      {/* Icon lives in its own soft circular gold badge. */}
      <span
        aria-hidden
        className={`relative z-[1] flex items-center justify-center rounded-full flex-shrink-0 ${dims.icon}`}
        style={{
          background: "radial-gradient(circle at 35% 30%, #FFE9B0 0%, #D4A843 60%, #9C7A2C 100%)",
          boxShadow: "inset 0 1px 1px rgba(255,255,255,0.7), inset 0 -1px 1px rgba(0,0,0,0.15)",
        }}
      >
        <Coins size={dims.iconSize} color="#4A3A10" strokeWidth={2.25} />
      </span>

      {/* Number + suffix. The animated value lives in its own bare
          motion.span whose ONLY child is the bound MotionValue (framer-
          motion mutates that text node directly without a React
          re-render) — the same pattern already proven in
          DashboardHeader.jsx. Kept isolated from the opacity-pulse
          wrapper below so the two animation mechanisms never touch the
          same element. */}
      <motion.span
        className="relative z-[1] flex items-baseline gap-1"
        animate={pulse === "down" && !reduced ? { opacity: [1, 0.45, 1] } : { opacity: 1 }}
        transition={{ duration: 0.5 }}
      >
        <motion.span className={`tnum font-bold ${dims.text}`} style={{ color: "#5B4416" }} data-testid={`${testId}-value`}>
          {display}
        </motion.span>
        {suffix ? (
          <span className={`font-semibold opacity-70 ${dims.text}`} style={{ color: "#5B4416" }}>
            {suffix}
          </span>
        ) : null}
      </motion.span>
    </motion.span>
  );
}
