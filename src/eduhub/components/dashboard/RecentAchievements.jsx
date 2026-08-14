// RecentAchievements.jsx — "Recent Achievements" section (Home Dashboard V4).
//
// Traced end-to-end before building this (per the Dashboard Reconstruction
// process): the Activity Center's notification system already has a real,
// backend-populated `priority` field on every item, independent of
// `category` — and "achievement" is one of exactly four defined priority
// values (critical | important | achievement | normal — see
// activityTheme.js's PRIORITY_STYLES/categoryIcon, already used to render
// a distinct icon/color for achievement-priority items in the drawer,
// LiveActivityStrip and CathyAssistant). listNotifications() is a real
// REST call (notificationApi.js) — "no mock data, every payload comes
// from real backend events" per that file's own header.
//
// So this section is a small, honest extension of an EXISTING system,
// not a new subsystem: filter the same `useNotifications()` feed this
// page already consumes for LiveActivityStrip/CathyAssistant down to
// priority==="achievement", and render whatever real events are there.
//
// What could NOT be verified from this frontend-only repo: whether any
// backend event producer actually ever sets priority="achievement" today
// (the Render backend's source isn't in this repository — see CLAUDE.md).
// That is a real, disclosed unknown, not silently assumed either way —
// this component simply renders nothing when there are none, exactly like
// every other real-data-only widget on this page.
//
// No point-delta ("+5 pts") badge is shown: no notification item anywhere
// in this codebase carries a points/amount field (grepped notificationApi.js
// and every consumer) — inventing one would be fabricating data.
//
// Icon badges use a hexagon silhouette (closer to the approved mockup's
// badge shape) but all share the same Award glyph — the underlying
// notification data carries exactly one real signal (priority ===
// "achievement"), not a typed sub-category, so per-type icons would be
// fabricated structure. Only the accent color rotates per tile, which is
// genuinely just a rotating visual accent, not implied data.
//
// RC2 — softened from a solid-fill hexagon (white icon on a saturated
// accent, closer to a game badge) to a tinted hexagon matching the tint
// language every other Dashboard tile already uses (ContinueLearningShelf,
// LiveActivityStrip, MyRankCard). Added the entrance stagger this section
// was the only one missing, plus a one-shot shimmer sweep across the badge
// on mount ("soft shimmer" per the Dashboard motion language) — a single
// framer-motion pass, not a loop, so it reads as a quiet accent rather than
// a game-style effect. Covered by the shell's MotionConfig
// reducedMotion="user" like every other motion.* use in this component.
import { Award } from "lucide-react";
import { motion } from "framer-motion";
import { useMemo } from "react";
import { useNotifications } from "../../context/NotificationContext";
import { relativeTime } from "../activity/activityTheme";
import { elevation, radius } from "../../styles/tokens/designTokens";
import { easing, duration, stagger, spring } from "../../styles/tokens/motionTokens";

const TILE_ACCENTS = ["#EF4444", "#22C55E", "#8B5CF6", "#F59E0B"];
const HEXAGON_CLIP = "polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)";

export default function RecentAchievements() {
  const ctx = useNotifications();

  const achievements = useMemo(
    () => (ctx?.items || []).filter((n) => n.priority === "achievement").slice(0, 4),
    [ctx?.items],
  );

  if (!ctx || achievements.length === 0) return null;

  return (
    <section data-testid="recent-achievements">
      <div className="px-4 mb-2.5">
        <h2 className="font-display text-[1rem] font-bold text-ink dark:text-white">Recent Achievements</h2>
      </div>

      <div className="px-4 grid grid-cols-2 gap-3">
        {achievements.map((item, i) => {
          const accent = TILE_ACCENTS[i % TILE_ACCENTS.length];
          return (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: duration.base, delay: i * stagger.tight, ease: easing.premiumEaseOut }}
              className="p-3.5 bg-white dark:bg-white/[0.05] border border-zinc-200 dark:border-white/[0.08]"
              style={{ borderRadius: radius.md, boxShadow: elevation.soft }}
              data-testid={`recent-achievement-${i}`}
            >
              <motion.div
                className="relative w-9 h-9 flex items-center justify-center mb-2.5 overflow-hidden"
                style={{ background: `${accent}1A`, color: accent, clipPath: HEXAGON_CLIP }}
                initial={{ scale: 0.6 }}
                animate={{ scale: 1 }}
                transition={{ ...spring.tap, delay: duration.base * 0.5 + i * stagger.tight }}
              >
                <Award className="w-4.5 h-4.5" />
                <motion.span
                  aria-hidden
                  className="absolute inset-0"
                  style={{ background: "linear-gradient(115deg, transparent 30%, rgba(255,255,255,0.55) 48%, transparent 66%)" }}
                  initial={{ x: "-120%" }}
                  animate={{ x: "120%" }}
                  transition={{ duration: 0.9, delay: 0.3 + i * stagger.tight, ease: easing.premiumEaseOut }}
                />
              </motion.div>
              <p className="text-[0.8rem] font-bold text-ink dark:text-white leading-snug line-clamp-2">
                {item.title}
              </p>
              <p className="text-[10.5px] text-zinc-500 dark:text-white/50 mt-1 tracking-wide">
                {relativeTime(item.createdAt)}
              </p>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}
