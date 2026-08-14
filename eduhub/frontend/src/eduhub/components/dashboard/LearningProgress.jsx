// LearningProgress.jsx — "Learning Progress" section (Home Dashboard RC2.9).
//
// Replaces the removed "Your Rank" card (MyRankCard.jsx — left on disk
// unused, same rollback-safety convention this codebase already uses)
// with a fuller explanation of the student's real standing: scope,
// period, position, percentile, tier, and genuine progress toward the
// next tier. Every number here is real, existing data — nothing is
// estimated or projected:
//   • rank/percentile — the SAME useTopEarners() hook + identity-join
//     MyRankCard used (duplicated here, not imported, matching this
//     codebase's own established "small honest duplicate" convention —
//     see ContinueLearningShelf.jsx's header comment for the same
//     reasoning applied elsewhere).
//   • scope/period — verified against roster.js: fetchRosterPoints() has
//     no class filter and no date-range parameter, so this is honestly
//     "All EduHub students" / "All-time points," not a guess.
//   • tier + progress-toward-next-tier — reuses tierDisplay()/
//     tierProgress() from attendance/attendancePassport.js UNCHANGED.
//     That function already exists, is already real (derived from the
//     actual /attendance/me on_time_rate_rolling field against the real
//     reward-tier thresholds in attendanceSchema.js), and is already
//     used elsewhere in this app — reused here, not reinvented.
//
// The Champion Cup artwork/stage (ChampionCupStage.jsx) is shared,
// unmodified, on the card. Tapping the card opens the Achievement Center
// (Trophy Tier achievements + claimable rewards — see
// pages/achievements/AchievementCenter.jsx), which replaced the previous
// Learning Progress detail sheet. Same entry point, no new route.
import { useState, lazy, Suspense } from "react";
import { motion } from "framer-motion";
import { ChevronRight, TrendingUp, Gift } from "lucide-react";
import { useTopEarners } from "../../hooks/useTopEarners";
import { useAttendance } from "../../hooks/useAttendance";
import useAchievements from "../../hooks/useAchievements";
import { useAuth } from "../../context/AuthContext";
import { elevation, radius } from "../../styles/tokens/designTokens";
import { easing, duration, spring } from "../../styles/tokens/motionTokens";
import { tierDisplay, tierProgress } from "../../pages/attendance/attendancePassport";
import ChampionCupStage from "./ChampionCupStage";
import EmptyStateCard from "./EmptyStateCard";
import TrophyJourneyStrip, { claimableCount } from "./TrophyJourneyStrip";

// Achievement Center (Phase 1) — replaces the previous Learning Progress
// detail sheet. Lazy-loaded so the Dashboard bundle stays light and the
// trophy artwork is only fetched when the student actually opens it.
const AchievementCenter = lazy(() => import("../../pages/achievements/AchievementCenter"));

function normalize(name) {
  return String(name || "").trim().toLowerCase();
}

// Same identity-join MyRankCard.jsx used — see header comment.
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

function ProgressFacts({ mine, percentile, tier, progress }) {
  const t = tierDisplay(tier);
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2">
      {/* RC3.2 §5 — Percentile gets stronger visual hierarchy (larger,
          violet-accented) than the other three facts: it's the single
          number a student reads fastest to answer "how am I doing." */}
      <Fact label="Position" value={`#${mine.rank}`} />
      <Fact label="Percentile" value={percentile ? `Top ${percentile}%` : "—"} valueColor="#8B5CF6" emphasize />
      <Fact label="Current tier" value={t.label} valueColor={t.color} />
      <Fact
        label={progress.nextTier ? `To ${tierDisplay(progress.nextTier).label}` : "Tier"}
        value={progress.atMax ? "Highest tier" : `${Math.round(progress.fraction * 100)}%`}
      />
    </div>
  );
}

function Fact({ label, value, valueColor, emphasize }) {
  return (
    <div>
      <p className="text-[9.5px] uppercase tracking-wide font-bold text-zinc-400 dark:text-white/35">{label}</p>
      <p
        className={`${emphasize ? "text-[1.05rem]" : "text-[0.92rem]"} font-bold mt-0.5`}
        style={valueColor ? { color: valueColor } : undefined}
      >
        <span className={valueColor ? "" : "text-ink dark:text-white"}>{value}</span>
      </p>
    </div>
  );
}

// The pill that replaced the generic "Details" affordance: it now says what
// is actually inside — and flips to a warm "Reward ready" state whenever a
// claimable reward is waiting, the single strongest reason to tap.
function OpenPill({ claimable }) {
  if (claimable > 0) {
    return (
      <span
        className="absolute right-3 top-2.5 z-10 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[9px] font-bold uppercase tracking-wide text-white"
        style={{ background: "linear-gradient(135deg,#F59E0B,#D97706)", boxShadow: "0 4px 12px -4px rgba(217,119,6,0.5)" }}
        data-testid="lp-reward-ready-pill"
      >
        <Gift className="w-3 h-3" /> Reward ready
      </span>
    );
  }
  return (
    <span
      className="absolute right-3 top-2.5 z-10 inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide text-violet-600 dark:text-violet-300 bg-violet-500/10"
      data-testid="lp-open-pill"
    >
      <Gift className="w-3 h-3" /> Trophies &amp; Rewards <ChevronRight className="w-3 h-3" />
    </span>
  );
}

export default function LearningProgress() {
  const { student, isAuthenticated } = useAuth() || {};
  const { all, totalCount, loading } = useTopEarners(5);
  const { me, loading: attendanceLoading, tier } = useAttendance({ enabled: isAuthenticated, pollLive: false });
  const { data: achievements, refresh: refreshAchievements } = useAchievements(isAuthenticated);
  const [open, setOpen] = useState(false);

  // Refresh the Dashboard preview when the sheet closes, so a claim made
  // inside the Achievement Center is reflected immediately (pill/count).
  const handleOpenChange = (v) => {
    setOpen(v);
    if (!v) refreshAchievements();
  };

  if (!isAuthenticated || loading) return null;

  const mine = all.length ? findMine(all, student) : null;
  const claimable = claimableCount(achievements);

  // The Achievement Center is PRIVATE (not leaderboard-dependent). The card
  // is now achievement-first: as long as /api/achievements/me answered, the
  // full journey preview renders even before the student appears on the
  // roster (previously this state collapsed to a bare empty card that
  // communicated nothing about the trophy journey).
  if (!mine && !achievements) {
    return (
      <section data-testid="learning-progress">
        <div className="px-4 mb-2.5">
          <h2 className="font-display text-[1rem] font-bold text-ink dark:text-white">Learning Progress</h2>
        </div>
        <div className="px-4">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="w-full text-left"
            data-testid="learning-progress-empty-open"
          >
            <EmptyStateCard
              Icon={TrendingUp}
              accent="#8B5CF6"
              title="Achievement Center"
              subtitle="View your trophies, progress and claimable rewards."
              compact
              data-testid="learning-progress-empty"
            />
          </button>
        </div>
        {open && (
          <Suspense fallback={null}>
            <AchievementCenter open={open} onOpenChange={handleOpenChange} />
          </Suspense>
        )}
      </section>
    );
  }

  const percentile = mine && totalCount > 0 ? Math.max(1, Math.ceil((mine.rank / totalCount) * 100)) : null;
  const progress = !attendanceLoading && me ? tierProgress(me) : { atMax: true, fraction: 0, nextTier: null };

  return (
    <section data-testid="learning-progress">
      <div className="px-4 mb-2.5 flex items-baseline justify-between">
        <h2 className="font-display text-[1rem] font-bold text-ink dark:text-white">Learning Progress</h2>
      </div>

      <div className="px-4">
        <motion.button
          type="button"
          onClick={() => setOpen(true)}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          whileTap={{ scale: 0.97, transition: spring.tap }}
          transition={{ duration: duration.base, ease: easing.premiumEaseOut }}
          className="relative w-full text-left overflow-hidden bg-white dark:bg-white/[0.05] border border-zinc-200 dark:border-white/[0.08]"
          style={{ borderRadius: radius.lg, boxShadow: elevation.soft }}
          data-testid="learning-progress-card"
        >
          <OpenPill claimable={claimable} />
          <ChampionCupStage size="card" />
          <div className="px-3.5 pb-3 pt-1.5">
            {/* Achievement journey preview — current tier, all 5 tiers,
                next tier progress, reward motivation, Khmer guidance. */}
            {achievements && <TrophyJourneyStrip data={achievements} />}
            {/* Rank/percentile facts kept unchanged beneath the journey. */}
            {mine && (
              <div className={achievements ? "mt-3 pt-2.5 border-t border-zinc-100 dark:border-white/[0.06]" : ""}>
                <ProgressFacts mine={mine} percentile={percentile} tier={tier} progress={progress} />
              </div>
            )}
          </div>
        </motion.button>
      </div>

      {open && (
        <Suspense fallback={null}>
          <AchievementCenter open={open} onOpenChange={handleOpenChange} />
        </Suspense>
      )}
    </section>
  );
}
