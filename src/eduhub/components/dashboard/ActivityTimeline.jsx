// ActivityTimeline.jsx — "Activity Timeline" section (Home Dashboard RC2.9).
//
// Replaces the removed AnnouncementStrip (GAS legacy announcement ticker)
// per explicit RC2.9 direction: "Completely remove. Do not redesign it. Do
// not rename it." The GAS announcement content itself is NOT carried
// forward into this component — those messages are un-timestamped strings
// (no id, no createdAt), so representing them as entries in a timestamped
// vertical timeline would mean fabricating a time for each one. Rather
// than invent that data, this section is powered ENTIRELY by the same
// real, timestamped feed LiveActivityStrip/RecentAchievements/
// CathyAssistant already read (useNotifications()) — a genuine record of
// "what happened since I last opened EduHub," never a guess.
//
// Data window is wider than the old LiveActivityStrip tile (7 days here,
// vs. LiveActivityStrip's 24h) since this is now the primary personal
// record for the page, not a small supporting tile — still real data,
// just a more generous real window rather than a bigger real limit.
import { Activity } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useMemo, useRef } from "react";
import { useNotifications } from "../../context/NotificationContext";
import { priorityStyle, categoryIcon, relativeTime, groupByDay } from "../activity/activityTheme";
import { elevation, radius } from "../../styles/tokens/designTokens";
import { easing, duration, stagger } from "../../styles/tokens/motionTokens";
import EmptyStateCard from "./EmptyStateCard";

const WINDOW_MS = 7 * 24 * 3600 * 1000;
const MAX_VISIBLE = 8;
const DAY_LABELS = ["Today", "Yesterday", "Older"];

export default function ActivityTimeline() {
  const ctx = useNotifications();

  const recent = useMemo(() => {
    const now = Date.now();
    return (ctx?.items || [])
      .filter((n) => now - new Date(n.createdAt).getTime() < WINDOW_MS)
      .slice(0, MAX_VISIBLE);
  }, [ctx?.items]);

  const buckets = useMemo(() => groupByDay(recent), [recent]);

  const seenIdsRef = useRef(null);
  const newIds = useMemo(() => {
    const currentIds = new Set(recent.map((r) => r.id));
    if (seenIdsRef.current === null) {
      seenIdsRef.current = currentIds;
      return new Set();
    }
    const fresh = new Set([...currentIds].filter((id) => !seenIdsRef.current.has(id)));
    seenIdsRef.current = currentIds;
    return fresh;
  }, [recent]);

  if (!ctx || ctx.loading) return null;

  return (
    <section data-testid="activity-timeline">
      <div className="px-4 mb-2.5 flex items-center justify-between">
        <h2 className="font-display text-[1rem] font-bold text-ink dark:text-white">Activity Timeline</h2>
        {/* "Live badge only when appropriate" — ctx.wsConnected is the
            real live-socket state, never a decorative always-on badge. */}
        {ctx.wsConnected && recent.length > 0 && (
          <span className="inline-flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Live
          </span>
        )}
      </div>

      {recent.length === 0 ? (
        <div className="px-4">
          <EmptyStateCard
            Icon={Activity}
            accent="#00A7C4"
            title="Nothing to show yet"
            subtitle="Points, lessons, streaks, and rewards will appear here as they happen."
            compact
            data-testid="activity-timeline-empty"
          />
        </div>
      ) : (
        <div className="px-4">
          <button
            onClick={ctx.openDrawer}
            data-testid="activity-timeline-btn"
            className="relative w-full text-left p-4 bg-white dark:bg-white/[0.05] border border-zinc-200 dark:border-white/[0.08]"
            style={{ borderRadius: radius.lg, boxShadow: elevation.soft }}
          >
            {DAY_LABELS.map((label) => {
              const items = buckets[label];
              if (!items || items.length === 0) return null;
              return (
                <div key={label} className="mb-1 last:mb-0">
                  <p className="text-[9.5px] uppercase tracking-wide font-bold text-zinc-400 dark:text-white/35 mb-2 first:mt-0 mt-3">
                    {label}
                  </p>
                  <AnimatePresence initial={false}>
                    {items.map((item, i) => {
                      const pri = priorityStyle(item.priority);
                      const Icon = categoryIcon(item.category, item.priority);
                      const isNew = newIds.has(item.id);
                      const isLast = i === items.length - 1;
                      return (
                        <motion.div
                          key={item.id}
                          layout
                          initial={{ opacity: 0, y: 8 }}
                          animate={{
                            opacity: 1,
                            y: 0,
                            backgroundColor: isNew ? [`${pri.accent}1F`, `${pri.accent}00`] : `${pri.accent}00`,
                          }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{
                            duration: duration.fast,
                            delay: i * stagger.tight,
                            ease: easing.premiumEaseOut,
                            backgroundColor: isNew ? { duration: 2.2, ease: "easeOut" } : { duration: 0.15 },
                          }}
                          className="relative flex gap-3 pb-3 -mx-1 px-1 rounded-xl"
                        >
                          {/* Connecting timeline line + icon dot */}
                          <div className="relative flex-none flex flex-col items-center">
                            <span
                              className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 z-10"
                              style={{ background: `${pri.accent}1A`, color: pri.accent }}
                            >
                              <Icon className="w-3.5 h-3.5" />
                            </span>
                            {!isLast && (
                              <span className="w-px flex-1 bg-zinc-150 dark:bg-white/10 mt-1" aria-hidden />
                            )}
                          </div>
                          <div className="flex-1 min-w-0 pt-0.5">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-[12.5px] font-semibold text-ink dark:text-white truncate">
                                {item.title}
                              </span>
                              <span className="text-[9.5px] text-zinc-400 dark:text-white/40 shrink-0 tabular-nums">
                                {relativeTime(item.createdAt)}
                              </span>
                            </div>
                            {item.body && (
                              <p className="text-[11px] text-zinc-500 dark:text-white/50 mt-0.5 line-clamp-2">
                                {item.body}
                              </p>
                            )}
                          </div>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              );
            })}
          </button>
        </div>
      )}
    </section>
  );
}
