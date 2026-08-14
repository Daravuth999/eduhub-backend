import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldAlert, LogOut } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { hasActiveSession } from "../lib/activeSessionRegistry";

/**
 * RestrictionGuard — app-wide overlay that activates the moment the
 * AuthContext sees `Restriction = TRUE` in the Sheet, regardless of
 * which route the student is on (Library, Reader, Game, Portal,
 * Assistant, Dashboard, …). The watchdog itself lives in AuthContext,
 * this component just renders the modal.
 *
 *   • No close path — the only outcome is sign-out.
 *   • Auto-logs-out after a 3 s countdown.
 *   • Uses the existing dark-academia palette so it visually matches
 *     every screen.
 */
const COUNTDOWN_S = 3;

export default function RestrictionGuard() {
  const { isRestricted, restrictionMsg, logout } = useAuth();
  const [count, setCount] = useState(COUNTDOWN_S);

  useEffect(() => {
    if (!isRestricted) {
      setCount(COUNTDOWN_S);
      return;
    }
    setCount(COUNTDOWN_S);
    const tick = setInterval(() => {
      // Issue 4 fix — a paid session (Live Voice Coach) in progress holds
      // the countdown at 1s instead of letting it reach 0 and auto-sign-
      // out. The overlay/message stay fully visible the whole time (the
      // student is never kept in the dark), and "Sign out now" always
      // works immediately regardless. The instant the session ends, the
      // very next tick resumes the countdown normally.
      if (hasActiveSession()) {
        setCount(1);
        return;
      }
      setCount((c) => {
        if (c <= 1) {
          clearInterval(tick);
          setTimeout(() => logout?.(), 0);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [isRestricted, logout]);

  return (
    <AnimatePresence>
      {isRestricted && (
        <motion.div
          key="restriction-guard"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[2000] grid place-items-center px-6"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(40,8,18,0.85), rgba(8,5,12,0.95))",
            backdropFilter: "blur(14px) saturate(110%)",
            WebkitBackdropFilter: "blur(14px) saturate(110%)",
          }}
          data-testid="restriction-guard"
          aria-modal="true"
          role="dialog"
        >
          <motion.div
            initial={{ scale: 0.92, y: 18, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ type: "spring", damping: 20, stiffness: 240 }}
            className="w-full max-w-[420px] rounded-3xl border p-7 text-center"
            style={{
              background:
                "linear-gradient(160deg, #2A1622 0%, #1A1420 100%)",
              borderColor: "rgba(230, 57, 118, 0.45)",
              boxShadow:
                "0 30px 80px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.06)",
              color: "#F4E5C1",
            }}
          >
            <motion.div
              animate={{ scale: [1, 1.05, 1] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
              className="mx-auto grid h-16 w-16 place-items-center rounded-2xl"
              style={{
                background: "rgba(230, 57, 118, 0.18)",
                color: "#FFB3C9",
                border: "1px solid rgba(230, 57, 118, 0.4)",
              }}
            >
              <ShieldAlert className="h-8 w-8" />
            </motion.div>
            <h3
              className="mt-5 font-display text-[22px] leading-tight"
              style={{ color: "#FFE8D7" }}
              data-testid="restriction-guard-title"
            >
              Account Restricted
            </h3>
            <p className="khmer mt-1 text-[12px] opacity-70">
              គណនីត្រូវបានរឹតបន្តឹង
            </p>
            <p
              className="mt-4 text-[13.5px] leading-relaxed whitespace-pre-line"
              style={{ color: "rgba(244, 229, 193, 0.85)" }}
              data-testid="restriction-guard-message"
            >
              {restrictionMsg ||
                "Your access has been temporarily restricted by the administrator."}
            </p>
            <div
              className="mt-5 text-[12.5px] font-bold tabular-nums"
              style={{ color: "#FF8BAA", letterSpacing: "0.18em" }}
              data-testid="restriction-guard-countdown"
            >
              SIGNING OUT IN {count}s
            </div>
            <button
              type="button"
              onClick={logout}
              data-testid="restriction-guard-logout"
              className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-bold uppercase tracking-wider transition"
              style={{
                background:
                  "linear-gradient(135deg, #FF6E91, #E63976)",
                color: "#1a0510",
                border: "1px solid rgba(255,255,255,0.4)",
                boxShadow:
                  "0 12px 26px rgba(230,57,118,0.45), inset 0 1px 0 rgba(255,255,255,0.55)",
              }}
            >
              <LogOut className="h-4 w-4" />
              Sign out now
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
