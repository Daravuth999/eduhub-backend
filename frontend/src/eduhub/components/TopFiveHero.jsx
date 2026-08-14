// TopFiveHero.jsx — flagship "Top 5 Points Earners" highlight card.
//   Replaces the 4-card stat strip; pulls live data via fetchRosterPoints().
import { memo, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Trophy, Crown, Medal, Sparkles, RefreshCw } from "lucide-react";
import { fetchRosterPoints } from "../lib/roster";

const POLL_MS = 60_000;

function initialsOf(name) {
  return String(name || "")
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const RANK_THEME = {
  1: { color: "#ffc94d", border: "border-aurora-gold/55",   glow: "0 0 32px rgba(255,201,77,0.45)",  badge: "from-aurora-gold via-aurora-coral to-aurora-magenta", icon: Crown },
  2: { color: "#00e0ff", border: "border-aurora-cyan/45",   glow: "0 0 22px rgba(0,224,255,0.35)",   badge: "from-aurora-cyan to-aurora-violet", icon: Medal },
  3: { color: "#9b5cff", border: "border-aurora-violet/45", glow: "0 0 22px rgba(155,92,255,0.35)",  badge: "from-aurora-violet to-aurora-magenta", icon: Medal },
  4: { color: "#ff3da6", border: "border-aurora-magenta/35",glow: "0 0 18px rgba(255,61,166,0.25)",  badge: "from-aurora-magenta to-aurora-coral", icon: Sparkles },
  5: { color: "#a3ff3a", border: "border-aurora-lime/35",   glow: "0 0 18px rgba(163,255,58,0.28)",  badge: "from-aurora-lime to-aurora-cyan", icon: Sparkles },
};

const Avatar = memo(function Avatar({ name, color, size = 48 }) {
  return (
    <div
      className="relative shrink-0 rounded-2xl flex items-center justify-center font-display font-extrabold text-white"
      style={{
        width: size, height: size,
        background: `linear-gradient(135deg, ${color}, ${color}55)`,
        boxShadow: `0 8px 22px -8px ${color}80, inset 0 0 0 1px rgba(255,255,255,0.2)`,
        fontSize: size * 0.34,
        letterSpacing: "0.02em",
      }}
    >
      <span aria-hidden className="absolute inset-0 rounded-2xl bg-gradient-to-br from-white/15 to-transparent pointer-events-none" />
      <span className="relative z-10">{initialsOf(name)}</span>
    </div>
  );
});

function CountUp({ value, decimals = 1 }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const target = Number(value || 0);
    if (!Number.isFinite(target)) { setN(0); return; }
    const start = performance.now();
    const dur = 900;
    let raf = 0;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setN(target * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span className="tnum">{n.toFixed(decimals)}</span>;
}

const PodiumCard = memo(function PodiumCard({ rank, name, points, delay = 0 }) {
  const t = RANK_THEME[rank] || RANK_THEME[5];
  const Icon = t.icon;
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, delay, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -4 }}
      data-testid={`top5-rank-${rank}`}
      className={`relative overflow-hidden rounded-2xl border ${t.border} bg-white/[0.04] backdrop-blur-md p-3 sm:p-4 group`}
      style={{ boxShadow: `0 0 0 0 ${t.color}00` }}
    >
      <div
        aria-hidden
        className="absolute -top-12 -right-12 w-28 h-28 rounded-full blur-3xl opacity-50 group-hover:opacity-80 transition-opacity"
        style={{ background: t.color }}
      />
      <div className="relative flex items-center gap-3">
        <div
          className={`shrink-0 h-9 w-9 rounded-xl flex items-center justify-center bg-gradient-to-br ${t.badge} text-white shadow-[0_6px_18px_rgba(0,0,0,0.35)]`}
        >
          <Icon className="h-4 w-4" />
        </div>
        <Avatar name={name} color={t.color} size={42} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/45">Rank</span>
            <span className="font-display text-base font-extrabold" style={{ color: t.color }}>#{rank}</span>
          </div>
          <div className="font-semibold text-white text-sm truncate" title={name}>{name}</div>
          <div className="font-display text-base sm:text-lg font-extrabold mt-0.5" style={{ color: t.color }}>
            <CountUp value={points} /> <span className="text-[10px] uppercase tracking-wider text-white/45 ml-0.5">pts</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
});

const ChampionHero = memo(function ChampionHero({ name, points }) {
  const t = RANK_THEME[1];
  return (
    <motion.div
      initial={{ opacity: 0, y: 26, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -5 }}
      data-testid="top5-champion"
      className="relative overflow-hidden rounded-3xl border border-aurora-gold/45 bg-gradient-to-br from-aurora-gold/[0.10] via-white/[0.04] to-aurora-magenta/[0.08] backdrop-blur-xl p-5 sm:p-6"
    >
      {/* Animated aurora ribbon */}
      <motion.div
        aria-hidden
        className="absolute inset-x-0 top-0 h-[2px]"
        style={{
          background: "linear-gradient(90deg, transparent, #ffc94d, #ff3da6, #00e0ff, #ffc94d, transparent)",
          backgroundSize: "200% 100%",
        }}
        animate={{ backgroundPositionX: ["0%", "200%"] }}
        transition={{ duration: 6, repeat: Infinity, ease: "linear" }}
      />
      {/* Drifting golden orb */}
      <motion.div
        aria-hidden
        className="absolute -top-16 -right-10 h-44 w-44 rounded-full blur-3xl"
        style={{ background: "rgba(255,201,77,0.35)" }}
        animate={{ x: [0, 12, 0], y: [0, -10, 0] }}
        transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        aria-hidden
        className="absolute -bottom-12 -left-10 h-36 w-36 rounded-full blur-3xl"
        style={{ background: "rgba(255,61,166,0.30)" }}
        animate={{ x: [0, -10, 0], y: [0, 10, 0] }}
        transition={{ duration: 10, repeat: Infinity, ease: "easeInOut", delay: 1 }}
      />

      <div className="relative flex items-start gap-4 sm:gap-5">
        <div className="relative shrink-0">
          <motion.div
            aria-hidden
            className="absolute -inset-2 rounded-3xl"
            style={{ background: "conic-gradient(from 0deg, #ffc94d, #ff3da6, #00e0ff, #ffc94d)" }}
            animate={{ rotate: 360 }}
            transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
          />
          <div className="relative">
            <Avatar name={name} color={t.color} size={88} />
            <motion.div
              className="absolute -top-2 -right-2 h-9 w-9 rounded-full bg-gradient-to-br from-aurora-gold via-aurora-coral to-aurora-magenta flex items-center justify-center text-white shadow-[0_8px_22px_-4px_rgba(255,201,77,0.85)]"
              animate={{ rotate: [-6, 6, -6] }}
              transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
            >
              <Crown className="h-4 w-4" />
            </motion.div>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.18em]"
              style={{
                background: "linear-gradient(90deg, rgba(255,201,77,0.22), rgba(255,61,166,0.22))",
                border: "1px solid rgba(255,201,77,0.45)",
                color: "#ffc94d",
              }}
            >
              <Trophy className="h-3 w-3" /> Champion
            </span>
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/50">Rank #1</span>
          </div>
          <h2
            className="font-display text-2xl sm:text-3xl font-extrabold text-white leading-tight truncate"
            title={name}
            data-testid="top5-champion-name"
          >
            {name}
          </h2>
          <div className="mt-1 flex items-baseline gap-2 flex-wrap">
            <span
              className="font-display text-4xl sm:text-5xl font-extrabold leading-none"
              style={{
                background: "linear-gradient(135deg, #ffc94d, #ff3da6, #00e0ff)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}
              data-testid="top5-champion-points"
            >
              <CountUp value={points} />
            </span>
            <span className="text-xs uppercase tracking-[0.18em] text-white/55 font-bold">points</span>
          </div>
          <p className="mt-2 text-xs text-white/55 leading-relaxed max-w-md hidden sm:block">
            Crowned by the live class roster. Earn points in evaluations and Lucky Spin to climb the board.
          </p>
        </div>
      </div>
    </motion.div>
  );
});

function SkeletonRow() {
  return <div className="h-[78px] rounded-2xl skeleton border border-white/5" />;
}

export default function TopFiveHero() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    fetchRosterPoints()
      .then((r) => {
        if (cancelled) return;
        const sorted = (r || []).slice().sort((a, b) => b.points - a.points);
        setRows(sorted);
      })
      .catch((e) => !cancelled && setErr(e?.message || "Could not load leaderboard"));
    const t = setInterval(() => setRefreshKey((k) => k + 1), POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const top5 = (rows || []).slice(0, 5);
  const champion = top5[0];
  const rest = top5.slice(1);

  return (
    <section
      className="mb-5 sm:mb-6"
      aria-labelledby="top5-heading"
      data-testid="top-five-hero"
    >
      <div className="flex items-end justify-between gap-3 mb-3">
        <div>
          <h2
            id="top5-heading"
            className="font-display text-lg sm:text-xl font-extrabold text-iridescent leading-tight"
          >
            Top 5 Points Earners
          </h2>
          <p className="text-[11px] sm:text-xs text-white/55 mt-0.5">
            Live class leaderboard · auto-refreshes every minute
          </p>
        </div>
        <button
          type="button"
          onClick={() => setRefreshKey((k) => k + 1)}
          aria-label="Refresh leaderboard"
          data-testid="top-five-refresh"
          className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-semibold text-white/65 hover:text-white hover:bg-white/[0.08] transition"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </div>

      <AnimatePresence mode="wait">
        {!rows && !err && (
          <motion.div key="sk" exit={{ opacity: 0 }} className="grid gap-3 grid-cols-1 lg:grid-cols-12">
            <div className="lg:col-span-7"><SkeletonRow /></div>
            <div className="lg:col-span-5 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {Array.from({ length: 4 }).map((_, i) => <SkeletonRow key={i} />)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {err && (
        <div className="rounded-2xl border border-aurora-coral/40 bg-aurora-coral/10 px-4 py-3 text-sm text-aurora-coral">
          {err}
        </div>
      )}

      {champion && (
        <div className="grid gap-3 grid-cols-1 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <ChampionHero name={champion.name} points={champion.points} />
          </div>
          <div className="lg:col-span-5 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {rest.map((r, i) => (
              <PodiumCard
                key={r.name + i}
                rank={i + 2}
                name={r.name}
                points={r.points}
                delay={0.1 + i * 0.07}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
