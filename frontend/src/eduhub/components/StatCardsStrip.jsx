// StatCardsStrip.jsx — 4-card stat strip on the public Dashboard.
import { memo, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Award, Coins, Calendar, Trophy, ArrowUp, ArrowDown, Minus } from "lucide-react";

const ICONS = { evaluation: Award, points: Coins, attendance: Calendar, leaderboard: Trophy };

const ACCENT = {
  evaluation: { color: "#a3ff3a", bg: "from-aurora-lime/30 to-aurora-cyan/10", border: "border-aurora-lime/35" },
  points:     { color: "#ffc94d", bg: "from-aurora-gold/35 to-aurora-coral/10", border: "border-aurora-gold/40" },
  attendance: { color: "#00e0ff", bg: "from-aurora-cyan/30 to-aurora-violet/10", border: "border-aurora-cyan/35" },
  leaderboard:{ color: "#ff3da6", bg: "from-aurora-magenta/30 to-aurora-violet/10", border: "border-aurora-magenta/40" },
};

function CountUp({ value }) {
  const [n, setN] = useState(0);
  const num = typeof value === "string" ? parseFloat(value.replace(/[^0-9.\-]/g, "")) : Number(value || 0);
  useEffect(() => {
    if (!Number.isFinite(num)) return;
    const start = performance.now();
    const dur = 1200;
    let raf = 0;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setN(num * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [num]);
  if (!Number.isFinite(num)) return <span>—</span>;
  return <span>{n.toFixed(num % 1 === 0 ? 0 : 1)}</span>;
}

const TrendIcon = ({ trend }) =>
  trend === "up" ? <ArrowUp className="h-3.5 w-3.5" /> :
  trend === "down" ? <ArrowDown className="h-3.5 w-3.5" /> :
  <Minus className="h-3.5 w-3.5" />;

const StatCard = memo(function StatCard({ id, label, value, trend, prefix = "", suffix = "", index }) {
  const a = ACCENT[id] ?? ACCENT.evaluation;
  const Icon = ICONS[id] ?? Award;
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: index * 0.1, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -3 }}
      className={`relative overflow-hidden rounded-2xl border ${a.border} bg-white/[0.04] backdrop-blur-md p-4`}
      data-testid={`stat-card-${id}`}
    >
      <div className={`absolute -top-10 -right-10 h-24 w-24 rounded-full bg-gradient-to-br ${a.bg} blur-2xl opacity-70`} />
      <div className="relative flex items-start justify-between mb-2.5">
        <div className={`h-9 w-9 rounded-xl flex items-center justify-center bg-gradient-to-br ${a.bg} text-white shadow-[0_0_18px_rgba(0,224,255,0.25)]`}>
          <Icon className="h-4 w-4" style={{ color: a.color }} />
        </div>
        <div
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{
            background: `${a.color}1f`,
            color: a.color,
            border: `1px solid ${a.color}40`,
          }}
        >
          <TrendIcon trend={trend} />
          {trend || "neutral"}
        </div>
      </div>
      <div className="relative">
        <div className="font-display text-3xl font-bold text-white leading-none">
          {value === null || value === undefined ? (
            <span className="text-white/40">—</span>
          ) : (
            <>
              {prefix}
              <CountUp value={value} />
              {suffix}
            </>
          )}
        </div>
        <div className="mt-1.5 text-[11px] uppercase tracking-wider text-white/55 font-semibold">
          {label}
        </div>
      </div>
    </motion.div>
  );
});

function asNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  return v;
}

export default function StatCardsStrip({ stats }) {
  const cards = [
    { id: "evaluation",  label: stats.evaluation.label,  value: asNumber(stats.evaluation.value),  trend: stats.evaluation.trend },
    { id: "points",      label: stats.points.label,      value: asNumber(stats.points.value),       trend: stats.points.trend },
    { id: "attendance",  label: stats.attendance.label,  value: asNumber(String(stats.attendance.value || "").replace("%", "")), trend: stats.attendance.trend, suffix: stats.attendance.value ? "%" : "" },
    { id: "leaderboard", label: stats.leaderboard.label, value: asNumber(String(stats.leaderboard.value || "").replace("#", "")), trend: stats.leaderboard.trend, prefix: stats.leaderboard.value ? "#" : "" },
  ];
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3 mb-4 sm:mb-5" data-testid="stat-cards-strip">
      {cards.map((c, i) => (
        <StatCard key={c.id} index={i} {...c} />
      ))}
    </div>
  );
}
