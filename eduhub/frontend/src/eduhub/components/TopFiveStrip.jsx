// TopFiveStrip.jsx — "Premium Compact Top 5 v1" leaderboard.
//
// v13.1 (Premium Compact Top 5 v1, Jan-2026)
// ────────────────────────────────────────────────────────────────────
// REAL DATA RULE: this component reads the existing useTopEarners()
// hook (Google Sheet poll) verbatim. Every name, point value, rank,
// the live connection status, and the lastUpdated tick come straight
// from the hook. No fake students, no invented "X points away" copy.
//
// What changed vs. the v12 strip:
//   • Refined glass background + sharper text hierarchy.
//   • Inline SVG trophy header icon (was the lucide `Trophy`).
//   • Crown SVG above the #1 chip (sits in the chip's upper-half).
//   • Gold halo / glow ring around the #1 avatar.
//   • Tiny inline medal SVGs (gold/silver/bronze) replace the
//     generic gradient pill on ranks #1 / #2 / #3.
//   • Neon "#4" / "#5" badges for ranks #4 / #5.
//   • Subtle sparkle decoration ONLY around the #1 chip.
//   • Tap feedback (active:scale) on every chip.
//   • Mobile spacing tightened so the row fits before Explore.
//   • Cycling spotlight + rank-6+ marquee preserved using real data.
//
// What stayed identical vs. v12:
//   • Single horizontal row of 5 chips (no stacked / tall layout).
//   • Same data source, same totalCount, same Live / Retry pill.
//   • Same overall card height envelope (~120-130px on mobile).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Wifi, WifiOff, Sparkles as SparklesIcon, Flame } from "lucide-react";
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

/* CountUp number animation — preserved from v12 spotlight. */
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
  return <span className="tabular-nums">{Math.round(display).toLocaleString()}</span>;
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Inline SVGs — premium, no external assets, sized for compact chips      */
/* ─────────────────────────────────────────────────────────────────────── */

function TrophySvg({ size = 14 }) {
  const id = React.useId();
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden focusable="false">
      <defs>
        <linearGradient id={id} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FFE6A1" />
          <stop offset="55%" stopColor="#F5C04F" />
          <stop offset="100%" stopColor="#B8741C" />
        </linearGradient>
      </defs>
      <path d="M12 6h24v6c0 6-5 11-12 11S12 18 12 12V6z" fill={`url(#${id})`} stroke="rgba(0,0,0,0.18)" strokeWidth="1" />
      <path d="M9 8h3v6a4 4 0 0 1-4-4V8h1zm27 0h3v2a4 4 0 0 1-4 4V8h1z" fill={`url(#${id})`} opacity="0.85" />
      <rect x="20" y="22" width="8" height="6" fill={`url(#${id})`} />
      <rect x="14" y="28" width="20" height="3" rx="1.5" fill={`url(#${id})`} />
      <rect x="16" y="31" width="16" height="6" rx="2" fill={`url(#${id})`} stroke="rgba(0,0,0,0.18)" />
      <rect x="12" y="38" width="24" height="4" rx="2" fill={`url(#${id})`} stroke="rgba(0,0,0,0.22)" />
    </svg>
  );
}

function CrownSvg({ size = 18 }) {
  const id = React.useId();
  return (
    <svg viewBox="0 0 48 32" width={size} height={size * (32 / 48)} aria-hidden focusable="false">
      <defs>
        <linearGradient id={id} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FFE6A1" />
          <stop offset="60%" stopColor="#F5C04F" />
          <stop offset="100%" stopColor="#A66A18" />
        </linearGradient>
      </defs>
      <path
        d="M2 28 6 8l10 8L24 4l8 12 10-8 4 20z"
        fill={`url(#${id})`}
        stroke="rgba(0,0,0,0.22)"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="6" cy="8" r="2" fill="#FFF7DA" />
      <circle cx="24" cy="4" r="2.2" fill="#FFF7DA" />
      <circle cx="42" cy="8" r="2" fill="#FFF7DA" />
      <rect x="3" y="29" width="42" height="2.5" rx="1.2" fill={`url(#${id})`} opacity="0.9" />
    </svg>
  );
}

/**
 * Small inline medal SVG (sized to live INSIDE the rank-badge dot).
 * Renders just a colored disc with a tiny inset ring + the numeral —
 * compact enough to stay in the 20×20 badge slot of the original chip.
 */
function MedalDot({ rank }) {
  const id = React.useId();
  const palette = {
    1: { a: "#FFE6A1", b: "#F5C04F", c: "#9C6E16" },
    2: { a: "#EEF2FA", b: "#C7D0DE", c: "#7C8696" },
    3: { a: "#F2C499", b: "#C2774A", c: "#7A3A14" },
  }[rank];
  if (!palette) return null;
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden focusable="false">
      <defs>
        <linearGradient id={id} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={palette.a} />
          <stop offset="55%" stopColor={palette.b} />
          <stop offset="100%" stopColor={palette.c} />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="11" fill={`url(#${id})`} stroke="rgba(0,0,0,0.30)" strokeWidth="0.8" />
      <circle cx="12" cy="12" r="7.2" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="0.8" />
      <text
        x="12" y="15.6"
        textAnchor="middle"
        fontSize="10"
        fontWeight="900"
        fill="rgba(0,0,0,0.6)"
        fontFamily="Outfit, system-ui, sans-serif"
      >
        {rank}
      </text>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Avatar chip — compact, with rank badge / crown / glow per rank          */
/* ─────────────────────────────────────────────────────────────────────── */
function AvatarChip({ row, active, onClick }) {
  const color = avatarColor(row.name);
  const isChamp = row.rank === 1;
  const showMedal = row.rank <= 3;

  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ y: -3, scale: 1.04 }}
      whileTap={{ scale: 0.94 }}
      transition={{ type: "spring", stiffness: 320, damping: 22 }}
      data-testid={`top5-chip-${row.rank}`}
      className={`group relative flex flex-col items-center justify-center flex-none w-[68px] sm:w-[82px] rounded-2xl px-1.5 pt-3 pb-2 transition-all ${
        isChamp
          ? "top5-champ-chip"
          : active
            ? "bg-white/[0.07] border border-white/20"
            : "bg-white/[0.03] border border-white/[0.08] hover:border-white/25"
      }`}
    >
      {/* #1 crown — sits above the avatar */}
      {isChamp && (
        <span aria-hidden className="absolute -top-2 left-1/2 -translate-x-1/2 drop-shadow-[0_0_6px_rgba(245,192,79,0.7)]">
          <CrownSvg size={20} />
        </span>
      )}

      {/* #1 sparkles — subtle, only around the champion */}
      {isChamp && (
        <div aria-hidden className="top5-sparkles">
          <span className="top5-sparkle" style={{ left: "14%", top: "22%", animationDelay: "0.0s" }} />
          <span className="top5-sparkle" style={{ left: "82%", top: "30%", animationDelay: "0.8s" }} />
          <span className="top5-sparkle" style={{ left: "20%", top: "78%", animationDelay: "1.5s" }} />
          <span className="top5-sparkle" style={{ left: "78%", top: "72%", animationDelay: "2.2s" }} />
        </div>
      )}

      {/* Avatar */}
      <div className="relative">
        {/* Gold halo ring — only for #1 */}
        {isChamp && <span aria-hidden className="absolute inset-[-3px] rounded-full top5-gold-ring" />}
        <div
          className="relative grid place-items-center w-[42px] h-[42px] sm:w-[46px] sm:h-[46px] rounded-full text-[12px] sm:text-[13px] font-black text-white"
          style={{
            background: `linear-gradient(135deg, ${color}, ${color}cc)`,
            fontFamily: "Outfit, sans-serif",
            boxShadow: isChamp
              ? `0 0 16px ${color}77, inset 0 0 10px rgba(255,255,255,0.10)`
              : `0 0 12px ${color}44`,
          }}
          aria-hidden
        >
          {initials(row.name)}
        </div>

        {/* Rank badge overlay — medal (1-3) or neon # (4-5) */}
        <span
          className="absolute -top-1.5 -right-1.5 grid place-items-center w-[22px] h-[22px] rounded-full font-extrabold tabular-nums"
          style={
            showMedal
              ? {
                  background: "transparent",
                  boxShadow: row.rank === 1 ? "0 0 10px rgba(245,192,79,0.7)" : "0 0 8px rgba(0,0,0,0.35)",
                }
              : {
                  background:
                    "linear-gradient(135deg, rgba(0,224,255,0.20), rgba(155,92,255,0.22))",
                  border: "1px solid rgba(155,92,255,0.65)",
                  color: "#ffffff",
                  fontSize: 10,
                  textShadow: "0 0 8px rgba(0,224,255,0.85)",
                  boxShadow:
                    "0 0 10px rgba(155,92,255,0.45), inset 0 0 6px rgba(0,224,255,0.22)",
                  fontFamily: "Outfit, sans-serif",
                }
          }
        >
          {showMedal ? <MedalDot rank={row.rank} /> : `#${row.rank}`}
        </span>
      </div>

      {/* Name */}
      <span
        className={`mt-1.5 text-[10px] sm:text-[11px] font-semibold truncate max-w-[68px] sm:max-w-[82px] ${
          isChamp ? "text-white" : "text-white/85"
        }`}
        title={row.name}
      >
        {row.name}
      </span>

      {/* Points */}
      <span className={`text-[10px] font-extrabold tabular-nums ${isChamp ? "text-aurora-gold" : "text-aurora-gold/90"}`}>
        {row.points >= 1000
          ? (row.points / 1000).toFixed(row.points % 1000 === 0 ? 0 : 1) + "k"
          : row.points.toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </span>

      {/* Active spotlight ring — subdued so it doesn't compete with the gold ring on #1 */}
      {active && !isChamp && (
        <motion.span
          layoutId="top5-active-ring"
          aria-hidden
          className="absolute inset-0 rounded-2xl pointer-events-none"
          style={{
            border: "1px solid rgba(0,224,255,0.45)",
            boxShadow:
              "inset 0 0 14px rgba(0,224,255,0.15), 0 0 14px rgba(0,224,255,0.20)",
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
      className="relative overflow-hidden border-t border-white/[0.06]"
      style={{ background: "rgba(5,0,16,0.45)" }}
      data-testid="top5-rest-marquee"
    >
      <span className="absolute left-2 top-1/2 -translate-y-1/2 z-10 hidden sm:inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.18em] font-bold text-white/60 bg-[rgba(5,0,16,0.85)] px-1.5 py-[3px] rounded">
        Rank 6+
      </span>
      <div
        className="flex items-center gap-5 py-1.5 pl-3 sm:pl-[80px] whitespace-nowrap will-change-transform"
        style={{ animation: `top5MarqueeLeft ${seconds}s linear infinite` }}
      >
        {duplicated.map((r, i) => (
          <span key={i} className="inline-flex items-center gap-1.5 text-[10.5px] text-white/70">
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
      className="top5-card relative overflow-hidden rounded-2xl mb-4 sm:mb-5 border border-white/[0.10] backdrop-blur-xl"
      data-testid="top5-strip"
    >
      {/* Left rainbow accent bar — preserved from v12 */}
      <div
        className="absolute left-0 top-0 bottom-0 w-[3px] z-10"
        style={{
          background: "linear-gradient(180deg,#ffc94d 0%,#ff7a3a 35%,#ff3da6 70%,#9b5cff 100%)",
          boxShadow: "0 0 12px rgba(255,122,58,0.5)",
        }}
      />

      {/* Header row — same compact height as v12 */}
      <div className="flex items-center flex-wrap gap-2 px-3.5 sm:px-5 pt-2.5 pb-1.5">
        <div className="w-7 h-7 rounded-md grid place-items-center bg-gradient-to-br from-aurora-gold/40 to-aurora-coral/30 border border-aurora-gold/40 shadow-[0_0_10px_rgba(255,201,77,0.45)]">
          <TrophySvg size={14} />
        </div>
        <div className="font-display text-[0.78rem] font-extrabold tracking-[0.10em] uppercase text-iridescent leading-none">
          Top 5 Points
        </div>
        <span className="font-khmer text-[0.78rem] text-white/70 -ml-0.5 leading-none">
          · កំពូលពិន្ទុ
        </span>

        {/* Cycling spotlight name (md+ only — keeps the row compact on mobile) */}
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

      {/* Avatar chips row — single compact horizontal scroller */}
      <div
        className="flex items-stretch gap-2 sm:gap-3 px-3.5 sm:px-5 pb-3 overflow-x-auto no-scrollbar"
        data-testid="top5-chips-row"
      >
        {loading && !top.length ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex-none w-[68px] sm:w-[82px] h-[92px] rounded-2xl skeleton" />
          ))
        ) : error && !top.length ? (
          <div className="flex items-center gap-2 text-[12px] text-aurora-coral px-2 py-3">
            <SparklesIcon className="w-3.5 h-3.5" />
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
            <span className="font-bold tabular-nums text-white/60">{totalCount}</span>
            <span>students</span>
          </div>
        )}
      </div>

      {/* Rank 6+ marquee — uses real `rest` rows */}
      {!loading && <RestMarquee rows={rest} />}

      {/* Scoped styles — .top5-* prefix so nothing leaks globally. */}
      <style>{`
        .top5-card {
          background:
            radial-gradient(ellipse 90% 100% at 0% 0%, rgba(255,201,77,0.12) 0%, transparent 55%),
            radial-gradient(ellipse 90% 100% at 100% 100%, rgba(255,61,166,0.12) 0%, transparent 55%),
            linear-gradient(135deg, rgba(10,4,30,0.85) 0%, rgba(15,8,40,0.85) 100%);
          box-shadow: 0 14px 40px rgba(0,0,0,0.32), 0 0 0 1px rgba(255,201,77,0.08);
        }
        /* Champion chip — same envelope as a normal chip, just dressed up */
        .top5-champ-chip {
          background:
            radial-gradient(120% 130% at 50% 0%, rgba(255,201,77,0.22) 0%, transparent 65%),
            linear-gradient(180deg, rgba(28,16,52,0.92) 0%, rgba(18,10,38,0.92) 100%);
          border: 1px solid rgba(245,192,79,0.45);
          box-shadow:
            0 0 18px rgba(245,192,79,0.30),
            inset 0 1px 0 rgba(255,225,154,0.20);
          isolation: isolate;
        }
        .top5-gold-ring {
          border-radius: 9999px;
          border: 2px solid rgba(245,192,79,0.65);
          box-shadow:
            0 0 12px rgba(245,192,79,0.55),
            inset 0 0 8px rgba(255,225,154,0.30);
          animation: top5RingPulse 3.6s ease-in-out infinite;
          pointer-events: none;
        }
        @keyframes top5RingPulse {
          0%, 100% { box-shadow: 0 0 10px rgba(245,192,79,0.40), inset 0 0 6px rgba(255,225,154,0.22); }
          50%      { box-shadow: 0 0 18px rgba(245,192,79,0.85), inset 0 0 12px rgba(255,225,154,0.42); }
        }
        .top5-sparkles {
          position: absolute;
          inset: 0;
          pointer-events: none;
          overflow: hidden;
          border-radius: inherit;
          z-index: 0;
        }
        .top5-sparkle {
          position: absolute;
          width: 3px;
          height: 3px;
          border-radius: 50%;
          background: radial-gradient(circle, #FFE6A1 0%, rgba(245,192,79,0.55) 60%, transparent 80%);
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.8);
          animation: top5Sparkle 4.4s ease-in-out infinite;
          box-shadow: 0 0 6px rgba(255,225,154,0.7);
        }
        @keyframes top5Sparkle {
          0%, 100% { opacity: 0; transform: translate(-50%, -50%) scale(0.6); }
          50%      { opacity: 1; transform: translate(-50%, -50%) scale(1.1); }
        }
        @keyframes top5MarqueeLeft {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }
        @media (prefers-reduced-motion: reduce) {
          .top5-gold-ring,
          .top5-sparkle,
          [data-testid="top5-rest-marquee"] > div:last-of-type {
            animation: none !important;
          }
          .top5-sparkle { opacity: 0.6; }
        }
      `}</style>
    </motion.section>
  );
}
