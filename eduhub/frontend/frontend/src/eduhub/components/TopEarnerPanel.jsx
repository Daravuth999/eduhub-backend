import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Crown, Trophy, Flame, Sparkles, Wifi, WifiOff } from "lucide-react";
import { useTopEarners } from "../hooks/useTopEarners";

const CYCLE_MS = 4500;
const TOP_LIMIT = 5;

function initials(name) {
  if (!name) return "??";
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarColor(name) {
  const palette = ["#00e0ff", "#9b5cff", "#ff3da6", "#ffc94d", "#a3ff3a", "#ff7a3a"];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

function CountUp({ value, duration = 900, decimals = 0 }) {
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
  }, [value, duration]);
  return (
    <span className="tabular-nums" data-testid="top-earner-countup">
      {display.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
    </span>
  );
}

function SpotlightCard({ row }) {
  return (
    <motion.div
      key={row.rank + ":" + row.name}
      initial={{ x: 90, opacity: 0, scale: 0.96 }}
      animate={{ x: 0, opacity: 1, scale: 1 }}
      exit={{ x: -90, opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      className="absolute inset-0 flex items-center gap-3 sm:gap-4 px-3.5 sm:px-5 py-3 sm:py-4"
      data-testid={`top-earner-spotlight-rank-${row.rank}`}
    >
      {/* Rank tile */}
      <div
        className="grid h-[48px] w-[48px] sm:h-[58px] sm:w-[58px] flex-none place-items-center rounded-2xl font-display text-[1.05rem] sm:text-[1.35rem] font-black"
        style={{
          background:
            row.rank === 1
              ? "linear-gradient(135deg, #ffc94d, #ff7a3a)"
              : row.rank === 2
              ? "linear-gradient(135deg, #00e0ff, #9b5cff)"
              : row.rank === 3
              ? "linear-gradient(135deg, #9b5cff, #ff3da6)"
              : "linear-gradient(135deg, rgba(155,92,255,0.55), rgba(0,224,255,0.45))",
          color: "#0a0220",
          boxShadow:
            row.rank === 1
              ? "0 0 22px rgba(255,201,77,0.55), inset 0 1px 0 rgba(255,255,255,0.35)"
              : "0 0 18px rgba(155,92,255,0.45), inset 0 1px 0 rgba(255,255,255,0.25)",
        }}
      >
        {row.rank === 1 ? <Crown className="w-5 h-5 sm:w-6 sm:h-6" /> : `#${row.rank}`}
      </div>

      {/* Avatar */}
      <div
        className="grid h-[48px] w-[48px] sm:h-[58px] sm:w-[58px] flex-none place-items-center rounded-2xl text-base sm:text-lg font-bold text-white border border-white/20"
        style={{ background: avatarColor(row.name), fontFamily: "Outfit, sans-serif" }}
        aria-hidden
      >
        {initials(row.name)}
      </div>

      {/* Name + points */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1 sm:gap-1.5 mb-0.5">
          <Sparkles className="w-3 h-3 text-aurora-gold" />
          <span className="text-[8px] sm:text-[9px] uppercase tracking-[0.2em] font-bold text-aurora-gold/90">
            {row.rank === 1 ? "Current Leader" : `Rank 0${row.rank}`}
          </span>
        </div>
        <div
          className="font-display text-[0.95rem] sm:text-xl font-extrabold text-white truncate"
          data-testid={`top-earner-name-${row.rank}`}
          style={{ letterSpacing: "-0.01em" }}
        >
          {row.name}
        </div>
        <div className="flex items-baseline gap-1.5">
          <div
            className="font-display text-[1.35rem] sm:text-3xl font-black leading-none bg-gradient-to-r from-aurora-gold via-aurora-coral to-aurora-magenta bg-clip-text text-transparent"
            data-testid={`top-earner-points-${row.rank}`}
          >
            <CountUp value={row.points} decimals={row.points % 1 === 0 ? 0 : 2} />
          </div>
          <span className="text-[10px] sm:text-[11px] uppercase tracking-wider text-white/55">pts</span>
        </div>
      </div>

      {row.rank === 1 && (
        <div className="hidden sm:flex flex-none items-center gap-1 text-aurora-coral">
          <Flame className="w-5 h-5 animate-bounce-soft drop-shadow-[0_0_10px_rgba(255,122,58,0.7)]" />
          <span className="text-[11px] font-semibold uppercase tracking-wider">On fire</span>
        </div>
      )}
    </motion.div>
  );
}

/**
 * Continuous left-scrolling marquee for students OUTSIDE the top 5.
 * Receives `rest` from useTopEarners. Falls back to a friendly note when empty.
 */
function RestTicker({ rows }) {
  // Memoized duplication so the marquee loops seamlessly without re-renders.
  const duplicated = useMemo(() => (rows.length ? [...rows, ...rows] : []), [rows]);

  if (!rows.length) {
    return (
      <div
        className="flex items-center justify-center gap-2 border-t border-white/[0.08] py-2 text-[10.5px] text-white/40"
        style={{ background: "rgba(8,3,22,0.45)" }}
        data-testid="top-earner-rest-empty"
      >
        <Sparkles className="w-3 h-3 text-aurora-cyan" />
        Top 5 covers every active student right now
      </div>
    );
  }

  // Tune speed by row count so density stays comfortable.
  const seconds = Math.max(28, Math.min(90, rows.length * 4));

  return (
    <div
      className="relative overflow-hidden border-t border-white/[0.08]"
      style={{ background: "rgba(8,3,22,0.45)" }}
      data-testid="top-earner-rest-ticker"
    >
      <span className="absolute left-2 top-1/2 -translate-y-1/2 z-10 hidden sm:inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.18em] font-bold text-white/35 bg-[rgba(8,3,22,0.85)] px-1.5 py-[3px] rounded">
        Rank 6+
      </span>
      <div
        className="flex items-center gap-5 py-2 pl-4 sm:pl-[88px] whitespace-nowrap will-change-transform"
        style={{ animation: `marqueeLeft ${seconds}s linear infinite` }}
      >
        {duplicated.map((r, i) => (
          <div
            key={i}
            className="flex items-center gap-1.5 text-[11px] text-white/70"
            data-testid={i < rows.length ? `rest-row-${r.rank}` : undefined}
          >
            <span
              className="grid h-5 w-5 flex-none place-items-center rounded-full font-bold text-[10px]"
              style={{ background: "rgba(155,92,255,0.32)", color: "#fff" }}
            >
              {r.rank}
            </span>
            <span className="font-semibold text-white/90">{r.name}</span>
            <span className="text-aurora-gold font-bold tabular-nums">
              {r.points.toLocaleString(undefined, { maximumFractionDigits: 2 })} pts
            </span>
            <span className="text-white/25">·</span>
          </div>
        ))}
      </div>
      <style>{`
        @keyframes marqueeLeft {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-testid="top-earner-rest-ticker"] > div:last-of-type { animation: none !important; }
        }
      `}</style>
    </div>
  );
}

export default function TopEarnerPanel() {
  const { top, rest, loading, error, connectionOk, lastUpdated, totalCount } =
    useTopEarners(TOP_LIMIT);
  const [cursor, setCursor] = useState(0);
  const [ago, setAgo] = useState(0);

  // Cycle through ALL of the top 5 (was top 3 previously).
  useEffect(() => {
    if (!top.length) return;
    const cycleSize = Math.min(TOP_LIMIT, top.length);
    const id = setInterval(() => {
      setCursor((c) => (c + 1) % cycleSize);
    }, CYCLE_MS);
    return () => clearInterval(id);
  }, [top.length]);

  useEffect(() => {
    const i = setInterval(() => {
      setAgo(lastUpdated ? Math.max(0, Math.floor((Date.now() - lastUpdated) / 1000)) : 0);
    }, 500);
    return () => clearInterval(i);
  }, [lastUpdated]);

  const visibleRow = top[Math.min(cursor, Math.max(0, top.length - 1))] || null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.25, 0.8, 0.25, 1], delay: 0.1 }}
      className="relative overflow-hidden rounded-2xl mb-4 sm:mb-5 backdrop-blur-xl border border-white/[0.08]"
      style={{
        background:
          "radial-gradient(ellipse 90% 100% at 0% 0%, rgba(255,201,77,0.14) 0%, transparent 55%)," +
          "radial-gradient(ellipse 90% 100% at 100% 100%, rgba(255,61,166,0.14) 0%, transparent 55%)," +
          "linear-gradient(135deg, rgba(10,4,30,0.85) 0%, rgba(15,8,40,0.85) 100%)",
        boxShadow: "0 14px 40px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,201,77,0.10)",
      }}
      data-testid="top-earner-panel"
    >
      {/* left rainbow accent */}
      <div
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{
          background: "linear-gradient(180deg, #ffc94d 0%, #ff7a3a 35%, #ff3da6 70%, #9b5cff 100%)",
          boxShadow: "0 0 16px rgba(255,122,58,0.5)",
        }}
      />

      {/* Header strip */}
      <div className="flex items-center flex-wrap gap-2 px-3.5 sm:px-5 pt-3 pb-1.5">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-gradient-to-br from-aurora-gold/40 to-aurora-coral/30 text-aurora-gold shadow-[0_0_12px_rgba(255,201,77,0.45)]">
          <Trophy className="w-3.5 h-3.5" />
        </div>
        <div className="font-display text-[0.74rem] sm:text-[0.78rem] font-bold tracking-[0.08em] uppercase text-iridescent">
          Top 5 Points Earner
        </div>
        <span className="font-khmer text-[0.78rem] sm:text-[0.82rem] text-white/75 -ml-0.5">· កំពូលពិន្ទុ</span>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-[3px] rounded-full border ${
              connectionOk
                ? "text-aurora-lime bg-aurora-lime/10 border-aurora-lime/40"
                : "text-aurora-coral bg-aurora-coral/10 border-aurora-coral/40"
            }`}
            data-testid={connectionOk ? "top-earner-status-ok" : "top-earner-status-fail"}
          >
            {connectionOk ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {connectionOk ? "Live" : "Retry"}
          </span>
          <span className="text-[10px] text-white/45 tabular-nums" data-testid="top-earner-ago">
            {lastUpdated ? `${ago}s ago` : "…"}
          </span>
        </div>
      </div>

      {/* Spotlight stage */}
      <div
        className="relative mx-3.5 sm:mx-5 my-2.5 sm:my-3 h-[78px] sm:h-[96px] rounded-xl overflow-hidden"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
        data-testid="top-earner-spotlight"
      >
        {loading && !top.length ? (
          <div className="absolute inset-0 flex items-center gap-3 px-4 py-3">
            <div className="h-[48px] w-[48px] sm:h-[58px] sm:w-[58px] rounded-2xl skeleton" />
            <div className="h-[48px] w-[48px] sm:h-[58px] sm:w-[58px] rounded-2xl skeleton" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-[55%] rounded skeleton" />
              <div className="h-5 w-[35%] rounded skeleton" />
            </div>
          </div>
        ) : error && !top.length ? (
          <div className="absolute inset-0 flex items-center justify-center text-[12px] text-aurora-coral px-3 text-center">
            Couldn't reach the Sheet — retrying automatically.
          </div>
        ) : (
          <AnimatePresence mode="wait">
            {visibleRow && <SpotlightCard row={visibleRow} />}
          </AnimatePresence>
        )}
      </div>

      {/* Top-5 chips: tap any to focus that rank */}
      {top.length >= 1 && (
        <div className="flex items-center gap-1.5 sm:gap-2 px-3.5 sm:px-5 pb-3 overflow-x-auto no-scrollbar">
          {top.map((r) => {
            const active = r.rank === (visibleRow?.rank ?? 1);
            return (
              <button
                key={r.name}
                type="button"
                onClick={() => setCursor(r.rank - 1)}
                data-testid={`top-earner-chip-${r.rank}`}
                className={`group flex-none inline-flex items-center gap-1.5 px-2.5 py-[5px] rounded-full border text-[11px] font-semibold transition ${
                  active
                    ? "bg-aurora-gold/15 border-aurora-gold/50 text-white shadow-[0_0_10px_rgba(255,201,77,0.3)]"
                    : "bg-white/[0.04] border-white/[0.10] text-white/65 hover:text-white hover:border-white/25"
                }`}
              >
                <span
                  className="grid h-4 w-4 place-items-center rounded-full text-[9px] font-black"
                  style={{
                    background:
                      r.rank === 1
                        ? "#ffc94d"
                        : r.rank === 2
                        ? "#00e0ff"
                        : r.rank === 3
                        ? "#ff3da6"
                        : "rgba(155,92,255,0.45)",
                    color: r.rank <= 3 ? "#0a0220" : "#fff",
                  }}
                >
                  {r.rank}
                </span>
                <span className="truncate max-w-[110px] sm:max-w-[140px]">{r.name}</span>
                <span className="text-aurora-gold tabular-nums">
                  {r.points.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </button>
            );
          })}
          {totalCount > 0 && (
            <span className="ml-auto flex-none text-[10px] uppercase tracking-wider text-white/40">
              {totalCount} students
            </span>
          )}
        </div>
      )}

      {/* Secondary auto-scrolling carousel for students OUTSIDE the top 5 */}
      {!loading && <RestTicker rows={rest} />}
    </motion.section>
  );
}
