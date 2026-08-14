/**
 * CrossfadeSwap.jsx — wraps a Dashboard Bootstrap resource's rendered
 * output so that when stale (cached) content is replaced by revalidated
 * content, the swap crossfades instead of snapping. Reuses Framer Motion
 * (already a project dependency) — no new dependency introduced.
 *
 * `dataKey` should change ONLY when the underlying data actually changes
 * (e.g. a content hash, id+version, or JSON string of the fields that
 * matter) — not on every render. Passing the same key across renders is a
 * no-op (AnimatePresence only animates on a key change).
 *
 * Uses mode="wait" (fade-out fully, then fade-in) rather than an
 * overlapping crossfade: Dashboard content (Hero, artwork) has
 * variable/dynamic height, and an overlapping transition would need
 * absolute positioning to avoid a layout jump while both versions are
 * mounted — not worth the complexity for a swap that only ever happens
 * once per resource per app launch. The exiting element stays opacity-0
 * in place (not removed from flow) until the new one is ready, so the
 * container never collapses to zero height in between.
 */
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

export default function CrossfadeSwap({ dataKey, children, className = "" }) {
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={dataKey}
        className={className}
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduceMotion ? { opacity: 1 } : { opacity: 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.35, ease: [0.22, 1, 0.36, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
