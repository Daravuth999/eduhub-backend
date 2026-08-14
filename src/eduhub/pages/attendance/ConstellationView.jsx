/**
 * ConstellationView.jsx — Attendance "Passport" Home (UI v2.1+), route `/attendance`.
 *
 * Layout (top → bottom):
 *   BentoHero (name, tier, streak, rate, live CTA)
 *   ClaimableRewardBento (pending → student claim → wallet credit)
 *   SummaryStats (Present / Late / Absent / Partial grid)
 *   Stamp Ledger
 *   Attendance Record Table
 *   Monthly Attendance Map
 *   Adventure Map
 *   SmartAction bento
 *   Tier Card
 *
 * risk_score is a private teacher signal and is deliberately NEVER rendered.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Flame, Trophy, Radio, MapPin, Stamp as StampIcon, Compass, ChevronRight,
  Check, X, Clock, Minus, ClipboardList, Star, Gift, Loader2, CalendarDays,
  AlertTriangle, Zap,
} from "lucide-react";
import useAttendance from "../../hooks/useAttendance";
import {
  tierDisplay, buildCheckpoints, MAP_CHAPTERS, tierProgress, shortDate,
} from "./attendancePassport";
import { PassportScene, Stamp, CheckpointMark } from "./PassportArt";

const IVORY = "#F6F1E6";
const INK = "#1B2A4A";
const SERIF = "Georgia, 'Times New Roman', serif";
const GOLD = "#C8920A";
const GOLD_BG = "#FBF0DC";
const GOLD_BORDER = "#E8D09A";

// ── Animation presets ─────────────────────────────────────────────────────────

const rise = (delay = 0) => ({
  initial: { opacity: 0, y: 18 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-60px" },
  transition: { duration: 0.55, delay, ease: [0.22, 1, 0.36, 1] },
});

// ── BentoHero ─────────────────────────────────────────────────────────────────

function BentoHero({ me, live, loading }) {
  const tier = tierDisplay(me?.reliability_tier);
  const rate = me?.attendance_rate != null
    ? `${Math.round(me.attendance_rate * 100)}%` : null;
  const name = me?.display_name || me?.student_id || "Traveller";

  return (
    <motion.section
      {...rise(0)}
      data-testid="bento-hero"
      className="relative overflow-hidden rounded-[28px]"
      style={{
        background: INK,
        boxShadow: "0 26px 60px -34px rgba(27,42,74,0.6)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      {/* Passport art strip */}
      <div className="relative h-[110px] sm:h-[130px]">
        <PassportScene className="absolute inset-0 w-full h-full" />
        <div
          className="absolute top-3.5 left-5 flex items-center gap-2 text-[10px] uppercase tracking-[0.32em]"
          style={{ color: "#C8BFA8" }}
        >
          <Compass className="h-3 w-3" /> EduHub · Attendance Passport
        </div>
      </div>

      {/* Live session pill */}
      {live?.live && (
        <div className="absolute top-3.5 right-4">
          <Link
            to={`/attendance/j/${live.slug}`}
            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold"
            style={{ background: "#1B5E3B", color: "#A8EFC6" }}
            data-testid="bento-hero-live-pill"
          >
            <Radio className="h-3 w-3 animate-pulse" strokeWidth={2} />
            Live now
          </Link>
        </div>
      )}

      {/* Name + stats row */}
      <div className="px-5 pt-4 pb-5">
        <div className="text-[10.5px] uppercase tracking-[0.22em] mb-0.5" style={{ color: "#8A95AF" }}>
          Passport holder
        </div>
        <h1
          className="text-[24px] sm:text-[28px] font-semibold leading-tight mb-3"
          style={{ fontFamily: SERIF, color: IVORY, textTransform: "capitalize" }}
          data-testid="bento-hero-name"
        >
          {loading ? "…" : name}
        </h1>

        {/* Stat chips */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Tier */}
          <div
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold"
            style={{ background: "rgba(255,255,255,0.10)", color: tier.color }}
            data-testid="bento-hero-tier"
          >
            <Trophy className="h-3.5 w-3.5" strokeWidth={2} /> {tier.label}
          </div>

          {/* Streak */}
          <div
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold"
            style={{ background: "rgba(255,255,255,0.08)", color: "#E7A87A" }}
            data-testid="bento-hero-streak"
          >
            <Flame className="h-3.5 w-3.5" strokeWidth={2} />
            {loading ? "—" : (me?.current_streak ?? 0)} day streak
          </div>

          {/* Attendance rate */}
          {rate && (
            <div
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold"
              style={{ background: "rgba(255,255,255,0.08)", color: "#A8C4E8" }}
              data-testid="bento-hero-rate"
            >
              <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> {rate} rate
            </div>
          )}
        </div>

        {/* Live join CTA — full-width below chips */}
        {live?.live && (
          <Link
            to={`/attendance/j/${live.slug}`}
            className="mt-3 flex items-center justify-between gap-2 rounded-2xl px-4 py-3"
            style={{ background: "#1B5E3B", color: "#A8EFC6" }}
            data-testid="bento-hero-live-cta"
          >
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              <Radio className="h-4 w-4" strokeWidth={2} />
              {live.title_en || "Your class"} is live — tap to check in
            </span>
            <ChevronRight className="h-4 w-4 opacity-70 shrink-0" />
          </Link>
        )}
      </div>
    </motion.section>
  );
}

// ── ClaimableRewardBento ──────────────────────────────────────────────────────

function PointBurst({ points }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.5, y: 10 }}
      animate={{ opacity: [0, 1, 1, 0], scale: [0.5, 1.2, 1, 0.8], y: [10, -20, -30, -50] }}
      transition={{ duration: 1.2, ease: "easeOut" }}
      className="pointer-events-none absolute inset-0 flex items-center justify-center text-[28px] font-bold"
      style={{ color: GOLD, fontFamily: SERIF }}
      aria-hidden="true"
    >
      +{points}
    </motion.div>
  );
}

function ClaimableRewardBento({ getRewardSummary, claimReward }) {
  const [summary, setSummary] = useState(null);
  const [claimPhase, setClaimPhase] = useState("idle"); // idle|claiming|burst|done
  const [creditedPts, setCreditedPts] = useState(0);
  const [err, setErr] = useState("");
  const alive = useRef(true);

  const loadSummary = useCallback(async () => {
    try {
      const data = await getRewardSummary();
      if (alive.current) setSummary(data);
    } catch {
      /* silent — reward summary is non-blocking */
    }
  }, [getRewardSummary]);

  useEffect(() => {
    alive.current = true;
    loadSummary();
    return () => { alive.current = false; };
  }, [loadSummary]);

  const handleClaim = useCallback(async () => {
    if (claimPhase !== "idle") return;
    setClaimPhase("claiming");
    setErr("");
    try {
      const res = await claimReward();
      if (!alive.current) return;
      if (res.ok && res.credited_points > 0) {
        setCreditedPts(res.credited_points);
        setClaimPhase("burst");
        setTimeout(() => {
          if (alive.current) setClaimPhase("done");
          loadSummary();
        }, 1400);
      } else if (res.message === "below_minimum") {
        setErr(`Need ${res.minimum} pts to claim (have ${res.current})`);
        setClaimPhase("idle");
      } else if (res.message === "no_pending_claims") {
        setClaimPhase("idle");
        loadSummary();
      } else {
        setErr("Could not claim right now — try again.");
        setClaimPhase("idle");
      }
    } catch (e) {
      if (!alive.current) return;
      setErr(e?.message || "Claim failed.");
      setClaimPhase("idle");
    }
  }, [claimPhase, claimReward, loadSummary]);

  // Don't render if claim mode isn't enabled (auto-credit mode).
  if (summary && !summary.claim_enabled) return null;
  // Don't render placeholder until we know summary.
  if (!summary) return null;

  const { claimable_points: pts, claimable_count: count, next_reward_progress: progress,
    recent_claims } = summary;
  const hasPending = count > 0;
  const isAccumulating = !hasPending && (progress != null);
  const isDone = claimPhase === "done" || (!hasPending && !isAccumulating && recent_claims?.length > 0);

  return (
    <motion.section
      {...rise(0.04)}
      data-testid="claimable-reward-bento"
      className="relative overflow-hidden rounded-[26px]"
      style={{
        background: GOLD_BG,
        border: `1.5px solid ${GOLD_BORDER}`,
        boxShadow: "0 18px 44px -28px rgba(180,130,20,0.30)",
      }}
    >
      {/* Burst overlay */}
      <AnimatePresence>
        {claimPhase === "burst" && (
          <PointBurst points={creditedPts} key="burst" />
        )}
      </AnimatePresence>

      <div className="px-5 pt-5 pb-5">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div
            className="grid h-10 w-10 place-items-center rounded-xl shrink-0"
            style={{ background: "#F5E0A0", color: GOLD }}
          >
            <Gift className="h-5 w-5" strokeWidth={1.8} />
          </div>
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.22em]" style={{ color: "#9A7A20" }}>
              Attendance reward
            </div>
            <h2 className="text-[17px] font-semibold" style={{ fontFamily: SERIF, color: "#4A3200" }}>
              {hasPending ? "Ready to claim" : isAccumulating ? "Earning points" : "Reward vault"}
            </h2>
          </div>
        </div>

        {/* Content per state */}
        {hasPending && (
          <div data-testid="reward-claimable-state">
            <div className="text-center my-3">
              <div className="text-[46px] font-bold leading-none" style={{ fontFamily: SERIF, color: GOLD }}>
                {pts}
              </div>
              <div className="text-[12px] uppercase tracking-[0.2em] mt-1" style={{ color: "#9A7A20" }}>
                points to claim
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: "#B0922A" }}>
                from {count} session{count > 1 ? "s" : ""}
              </div>
            </div>
            <button
              type="button"
              onClick={handleClaim}
              disabled={claimPhase !== "idle"}
              data-testid="claim-reward-button"
              className="w-full mt-2 rounded-2xl py-3.5 text-[14px] font-bold flex items-center justify-center gap-2 transition-opacity"
              style={{
                background: claimPhase !== "idle" ? "#D4A830" : GOLD,
                color: "#FFFBF0",
                opacity: claimPhase !== "idle" ? 0.8 : 1,
              }}
            >
              {claimPhase === "claiming" ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Claiming…</>
              ) : claimPhase === "burst" ? (
                <><Star className="h-4 w-4" /> Credited!</>
              ) : (
                <><Zap className="h-4 w-4" /> Claim {pts} points</>
              )}
            </button>
            {err && (
              <p className="mt-2 text-[11.5px] text-center" style={{ color: "#B04020" }}>{err}</p>
            )}
          </div>
        )}

        {isAccumulating && !hasPending && (
          <div data-testid="reward-accumulating-state">
            <div className="rounded-2xl px-4 py-3" style={{ background: "rgba(200,146,10,0.08)", border: `1px solid ${GOLD_BORDER}` }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[12px] font-medium" style={{ color: "#7A5A10" }}>Progress to claim</span>
                <span className="text-[12px] font-semibold" style={{ color: GOLD }}>
                  {progress.current} / {progress.target} pts
                </span>
              </div>
              <div className="h-2.5 rounded-full overflow-hidden" style={{ background: "#F0DCA0" }}>
                <motion.div
                  initial={{ width: 0 }}
                  whileInView={{ width: `${progress.percent}%` }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
                  className="h-full rounded-full"
                  style={{ background: GOLD }}
                />
              </div>
              <p className="text-[11px] mt-2 text-center" style={{ color: "#9A7A20" }}>
                Attend more classes to unlock your reward
              </p>
            </div>
          </div>
        )}

        {isDone && !hasPending && !isAccumulating && (
          <div data-testid="reward-claimed-state">
            {claimPhase === "done" && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="text-center py-3"
              >
                <div className="text-[36px] mb-1">🎉</div>
                <div className="text-[15px] font-semibold" style={{ color: "#4A3200" }}>
                  +{creditedPts} points added!
                </div>
                <div className="text-[11.5px] mt-0.5" style={{ color: "#9A7A20" }}>
                  Check your wallet for the balance.
                </div>
              </motion.div>
            )}
            {recent_claims && recent_claims.length > 0 && claimPhase !== "done" && (
              <div className="space-y-2">
                {recent_claims.slice(0, 3).map((c, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-2 rounded-xl"
                    style={{ background: "rgba(200,146,10,0.08)" }}>
                    <span className="text-[12px]" style={{ color: "#7A5A10" }}>
                      {c.claimed_at
                        ? new Date(c.claimed_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                        : "Claimed"}
                    </span>
                    <span className="text-[13px] font-semibold" style={{ color: GOLD }}>+{c.points}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {!hasPending && !isAccumulating && !isDone && (
          <div data-testid="reward-no-pending-state">
            <p className="text-[12.5px] text-center py-4" style={{ color: "#9A7A20" }}>
              Attend sessions to earn attendance reward points.
            </p>
          </div>
        )}
      </div>
    </motion.section>
  );
}

// ── SummaryStats ──────────────────────────────────────────────────────────────

function SummaryStats({ me }) {
  const stats = useMemo(() => {
    const p = me?.present_count ?? 0;
    const l = me?.late_count ?? 0;
    const a = me?.absent_count ?? 0;
    const t = me?.total_sessions ?? 0;
    const rate = me?.attendance_rate != null ? Math.round(me.attendance_rate * 100) : null;
    const longest = me?.longest_streak ?? 0;
    return [
      { label: "Present",   value: p,        color: "#2F7D5B", bg: "#E7F2EA",  Icon: Check },
      { label: "Late",      value: l,        color: "#B6822A", bg: "#F6ECD4",  Icon: Clock },
      { label: "Absent",    value: a,        color: "#7A7265", bg: "#EFEBE2",  Icon: X     },
      { label: "Sessions",  value: t,        color: "#4A6090", bg: "#E5E9F3",  Icon: CalendarDays },
      ...(rate != null ? [{ label: "Att. rate", value: `${rate}%`, color: "#1B2A4A", bg: IVORY, Icon: Trophy }] : []),
      ...(longest > 0    ? [{ label: "Best streak", value: `${longest}d`, color: "#C2682E", bg: "#FCEEE4", Icon: Flame }] : []),
    ];
  }, [me]);

  if (!me) return null;

  return (
    <motion.section
      {...rise(0.03)}
      data-testid="summary-stats"
      className="grid grid-cols-3 gap-2.5"
    >
      {stats.map(({ label, value, color, bg, Icon }) => (
        <div
          key={label}
          className="rounded-[20px] px-3 py-3.5 text-center"
          style={{ background: bg, border: "1px solid rgba(0,0,0,0.06)" }}
          data-testid={`stat-${label.toLowerCase().replace(/\s/g, "-")}`}
        >
          <div className="flex justify-center mb-1.5">
            <Icon className="h-4 w-4" style={{ color }} strokeWidth={2.2} />
          </div>
          <div className="text-[20px] font-bold leading-none" style={{ color, fontFamily: SERIF }}>
            {value}
          </div>
          <div className="text-[9.5px] uppercase tracking-[0.18em] mt-1" style={{ color }}>
            {label}
          </div>
        </div>
      ))}
    </motion.section>
  );
}

// ── MonthlyMap ────────────────────────────────────────────────────────────────

const DOT_STATUS = {
  present_full:    "#2F7D5B",
  present_partial: "#5E6E96",
  late:            "#B6822A",
  absent:          "#C4BAB0",
};

function MonthlyMap({ history }) {
  const months = useMemo(() => {
    if (!history || history.length === 0) return [];
    const byMonth = new Map();
    history.forEach((h) => {
      const iso = h.session_date || h.checked_in_at;
      if (!iso) return;
      try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!byMonth.has(key)) {
          byMonth.set(key, { label: d.toLocaleDateString(undefined, { month: "long", year: "numeric" }), sessions: [] });
        }
        byMonth.get(key).sessions.push({ day: d.getDate(), status: h.status, iso });
      } catch { /* ignore */ }
    });
    // Most recent first, max 3 months.
    return [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 3)
      .map(([, v]) => v);
  }, [history]);

  if (months.length === 0) return null;

  return (
    <motion.section
      {...rise(0.04)}
      data-testid="monthly-map"
      className="rounded-[26px] overflow-hidden"
      style={{ background: "#FBF8F1", border: "1px solid #E4DAC6", boxShadow: "0 18px 44px -28px rgba(27,42,74,0.30)" }}
    >
      <div className="px-5 pt-5 pb-2">
        <div className="flex items-center gap-3 mb-4">
          <div className="grid h-10 w-10 place-items-center rounded-xl" style={{ background: "#E2EAE0", color: "#2F7D5B" }}>
            <CalendarDays className="h-5 w-5" strokeWidth={1.8} />
          </div>
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.22em]" style={{ color: "#9A8B6C" }}>Monthly view</div>
            <h2 className="text-[17px] font-semibold" style={{ fontFamily: SERIF, color: INK }}>Attendance map</h2>
          </div>
        </div>

        {months.map((m) => (
          <div key={m.label} className="mb-4">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] mb-2" style={{ color: "#9A8B6C" }}>
              {m.label}
            </div>
            <div className="flex flex-wrap gap-2">
              {m.sessions.map((s, i) => (
                <div
                  key={s.iso || i}
                  title={`Day ${s.day} — ${s.status}`}
                  className="flex flex-col items-center gap-0.5"
                  data-testid={`month-dot-${s.iso}`}
                >
                  <div
                    className="h-7 w-7 rounded-full flex items-center justify-center text-[10px] font-semibold"
                    style={{
                      background: DOT_STATUS[s.status] || "#C4BAB0",
                      color: "#fff",
                    }}
                  >
                    {s.day}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Legend */}
        <div className="flex flex-wrap gap-3 pb-4">
          {[
            { label: "Present", color: DOT_STATUS.present_full },
            { label: "Late",    color: DOT_STATUS.late },
            { label: "Absent",  color: DOT_STATUS.absent },
            { label: "Partial", color: DOT_STATUS.present_partial },
          ].map(({ label, color }) => (
            <div key={label} className="flex items-center gap-1.5">
              <div className="h-3 w-3 rounded-full" style={{ background: color }} />
              <span className="text-[10px]" style={{ color: "#9A8B6C" }}>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </motion.section>
  );
}

// ── SmartAction bento ─────────────────────────────────────────────────────────

function SmartAction({ me, live }) {
  const action = useMemo(() => {
    if (live?.live) {
      return {
        label: "Class is live now",
        sub: `Join ${live.title_en || "your class"} before the window closes`,
        to: `/attendance/j/${live.slug}`,
        bg: "#1B5E3B",
        color: "#A8EFC6",
        Icon: Radio,
        testId: "smart-action-join",
      };
    }
    const recent = me?.history?.[0];
    if (recent?.status === "absent") {
      return {
        label: "Let your teacher know",
        sub: "Share a reason for your last absence",
        to: "/attendance",
        bg: "#3A2A00",
        color: "#F5C870",
        Icon: AlertTriangle,
        testId: "smart-action-absent",
      };
    }
    if (me && (me?.total_sessions ?? 0) === 0) {
      return {
        label: "Check in to your first class",
        sub: "Your stamp ledger is waiting",
        to: "/attendance",
        bg: INK,
        color: IVORY,
        Icon: Compass,
        testId: "smart-action-first",
      };
    }
    return null;
  }, [me, live]);

  if (!action) return null;

  return (
    <motion.section {...rise(0.06)} data-testid="smart-action">
      <Link
        to={action.to}
        className="flex items-center justify-between gap-3 rounded-[22px] px-5 py-4"
        style={{ background: action.bg, color: action.color, boxShadow: "0 12px 28px -18px rgba(27,42,74,0.5)" }}
        data-testid={action.testId}
      >
        <div className="flex items-center gap-3">
          <action.Icon className="h-5 w-5 shrink-0" strokeWidth={2} />
          <div>
            <div className="text-[13.5px] font-semibold">{action.label}</div>
            <div className="text-[11px] opacity-75 mt-0.5">{action.sub}</div>
          </div>
        </div>
        <ChevronRight className="h-4 w-4 opacity-70 shrink-0" />
      </Link>
    </motion.section>
  );
}

// ── Attendance Record Table ───────────────────────────────────────────────────

const STATUS_CONFIG = {
  present_full:    { label: "Present",  Icon: Check,  bg: "#E7F2EA", color: "#1B5E3B", iconColor: "#2F7D5B" },
  present_partial: { label: "Partial",  Icon: Minus,  bg: "#E5E9F3", color: "#3A4A7A", iconColor: "#5E6E96" },
  late:            { label: "Late",     Icon: Clock,  bg: "#F6ECD4", color: "#7A4E0A", iconColor: "#B6822A" },
  absent:          { label: "Absent",   Icon: X,      bg: "#EFEBE2", color: "#5A5345", iconColor: "#9A9285" },
};

function statusCfg(status) {
  return STATUS_CONFIG[status] || STATUS_CONFIG.absent;
}

function lateLabel(h) {
  if (h.minutes_late != null && h.minutes_late > 0) return `${h.minutes_late} min late`;
  if (h.checked_in_at && h.session_start_at) {
    const diff = Math.round(
      (new Date(h.checked_in_at) - new Date(h.session_start_at)) / 60000,
    );
    if (diff > 0) return `${diff} min late`;
  }
  return null;
}

function rowDate(h) {
  const iso = h.checked_in_at || h.session_date;
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch { return "—"; }
}

const FILTERS = ["All", "Present", "Late", "Absent"];

function AttendanceTable({ history }) {
  const [filter, setFilter] = useState("All");

  const counts = useMemo(() => ({
    present: history.filter((h) => h.status === "present_full" || h.status === "present_partial").length,
    late:    history.filter((h) => h.status === "late").length,
    absent:  history.filter((h) => h.status === "absent").length,
  }), [history]);

  const filtered = useMemo(() => {
    if (filter === "Present") return history.filter((h) => h.status === "present_full" || h.status === "present_partial");
    if (filter === "Late")    return history.filter((h) => h.status === "late");
    if (filter === "Absent")  return history.filter((h) => h.status === "absent");
    return history;
  }, [history, filter]);

  if (history.length === 0) return null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.55, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
      data-testid="attendance-record-table"
      className="rounded-[26px] overflow-hidden"
      style={{ background: "#FBF8F1", border: "1px solid #E4DAC6", boxShadow: "0 18px 44px -28px rgba(27,42,74,0.35)" }}
    >
      <div className="px-5 pt-5 pb-0">
        <div className="flex items-center gap-3 mb-4">
          <div className="grid h-10 w-10 place-items-center rounded-xl shrink-0" style={{ background: "#EAE0CC", color: "#9A7A20" }}>
            <ClipboardList className="h-5 w-5" strokeWidth={1.8} />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em]" style={{ color: "#9A8B6C" }}>Attendance record</div>
            <h2 className="text-[17px] font-semibold" style={{ fontFamily: SERIF, color: INK }}>Session history</h2>
          </div>
        </div>

        {/* Summary chips */}
        <div className="grid grid-cols-3 gap-2 mb-4">
          {[
            { label: "Present", n: counts.present, color: "#2F7D5B", bg: "#E7F2EA" },
            { label: "Late",    n: counts.late,    color: "#B6822A", bg: "#F6ECD4" },
            { label: "Absent",  n: counts.absent,  color: "#7A7265", bg: IVORY     },
          ].map(({ label, n, color, bg }) => (
            <div key={label} className="rounded-2xl px-3 py-2.5 text-center" style={{ background: bg }}>
              <div className="text-[22px] font-semibold leading-none" style={{ color }}>{n}</div>
              <div className="text-[10.5px] uppercase tracking-[0.15em] mt-1" style={{ color }}>{label}</div>
            </div>
          ))}
        </div>

        {/* Filter pills */}
        <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className="shrink-0 rounded-full px-3.5 py-1.5 text-[11.5px] font-medium transition-colors"
              style={
                filter === f
                  ? { background: INK, color: IVORY }
                  : { background: IVORY, color: "#7A7265", border: "1px solid #DDD0B8" }
              }
              data-testid={`attendance-filter-${f.toLowerCase()}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3">
        <div
          className="grid px-5 py-2"
          style={{ gridTemplateColumns: "72px 1fr 96px", borderTop: "1px solid #E4DAC6", borderBottom: "1px solid #E4DAC6", background: "#F4EFE4" }}
        >
          {["Date", "Class", "Status"].map((h, i) => (
            <span key={h} className="text-[10px] uppercase tracking-[0.2em] font-semibold"
              style={{ color: "#9A8B6C", textAlign: i === 2 ? "right" : "left" }}>
              {h}
            </span>
          ))}
        </div>

        <div className="divide-y" style={{ borderColor: "#EDE5D4" }}>
          {filtered.length === 0 ? (
            <p className="px-5 py-6 text-[13px] text-center" style={{ color: "#9A8B6C" }}>
              No {filter.toLowerCase()} sessions yet.
            </p>
          ) : (
            filtered.map((h, i) => {
              const cfg = statusCfg(h.status);
              const late = h.status === "late" ? lateLabel(h) : null;
              return (
                <motion.div
                  key={h.session_id || i}
                  initial={{ opacity: 0, x: -6 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.25, delay: Math.min(i * 0.025, 0.3) }}
                  className="grid items-center px-5 py-3"
                  style={{ gridTemplateColumns: "72px 1fr 96px" }}
                  data-testid={`attendance-row-${h.session_id || i}`}
                >
                  <div>
                    <div className="text-[12.5px] font-medium" style={{ color: INK }}>{rowDate(h)}</div>
                  </div>
                  <div className="pr-2 min-w-0">
                    <div className="text-[12.5px] font-medium leading-snug truncate" style={{ color: INK }}>
                      {h.title_en || h.class_title || "Class"}
                    </div>
                    {late && (
                      <div className="flex items-center gap-1 mt-0.5">
                        <Clock className="h-3 w-3 shrink-0" style={{ color: cfg.iconColor }} strokeWidth={2} />
                        <span className="text-[11px] font-medium" style={{ color: cfg.iconColor }}>{late}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex justify-end">
                    <div className="inline-flex items-center gap-1 rounded-full px-2.5 py-1"
                      style={{ background: cfg.bg, color: cfg.color }}>
                      <cfg.Icon className="h-3 w-3 shrink-0" strokeWidth={2.5} />
                      <span className="text-[11px] font-semibold">{cfg.label}</span>
                    </div>
                  </div>
                </motion.div>
              );
            })
          )}
        </div>

        <div className="px-5 py-2.5 text-[11px] text-right"
          style={{ color: "#9A8B6C", borderTop: "1px solid #E4DAC6", background: "#F4EFE4" }}>
          {filtered.length} of {history.length} sessions shown
        </div>
      </div>
    </motion.section>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function ConstellationView() {
  const { me, live, loading, getRewardSummary, claimReward } = useAttendance({ pollLive: true });
  const checkpoints = useMemo(() => buildCheckpoints(me?.history), [me]);
  const tier = tierDisplay(me?.reliability_tier);
  const progress = useMemo(() => tierProgress(me), [me]);
  const history = me?.history || [];

  return (
    <div
      className="min-h-screen"
      style={{ background: "#EFE9DB", color: INK }}
      data-testid="constellation-view"
    >
      <div className="max-w-3xl mx-auto px-4 py-6 sm:py-8 space-y-5" data-testid="passport-home">

        {/* ── 1. Bento Hero ─────────────────────────────────────────── */}
        <BentoHero me={me} live={live} loading={loading} />

        {/* ── 2. Claimable Reward Bento ─────────────────────────────── */}
        <ClaimableRewardBento
          getRewardSummary={getRewardSummary}
          claimReward={claimReward}
        />

        {/* ── 3. Summary Stats grid ─────────────────────────────────── */}
        <SummaryStats me={me} />

        {/* ── 4. Stamp Ledger ───────────────────────────────────────── */}
        <motion.section
          {...rise(0.05)}
          data-testid="stamp-ledger"
          className="rounded-[26px] p-6 sm:p-7"
          style={{ background: "#FBF8F1", border: "1px solid #E4DAC6", boxShadow: "0 18px 44px -28px rgba(27,42,74,0.35)" }}
        >
          <div className="flex items-center gap-3 mb-5">
            <div className="grid h-10 w-10 place-items-center rounded-xl" style={{ background: "#EAE0CC", color: "#9A7A20" }}>
              <StampIcon className="h-5 w-5" strokeWidth={1.8} />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.22em]" style={{ color: "#9A8B6C" }}>Stamp Ledger</div>
              <h2 className="text-[17px] font-semibold" style={{ fontFamily: SERIF, color: INK }}>
                Your collected stamps
              </h2>
            </div>
          </div>

          {history.length === 0 ? (
            <p className="text-[13px] rounded-2xl px-4 py-6 text-center"
              style={{ background: IVORY, border: "1px dashed #DDCFB3", color: "#5A5345" }}
              data-testid="stamp-ledger-empty">
              Your first stamp lands here the moment you check in to a class.
            </p>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-x-3 gap-y-5 justify-items-center"
              data-testid="stamp-ledger-grid">
              {history.map((h, i) => (
                <motion.div
                  key={h.session_id || i}
                  initial={{ opacity: 0, scale: 0.85 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.32, delay: Math.min(i * 0.03, 0.4) }}
                >
                  <Stamp status={h.status} date={shortDate(h.checked_in_at || h.session_date)} />
                </motion.div>
              ))}
            </div>
          )}
        </motion.section>

        {/* ── 5. Attendance Record Table ────────────────────────────── */}
        <AttendanceTable history={history} />

        {/* ── 6. Monthly Attendance Map ─────────────────────────────── */}
        <MonthlyMap history={history} />

        {/* ── 7. Adventure Map ──────────────────────────────────────── */}
        <motion.section
          {...rise(0.05)}
          data-testid="adventure-map"
          className="rounded-[26px] p-6 sm:p-7"
          style={{ background: "#FBF8F1", border: "1px solid #E4DAC6", boxShadow: "0 18px 44px -28px rgba(27,42,74,0.35)" }}
        >
          <div className="flex items-center gap-3 mb-5">
            <div className="grid h-10 w-10 place-items-center rounded-xl" style={{ background: "#E2EAE0", color: "#2F7D5B" }}>
              <MapPin className="h-5 w-5" strokeWidth={1.8} />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.22em]" style={{ color: "#9A8B6C" }}>Adventure Map</div>
              <h2 className="text-[17px] font-semibold" style={{ fontFamily: SERIF, color: INK }}>
                Your journey so far
              </h2>
            </div>
          </div>

          {checkpoints.length === 0 ? (
            <p className="text-[13px] rounded-2xl px-4 py-6 text-center"
              style={{ background: IVORY, border: "1px dashed #DDCFB3", color: "#5A5345" }}
              data-testid="adventure-map-empty">
              The trail begins with your first check-in.
            </p>
          ) : (
            <div className="relative overflow-x-auto pb-2" data-testid="adventure-map-trail">
              <div className="flex items-stretch min-w-max">
                {MAP_CHAPTERS.map((ch) => {
                  const nodes = checkpoints.filter((c) => c.chapter === MAP_CHAPTERS.indexOf(ch));
                  if (nodes.length === 0) return null;
                  return (
                    <div key={ch.key} className="relative px-4 py-5 first:rounded-l-2xl last:rounded-r-2xl"
                      style={{ background: ch.tint }} data-testid={`map-chapter-${ch.key}`}>
                      <div className="text-[10px] uppercase tracking-[0.18em] mb-3 text-center" style={{ color: "#7C7257" }}>
                        {ch.name}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {nodes.map((c) => (
                          <div key={c.id} className="flex items-center gap-1.5">
                            <CheckpointMark status={c.status} n={c.index} />
                            <span className="h-[2px] w-4 last:hidden" style={{ background: "#CBBE9F" }} />
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </motion.section>

        {/* ── 8. Smart Action ───────────────────────────────────────── */}
        <SmartAction me={me} live={live} />

        {/* ── 9. Tier Card ──────────────────────────────────────────── */}
        <motion.section
          {...rise(0.05)}
          data-testid="tier-card"
          className="rounded-[26px] p-6 sm:p-7"
          style={{ background: INK, color: "#F6F1E6", boxShadow: "0 22px 50px -30px rgba(27,42,74,0.8)" }}
        >
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl"
                style={{ background: "rgba(255,255,255,0.08)", color: tier.color }}>
                <Trophy className="h-5 w-5" strokeWidth={1.9} />
              </span>
              <div>
                <div className="text-[11px] uppercase tracking-[0.22em]" style={{ color: "#B7BFD1" }}>
                  Reliability tier
                </div>
                <div className="text-[18px] font-semibold" style={{ fontFamily: SERIF, color: tier.color }}>
                  {tier.label}
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-wider" style={{ color: "#B7BFD1" }}>Longest</div>
              <div className="text-[18px] font-semibold">{me?.longest_streak ?? 0} days</div>
            </div>
          </div>

          {progress.atMax ? (
            <p className="text-[13px]" style={{ color: "#CBD3E4" }} data-testid="tier-card-max">
              You've reached the highest tier. Keep your streak alive to hold your Champion standing.
            </p>
          ) : (
            <div data-testid="tier-card-progress">
              <div className="flex items-center justify-between text-[12px] mb-1.5" style={{ color: "#CBD3E4" }}>
                <span>On-time rate {Math.round((progress.rate || 0) * 100)}%</span>
                <span>Next: {tierDisplay(progress.nextTier).label}</span>
              </div>
              <div className="h-2.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.12)" }}>
                <motion.div
                  initial={{ width: 0 }}
                  whileInView={{ width: `${Math.round(progress.fraction * 100)}%` }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
                  className="h-full rounded-full"
                  style={{ background: tierDisplay(progress.nextTier).color }}
                />
              </div>
              <p className="mt-2 text-[11.5px]" style={{ color: "#9AA4BC" }}>
                Reach {Math.round((progress.needed || 0) * 100)}% on-time to advance to {tierDisplay(progress.nextTier).label}.
              </p>
            </div>
          )}
        </motion.section>

      </div>
    </div>
  );
}
