// AnnouncementStrip.jsx — compact ~40px LIVE strip with rotating marquee
//   announcement messages. Replaces the bulky AnnouncementCard on Dashboard
//   while keeping the same data source (useEduHubConfig) intact.
//
// Home Dashboard V4 restyle: the neon multi-color gradient treatment
// (cyan/violet/magenta) belonged to the V3 ambient "world" visual
// language. This component has exactly one consumer (Dashboard.jsx), so
// it's restyled in place rather than forked — same props, same
// data-testids, same behavior (marquee rotation, retry, expand), only the
// surface/accent/typography now match the flat, single-accent, light
// card language the rest of the V4 page uses (MissionHero/DiscoveryCard).
import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Megaphone, RotateCw, ChevronDown, ChevronUp } from "lucide-react";
import StatusPill from "./StatusPill";
import { elevation } from "../styles/tokens/designTokens";
import useAmbientActive from "../hooks/useAmbientActive";

const ROTATE_MS = 6500;

export default function AnnouncementStrip({
  config,
  fetchStatus,
  fetchStatusText,
  source,
  onRetry,
}) {
  const messages = (config?.announcementMessages || []).filter(Boolean);
  const showRetry = source === "default";
  const [idx, setIdx] = useState(0);
  const [open, setOpen] = useState(false);
  const { ref: ambientRef, active: ambientActive } = useAmbientActive();

  useEffect(() => {
    if (messages.length < 2) return;
    const id = setInterval(() => setIdx((i) => (i + 1) % messages.length), ROTATE_MS);
    return () => clearInterval(id);
  }, [messages.length]);

  const current = messages[idx] || "";
  const isKhmer = /[ក-៿]/.test(current);

  return (
    <motion.section
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45 }}
      className="relative mx-4 rounded-2xl overflow-hidden border border-amber-200/60 dark:border-amber-400/[0.14] bg-gradient-to-br from-[#FFFBEB] to-[#FFFEFB] dark:from-[#1D1810] dark:to-[#16130D]"
      style={{
        // RC2 — this background had no dark-mode variant at all: a hardcoded
        // cream gradient regardless of theme, i.e. a bright card stranded on
        // the dark page. Now a layered warm-charcoal dark surface (not pure
        // black) instead, matching MissionHero's fix and the "avoid
        // pure-white-on-black" dark mode principle.
        boxShadow: elevation.soft,
      }}
      data-testid="announcement-strip"
      ref={ambientRef}
    >
      {/* Compact strip */}
      <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2 min-h-[40px]">
        {/* Live dot + icon */}
        <div className="flex items-center gap-1.5 flex-none">
          <span
            className="relative w-2 h-2 rounded-full bg-amber-500"
            style={{ boxShadow: "0 0 10px rgba(217,119,6,0.55)" }}
          >
            {/* RC2.5 — softened from Tailwind's animate-ping (a hard
                expanding-ring pulse) to a gentle opacity/scale breathe. */}
            {ambientActive && (
              <motion.span
                aria-hidden
                className="absolute inset-0 rounded-full bg-amber-500"
                initial={{ opacity: 0.5, scale: 1 }}
                animate={{ opacity: [0.5, 0, 0.5], scale: [1, 1.6, 1] }}
                transition={{ duration: 2.2, repeat: Infinity, ease: "easeOut" }}
              />
            )}
          </span>
          <span className="text-[9px] font-extrabold tracking-[0.2em] uppercase text-amber-700 dark:text-amber-400 hidden sm:inline">
            Live
          </span>
          <motion.span
            className="sm:hidden inline-flex"
            animate={ambientActive ? { rotate: [0, -8, 8, 0] } : undefined}
            transition={{ duration: 2.6, repeat: Infinity, repeatDelay: 3, ease: "easeInOut" }}
          >
            <Megaphone className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
          </motion.span>
        </div>

        {/* Marquee message */}
        <div className="relative flex-1 min-w-0 overflow-hidden">
          <AnimatePresence mode="wait">
            <motion.div
              key={idx + ":" + current.slice(0, 12)}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
              className={`whitespace-nowrap text-[0.78rem] sm:text-[0.84rem] truncate ${
                isKhmer ? "font-khmer text-amber-700 dark:text-amber-400" : "text-ink dark:text-white/90"
              }`}
              data-testid="announcement-strip-msg"
            >
              {current || (
                <span className="text-zinc-600 dark:text-white/70">Loading announcements…</span>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Right cluster: indicators + retry + expand */}
        <div className="flex items-center gap-1.5 flex-none">
          {messages.length > 1 && (
            <div className="hidden sm:flex items-center gap-1 mr-1">
              {messages.map((_, i) =>
                i === idx ? (
                  // RC2.5 — real cycle-progress indicator: the active dot
                  // fills over the exact rotation interval (ROTATE_MS),
                  // resetting every time idx changes. Genuinely tied to
                  // the timer already driving rotation, not decorative.
                  <button
                    key={i}
                    type="button"
                    aria-label={`Show announcement ${i + 1}`}
                    onClick={() => setIdx(i)}
                    className="relative w-4 h-1.5 rounded-full overflow-hidden bg-amber-500/25"
                  >
                    <motion.span
                      key={idx}
                      className="absolute inset-y-0 left-0 bg-amber-500 rounded-full"
                      initial={{ width: "0%" }}
                      animate={{ width: "100%" }}
                      transition={{ duration: ROTATE_MS / 1000, ease: "linear" }}
                    />
                  </button>
                ) : (
                  <button
                    key={i}
                    type="button"
                    aria-label={`Show announcement ${i + 1}`}
                    onClick={() => setIdx(i)}
                    className="w-1.5 h-1.5 rounded-full bg-zinc-300 hover:bg-zinc-400 dark:bg-white/25 dark:hover:bg-white/45 transition-colors"
                  />
                ),
              )}
            </div>
          )}

          <StatusPill status={fetchStatus} text={fetchStatusText} />

          {showRetry && (
            <button
              onClick={onRetry}
              data-testid="announcement-strip-retry"
              className="inline-flex items-center justify-center w-6 h-6 rounded-full border border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400 hover:bg-amber-500/25 transition-[background-color]"
              aria-label="Retry"
            >
              <RotateCw className="w-3 h-3" />
            </button>
          )}

          {messages.length > 1 && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              data-testid="announcement-strip-toggle"
              aria-expanded={open}
              aria-label={open ? "Collapse" : "Expand"}
              className="inline-flex items-center justify-center w-6 h-6 rounded-full text-zinc-600 hover:text-ink hover:bg-zinc-900/[0.05] dark:text-white/70 dark:hover:text-white dark:hover:bg-white/10 transition-[background-color,color]"
            >
              {open ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Expanded list */}
      <AnimatePresence initial={false}>
        {open && messages.length > 1 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="border-t border-amber-200/60 dark:border-amber-400/[0.14] overflow-hidden"
          >
            <ul className="px-3 sm:px-4 py-2 space-y-1.5">
              {messages.map((m, i) => {
                const km = /[ក-៿]/.test(m);
                return (
                  <li
                    key={i}
                    className={`flex items-start gap-2 text-[0.78rem] leading-relaxed ${
                      km ? "font-khmer text-amber-700 dark:text-amber-400" : "text-ink/90 dark:text-white/85"
                    }`}
                  >
                    <span className="mt-1.5 h-1 w-1 flex-none rounded-full bg-amber-500" />
                    <span>{m}</span>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}
