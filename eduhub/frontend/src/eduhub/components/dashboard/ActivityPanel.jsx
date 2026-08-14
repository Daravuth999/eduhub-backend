// ActivityPanel.jsx — "Activity Panel" (Home Dashboard RC3).
//
// RC3 §1/§7: replaces ActivityTimeline.jsx's full vertical inbox-style
// feed (which had grown to dominate the page — confirmed via a live
// screenshot showing 8+ stacked rows) with a compact, single-item
// rotating preview — an "Apple News headline carousel," not a
// notification inbox. ActivityTimeline.jsx is left on disk unused (same
// rollback-safety convention this codebase uses elsewhere).
//
// Same real data source as before (useNotifications()) — still never
// fabricated — but now EXCLUDES priority==="achievement" items. Per
// RC3 §7, Recent Achievements and this panel were showing overlapping
// content (both read the same feed with no partition), which is a real,
// confirmed duplication bug, not a hypothetical one. Achievement-priority
// items are personal accomplishments — RecentAchievements.jsx's exclusive
// territory; this panel covers everything else real (announcements,
// class updates, rewards, payments, system events).
//
// Tapping the panel opens the SAME real notification drawer every other
// widget on this page already opens (ctx.openDrawer) — "the complete
// Activity page" per the RC3 spec is this existing drawer, not a new
// route (routing is explicitly out of scope for this phase).
import { Activity } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNotifications } from "../../context/NotificationContext";
import { priorityStyle, categoryIcon, relativeTime } from "../activity/activityTheme";
import { elevation, radius } from "../../styles/tokens/designTokens";
import { easing } from "../../styles/tokens/motionTokens";
import EmptyStateCard from "./EmptyStateCard";

const WINDOW_MS = 7 * 24 * 3600 * 1000;
const MAX_ITEMS = 6;
const ROTATE_MS = 6500; // within the RC3-specified 5-8s range

export default function ActivityPanel() {
  const ctx = useNotifications();

  const items = useMemo(() => {
    const now = Date.now();
    return (ctx?.items || [])
      .filter((n) => n.priority !== "achievement")
      .filter((n) => now - new Date(n.createdAt).getTime() < WINDOW_MS)
      .slice(0, MAX_ITEMS);
  }, [ctx?.items]);

  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [paused, setPaused] = useState(false);

  // Clamp index if the underlying item count shrinks (e.g. feed refresh).
  useEffect(() => {
    if (index > items.length - 1) setIndex(Math.max(0, items.length - 1));
  }, [items.length, index]);

  useEffect(() => {
    if (items.length < 2 || paused) return undefined;
    const id = setInterval(() => {
      setDirection(1);
      setIndex((i) => (i + 1) % items.length);
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, [items.length, paused]);

  const go = (delta) => {
    if (items.length < 2) return;
    setDirection(delta);
    setIndex((i) => (i + delta + items.length) % items.length);
  };

  const dragStartX = useRef(0);

  if (!ctx || ctx.loading) return null;

  if (items.length === 0) {
    return (
      <section data-testid="activity-panel">
        <div className="px-4 mb-2.5 flex items-center justify-between">
          <h2 className="font-display text-[1rem] font-bold text-ink dark:text-white">Activity</h2>
        </div>
        <div className="px-4">
          <EmptyStateCard
            Icon={Activity}
            accent="#00A7C4"
            title="Nothing to show yet"
            subtitle="Announcements, rewards, and class updates will appear here."
            compact
            data-testid="activity-panel-empty"
          />
        </div>
      </section>
    );
  }

  const current = items[Math.min(index, items.length - 1)];
  const pri = priorityStyle(current.priority);
  const Icon = categoryIcon(current.category, current.priority);

  const slideVariants = {
    enter: (dir) => ({ opacity: 0, x: dir > 0 ? 24 : -24 }),
    center: { opacity: 1, x: 0 },
    exit: (dir) => ({ opacity: 0, x: dir > 0 ? -24 : 24 }),
  };

  return (
    <section data-testid="activity-panel">
      <div className="px-4 mb-2.5 flex items-center justify-between">
        <h2 className="font-display text-[1rem] font-bold text-ink dark:text-white">Activity</h2>
        {ctx.wsConnected && (
          <span className="inline-flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Live
          </span>
        )}
      </div>

      <div className="px-4">
        <motion.button
          type="button"
          onClick={ctx.openDrawer}
          onPointerDown={() => {
            setPaused(true);
          }}
          onPointerUp={() => setPaused(false)}
          onPointerLeave={() => setPaused(false)}
          drag={items.length > 1 ? "x" : false}
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={0.6}
          onDragStart={(_, info) => {
            dragStartX.current = info.point.x;
          }}
          onDragEnd={(_, info) => {
            const delta = info.point.x - dragStartX.current;
            if (delta < -40) go(1);
            else if (delta > 40) go(-1);
          }}
          className="relative w-full text-left overflow-hidden bg-white dark:bg-white/[0.05] border border-zinc-200 dark:border-white/[0.08] px-3.5 py-3"
          style={{ borderRadius: radius.lg, boxShadow: elevation.soft }}
          data-testid="activity-panel-card"
        >
          <AnimatePresence mode="wait" custom={direction} initial={false}>
            <motion.div
              key={current.id}
              custom={direction}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.35, ease: easing.premiumEaseOut }}
              className="flex items-center gap-3"
            >
              <span
                className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: `${pri.accent}1A`, color: pri.accent }}
              >
                <Icon className="w-4.5 h-4.5" />
              </span>
              <span className="flex-1 min-w-0">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-[12.5px] font-semibold text-ink dark:text-white truncate">
                    {current.title}
                  </span>
                  <span className="text-[9.5px] text-zinc-400 dark:text-white/40 shrink-0 tabular-nums">
                    {relativeTime(current.createdAt)}
                  </span>
                </span>
                {current.body && (
                  <span className="block text-[11px] text-zinc-500 dark:text-white/50 mt-0.5 truncate">
                    {current.body}
                  </span>
                )}
              </span>
            </motion.div>
          </AnimatePresence>

          {items.length > 1 && (
            <div className="relative flex items-center justify-center gap-1.5 mt-2.5">
              {items.map((_, i) => (
                <span
                  key={i}
                  className={`h-1.5 rounded-full transition-[width,background-color] ${
                    i === index ? "w-4" : "w-1.5 bg-zinc-300 dark:bg-white/25"
                  }`}
                  style={i === index ? { background: pri.accent } : undefined}
                />
              ))}
            </div>
          )}
        </motion.button>
      </div>
    </section>
  );
}
