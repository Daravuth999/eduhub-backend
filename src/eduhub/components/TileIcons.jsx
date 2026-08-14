import React from "react";
import { motion } from "framer-motion";

/**
 * TileIcons.jsx — 8 animated SVG icons drawn in the same chunky 3D style
 * as the iOS App Store category illustrations. Each accepts an `active`
 * prop (truthy → animate, falsy → freeze) and `pressed` prop (counter
 * that triggers a brief energetic burst).
 *
 * All icons use only transform/opacity → GPU-cheap, no filters.
 */

const idle = (active, base = {}) => ({
  ...base,
  transition: active
    ? { repeat: Infinity, repeatType: "reverse", duration: 2.4, ease: "easeInOut" }
    : { duration: 0 },
});

const burstScale = { scale: [1, 1.18, 1], rotate: [0, -10, 8, 0] };

/* 1. Library — open book with flipping page */
export function BookIcon({ active, pressed }) {
  return (
    <svg viewBox="0 0 100 100" width="88" height="88" aria-hidden>
      <defs>
        <linearGradient id="bk-cover" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#fff" />
          <stop offset="100%" stopColor="#e6f0fa" />
        </linearGradient>
      </defs>
      <motion.g
        animate={pressed ? burstScale : { y: active ? [0, -3, 0] : 0 }}
        transition={pressed ? { duration: 0.5 } : idle(active).transition}
      >
        {/* Back cover */}
        <rect x="20" y="36" width="60" height="42" rx="5" fill="#5a98e8" />
        {/* Pages */}
        <rect x="22" y="38" width="56" height="38" rx="3" fill="url(#bk-cover)" />
        {/* Center spine */}
        <line x1="50" y1="38" x2="50" y2="76" stroke="#bcd3ee" strokeWidth="1.4" />
        {/* Flipping page */}
        <motion.path
          d="M50 38 Q66 36 76 44 L76 70 Q66 74 50 76 Z"
          fill="#fff"
          stroke="#cfdef0"
          strokeWidth="0.8"
          style={{ transformOrigin: "50px 57px" }}
          animate={active ? { rotateY: [0, -55, 0] } : { rotateY: 0 }}
          transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
        />
        {/* Lines on left page */}
        <g stroke="#a9c1da" strokeWidth="1" strokeLinecap="round">
          <line x1="28" y1="46" x2="46" y2="46" />
          <line x1="28" y1="52" x2="44" y2="52" />
          <line x1="28" y1="58" x2="46" y2="58" />
          <line x1="28" y1="64" x2="42" y2="64" />
        </g>
      </motion.g>
    </svg>
  );
}

/* 2. Portal — chart bars rising on a podium */
export function ChartIcon({ active, pressed }) {
  const bars = [
    { x: 28, h: 22, fill: "#a78bff" },
    { x: 44, h: 36, fill: "#7c5cff" },
    { x: 60, h: 28, fill: "#9379ff" },
  ];
  return (
    <svg viewBox="0 0 100 100" width="88" height="88" aria-hidden>
      <motion.g
        animate={pressed ? burstScale : {}}
        transition={{ duration: 0.5 }}
      >
        {/* Podium base */}
        <ellipse cx="50" cy="78" rx="32" ry="6" fill="#3a2a82" opacity="0.35" />
        <rect x="18" y="70" width="64" height="10" rx="3" fill="#fff" />
        {/* Bars */}
        {bars.map((b, i) => (
          <motion.rect
            key={i}
            x={b.x}
            y={70 - b.h}
            width="10"
            height={b.h}
            rx="2"
            fill={b.fill}
            initial={{ scaleY: 0 }}
            animate={{ scaleY: active ? [0.6, 1, 0.85, 1] : 1 }}
            style={{ transformOrigin: `${b.x + 5}px 70px` }}
            transition={{ duration: 2.2, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
          />
        ))}
        {/* Star on top */}
        <motion.path
          d="M50 22 L52.5 28 L59 28.6 L54 33 L55.6 39.4 L50 36.2 L44.4 39.4 L46 33 L41 28.6 L47.5 28 Z"
          fill="#ffd86b"
          stroke="#e8a800"
          strokeWidth="0.6"
          animate={active ? { rotate: [0, 10, -10, 0] } : { rotate: 0 }}
          style={{ transformOrigin: "50px 30px" }}
          transition={{ duration: 2.4, repeat: Infinity }}
        />
      </motion.g>
    </svg>
  );
}

/* 3. Lucky Spin — coin with star burst */
export function CoinIcon({ active, pressed }) {
  return (
    <svg viewBox="0 0 100 100" width="88" height="88" aria-hidden>
      <motion.g
        animate={pressed ? burstScale : { rotate: active ? [0, 360] : 0 }}
        style={{ transformOrigin: "50px 50px" }}
        transition={pressed ? { duration: 0.5 } : { duration: 6, repeat: Infinity, ease: "linear" }}
      >
        {/* Sparkles */}
        {[0, 60, 120, 180, 240, 300].map((deg, i) => (
          <motion.circle
            key={i}
            cx={50 + 36 * Math.cos((deg * Math.PI) / 180)}
            cy={50 + 36 * Math.sin((deg * Math.PI) / 180)}
            r="2.4"
            fill="#fff7c2"
            animate={{ opacity: active ? [0.3, 1, 0.3] : 0.6 }}
            transition={{ duration: 1.6, repeat: Infinity, delay: i * 0.18 }}
          />
        ))}
        {/* Coin */}
        <circle cx="50" cy="50" r="26" fill="#ffd86b" stroke="#e8a800" strokeWidth="2" />
        <circle cx="50" cy="50" r="20" fill="#ffe793" />
        {/* Dollar/Star */}
        <path
          d="M50 36 L53 47 L64 47 L55 53.5 L58 65 L50 58 L42 65 L45 53.5 L36 47 L47 47 Z"
          fill="#e8a800"
        />
      </motion.g>
    </svg>
  );
}

/* 4. AI Tutor — chat bubble bot */
export function BotIcon({ active, pressed }) {
  return (
    <svg viewBox="0 0 100 100" width="88" height="88" aria-hidden>
      <motion.g
        animate={pressed ? burstScale : { y: active ? [0, -2, 0] : 0 }}
        transition={pressed ? { duration: 0.5 } : { duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
      >
        {/* Antenna */}
        <line x1="50" y1="22" x2="50" y2="32" stroke="#1a4d3a" strokeWidth="2" strokeLinecap="round" />
        <motion.circle
          cx="50" cy="20" r="3"
          fill="#ffd86b"
          animate={active ? { scale: [1, 1.4, 1] } : { scale: 1 }}
          style={{ transformOrigin: "50px 20px" }}
          transition={{ duration: 1.2, repeat: Infinity }}
        />
        {/* Body */}
        <rect x="22" y="32" width="56" height="42" rx="14" fill="#fff" stroke="#37a877" strokeWidth="2" />
        {/* Eyes */}
        <motion.g animate={active ? { scaleY: [1, 1, 0.1, 1, 1] } : {}}
                  style={{ transformOrigin: "50px 50px" }}
                  transition={{ duration: 3, times: [0,0.92,0.95,0.98,1], repeat: Infinity }}>
          <circle cx="38" cy="50" r="4" fill="#1a4d3a" />
          <circle cx="62" cy="50" r="4" fill="#1a4d3a" />
          <circle cx="39" cy="48.5" r="1.2" fill="#fff" />
          <circle cx="63" cy="48.5" r="1.2" fill="#fff" />
        </motion.g>
        {/* Mouth */}
        <path d="M42 62 Q50 67 58 62" stroke="#1a4d3a" strokeWidth="2" fill="none" strokeLinecap="round" />
        {/* Side ears */}
        <rect x="14" y="44" width="6" height="14" rx="3" fill="#37a877" />
        <rect x="80" y="44" width="6" height="14" rx="3" fill="#37a877" />
      </motion.g>
    </svg>
  );
}

/* 5. Speaking Test — microphone with sound waves */
export function MicIcon({ active, pressed }) {
  return (
    <svg viewBox="0 0 100 100" width="88" height="88" aria-hidden>
      <motion.g animate={pressed ? burstScale : {}} transition={{ duration: 0.5 }}>
        {/* Sound waves */}
        {[0, 1, 2].map((i) => (
          <motion.path
            key={i}
            d={`M${22 - i * 4} ${42 + i * 4} Q${18 - i * 6} 50 ${22 - i * 4} ${58 - i * 4}`}
            stroke="#f59c2e"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            animate={{ opacity: active ? [0.2, 1, 0.2] : 0.5 }}
            transition={{ duration: 1.6, repeat: Infinity, delay: i * 0.15 }}
          />
        ))}
        {[0, 1, 2].map((i) => (
          <motion.path
            key={`r${i}`}
            d={`M${78 + i * 4} ${42 + i * 4} Q${82 + i * 6} 50 ${78 + i * 4} ${58 - i * 4}`}
            stroke="#f59c2e"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            animate={{ opacity: active ? [0.2, 1, 0.2] : 0.5 }}
            transition={{ duration: 1.6, repeat: Infinity, delay: i * 0.15 + 0.3 }}
          />
        ))}
        {/* Mic body */}
        <rect x="40" y="24" width="20" height="36" rx="10" fill="#fff" stroke="#b85e00" strokeWidth="2" />
        <line x1="42" y1="32" x2="58" y2="32" stroke="#ffb368" strokeWidth="1.5" />
        <line x1="42" y1="40" x2="58" y2="40" stroke="#ffb368" strokeWidth="1.5" />
        <line x1="42" y1="48" x2="58" y2="48" stroke="#ffb368" strokeWidth="1.5" />
        {/* Stand */}
        <path d="M30 56 Q30 72 50 72 Q70 72 70 56" stroke="#b85e00" strokeWidth="3" fill="none" />
        <line x1="50" y1="72" x2="50" y2="82" stroke="#b85e00" strokeWidth="3" />
        <line x1="40" y1="82" x2="60" y2="82" stroke="#b85e00" strokeWidth="3" strokeLinecap="round" />
      </motion.g>
    </svg>
  );
}

/* 6. Top 5 — trophy bouncing */
export function TrophyIcon({ active, pressed }) {
  return (
    <svg viewBox="0 0 100 100" width="88" height="88" aria-hidden>
      <motion.g
        animate={pressed ? burstScale : { y: active ? [0, -4, 0] : 0, rotate: active ? [0, 5, -5, 0] : 0 }}
        style={{ transformOrigin: "50px 70px" }}
        transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
      >
        {/* Handles */}
        <path d="M28 32 Q14 32 14 48 Q14 60 30 60" stroke="#e2649c" strokeWidth="3" fill="none" />
        <path d="M72 32 Q86 32 86 48 Q86 60 70 60" stroke="#e2649c" strokeWidth="3" fill="none" />
        {/* Cup */}
        <path d="M28 26 L72 26 L68 56 Q60 62 50 62 Q40 62 32 56 Z" fill="#ffd86b" stroke="#e8a800" strokeWidth="2" />
        {/* Star */}
        <path d="M50 34 L52.5 41 L60 41.6 L54 46 L55.6 53.4 L50 49.8 L44.4 53.4 L46 46 L40 41.6 L47.5 41 Z" fill="#fff" />
        {/* Stem + base */}
        <rect x="44" y="62" width="12" height="8" fill="#e8a800" />
        <rect x="34" y="70" width="32" height="6" rx="2" fill="#a8456e" />
      </motion.g>
    </svg>
  );
}

/* 7. Notifications — bell with clapper */
export function BellIcon({ active, pressed }) {
  return (
    <svg viewBox="0 0 100 100" width="88" height="88" aria-hidden>
      <motion.g
        style={{ transformOrigin: "50px 30px" }}
        animate={pressed ? burstScale : { rotate: active ? [-12, 12, -8, 8, 0] : 0 }}
        transition={pressed ? { duration: 0.5 } : { duration: 1.4, repeat: Infinity, repeatDelay: 1.8 }}
      >
        <path d="M30 60 Q30 32 50 30 Q70 32 70 60 L74 66 L26 66 Z" fill="#fff" stroke="#0a4a5a" strokeWidth="2" />
        <rect x="46" y="22" width="8" height="8" rx="2" fill="#0a4a5a" />
        <ellipse cx="50" cy="72" rx="6" ry="3" fill="#0a4a5a" />
      </motion.g>
      {/* Sound waves */}
      {[0, 1].map((i) => (
        <motion.circle
          key={i}
          cx="50" cy="50" r={28 + i * 8}
          fill="none"
          stroke="#0a4a5a"
          strokeWidth="1.5"
          opacity="0.35"
          animate={active ? { scale: [0.8, 1.2], opacity: [0.45, 0] } : {}}
          style={{ transformOrigin: "50px 50px" }}
          transition={{ duration: 1.8, repeat: Infinity, delay: i * 0.4 }}
        />
      ))}
    </svg>
  );
}

/* 8. Studio — pencil writing */
export function PencilIcon({ active, pressed }) {
  return (
    <svg viewBox="0 0 100 100" width="88" height="88" aria-hidden>
      <motion.g
        animate={pressed ? burstScale : { x: active ? [-2, 2, -2] : 0, y: active ? [2, -2, 2] : 0 }}
        transition={pressed ? { duration: 0.5 } : { duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
      >
        {/* Page */}
        <rect x="14" y="20" width="58" height="60" rx="4" fill="#fff" stroke="#3a5e0a" strokeWidth="1.5" />
        {/* Lines */}
        <motion.g stroke="#a8c878" strokeWidth="1.5" strokeLinecap="round">
          <motion.line x1="22" y1="32" x2="60" y2="32"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: active ? [0, 1] : 1 }}
            transition={{ duration: 1.4, repeat: Infinity, repeatType: "reverse" }} />
          <motion.line x1="22" y1="42" x2="56" y2="42"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: active ? [0, 1] : 1 }}
            transition={{ duration: 1.4, repeat: Infinity, repeatType: "reverse", delay: 0.2 }} />
          <motion.line x1="22" y1="52" x2="58" y2="52"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: active ? [0, 1] : 1 }}
            transition={{ duration: 1.4, repeat: Infinity, repeatType: "reverse", delay: 0.4 }} />
          <motion.line x1="22" y1="62" x2="50" y2="62"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: active ? [0, 1] : 1 }}
            transition={{ duration: 1.4, repeat: Infinity, repeatType: "reverse", delay: 0.6 }} />
        </motion.g>
        {/* Pencil */}
        <g style={{ transform: "translate(58px, 14px) rotate(35deg)" }}>
          <rect x="0" y="0" width="6" height="38" fill="#ffd86b" />
          <polygon points="0,38 6,38 3,46" fill="#3a3a3a" />
          <rect x="0" y="0" width="6" height="6" fill="#e2649c" />
        </g>
      </motion.g>
    </svg>
  );
}

// TreasureIcon — original Voice Treasure mark (a glowing chest + sound spark).
// No copyrighted characters or assets.
export function TreasureIcon({ active, pressed }) {
  return (
    <svg viewBox="0 0 100 100" width="88" height="88" aria-hidden>
      <motion.g animate={pressed ? burstScale : {}} transition={{ duration: 0.5 }}>
        {/* chest base */}
        <rect x="24" y="46" width="52" height="30" rx="6" fill="#7c5cff" />
        <rect x="24" y="40" width="52" height="16" rx="8" fill="#9a6cff" />
        {/* lid band + lock */}
        <rect x="24" y="54" width="52" height="6" fill="#ffce6b" />
        <rect x="46" y="52" width="8" height="12" rx="2" fill="#ffe19a" />
        {/* glow sparks */}
        {[0, 1, 2].map((i) => (
          <motion.circle
            key={i}
            cx={36 + i * 14}
            cy={36}
            r="2.5"
            fill="#46e0ff"
            animate={{ opacity: active ? [0.2, 1, 0.2] : 0.6, cy: active ? [36, 30, 36] : 36 }}
            transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.18 }}
          />
        ))}
      </motion.g>
    </svg>
  );
}
