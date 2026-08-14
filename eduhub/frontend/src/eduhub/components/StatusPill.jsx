import React from "react";
import { motion, AnimatePresence } from "framer-motion";

// v18 (Premium UI Reconstruction) — theme-aware, WCAG-AA color pairs.
// Light theme uses deepened accent tones (≥ 4.5:1 on #FAFAFA/#FFFFFF);
// dark theme keeps the original aurora accents on #050010 surfaces.
const STYLE = {
  loading: "text-[#A16207] bg-[#A16207]/10 border-[#A16207]/40 dark:text-aurora-gold dark:bg-aurora-gold/10 dark:border-aurora-gold/40",
  success: "text-[#15803D] bg-[#15803D]/10 border-[#15803D]/40 dark:text-aurora-lime dark:bg-aurora-lime/10 dark:border-aurora-lime/40",
  error:   "text-[#C2410C] bg-[#C2410C]/10 border-[#C2410C]/40 dark:text-aurora-coral dark:bg-aurora-coral/10 dark:border-aurora-coral/40",
  cached:  "text-[#0E7490] bg-[#0E7490]/10 border-[#0E7490]/30 dark:text-aurora-cyan dark:bg-aurora-cyan/10 dark:border-aurora-cyan/30",
};

// RC2.5 — a small crossfade when the status itself changes (loading ->
// success, etc.), rather than the pill's content just snapping. The dot's
// own `animate-pulse-dot` stays exactly as-is — it's a shared Tailwind
// keyframe used elsewhere in the app (liveCoach.css, PortalPublic.jsx),
// out of this component's scope to redefine.
export default function StatusPill({ status, text }) {
  return (
    <div
      className={`inline-flex items-center gap-1.5 text-[0.68rem] font-semibold px-2.5 py-[3px] rounded-full border transition-[background-color,border-color] ${STYLE[status] || STYLE.loading}`}
      data-testid={`status-pill-${status}`}
    >
      <span
        className={`w-[5px] h-[5px] rounded-full bg-current ${status === "loading" || status === "success" ? "animate-pulse-dot" : ""}`}
        style={{ boxShadow: "0 0 8px currentColor" }}
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={text}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
          transition={{ duration: 0.25 }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}
