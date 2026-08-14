/**
 * LiveActivityStrip.jsx — Community Pulse's live activity feed (Dashboard).
 *
 * RC2: redesigned from a single-line rotating ticker on a near-black slab
 * (`eh-activity-surface`, calibrated for dark-only neon accents from
 * activityTheme.js — a design that predates and clashes with the flat
 * light V4 Dashboard) into a small stacked feed card using the SAME
 * elevation/radius language as every other Dashboard tile. activityTheme.js
 * itself is untouched (shared with the bell/drawer/Cathy) — its accent
 * colors are reused only as a small tinted icon-chip, the same pattern
 * RecentAchievements.jsx already uses, rather than driving the whole
 * surface color the way the old dark strip did.
 *
 * Still the student's REAL events from the last 24h, still opens the same
 * drawer on tap — presentation-only. A genuine empty state (rather than
 * silent absence) now renders when there is confirmed zero recent
 * activity, distinguished from "still loading" via the context's own
 * `loading` flag so it never flashes before real data arrives.
 */
import { Activity } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useMemo, useRef } from "react";
import { useNotifications } from "../../context/NotificationContext";
import { priorityStyle, relativeTime } from "./activityTheme";
import { elevation, radius } from "../../styles/tokens/designTokens";
import EmptyStateCard from "../dashboard/EmptyStateCard";

const WINDOW_MS = 24 * 3600 * 1000;
const MAX_VISIBLE = 3;

export default function LiveActivityStrip() {
  const ctx = useNotifications();

  const recent = useMemo(() => {
    const now = Date.now();
    return (ctx?.items || [])
      .filter((n) => now - new Date(n.createdAt).getTime() < WINDOW_MS)
      .slice(0, MAX_VISIBLE);
  }, [ctx?.items]);

  // RC2.5 — "new activity briefly highlighted": a one-shot flash for any
  // item that genuinely wasn't in the feed on the previous render. Seeded
  // (not flashed) on first mount, so a fresh page load never flashes every
  // row at once — only real, live arrivals while the strip is already
  // being looked at.
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

  if (!recent.length) {
    return (
      <div className="px-4 mt-2" data-testid="live-activity-strip">
        <EmptyStateCard
          Icon={Activity}
          accent="#00A7C4"
          title="No recent activity"
          subtitle="Real updates — points, rewards, classes — will appear here as they happen."
          compact
          data-testid="live-activity-strip-empty"
        />
      </div>
    );
  }

  return (
    <div className="px-4 mt-2" data-testid="live-activity-strip">
      <button
        onClick={ctx.openDrawer}
        data-testid="live-activity-strip-btn"
        className="w-full text-left rounded-2xl bg-white dark:bg-white/[0.05] border border-zinc-200 dark:border-white/[0.08] divide-y divide-zinc-100 dark:divide-white/[0.06] overflow-hidden active:scale-[0.99] transition-transform"
        style={{ borderRadius: radius.lg, boxShadow: elevation.soft }}
      >
        <AnimatePresence initial={false}>
        {recent.map((item, i) => {
          const pri = priorityStyle(item.priority);
          const isNew = newIds.has(item.id);
          return (
            <motion.span
              key={item.id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{
                opacity: 1,
                y: 0,
                backgroundColor: isNew ? [`${pri.accent}22`, `${pri.accent}00`] : `${pri.accent}00`,
              }}
              exit={{ opacity: 0, height: 0 }}
              whileHover={{ backgroundColor: "rgba(127,127,127,0.06)" }}
              transition={{
                duration: 0.35,
                delay: i * 0.06,
                ease: [0.22, 1, 0.36, 1],
                backgroundColor: isNew ? { duration: 2.2, ease: "easeOut" } : { duration: 0.15 },
              }}
              style={{ display: "flex" }}
              className="items-center gap-2.5 px-3 py-2.5"
            >
              <span
                className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                style={{ background: `${pri.accent}1A`, color: pri.accent }}
              >
                <Activity className="w-3.5 h-3.5" />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[11.5px] font-semibold text-ink dark:text-white truncate">
                  {item.title}
                </span>
                {item.body && (
                  <span className="block text-[10.5px] text-zinc-500 dark:text-white/50 truncate">
                    {item.body}
                  </span>
                )}
              </span>
              <span className="text-[9.5px] text-zinc-400 dark:text-white/40 shrink-0 tabular-nums">
                {relativeTime(item.createdAt)}
              </span>
            </motion.span>
          );
        })}
        </AnimatePresence>
      </button>
    </div>
  );
}
