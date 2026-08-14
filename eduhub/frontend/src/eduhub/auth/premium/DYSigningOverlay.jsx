// DYSigningOverlay.jsx — full-screen premium signing-in overlay.
// White/ivory backdrop with the DY orbit logo centered, a calm
// "Signing in…" title, and a slow-rotating supportive status line.
//
// Rendered conditionally by the credential card while
// authentication is pending. Closes automatically when the parent
// flips `open` back to false.
//
// Accessibility:
//   • role="status" + aria-live="polite" so screen readers announce
//     the rotating progress copy without interrupting.
//   • Respects prefers-reduced-motion: rotation is frozen, status
//     line still changes (but with a longer dwell) so the user still
//     sees the progress feedback.
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import DYOrbitLogo from "./DYOrbitLogo";
import "./premium-auth.css";

const DEFAULT_STATUSES = [
  "Checking your learning profile…",
  "Loading your points wallet…",
  "Preparing EduTalk and AI Coach…",
  "Almost ready…",
];

/**
 * Props:
 *   open:      boolean       overlay visible?
 *   title:     string        title text (default "Signing in…")
 *   statuses:  string[]      rotating status lines
 *   testID:    string        data-testid root (default "dy-signing-overlay")
 */
export default function DYSigningOverlay({
  open,
  title = "Signing in…",
  statuses = DEFAULT_STATUSES,
  testID = "dy-signing-overlay",
}) {
  const reduce = useReducedMotion();
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (!open) {
      setIdx(0);
      return undefined;
    }
    const dwell = reduce ? 2600 : 1700;
    const t = setInterval(() => {
      setIdx((i) => (i + 1) % statuses.length);
    }, dwell);
    return () => clearInterval(t);
  }, [open, reduce, statuses.length]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="dy-signing-overlay"
          className="dy-signing-overlay"
          data-testid={testID}
          role="status"
          aria-live="polite"
          aria-busy="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        >
          <motion.div
            className="dy-signing-card"
            initial={{ opacity: 0, y: 14, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.985 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-center justify-center">
              <DYOrbitLogo size={172} active palette="light" testID={`${testID}-orbit`} />
            </div>

            <h2
              className="mt-4 font-display text-[20px] font-semibold"
              style={{ color: "#0B1B36", letterSpacing: "-0.005em" }}
              data-testid={`${testID}-title`}
            >
              {title}
            </h2>

            <div
              className="relative mt-1.5 h-[22px] overflow-hidden"
              aria-hidden={false}
            >
              <AnimatePresence mode="wait">
                <motion.p
                  key={idx}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.32, ease: "easeOut" }}
                  className="absolute inset-0 text-[13.5px]"
                  style={{ color: "#4B5563" }}
                  data-testid={`${testID}-status`}
                >
                  {statuses[idx]}
                </motion.p>
              </AnimatePresence>
            </div>

            <div
              className="dy-signing-bar"
              aria-hidden
              data-testid={`${testID}-progress`}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
