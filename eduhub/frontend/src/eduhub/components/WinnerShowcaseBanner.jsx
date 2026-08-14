// WinnerShowcaseBanner.jsx — Automatic Winner Showcase (architecture
//   continuation). Renders nothing until the backend has auto-published at
//   least one experienceType="winner_showcase" config (event_engine.py's
//   _publish_winner_showcase, fired right after a Lucky Draw finalizes).
//   Champion/top winners/payout status are all authoritative settlement
//   data — nothing here is guessed, computed, or editable from this screen.
import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Trophy, PartyPopper } from "lucide-react";
import useWinnerShowcaseRotation from "../hooks/useWinnerShowcaseRotation";

export default function WinnerShowcaseBanner() {
  const { current, count, index, setIndex } = useWinnerShowcaseRotation();

  if (!current) return null;
  const content = current.content || {};
  const champion = content.champion || {};
  const topWinners = Array.isArray(content.topWinners) ? content.topWinners : [];

  return (
    <AnimatePresence mode="wait">
      <motion.section
        key={current.key}
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.45 }}
        className="relative mx-4 mb-2 rounded-2xl overflow-hidden border border-amber-300/60 dark:border-amber-400/30"
        style={{
          background: "linear-gradient(120deg, rgba(212,168,67,0.14) 0%, rgba(255,225,154,0.10) 50%, rgba(212,168,67,0.14) 100%)",
          backdropFilter: "blur(14px)",
        }}
        data-testid="winner-showcase-banner"
      >
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-xl flex-none"
               style={{ background: "rgba(212,168,67,0.2)", border: "1px solid rgba(212,168,67,0.4)" }}>
            <Trophy className="w-4.5 h-4.5 text-[#9C7A2C] dark:text-[#FFE19A]" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <PartyPopper className="w-3.5 h-3.5 text-[#9C7A2C] dark:text-[#FFE19A]" />
              <span className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-[#9C7A2C] dark:text-[#FFE19A]">
                {content.eventName || "Event"} — Winners
              </span>
            </div>
            <p className="text-[0.82rem] font-semibold text-ink dark:text-white/90 truncate"
               data-testid="winner-showcase-champion">
              🏆 {champion.display_name || champion.student_id || "Champion"}
              {typeof champion.amount === "number" ? ` — ${champion.amount} pts` : ""}
            </p>
            {topWinners.length > 1 && (
              <p className="text-[0.72rem] text-zinc-600 dark:text-white/60 truncate">
                {topWinners.slice(1, 5).map((w) => w.display_name || w.student_id).join(", ")}
              </p>
            )}
          </div>

          {content.distributionCompleted && (
            <span className="flex-none text-[9px] font-bold uppercase tracking-wide px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
              Rewards Sent
            </span>
          )}
        </div>

        {count > 1 && (
          <div className="flex items-center justify-center gap-1 pb-2" data-testid="winner-showcase-dots">
            {Array.from({ length: count }).map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Show winner showcase ${i + 1}`}
                onClick={() => setIndex(i)}
                className={`h-1.5 rounded-full transition-[width,background-color] ${
                  i === index
                    ? "w-4 bg-gradient-to-r from-amber-400 to-yellow-300"
                    : "w-1.5 bg-zinc-300 hover:bg-zinc-400 dark:bg-white/25 dark:hover:bg-white/45"
                }`}
              />
            ))}
          </div>
        )}
      </motion.section>
    </AnimatePresence>
  );
}
