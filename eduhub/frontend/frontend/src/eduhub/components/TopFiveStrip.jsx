// TopFiveStrip.jsx — compact ~120px Top 5 strip for the unified dashboard.
//   Shows: live status pill, cycling spotlight (CountUp on points), 5 avatar
//   chips with rank badge overlay, and an auto-scrolling marquee for ranks 6+.
//   Reuses the existing useTopEarners hook so backend logic is untouched.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Crown, Trophy, Wifi, WifiOff, Sparkles, Flame } from "lucide-react";
import { useTopEarners } from "../hooks/useTopEarners";

const CYCLE_MS = 3500;
const TOP_LIMIT = 5;

const PALETTE = ["#00e0ff", "#9b5cff", "#ff3da6", "#ffc94d", "#a3ff3a", "#ff7a3a"];

function initials(name) {
  if (!name) return "??";
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function rankBadgeBg(rank) {
  if (rank === 1) return "linear-gradient(135deg,#ffc94d,#ff7a3a)";
  if (rank === 2) return "linear-gradient(135deg,#cfd8ff,#9b5cff)";
  if (rank === 3) return "linear-gradient(135deg,#ff3da6,#9b5cff)";
  return "linear-gradient(135deg,rgba(0,224,255,0.6),rgba(155,92,255,0.6))";
}

/* CountUp number animation */
function CountUp({ value, duration = 700 }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const startRef = useRef(0);
  const rafRef = useRef(0);
  useEffect(() => {
    fromRef.current = display;
    startRef.current = performance.now();
    cancelAnimationFrame(rafRef.current);
    const step = (now) => {
      const t = Math.min(1, (now - startRef.current) / duration);
      const e = 1 - Math.pow(1 - t, 3);
      const next = fromRef.current + (value - fromRef.current) * e;
      setDisplay(next);
      if (t < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <span className="tabular-nums">
      {Math.round(display).toLocaleString()}
    </span>
  );
}

/* ───────── Avatar chip with rank badge ───────── */
function AvatarChip({ row, active, onClick }) {
  const color = avatarColor(row.name);
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ y: -3, scale: 1.04 }}
      whileTap={{ scale: 0.96 }}
      transition={{ type: "spring", stiffness: 320, damping: 22 }}
      data-testid={`top5-chip-${row.rank}`}
      className={`group relative flex flex-col items-center justify-center flex-none w-[64px] sm:w-[78px] rounded-2xl px-1.5 py-2 transition-all ${
        active
          ? "bg-white/[0.08] border border-white/25 shadow-[0_0_22px_rgba(255,201,77,0.35)]"
          : "bg-white/[0.03] border border-white/[0.08] hover:border-white/25"
      }`}
    >
      {/* Avatar */}
      <div
        className="relative grid place-items-center w-[40px] h-[40px] sm:w-[44px] sm:h-[44px] rounded-full text-[12px] sm:text-[13px] font-black text-white shadow-md"
        style={{
          background: `linear-gradient(135deg, ${color}, ${color}cc)`,
          fontFamily: "Outfit, sans-serif",
          boxShadow: `0 0 14px ${color}55`,
        }}
        aria-hidden
      >
        {initials(row.name)}
        {/* Rank badge overlay */}
        <span
          className="absolute -top-1.5 -right-1.5 grid place-items-center w-[20px] h-[20px] rounded-full text-[10px] font-extrabold border border-white/40"
          style={{
            background: rankBadgeBg(row.rank),
            color: row.rank <= 3 ? "#0a0220" : "#fff",
            boxShadow: row.rank === 1
              ? "0 0 10px rgba(255,201,77,0.7)"
              : "0 0 8px rgba(155,92,255,0.5)",
          }}
        >
          {row.rank === 1 ? <Crown className="w-3 h-3" /> : `#${row.rank}`}
        </span>
      </div>

      {/* Name */}
      <span className="mt-1.5 text-[10px] sm:text-[11px] font-semibold text-white/85 truncate max-w-[64px] sm:max-w-[78px]">
        {row.name}
      </span>
      {/* Points */}
      <span className="text-[10px] font-extrabold tabular-nums text-aurora-gold">
        {row.points >= 1000
          ? (row.points / 1000).toFixed(row.points % 1000 === 0 ? 0 : 1) + "k"
          : row.points.toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </span>

      {active && (
        <motion.span
          layoutId="top5-active-ring"
          aria-hidden
          className="absolute inset-0 rounded-2xl pointer-events-none"
          style={{
            border: "1px solid rgba(255,201,77,0.55)",
            boxShadow:
              "inset 0 0 18px rgba(255,201,77,0.18), 0 0 18px rgba(255,201,77,0.25)",
          }}
        />
      )}
    </motion.button>
  );
}

/* ───────── Marquee for ranks 6+ ───────── */
function RestMarquee({ rows }) {
  const duplicated = useMemo(() => (rows.length ? [...rows, ...rows] : []), [rows]);
  if (!rows.length) return null;
  const seconds = Math.max(28, Math.min(80, rows.length * 4));
  return (
    <div
      className="relative overflow-hidden border-t border-white/[0.08]"
      style={{ background: "rgba(8,3,22,0.45)" }}
      data-testid="top5-rest-marquee"
    >
      <span className="absolute left-2 top-1/2 -translate-y-1/2 z-10 hidden sm:inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.18em] font-bold text-white/35 bg-[rgba(8,3,22,0.85)] px-1.5 py-[3px] rounded">
        Rank 6+
      </span>
      <div
        className="flex items-center gap-5 py-1.5 pl-3 sm:pl-[80px] whitespace-nowrap will-change-transform"
        style={{ animation: `top5MarqueeLeft ${seconds}s linear infinite` }}
      >
        {duplicated.map((r, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1.5 text-[10.5px] text-white/70"
          >
            <span
              className="grid h-4 w-4 place-items-center rounded-full text-[9px] font-bold"
              style={{ background: "rgba(155,92,255,0.32)", color: "#fff" }}
            >
              {r.rank}
            </span>
            <span className="font-semibold text-white/90">{r.name}</span>
            <span className="text-aurora-gold font-bold tabular-nums">
              {r.points.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
            <span className="text-white/25">·</span>
          </span>
        ))}
      </div>
      <style>{`
        @keyframes top5MarqueeLeft {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-testid="top5-rest-marquee"] > div:last-of-type { animation: none !important; }
        }
      `}</style>
    </div>
  );
}

export default function TopFiveStrip() {
  const { top, rest, loading, error, connectionOk, lastUpdated, totalCount } =
    useTopEarners(TOP_LIMIT);
  const [cursor, setCursor] = useState(0);
  const [ago, setAgo] = useState(0);

  // Cycle the spotlight
  useEffect(() => {
    if (!top.length) return;
    const id = setInterval(
      () => setCursor((c) => (c + 1) % Math.min(TOP_LIMIT, top.length)),
      CYCLE_MS,
    );
    return () => clearInterval(id);
  }, [top.length]);

  useEffect(() => {
    const i = setInterval(() => {
      setAgo(lastUpdated ? Math.max(0, Math.floor((Date.now() - lastUpdated) / 1000)) : 0);
    }, 1000);
    return () => clearInterval(i);
  }, [lastUpdated]);

  const visible = top[Math.min(cursor, Math.max(0, top.length - 1))] || null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.05 }}
      className="relative overflow-hidden rounded-2xl mb-4 sm:mb-5 border border-white/[0.08] backdrop-blur-xl"
      style={{
        background:
          "radial-gradient(ellipse 90% 100% at 0% 0%, rgba(255,201,77,0.12) 0%, transparent 55%)," +
          "radial-gradient(ellipse 90% 100% at 100% 100%, rgba(255,61,166,0.12) 0%, transparent 55%)," +
          "linear-gradient(135deg, rgba(10,4,30,0.85) 0%, rgba(15,8,40,0.85) 100%)",
        boxShadow: "0 14px 40px rgba(0,0,0,0.32), 0 0 0 1px rgba(255,201,77,0.08)",
      }}
      data-testid="top5-strip"
    >
      {/* Left rainbow accent bar */}
      <div
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{
          background:
            "linear-gradient(180deg,#ffc94d 0%,#ff7a3a 35%,#ff3da6 70%,#9b5cff 100%)",
          boxShadow: "0 0 12px rgba(255,122,58,0.5)",
        }}
      />

      {/* Header row */}
      <div className="flex items-center flex-wrap gap-2 px-3.5 sm:px-5 pt-2.5 pb-1.5">
        <div className="w-6 h-6 rounded-md grid place-items-center bg-gradient-to-br from-aurora-gold/40 to-aurora-coral/30 text-aurora-gold shadow-[0_0_10px_rgba(255,201,77,0.45)]">
          <Trophy className="w-3 h-3" />
        </div>
        <div className="font-display text-[0.74rem] font-bold tracking-[0.08em] uppercase text-iridescent">
          Top 5 Points
        </div>
        <span className="font-khmer text-[0.78rem] text-white/75 -ml-0.5">
          · កំពូលពិន្ទុ
        </span>

        {/* Cycling spotlight name */}
        <div className="hidden md:flex items-center gap-1.5 ml-2 max-w-[280px] min-w-0">
          <span className="text-[10px] uppercase tracking-[0.18em] text-white/35 font-bold">
            Spotlight
          </span>
          <AnimatePresence mode="wait">
            {visible && (
              <motion.span
                key={visible.rank + visible.name}
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.35 }}
                className="text-[12px] font-bold text-white/95 truncate"
                data-testid="top5-spotlight-name"
              >
                #{visible.rank} {visible.name} ·{" "}
                <span className="text-aurora-gold">
                  <CountUp value={visible.points} /> pts
                </span>
                {visible.rank === 1 && (
                  <Flame className="inline w-3 h-3 ml-1 text-aurora-coral animate-bounce-soft" />
                )}
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-[3px] rounded-full border ${
              connectionOk
                ? "text-aurora-lime bg-aurora-lime/10 border-aurora-lime/40"
                : "text-aurora-coral bg-aurora-coral/10 border-aurora-coral/40"
            }`}
            data-testid={connectionOk ? "top5-status-ok" : "top5-status-fail"}
          >
            {connectionOk ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {connectionOk ? "Live" : "Retry"}
            <span className="text-[8px] tabular-nums opacity-75 ml-0.5">
              {lastUpdated ? `· ${ago}s` : ""}
            </span>
          </span>
        </div>
      </div>

      {/* Avatar chips row */}
      <div
        className="flex items-stretch gap-2 sm:gap-3 px-3.5 sm:px-5 pb-3 overflow-x-auto no-scrollbar"
        data-testid="top5-chips-row"
      >
        {loading && !top.length ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="flex-none w-[64px] sm:w-[78px] h-[88px] rounded-2xl skeleton"
            />
          ))
        ) : error && !top.length ? (
          <div className="flex items-center gap-2 text-[12px] text-aurora-coral px-2 py-3">
            <Sparkles className="w-3.5 h-3.5" />
            Couldn’t reach the leaderboard — auto-retrying.
          </div>
        ) : (
          top.map((row) => (
            <AvatarChip
              key={row.name + ":" + row.rank}
              row={row}
              active={visible?.rank === row.rank}
              onClick={() => setCursor(row.rank - 1)}
            />
          ))
        )}

        {totalCount > 0 && (
          <div className="ml-auto self-center hidden sm:flex flex-col items-end justify-center px-1 text-[10px] uppercase tracking-wider text-white/40">
            <span className="font-bold tabular-nums text-white/60">
              {totalCount}
            </span>
            <span>students</span>
          </div>
        )}
      </div>

      {/* Rank 6+ marquee */}
      {!loading && <RestMarquee rows={rest} />}
    </motion.section>
  );
}
