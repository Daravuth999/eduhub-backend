// EduMascotGreeter.jsx — v13.2 (Learning Beacon, Jan-2026)
//
// Replaces the cartoon-owl mascot with a premium professional SVG
// illustration called "EduHub Learning Beacon" — an elegant educational
// guide symbol combining:
//   • an open book base (parchment + glass cover)
//   • an upward beacon light beam rising from the pages
//   • a layered glass orb / spark at the center of the beam
//   • a small achievement star drifting near the orb
//   • cyan / violet / blue / gold accents matching the app palette
//
// The public export name, file path, default export, props
// ({ name, className }) and DOM layout (icon + greeting + tip
// bubble) are PRESERVED so Dashboard.jsx never needs to change.
//
// Motion (all subtle, all reduced-motion safe):
//   • soft breathing glow on the beacon halo
//   • slow vertical float on the orb
//   • tiny sparkle drift around the orb
//   • light shimmer along the beam edge
//
// Public contract:
//   <EduMascotGreeter name={student?.name || "Friend"} className="" />
//
// No backend / wallet / payment / referral logic touched. Pure UI swap.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useMediaQuery } from "../hooks/useMediaQuery";

const TIPS = [
  { en: "Tap a book to start reading.",   kh: "ចុចសៀវភៅដើម្បីចាប់ផ្ដើម" },
  { en: "Spin the wheel — earn points!",  kh: "បង្វិលកង់ដើម្បីយកពិន្ទុ" },
  { en: "Daily streaks unlock rewards.",  kh: "រៀនរាល់ថ្ងៃ ទទួលរង្វាន់" },
  { en: "Need help? Ask the AI Tutor.",   kh: "ត្រូវការជំនួយ? សួរគ្រូ AI" },
];

function GREET_BY_HOUR() {
  const h = new Date().getHours();
  if (h < 12) return { en: "Good morning,",   kh: "អរុណសួស្តី" };
  if (h < 18) return { en: "Good afternoon,", kh: "ទិវាសួស្តី" };
  return { en: "Good evening,", kh: "សាយ័ណ្ហសួស្តី" };
}

/* ──────────────────────────────────────────────────────────────────── */
/* LearningBeaconSvg — inline premium SVG, no external image / Lottie. */
/* ──────────────────────────────────────────────────────────────────── */
function LearningBeaconSvg({ size = 96, reduced = false, poke = 0 }) {
  // Stable, unique gradient ids per mount so multiple beacons can coexist.
  const idCover   = React.useId();
  const idPages   = React.useId();
  const idBeam    = React.useId();
  const idOrb     = React.useId();
  const idHalo    = React.useId();
  const idStar    = React.useId();
  const idShimmer = React.useId();

  return (
    <motion.svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      role="img"
      aria-label="EduHub Learning Beacon"
      data-testid="learning-beacon-svg"
      animate={poke ? { rotate: [0, -3, 3, 0], scale: [1, 1.04, 1] } : {}}
      transition={{ duration: 0.45, ease: "easeOut" }}
    >
      <defs>
        {/* Book cover — deep violet → cyan, premium glass feel */}
        <linearGradient id={idCover} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"  stopColor="#3A1F7A" />
          <stop offset="55%" stopColor="#2056C8" />
          <stop offset="100%" stopColor="#0F8FD1" />
        </linearGradient>
        {/* Pages — warm parchment */}
        <linearGradient id={idPages} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#FFF7E6" />
          <stop offset="100%" stopColor="#F0DCAE" />
        </linearGradient>
        {/* Beacon beam — vertical cyan→gold fade */}
        <linearGradient id={idBeam} x1="0%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%"  stopColor="rgba(91,208,255,0.55)" />
          <stop offset="50%" stopColor="rgba(155,92,255,0.42)" />
          <stop offset="100%" stopColor="rgba(255,214,128,0.00)" />
        </linearGradient>
        {/* Orb — radial cyan → violet, glass */}
        <radialGradient id={idOrb} cx="50%" cy="40%" r="60%">
          <stop offset="0%"  stopColor="#E8F9FF" />
          <stop offset="40%" stopColor="#5BD0FF" />
          <stop offset="100%" stopColor="#2E1D7A" />
        </radialGradient>
        {/* Halo glow */}
        <radialGradient id={idHalo} cx="50%" cy="50%" r="55%">
          <stop offset="0%"   stopColor="rgba(91,208,255,0.55)" />
          <stop offset="55%"  stopColor="rgba(155,92,255,0.18)" />
          <stop offset="100%" stopColor="rgba(155,92,255,0)" />
        </radialGradient>
        {/* Achievement star — gold */}
        <linearGradient id={idStar} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"  stopColor="#FFE6A1" />
          <stop offset="100%" stopColor="#D4A843" />
        </linearGradient>
        {/* Shimmer mask along the beam */}
        <linearGradient id={idShimmer} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"  stopColor="rgba(255,255,255,0)" />
          <stop offset="50%" stopColor="rgba(255,255,255,0.55)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </linearGradient>
      </defs>

      {/* ── Outer breathing halo ───────────────────────────────────── */}
      <motion.circle
        cx="60"
        cy="58"
        r="48"
        fill={`url(#${idHalo})`}
        animate={reduced ? {} : { opacity: [0.65, 1, 0.65], scale: [1, 1.045, 1] }}
        transition={reduced ? {} : { duration: 4.2, repeat: Infinity, ease: "easeInOut" }}
        style={{ transformOrigin: "60px 58px" }}
      />

      {/* ── Beam (upward light) ────────────────────────────────────── */}
      <g style={{ mixBlendMode: "screen" }}>
        <path
          d="M48 86 L72 86 L86 18 L34 18 Z"
          fill={`url(#${idBeam})`}
          opacity="0.95"
        />
        {/* Shimmer streak that gently slides up — reduced-motion safe */}
        <motion.rect
          x="52"
          y="20"
          width="16"
          height="64"
          rx="6"
          fill={`url(#${idShimmer})`}
          opacity="0.45"
          animate={reduced ? {} : { y: [70, -10, -10], opacity: [0, 0.55, 0] }}
          transition={reduced ? {} : { duration: 3.6, repeat: Infinity, ease: "easeInOut" }}
        />
      </g>

      {/* ── Floating gold achievement star (top-right of orb) ──────── */}
      <motion.g
        animate={reduced ? {} : { y: [0, -3, 0], rotate: [-4, 6, -4] }}
        transition={reduced ? {} : { duration: 5.0, repeat: Infinity, ease: "easeInOut" }}
        style={{ transformOrigin: "92px 36px" }}
      >
        <path
          d="M92 28 l1.8 4.2 4.6 .4 -3.5 3.0 1.0 4.5 -3.9 -2.4 -3.9 2.4 1.0 -4.5 -3.5 -3.0 4.6 -.4z"
          fill={`url(#${idStar})`}
          stroke="rgba(0,0,0,0.18)"
          strokeWidth="0.6"
          strokeLinejoin="round"
        />
      </motion.g>

      {/* ── Tiny drifting sparkles around the orb ──────────────────── */}
      {!reduced && (
        <g aria-hidden>
          {[
            { cx: 30, cy: 40, r: 1.6, d: 0.0,  yTo: -6 },
            { cx: 90, cy: 50, r: 1.4, d: 1.0,  yTo: -5 },
            { cx: 36, cy: 64, r: 1.2, d: 1.8,  yTo: -4 },
            { cx: 84, cy: 70, r: 1.5, d: 2.4,  yTo: -6 },
          ].map((s, i) => (
            <motion.circle
              key={i}
              cx={s.cx}
              cy={s.cy}
              r={s.r}
              fill="#FFE6A1"
              animate={{
                opacity: [0, 1, 0],
                y: [0, s.yTo, s.yTo],
              }}
              transition={{
                duration: 3.2 + (i % 2),
                repeat: Infinity,
                ease: "easeInOut",
                delay: s.d,
              }}
            />
          ))}
        </g>
      )}

      {/* ── Beacon orb ─────────────────────────────────────────────── */}
      <motion.g
        animate={reduced ? {} : { y: [0, -2.5, 0] }}
        transition={reduced ? {} : { duration: 3.8, repeat: Infinity, ease: "easeInOut" }}
        style={{ transformOrigin: "60px 50px" }}
      >
        <circle
          cx="60"
          cy="50"
          r="14"
          fill={`url(#${idOrb})`}
          stroke="rgba(255,255,255,0.32)"
          strokeWidth="1"
        />
        {/* Inner glass highlight */}
        <ellipse cx="56" cy="44" rx="5" ry="3.4" fill="rgba(255,255,255,0.55)" />
        {/* Inner ring */}
        <circle
          cx="60"
          cy="50"
          r="9.5"
          fill="none"
          stroke="rgba(255,255,255,0.30)"
          strokeWidth="0.8"
        />
      </motion.g>

      {/* ── Book ─ pages ───────────────────────────────────────────── */}
      <g>
        {/* Page block (parchment) */}
        <path
          d="M22 84
             C 30 78, 44 76, 60 80
             C 76 76, 90 78, 98 84
             L 98 100
             C 90 96, 76 94, 60 98
             C 44 94, 30 96, 22 100
             Z"
          fill={`url(#${idPages})`}
          stroke="rgba(0,0,0,0.20)"
          strokeWidth="1"
          strokeLinejoin="round"
        />
        {/* Spine highlight */}
        <path
          d="M60 80 L60 98"
          stroke="rgba(0,0,0,0.18)"
          strokeWidth="0.8"
        />
        {/* Faint text lines for ‘pages’ feel */}
        <g stroke="rgba(43,32,12,0.35)" strokeWidth="0.7" strokeLinecap="round">
          <path d="M30 88 L52 87" />
          <path d="M30 92 L50 91" />
          <path d="M68 87 L90 88" />
          <path d="M70 91 L90 92" />
        </g>
      </g>

      {/* ── Book cover (premium gradient) ──────────────────────────── */}
      <path
        d="M18 100
           C 30 96, 46 94, 60 98
           C 74 94, 90 96, 102 100
           L 102 108
           C 90 104, 74 102, 60 106
           C 46 102, 30 104, 18 108
           Z"
        fill={`url(#${idCover})`}
        stroke="rgba(0,0,0,0.30)"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      {/* Cover top highlight */}
      <path
        d="M22 99 C 34 96, 48 95, 60 98 C 72 95, 86 96, 98 99"
        fill="none"
        stroke="rgba(255,255,255,0.30)"
        strokeWidth="0.8"
      />
    </motion.svg>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Main exported component — keeps the same public contract as v12.    */
/* ──────────────────────────────────────────────────────────────────── */
export default function EduMascotGreeter({ name = "Friend", className = "" }) {
  const reduce = useReducedMotion();
  const isCoarse = useMediaQuery("(pointer: coarse)");
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  const [tipIdx, setTipIdx] = useState(0);
  const [poke, setPoke] = useState(0);
  const greet = useMemo(() => GREET_BY_HOUR(), []);

  // Pause animation work when off-screen.
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.2 },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);

  // Cycle tips every 7 s but ONLY when visible + tab focused.
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      setTipIdx((i) => (i + 1) % TIPS.length);
    }, 7000);
    return () => clearInterval(id);
  }, [visible]);

  const tip = TIPS[tipIdx];

  const handlePoke = () => {
    setPoke((p) => p + 1);
    setTipIdx((i) => (i + 1) % TIPS.length);
    try {
      if ("vibrate" in navigator && isCoarse) navigator.vibrate(8);
    } catch { /* ignore */ }
  };

  return (
    <div
      ref={ref}
      className={`flex items-start gap-3 sm:gap-4 ${className}`}
      data-testid="edu-mascot-greeter"
    >
      {/* ── Premium Learning Beacon — clickable for tip swap ─────── */}
      <button
        type="button"
        onClick={handlePoke}
        aria-label="Switch tip"
        data-testid="edu-mascot-poke"
        className="shrink-0 grid place-items-center rounded-2xl transition-transform active:scale-95"
        style={{
          width: 96,
          height: 96,
          padding: 4,
          background:
            "radial-gradient(120% 130% at 30% 20%, rgba(91,208,255,0.10) 0%, transparent 65%), linear-gradient(160deg, rgba(20,12,40,0.55), rgba(5,0,16,0.65))",
          border: "1px solid rgba(155,92,255,0.22)",
          boxShadow:
            "0 10px 28px rgba(5,0,16,0.45), inset 0 1px 0 rgba(255,255,255,0.06)",
        }}
      >
        <LearningBeaconSvg
          size={88}
          reduced={!visible || !!reduce}
          poke={poke}
        />
      </button>

      {/* ── Greeting + tip bubble ──────────────────────────────────── */}
      <div className="flex-1 min-w-0">
        <div
          className="relative inline-flex flex-col items-start rounded-2xl px-3.5 py-2.5 max-w-full"
          style={{
            background:
              "linear-gradient(135deg, rgba(20,12,40,0.55) 0%, rgba(5,0,16,0.55) 100%)",
            border: "1px solid rgba(155,92,255,0.22)",
            boxShadow:
              "0 8px 22px rgba(5,0,16,0.35), inset 0 1px 0 rgba(255,255,255,0.04)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
          }}
        >
          <div className="flex items-baseline flex-wrap gap-x-1.5 leading-tight">
            <span className="text-[0.95rem] sm:text-[1rem] font-extrabold text-white">
              {greet.en}
            </span>
            <span
              className="text-[0.95rem] sm:text-[1rem] font-extrabold"
              style={{
                background:
                  "linear-gradient(135deg, #5BD0FF 0%, #9b5cff 55%, #ff3da6 100%)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
              }}
              data-testid="edu-mascot-name"
            >
              {name}!
            </span>
          </div>
          <span className="font-khmer text-[0.8rem] text-white/65 mt-0.5">
            {greet.kh}, {name} 👋
          </span>
          <motion.div
            key={tipIdx}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="mt-1.5 text-[0.82rem] text-white/85 leading-snug"
            data-testid="edu-mascot-tip"
          >
            <span>{tip.en}</span>
            <span className="font-khmer text-[0.82rem] text-white/55 ml-1">
              · {tip.kh}
            </span>
          </motion.div>
          {/* Speech-bubble pointer */}
          <span
            aria-hidden
            className="absolute -left-1.5 top-5 w-3 h-3 rotate-45"
            style={{
              background:
                "linear-gradient(135deg, rgba(20,12,40,0.55) 0%, rgba(5,0,16,0.55) 100%)",
              borderLeft: "1px solid rgba(155,92,255,0.22)",
              borderBottom: "1px solid rgba(155,92,255,0.22)",
            }}
          />
        </div>
      </div>
    </div>
  );
}
