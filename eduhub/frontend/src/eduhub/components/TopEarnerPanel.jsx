import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Crown, Trophy, Medal, Star, Award, Flame, Sparkles, Wifi, WifiOff } from "lucide-react";
import { useTopEarners } from "../hooks/useTopEarners";
import { useTheme } from "../pages/portal/hooks/useTheme";
import { resolveAchievementPresentation } from "../lib/experienceConfig/achievementConfigResolver";
import AchievementDecorations from "./AchievementDecorations";
import HeroArtworkLayer from "./HeroArtworkLayer";

const CYCLE_MS = 4500;
const TOP_LIMIT = 5;

const TROPHY_ICONS = {
  classic: Trophy,
  crownJewel: Crown,
  medal: Medal,
  star: Star,
  wreath: Award,
};

const BORDER_STYLE = {
  solid: (color) => ({ border: `1px solid ${color}` }),
  glow: (color) => ({ border: `1px solid ${color}`, boxShadow: `0 0 14px ${color}40` }),
  none: () => ({ border: "none" }),
};

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

function SpotlightCard({ row, achievement }) {
  const tile = achievement.rankTile[row.rank] || achievement.rankTile.rest;
  const TrophyIcon = TROPHY_ICONS[achievement.trophy?.style] || Crown;
  const winnerEmphasis = achievement.playerCard?.winnerEmphasis?.enabled !== false;
  const cardRadius = achievement.playerCard?.cornerRadius;
  const championGlow = row.rank === 1 && achievement.trophy?.championGlow?.enabled && winnerEmphasis;

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
      {/* Rank tile — icon reflects the configured trophy style */}
      <div
        className="grid h-[48px] w-[48px] sm:h-[58px] sm:w-[58px] flex-none place-items-center font-display text-[1.05rem] sm:text-[1.35rem] font-black"
        style={{
          background: tile.gradient,
          color: tile.on,
          borderRadius: cardRadius,
          boxShadow: championGlow
            ? `0 0 28px ${achievement.trophy.color}, inset 0 1px 0 rgba(255,255,255,0.35)`
            : `0 0 22px ${tile.glow}, inset 0 1px 0 rgba(255,255,255,0.3)`,
        }}
      >
        {row.rank === 1 ? <TrophyIcon className="w-5 h-5 sm:w-6 sm:h-6" data-testid="top-earner-trophy-icon" /> : `#${row.rank}`}
      </div>

      {/* Avatar */}
      <div
        className="grid h-[48px] w-[48px] sm:h-[58px] sm:w-[58px] flex-none place-items-center text-base sm:text-lg font-bold text-white border border-white/20"
        style={{ background: avatarColor(row.name), fontFamily: "Outfit, sans-serif", borderRadius: cardRadius }}
        aria-hidden
      >
        {initials(row.name)}
      </div>

      {/* Name + points */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1 sm:gap-1.5 mb-0.5">
          <Sparkles className="w-3 h-3" style={{ color: achievement.goldAccent }} />
          <span
            className="text-[8px] sm:text-[9px] uppercase tracking-[0.2em] font-bold"
            style={{ color: achievement.goldAccent, opacity: 0.9 }}
          >
            {row.rank === 1 ? "Current Leader" : `Rank 0${row.rank}`}
          </span>
        </div>
        <div
          className="font-display text-[0.95rem] sm:text-xl font-extrabold truncate"
          data-testid={`top-earner-name-${row.rank}`}
          style={{ letterSpacing: "-0.01em", color: achievement.nameColor || achievement.onSurface }}
        >
          {row.name}
        </div>
        <div className="flex items-baseline gap-1.5">
          <div
            className="font-display text-[1.35rem] sm:text-3xl font-black leading-none"
            data-testid={`top-earner-points-${row.rank}`}
            style={{ color: achievement.scoreColor || achievement.goldAccent }}
          >
            <CountUp value={row.points} decimals={row.points % 1 === 0 ? 0 : 2} />
          </div>
          <span className="text-[10px] sm:text-[11px] uppercase tracking-wider" style={{ color: achievement.onSurfaceSoft }}>pts</span>
        </div>
      </div>

      {row.rank === 1 && winnerEmphasis && (
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
function RestTicker({ rows, achievement }) {
  // Memoized duplication so the marquee loops seamlessly without re-renders.
  const duplicated = useMemo(() => (rows.length ? [...rows, ...rows] : []), [rows]);

  if (!rows.length) {
    return (
      <div
        className="flex items-center justify-center gap-2 border-t border-white/[0.08] py-2 text-[10.5px] text-white/40"
        style={{ background: achievement.tickerBg }}
        data-testid="top-earner-rest-empty"
      >
        <Sparkles className="w-3 h-3" style={{ color: achievement.emeraldAccent }} />
        Top 5 covers every active student right now
      </div>
    );
  }

  // Tune speed by row count so density stays comfortable.
  const seconds = Math.max(28, Math.min(90, rows.length * 4));

  return (
    <div
      className="relative overflow-hidden border-t border-white/[0.08]"
      style={{ background: achievement.tickerBg }}
      data-testid="top-earner-rest-ticker"
    >
      <span
        className="absolute left-2 top-1/2 -translate-y-1/2 z-10 hidden sm:inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.18em] font-bold text-white/35 px-1.5 py-[3px] rounded"
        style={{ background: achievement.tickerBg }}
      >
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
              style={{ background: `${achievement.emeraldAccent}52`, color: "#fff" }}
            >
              {r.rank}
            </span>
            <span className="font-semibold text-white/90">{r.name}</span>
            <span className="font-bold tabular-nums" style={{ color: achievement.goldAccent }}>
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

/**
 * @param {object} [achievementConfig] — resolved ExperienceConfig for
 *   experienceType="achievement_top_earner" (see useDashboardBootstrap /
 *   useExperienceConfig). Optional and purely presentational — leaderboard
 *   data (points, rankings, live updates) is untouched, still owned
 *   entirely by useTopEarners below. Absent/null falls back to the exact
 *   Phase E behavior (Follow-Welcome Emerald/Midnight pair, no artwork,
 *   no decorations) — never a broken or blank panel.
 */
export default function TopEarnerPanel({ achievementConfig } = {}) {
  const { top, rest, loading, error, connectionOk, lastUpdated, totalCount } =
    useTopEarners(TOP_LIMIT);
  const [cursor, setCursor] = useState(0);
  const [ago, setAgo] = useState(0);
  const { theme } = useTheme();
  const prefersReducedMotion = useReducedMotion();
  const animateEnabled = !prefersReducedMotion;
  const achievement = useMemo(
    () => resolveAchievementPresentation(achievementConfig, { appTheme: theme }),
    [achievementConfig, theme],
  );

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

  if (!achievement.visible) return null;

  const visibleRow = top[Math.min(cursor, Math.max(0, top.length - 1))] || null;
  const cardBorder = BORDER_STYLE[achievement.playerCard?.borderStyle || "glow"](achievement.goldAccent);

  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.25, 0.8, 0.25, 1], delay: 0.1 }}
      className="relative overflow-hidden rounded-2xl mb-4 sm:mb-5 backdrop-blur-xl"
      style={{
        background: achievement.surface,
        boxShadow: `${achievement.shadow || "0 14px 40px rgba(0,0,0,0.35)"}, 0 0 0 1px ${achievement.borderColor || `${achievement.goldAccent}1A`}`,
      }}
      data-testid="top-earner-panel"
      data-achievement-theme={achievement.mode}
      data-achievement-preset={achievement.id}
    >
      {/* Background artwork — reuses the SAME compositing layer + offline
          cache as the Welcome Hero (heroArtworkSchema.js / HeroArtworkLayer),
          no duplicate infrastructure. */}
      {achievement.artwork?.url && (
        <HeroArtworkLayer heroArtwork={achievement.artwork} animateEnabled={animateEnabled} />
      )}

      {/* Seasonal/celebratory decorations — see AchievementDecorations.jsx */}
      <AchievementDecorations decorations={achievement.decorations} animateEnabled={animateEnabled} />

      {/* left accent bar — gold trophy tone into emerald, per achievement theme */}
      <div
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{
          background: achievement.accentBarGradient,
          boxShadow: `0 0 16px ${achievement.emeraldAccent}80`,
        }}
      />

      {/* Header strip */}
      <div className="relative flex items-center flex-wrap gap-2 px-3.5 sm:px-5 pt-3 pb-1.5">
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{ background: `linear-gradient(135deg, ${achievement.goldAccent}40, ${achievement.emeraldAccent}30)`, color: achievement.headerColor || achievement.goldAccent, boxShadow: `0 0 12px ${achievement.goldAccent}45` }}
        >
          <Trophy className="w-3.5 h-3.5" />
        </div>
        <div className="font-display text-[0.74rem] sm:text-[0.78rem] font-bold tracking-[0.08em] uppercase" style={{ color: achievement.headerColor || undefined }}>
          Top 5 Points Earner
        </div>
        <span className="font-khmer text-[0.78rem] sm:text-[0.82rem] text-white/75 -ml-0.5">· កំពូលពិន្ទុ</span>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <span
            className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-[3px] rounded-full border"
            style={
              connectionOk
                ? { color: achievement.liveBadge.color, background: achievement.liveBadge.bg, borderColor: achievement.liveBadge.border }
                : { color: "#ff7a5a", background: "rgba(255,122,90,0.10)", borderColor: "rgba(255,122,90,0.4)" }
            }
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
        className="relative mx-3.5 sm:mx-5 my-2.5 sm:my-3 h-[78px] sm:h-[96px] overflow-hidden"
        style={{ background: achievement.surfaceCard, borderRadius: achievement.playerCard?.cornerRadius, ...cardBorder }}
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
            {visibleRow && <SpotlightCard row={visibleRow} achievement={achievement} />}
          </AnimatePresence>
        )}
      </div>

      {/* Top-5 chips: tap any to focus that rank */}
      {top.length >= 1 && (
        <div className="relative flex items-center gap-1.5 sm:gap-2 px-3.5 sm:px-5 pb-3 overflow-x-auto no-scrollbar">
          {top.map((r) => {
            const active = r.rank === (visibleRow?.rank ?? 1) && achievement.playerCard?.activeHighlight?.enabled !== false;
            const tile = achievement.rankTile[r.rank] || achievement.rankTile.rest;
            return (
              <button
                key={r.name}
                type="button"
                onClick={() => setCursor(r.rank - 1)}
                data-testid={`top-earner-chip-${r.rank}`}
                className="group flex-none inline-flex items-center gap-1.5 px-2.5 py-[5px] rounded-full border text-[11px] font-semibold transition"
                style={
                  active
                    ? { background: achievement.chipActiveBg, borderColor: achievement.chipActiveBorder, color: achievement.onSurface, boxShadow: `0 0 10px ${achievement.goldAccent}4D` }
                    : { background: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.10)", color: "rgba(255,255,255,0.65)" }
                }
              >
                <span
                  className="grid h-4 w-4 place-items-center rounded-full text-[9px] font-black"
                  style={{ background: tile.gradient, color: tile.on }}
                >
                  {r.rank}
                </span>
                <span className="truncate max-w-[110px] sm:max-w-[140px]">{r.name}</span>
                <span className="tabular-nums" style={{ color: achievement.goldAccent }}>
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
      {!loading && <RestTicker rows={rest} achievement={achievement} />}
    </motion.section>
  );
}
