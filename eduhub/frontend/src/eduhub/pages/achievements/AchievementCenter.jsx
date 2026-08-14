// AchievementCenter.jsx — private Trophy Tier Achievement Center (Phase 1).
//
// Replaces the previous "Learning Progress" detail sheet: same entry point
// (tapping the Learning Progress dashboard card), same bottom-sheet
// presentation convention (Radix Dialog + framer-motion, mirroring the
// pattern the previous LearningProgressModal established) — no new route,
// no new menu item.
//
// PRIVATE by design: every number comes from GET /api/achievements/me,
// which is scoped to the authenticated student. Nothing is fabricated —
// if the backend can't be reached the sheet shows an error state, never
// placeholder values.
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Lock, Check, Gift, Loader2, RefreshCw } from "lucide-react";
import { getAchievements, claimReward } from "../../lib/achievementApi";
import { haptic } from "../../lib/haptics";
import TrophyAmbience from "./TrophyAmbience";
import AchievementIntro from "./AchievementIntro";
import { elevation, radius } from "../../styles/tokens/designTokens";
import { easing, duration, spring } from "../../styles/tokens/motionTokens";

/* ------------------------------------------------------------------ */
/* Small pieces                                                        */
/* ------------------------------------------------------------------ */

function SummaryStat({ label, value, testId }) {
  return (
    <div className="flex-1 min-w-0 text-center" data-testid={testId}>
      <p className="text-[1.05rem] font-extrabold text-ink dark:text-white leading-tight truncate">{value}</p>
      <p className="text-[9.5px] uppercase tracking-wide font-bold text-zinc-400 dark:text-white/35 mt-0.5">{label}</p>
    </div>
  );
}

function MetricRow({ label, value }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[0.78rem] text-zinc-500 dark:text-white/50">{label}</span>
      <span className="text-[0.82rem] font-bold text-ink dark:text-white">{value.toLocaleString()}</span>
    </div>
  );
}

function RequirementRow({ req }) {
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[0.75rem] font-semibold text-zinc-600 dark:text-white/60 flex items-center gap-1">
          {req.met && <Check className="w-3 h-3 text-emerald-500" />}
          {req.label}
        </span>
        <span className={`text-[0.72rem] font-bold ${req.met ? "text-emerald-500" : "text-zinc-500 dark:text-white/45"}`}>
          {req.current.toLocaleString()} / {req.required.toLocaleString()}
        </span>
      </div>
      <div className="h-1 rounded-full bg-zinc-100 dark:bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{
            width: `${Math.max(3, Math.round(req.fraction * 100))}%`,
            background: req.met ? "#10B981" : "#8B5CF6",
          }}
        />
      </div>
      {!req.met && (
        <p className="text-[0.68rem] text-zinc-400 dark:text-white/35 mt-0.5">
          {req.remaining.toLocaleString()} remaining
        </p>
      )}
    </div>
  );
}

function TrophyArtwork({ trophy, size = 160, className = "" }) {
  return (
    <div className={`relative inline-block ${className}`}>
      <img
        src={trophy.artwork}
        alt={trophy.name}
        loading="lazy"
        decoding="async"
        width={size}
        height={size}
        className="object-contain transition-[filter] duration-300"
        style={{
          width: size,
          height: size,
          filter: trophy.unlocked ? "none" : "grayscale(1) opacity(0.55) contrast(0.9)",
        }}
        draggable={false}
      />
      {!trophy.unlocked && (
        <span className="absolute bottom-1 right-1 inline-flex items-center justify-center w-5 h-5 rounded-full bg-zinc-200 dark:bg-white/15 border border-white dark:border-white/10">
          <Lock className="w-2.5 h-2.5 text-zinc-500 dark:text-white/60" />
        </span>
      )}
    </div>
  );
}

function ClaimButton({ trophy, claiming, onClaim }) {
  if (trophy.claimed) {
    return (
      <div
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[0.8rem] font-bold"
        data-testid={`reward-claimed-${trophy.trophy_id}`}
      >
        <Check className="w-4 h-4" /> Reward Claimed
      </div>
    );
  }
  if (!trophy.claimable) return null;
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.96, transition: spring.tap }}
      disabled={claiming}
      onClick={() => onClaim(trophy.trophy_id)}
      className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-full text-white text-[0.82rem] font-bold disabled:opacity-60"
      style={{ background: "linear-gradient(135deg,#8B5CF6,#6D28D9)", boxShadow: "0 6px 18px -6px rgba(109,40,217,0.5)" }}
      data-testid={`claim-reward-${trophy.trophy_id}`}
    >
      {claiming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Gift className="w-4 h-4" />}
      Claim Reward
    </motion.button>
  );
}

function RewardSection({ trophy, claiming, onClaim }) {
  const points = trophy?.reward?.points || 0;
  if (!trophy) return null;
  return (
    <div
      className="rounded-2xl border border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.05] p-4 text-center"
      style={{ boxShadow: elevation.soft }}
      data-testid="reward-section"
    >
      <p className="text-[10px] uppercase tracking-wide font-bold text-zinc-400 dark:text-white/35">Reward</p>
      <p className="text-[1.4rem] font-extrabold mt-0.5" style={{ color: "#8B5CF6" }}>
        {points > 0 ? `+${points.toLocaleString()} Points` : "Not configured yet"}
      </p>
      <div className="mt-2.5">
        <ClaimButton trophy={trophy} claiming={claiming} onClaim={onClaim} />
        {!trophy.claimed && !trophy.claimable && trophy.unlocked && points > 0 && (
          <p className="text-[0.7rem] text-zinc-400 dark:text-white/35">Claiming is not enabled for this trophy yet.</p>
        )}
        {!trophy.unlocked && (
          <p className="text-[0.7rem] text-zinc-400 dark:text-white/35">Unlock this trophy to claim its reward.</p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Trophy carousel — CSS scroll-snap, no extra library                 */
/* ------------------------------------------------------------------ */

function TrophyCarousel({ trophies, selectedId, currentId, onSelect }) {
  const trackRef = useRef(null);

  useEffect(() => {
    // Center the current (or first) trophy on mount — premium snap.
    const track = trackRef.current;
    if (!track) return;
    const target = track.querySelector(`[data-tid="${currentId || (trophies[0] && trophies[0].trophy_id)}"]`);
    if (target) {
      const left = target.offsetLeft - (track.clientWidth - target.clientWidth) / 2;
      // "instant" is not a real feature to detect on a DOM element (the
      // previous `"instant" in track` check always evaluated false, since
      // "instant" is never a property name on an HTMLElement) — scrollTo's
      // behavior option only ever needs "auto" here; there is nothing to
      // feature-detect.
      track.scrollTo({ left, behavior: "auto" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  return (
    <div
      ref={trackRef}
      className="flex gap-3 overflow-x-auto px-8 py-2 -mx-4 scrollbar-none"
      style={{ scrollSnapType: "x mandatory", WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}
      data-testid="trophy-carousel"
    >
      {trophies.map((t) => {
        const selected = t.trophy_id === selectedId;
        return (
          <button
            key={t.trophy_id}
            type="button"
            data-tid={t.trophy_id}
            onClick={() => onSelect(t.trophy_id)}
            className={`shrink-0 rounded-2xl border p-3 flex flex-col items-center transition-colors duration-200 ${
              selected
                ? "border-violet-400 dark:border-violet-500/60 bg-violet-50/60 dark:bg-violet-500/10"
                : "border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.04]"
            }`}
            style={{ scrollSnapAlign: "center", width: 118, boxShadow: selected ? elevation.soft : "none" }}
            data-testid={`trophy-card-${t.trophy_id}`}
          >
            <TrophyArtwork trophy={t} size={72} />
            <p className="text-[0.68rem] font-bold text-ink dark:text-white mt-1.5 text-center leading-tight line-clamp-2">
              {t.name}
            </p>
            <p className={`text-[0.6rem] font-bold mt-0.5 ${
              t.claimed ? "text-emerald-500" : t.unlocked ? "text-violet-500" : "text-zinc-400 dark:text-white/35"
            }`}>
              {t.claimed ? "Claimed" : t.unlocked ? "Unlocked" : "Locked"}
            </p>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main sheet                                                          */
/* ------------------------------------------------------------------ */

export default function AchievementCenter({ open, onOpenChange }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [claimingId, setClaimingId] = useState(null);
  const [claimResult, setClaimResult] = useState(null);
  const aliveRef = useRef(true);
  const claimResultTimerRef = useRef(null);

  const load = useCallback(async ({ announce = false } = {}) => {
    setError(null);
    try {
      const d = await getAchievements();
      if (!aliveRef.current) return;
      setData(d);
      setSelectedId((sel) => sel || d.current_trophy_id || d.next_trophy_id || d.trophies?.[0]?.trophy_id || null);
      if (announce && d.current_trophy_id) haptic.select(); // earned trophy greets you
    } catch (e) {
      if (aliveRef.current) setError(e?.message || "Failed to load achievements");
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    if (open) load({ announce: true });
    return () => {
      aliveRef.current = false;
      // Prevent a pending "clear the claim toast" timeout from firing a
      // state update after the sheet has closed/unmounted.
      if (claimResultTimerRef.current) clearTimeout(claimResultTimerRef.current);
    };
  }, [open, load]);

  const handleClaim = useCallback(async (trophyId) => {
    haptic.tick();
    setClaimingId(trophyId);
    setClaimResult(null);
    try {
      const res = await claimReward(trophyId);
      if (!aliveRef.current) return;
      setClaimResult({ ok: true, points: res.points, celebration: res.celebration });
      if (res.celebration) haptic.celebrate(); else haptic.success();
      await load(); // refresh real state from backend — never optimistic
    } catch (e) {
      if (!aliveRef.current) return;
      // 409 = already claimed elsewhere — a reload shows the true state.
      setClaimResult({ ok: false, text: e?.message || "Claim failed" });
      if (e?.status === 409) await load();
    } finally {
      if (aliveRef.current) setClaimingId(null);
      if (claimResultTimerRef.current) clearTimeout(claimResultTimerRef.current);
      claimResultTimerRef.current = setTimeout(() => {
        if (aliveRef.current) setClaimResult((r) => (r?.ok ? null : r));
      }, 4000);
    }
  }, [load]);

  const trophies = data?.trophies || [];
  const summary = data?.summary;
  const metrics = data?.metrics;
  const current = trophies.find((t) => t.trophy_id === data?.current_trophy_id) || null;
  const next = trophies.find((t) => t.trophy_id === data?.next_trophy_id) || null;
  const selected = trophies.find((t) => t.trophy_id === selectedId) || null;
  const hero = current || next || trophies[0] || null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-[500] bg-black/25"
                style={{ backdropFilter: "blur(8px)" }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content asChild forceMount>
              <motion.div
                className="fixed inset-x-0 bottom-0 z-[501] max-h-[92vh] overflow-y-auto overscroll-contain bg-white dark:bg-[#151022] border-t border-x border-zinc-200 dark:border-white/10"
                style={{
                  borderTopLeftRadius: 28,
                  borderTopRightRadius: 28,
                  boxShadow: "0 -8px 40px -8px rgba(0,0,0,0.25)",
                  paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
                }}
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={spring.settle}
                data-testid="achievement-center"
              >
                <div className="flex justify-center pt-2.5 pb-1" aria-hidden>
                  <span className="w-9 h-1 rounded-full bg-zinc-300 dark:bg-white/20" />
                </div>

                <DialogPrimitive.Title className="sr-only">Achievement Center</DialogPrimitive.Title>
                <DialogPrimitive.Description className="sr-only">
                  Your private trophies, unlock progress, and claimable point rewards.
                </DialogPrimitive.Description>

                <div className="px-4 pt-1 pb-4">
                  <p className="text-[10px] uppercase tracking-wide font-bold text-violet-500/80">Private · Only you can see this</p>
                  <h3 className="font-display text-[1.3rem] font-extrabold text-ink dark:text-white leading-tight">
                    Achievement Center
                  </h3>

                  {error && (
                    <div className="mt-4 rounded-2xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 p-4 text-center" data-testid="achievement-error">
                      <p className="text-[0.8rem] text-red-600 dark:text-red-400 font-semibold">{error}</p>
                      <button
                        type="button"
                        onClick={load}
                        className="mt-2 inline-flex items-center gap-1 text-[0.75rem] font-bold text-red-600 dark:text-red-400"
                      >
                        <RefreshCw className="w-3.5 h-3.5" /> Try again
                      </button>
                    </div>
                  )}

                  {!data && !error && (
                    <div className="py-14 flex justify-center" data-testid="achievement-loading">
                      <Loader2 className="w-6 h-6 animate-spin text-violet-400" />
                    </div>
                  )}

                  {data && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: duration.base, ease: easing.premiumEaseOut }}
                    >
                      {/* ── First-time explainer (one-time, dismissible) ── */}
                      <AchievementIntro />

                      {/* ── Achievement Summary ─────────────────────── */}
                      <div
                        className="mt-3 flex items-center rounded-2xl border border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.05] px-2 py-3"
                        style={{ boxShadow: elevation.soft }}
                        data-testid="achievement-summary"
                      >
                        <SummaryStat label="Unlocked Trophies" value={`${summary.unlocked_count}/${summary.total}`} testId="summary-unlocked" />
                        <span className="w-px h-8 bg-zinc-100 dark:bg-white/10" />
                        <SummaryStat label="Claimed Rewards" value={summary.claimed_count} testId="summary-claimed" />
                        <span className="w-px h-8 bg-zinc-100 dark:bg-white/10" />
                        <SummaryStat label="Next Trophy" value={summary.next_trophy?.name || "—"} testId="summary-next" />
                      </div>

                      {/* ── Current Trophy ──────────────────────────── */}
                      {hero && (
                        <div
                          className="mt-4 relative rounded-3xl border border-zinc-200 dark:border-white/[0.08] p-5 text-center overflow-hidden"
                          style={{
                            background: "linear-gradient(180deg, rgba(139,92,246,0.06) 0%, rgba(255,255,255,0) 70%)",
                            boxShadow: elevation.soft,
                            borderRadius: radius.lg,
                          }}
                          data-testid="current-trophy"
                        >
                          {/* Live ambience — ONLY for an earned trophy, and only
                              when Author Studio's Celebration Enabled is on.
                              Locked trophies stay matte and silent by design. */}
                          {hero.unlocked && hero.reward.celebration_enabled && (
                            <TrophyAmbience effectId={hero.reward.celebration_effect} />
                          )}
                          <p className="relative text-[10px] uppercase tracking-wide font-bold text-zinc-400 dark:text-white/35 mb-2">
                            {current ? "Current Trophy" : "First Trophy to Unlock"}
                          </p>
                          <motion.div
                            className="relative"
                            initial={{ scale: 0.94, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{ duration: duration.slow, ease: easing.premiumEaseOut }}
                          >
                            <TrophyArtwork trophy={hero} size={170} />
                          </motion.div>
                          <h4 className="font-display text-[1.1rem] font-extrabold text-ink dark:text-white mt-2" data-testid="current-trophy-name">
                            {hero.name}
                          </h4>
                          <p className={`text-[0.72rem] font-bold mt-0.5 ${hero.unlocked ? "text-violet-500" : "text-zinc-400 dark:text-white/35"}`}>
                            {hero.claimed ? "Unlocked · Reward Claimed" : hero.unlocked ? "Unlocked" : "Locked"}
                          </p>
                          {/* Why this trophy matters — one bilingual line,
                              derived from real state only. */}
                          {hero.unlocked ? (
                            <p className="relative text-[0.72rem] text-zinc-500 dark:text-white/45 mt-1" data-testid="hero-context-line">
                              You reached every goal for this trophy
                              <span className="font-khmer block text-[0.7rem] text-zinc-400 dark:text-white/35">
                                អ្នកបានសម្រេចគោលដៅទាំងអស់របស់ពាននេះ
                              </span>
                            </p>
                          ) : (
                            <p className="relative text-[0.72rem] text-zinc-500 dark:text-white/45 mt-1" data-testid="hero-context-line">
                              Reach the goals below to unlock it
                              <span className="font-khmer block text-[0.7rem] text-zinc-400 dark:text-white/35">
                                បំពេញគោលដៅខាងក្រោម ដើម្បីដោះសោ
                              </span>
                            </p>
                          )}
                        </div>
                      )}

                      {/* ── Reward Section (for hero trophy) ────────── */}
                      <div className="mt-3">
                        <RewardSection trophy={hero} claiming={claimingId === hero?.trophy_id} onClaim={handleClaim} />
                      </div>

                      {claimResult && (
                        <motion.p
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          className={`mt-2 text-center text-[0.78rem] font-bold ${claimResult.ok ? "text-emerald-600" : "text-red-500"}`}
                          data-testid="claim-result"
                        >
                          {claimResult.ok
                            ? `🎉 +${claimResult.points.toLocaleString()} points added to your wallet`
                            : claimResult.text}
                        </motion.p>
                      )}

                      {/* ── Current Progress (real production metrics) ─ */}
                      <div
                        className="mt-4 rounded-2xl border border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.05] px-4 py-3"
                        style={{ boxShadow: elevation.soft }}
                        data-testid="current-progress"
                      >
                        <p className="text-[10px] uppercase tracking-wide font-bold text-zinc-400 dark:text-white/35 mb-1">Current Progress</p>
                        <div className="divide-y divide-zinc-50 dark:divide-white/5">
                          <MetricRow label="Lifetime Points" value={metrics.lifetime_points} />
                          <MetricRow label="Attendance (sessions)" value={metrics.attendance_sessions} />
                          <MetricRow label="Lessons Completed" value={metrics.lessons_completed} />
                          <MetricRow label="Reading Completed" value={metrics.reading_completed} />
                          <MetricRow label="Speaking Activities" value={metrics.speaking_activities} />
                          <MetricRow label="Learning Streak (days)" value={metrics.streak_days} />
                        </div>
                      </div>

                      {/* ── Next Trophy ─────────────────────────────── */}
                      {next && (
                        <div
                          className="mt-4 rounded-2xl border border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.05] px-4 py-3"
                          style={{ boxShadow: elevation.soft }}
                          data-testid="next-trophy"
                        >
                          <div className="flex items-baseline justify-between">
                            <p className="text-[10px] uppercase tracking-wide font-bold text-zinc-400 dark:text-white/35">Next Trophy</p>
                            <p className="font-khmer text-[0.68rem] text-zinc-400 dark:text-white/35" data-testid="next-trophy-khmer">
                              ពានបន្ទាប់របស់អ្នក · បន្តរៀនទៀត!
                            </p>
                          </div>
                          <div className="flex items-center gap-3 mt-1.5">
                            <TrophyArtwork trophy={next} size={48} />
                            <div>
                              <p className="text-[0.9rem] font-extrabold text-ink dark:text-white">{next.name}</p>
                              {next.needs_configuration && (
                                <p className="text-[0.68rem] text-zinc-400 dark:text-white/35">Requirements coming soon</p>
                              )}
                            </div>
                          </div>
                          {next.progress.length > 0 && (
                            <div className="mt-1.5 divide-y divide-zinc-50 dark:divide-white/5">
                              {next.progress.map((r) => <RequirementRow key={r.key} req={r} />)}
                            </div>
                          )}
                        </div>
                      )}

                      {/* ── Trophy Collection ───────────────────────── */}
                      <div className="mt-5">
                        <p className="text-[10px] uppercase tracking-wide font-bold text-zinc-400 dark:text-white/35 px-0.5 mb-1">Trophy Collection</p>
                        <TrophyCarousel
                          trophies={trophies}
                          selectedId={selectedId}
                          currentId={data.current_trophy_id || data.next_trophy_id}
                          onSelect={(id) => { haptic.tick(); setSelectedId(id); }}
                        />
                      </div>

                      {/* ── Selected Trophy Detail ──────────────────── */}
                      {selected && (
                        <div
                          className="mt-3 rounded-2xl border border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.05] p-4"
                          style={{ boxShadow: elevation.soft }}
                          data-testid="trophy-detail"
                        >
                          <div className="flex items-start gap-3">
                            <TrophyArtwork trophy={selected} size={72} />
                            <div className="flex-1 min-w-0">
                              <p className="text-[0.95rem] font-extrabold text-ink dark:text-white" data-testid="trophy-detail-name">{selected.name}</p>
                              <p className={`text-[0.7rem] font-bold mt-0.5 ${
                                selected.claimed ? "text-emerald-500" : selected.unlocked ? "text-violet-500" : "text-zinc-400 dark:text-white/35"
                              }`} data-testid="trophy-detail-status">
                                {selected.claimed ? "Reward Claimed" : selected.unlocked ? "Unlocked" : "Locked"}
                              </p>
                              <p className="text-[0.78rem] font-bold mt-1" style={{ color: "#8B5CF6" }}>
                                {selected.reward.points > 0
                                  ? `Reward: +${selected.reward.points.toLocaleString()} Points`
                                  : "Reward: not configured yet"}
                              </p>
                            </div>
                          </div>
                          {selected.progress.length > 0 ? (
                            <div className="mt-2 divide-y divide-zinc-50 dark:divide-white/5">
                              {selected.progress.map((r) => <RequirementRow key={r.key} req={r} />)}
                            </div>
                          ) : (
                            <p className="text-[0.72rem] text-zinc-400 dark:text-white/35 mt-2">
                              Requirements for this trophy haven't been announced yet.
                            </p>
                          )}
                          <div className="mt-3 text-center">
                            <ClaimButton trophy={selected} claiming={claimingId === selected.trophy_id} onClaim={handleClaim} />
                          </div>
                        </div>
                      )}

                      <DialogPrimitive.Close asChild>
                        <button
                          type="button"
                          className="mt-5 w-full py-2.5 rounded-full text-[0.8rem] font-bold text-white active:scale-[0.97] transition-transform"
                          style={{ background: "#8B5CF6" }}
                          data-testid="achievement-center-close"
                        >
                          Done
                        </button>
                      </DialogPrimitive.Close>
                    </motion.div>
                  )}
                </div>
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}
