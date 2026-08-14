// MyRankCard.jsx — "Your Rank" tile (Home Dashboard V4, Community Pulse).
//
// A NEW sibling to TopEarnerPanel.jsx, not a rewrite of it.
// TopEarnerPanel.jsx is left untouched because Author Studio's
// AchievementExperienceStudio live-preview panel imports it directly.
// This card reuses the SAME useTopEarners() data hook (zero duplicate
// fetching/leaderboard logic) and only adds one derived value:
// "which row is the signed-in student."
//
// Identity join, in order of preference:
//   1. studentId match — roster.js now passes through the Mongo-backed
//      leaderboard's real student_id/clean_id (see fetchLeaderboardFromBackend
//      in roster.js), so when that backend path is active this is a real,
//      reliable id-based join against student.studentId. No fabricated
//      mapping, no guessing — just an existing identifier that was being
//      fetched and then silently dropped before this change.
//   2. name match (best-effort) — the ONLY path available whenever the
//      roster is still being served from the legacy Google Sheets CSV
//      export (no ids at all, per SKIP_NAMES's own comments: "GAS Sheets
//      remains authoritative for most students in production today").
//      Case-insensitive/trimmed; can miss on genuine name-formatting
//      differences between the roster's free-text name and the account
//      name — that limitation is inherent to matching on free text, not
//      something a frontend can fully solve without the backend
//      attaching a real id to every roster row.
// Per the Dashboard Reconstruction Blueprint's data rule, a failed match
// (either path) never guesses or shows a wrong rank — but per the Final
// Polish Phase, it also never just vanishes: a signed-in student who
// simply isn't on the roster yet (brand new account, not yet synced) sees
// a truthful "not ranked yet" empty state instead of a silent gap.
import { Trophy } from "lucide-react";
import { useEffect, useRef } from "react";
import { motion, useMotionValue, useTransform, animate, useReducedMotion } from "framer-motion";
import { useTopEarners } from "../../hooks/useTopEarners";
import { useAuth } from "../../context/AuthContext";
import { elevation, radius } from "../../styles/tokens/designTokens";
import { easing, duration, ambient } from "../../styles/tokens/motionTokens";
import useAmbientActive from "../../hooks/useAmbientActive";
import EmptyStateCard from "./EmptyStateCard";

// RC2.5 — rank counts up to its real, already-fetched value on
// mount/change, same pattern as DashboardHeader's points counter. Skips
// the tween under reduced-motion; counts from 0 only on first mount, from
// the previous value on later updates (e.g. leaderboard refresh).
function useRankCountUp(rank) {
  const reducedMotion = useReducedMotion();
  const count = useMotionValue(rank);
  const display = useTransform(count, (v) => Math.round(v));
  const first = useRef(true);

  useEffect(() => {
    if (reducedMotion) {
      count.set(rank);
      return undefined;
    }
    const from = first.current ? 0 : count.get();
    first.current = false;
    const controls = animate(from, rank, {
      duration: 0.8,
      ease: easing.premiumEaseOut,
      onUpdate: (v) => count.set(v),
    });
    return () => controls.stop();
  }, [rank, reducedMotion, count]);

  return display;
}

function normalize(name) {
  return String(name || "").trim().toLowerCase();
}

function findMine(all, student) {
  const myId = normalize(student?.studentId);
  if (myId) {
    const byId = all.find((r) => r.studentId && normalize(r.studentId) === myId);
    if (byId) return byId;
  }
  const myName = normalize(student?.name);
  if (!myName) return null;
  return all.find((r) => normalize(r.name) === myName) || null;
}

export default function MyRankCard() {
  const { student, isAuthenticated } = useAuth() || {};
  const { all, totalCount, loading } = useTopEarners(5);
  const mine = all.length ? findMine(all, student) : null;
  // Hooks run unconditionally (rules of hooks) — before either early
  // return below.
  const rankDisplay = useRankCountUp(mine?.rank ?? 0);
  const { ref: ambientRef, active: ambientActive } = useAmbientActive();

  if (!isAuthenticated || loading) return null;

  if (!mine) {
    return (
      <div className="flex-1 min-w-[140px]">
        <EmptyStateCard
          Icon={Trophy}
          accent="#8B5CF6"
          title="Not ranked yet"
          subtitle="Your rank will appear here once you're on the leaderboard."
          compact
          data-testid="my-rank-card-empty"
        />
      </div>
    );
  }

  const percentile = totalCount > 0 ? Math.max(1, Math.ceil((mine.rank / totalCount) * 100)) : null;
  const restShadow = elevation.soft;
  const glowShadow = `${elevation.soft}, 0 0 0 1px rgba(139,92,246,0.35), 0 0 22px rgba(139,92,246,0.22)`;

  return (
    <motion.div
      ref={ambientRef}
      initial={{ opacity: 0, y: 10 }}
      animate={{
        opacity: 1,
        y: 0,
        boxShadow: ambientActive ? [restShadow, glowShadow, restShadow] : restShadow,
      }}
      transition={{
        duration: duration.base,
        ease: easing.premiumEaseOut,
        boxShadow: ambientActive
          ? { duration: ambient.breathe * 1.3, repeat: Infinity, ease: "easeInOut", delay: duration.base }
          : { duration: duration.base },
      }}
      className="flex-1 min-w-[140px] p-3.5 bg-gradient-to-br from-violet-50 to-white dark:from-violet-500/10 dark:to-transparent border border-violet-200/70 dark:border-violet-400/20"
      style={{ borderRadius: radius.md }}
      data-testid="my-rank-card"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] uppercase tracking-wide font-bold text-violet-500/80">Your Rank</p>
          <p className="text-[1.6rem] font-black text-ink dark:text-white leading-none mt-1 tnum" data-testid="my-rank-value">
            #<motion.span>{rankDisplay}</motion.span>
          </p>
          {percentile && (
            <p className="text-[11px] text-zinc-500 dark:text-white/50 mt-1">Top {percentile}%</p>
          )}
        </div>
        <span className="relative w-9 h-9 rounded-xl flex items-center justify-center bg-violet-500/15 text-violet-500 flex-none">
          {ambientActive && (
            <motion.span
              aria-hidden
              className="absolute inset-0 rounded-xl"
              style={{ boxShadow: "0 0 16px rgba(139,92,246,0.55)" }}
              animate={{ opacity: [0.3, 0.8, 0.3] }}
              transition={{ duration: ambient.breathe, repeat: Infinity, ease: "easeInOut" }}
            />
          )}
          <Trophy className="w-4.5 h-4.5" />
        </span>
      </div>
    </motion.div>
  );
}
