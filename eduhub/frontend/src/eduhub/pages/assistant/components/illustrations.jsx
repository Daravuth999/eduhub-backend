// illustrations.jsx — original SVG mascots and category emblems for
// the AI Assistant "Toy Console" redesign.
//
// All artwork here is hand-authored SVG. No external assets, no icon
// font glyphs as primary identity, and no purple-on-white slop. Each
// component accepts a `size` prop (default 56) plus optional className
// so it can be reused inside CategoryCard, MissionCard, the paused-
// state emblem, and the hero coach orb.
//
// IMPORTANT: these illustrations are PRESENTATIONAL ONLY. They never
// reach into AuthContext, API helpers, or chat state. Safe to import
// from anywhere in the Assistant page tree.

import React from "react";

function box(size) {
  const s = Number(size) || 56;
  return { width: s, height: s, viewBox: "0 0 64 64" };
}

/* ── Shared plastic shadow + soft gradient defs ─────────────────── */
function Defs({ id, from, to }) {
  return (
    <defs>
      <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor={from} stopOpacity="0.95" />
        <stop offset="100%" stopColor={to} stopOpacity="0.95" />
      </linearGradient>
      <radialGradient id={`${id}-hl`} cx="0.3" cy="0.25" r="0.7">
        <stop offset="0%" stopColor="#ffffff" stopOpacity="0.35" />
        <stop offset="60%" stopColor="#ffffff" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

/* ── Coach mascot orb — replaces the conic-gradient + Bot icon ──── */
export function CoachOrbSvg({ size = 56, className = "" }) {
  return (
    <svg {...box(size)} className={className} aria-hidden="true">
      <Defs id="orb" from="#00e0ff" to="#ff3da6" />
      <defs>
        <linearGradient id="orb-mid" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#9b5cff" />
          <stop offset="100%" stopColor="#ff3da6" />
        </linearGradient>
      </defs>
      {/* outer halo */}
      <circle cx="32" cy="32" r="28" fill="url(#orb-g)" opacity="0.25" />
      {/* main body */}
      <circle cx="32" cy="32" r="22" fill="url(#orb-mid)" />
      <circle cx="32" cy="32" r="22" fill="url(#orb-hl)" />
      {/* friendly face */}
      <circle cx="25" cy="29" r="2.6" fill="#0a0218" />
      <circle cx="39" cy="29" r="2.6" fill="#0a0218" />
      <path
        d="M24 38 Q32 44 40 38"
        stroke="#0a0218"
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
      />
      {/* antenna sparkle */}
      <circle cx="32" cy="10" r="2.2" fill="#ffd24d" />
      <path d="M32 12 L32 16" stroke="#ffd24d" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/* ── Grammar — open book with bookmark ──────────────────────────── */
export function GrammarBookSvg({ size = 56, className = "" }) {
  return (
    <svg {...box(size)} className={className} aria-hidden="true">
      <Defs id="gbook" from="#00e0ff" to="#5a8cff" />
      <rect x="8" y="14" width="48" height="40" rx="6" fill="url(#gbook-g)" />
      <rect x="8" y="14" width="48" height="40" rx="6" fill="url(#gbook-hl)" />
      <path d="M32 18 L32 50" stroke="#0a0218" strokeWidth="2" opacity="0.35" />
      <path d="M14 24 H28 M14 30 H26 M14 36 H28 M14 42 H24" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" opacity="0.8" />
      <path d="M36 24 H50 M36 30 H48 M36 36 H50 M36 42 H46" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" opacity="0.8" />
      <path d="M44 14 L44 28 L48 24 L52 28 L52 14 Z" fill="#ff3da6" />
    </svg>
  );
}

/* ── Writing — pencil on note ───────────────────────────────────── */
export function WritingPencilSvg({ size = 56, className = "" }) {
  return (
    <svg {...box(size)} className={className} aria-hidden="true">
      <Defs id="wpen" from="#9b5cff" to="#c084ff" />
      <rect x="10" y="12" width="38" height="44" rx="5" fill="url(#wpen-g)" />
      <rect x="10" y="12" width="38" height="44" rx="5" fill="url(#wpen-hl)" />
      <path d="M16 22 H42 M16 30 H38 M16 38 H40 M16 46 H32" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" opacity="0.8" />
      {/* pencil */}
      <g transform="rotate(35 46 32)">
        <rect x="40" y="14" width="8" height="34" rx="2" fill="#ffd24d" />
        <polygon points="40,48 44,56 48,48" fill="#0a0218" />
        <polygon points="40,48 44,53 48,48" fill="#ff3da6" />
        <rect x="40" y="14" width="8" height="4" fill="#ff3da6" />
      </g>
    </svg>
  );
}

/* ── Speaking — chunky retro mic ────────────────────────────────── */
export function SpeakingMicSvg({ size = 56, className = "" }) {
  return (
    <svg {...box(size)} className={className} aria-hidden="true">
      <Defs id="smic" from="#ff3da6" to="#ff7ac0" />
      <rect x="24" y="10" width="16" height="28" rx="8" fill="url(#smic-g)" />
      <rect x="24" y="10" width="16" height="28" rx="8" fill="url(#smic-hl)" />
      <path d="M20 32 Q20 44 32 44 Q44 44 44 32" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" opacity="0.9" />
      <rect x="30" y="44" width="4" height="8" fill="#fff" opacity="0.9" />
      <rect x="22" y="50" width="20" height="3" rx="1.5" fill="#fff" opacity="0.9" />
      {/* mic grill */}
      <path d="M27 18 H37 M27 23 H37 M27 28 H37" stroke="#0a0218" strokeWidth="1.2" opacity="0.45" />
    </svg>
  );
}

/* ── Vocabulary — dictionary tile w/ globe ──────────────────────── */
export function VocabDictSvg({ size = 56, className = "" }) {
  return (
    <svg {...box(size)} className={className} aria-hidden="true">
      <Defs id="vdict" from="#ffc400" to="#ffa030" />
      <rect x="10" y="10" width="44" height="44" rx="7" fill="url(#vdict-g)" />
      <rect x="10" y="10" width="44" height="44" rx="7" fill="url(#vdict-hl)" />
      <circle cx="32" cy="32" r="14" fill="none" stroke="#0a0218" strokeWidth="2" opacity="0.55" />
      <ellipse cx="32" cy="32" rx="6" ry="14" fill="none" stroke="#0a0218" strokeWidth="1.6" opacity="0.55" />
      <path d="M18 32 H46" stroke="#0a0218" strokeWidth="1.6" opacity="0.55" />
      <text x="32" y="52" textAnchor="middle" fontSize="9" fontWeight="800" fill="#0a0218" opacity="0.7">A→Z</text>
    </svg>
  );
}

/* ── IELTS — mortarboard ────────────────────────────────────────── */
export function IeltsCapSvg({ size = 56, className = "" }) {
  return (
    <svg {...box(size)} className={className} aria-hidden="true">
      <Defs id="icap" from="#50dca0" to="#7af2c4" />
      <polygon points="32,12 58,24 32,36 6,24" fill="url(#icap-g)" />
      <polygon points="32,12 58,24 32,36 6,24" fill="url(#icap-hl)" />
      <path d="M14 28 V40 Q14 48 32 48 Q50 48 50 40 V28" fill="none" stroke="#0a0218" strokeWidth="2.2" opacity="0.55" />
      <path d="M52 26 V42" stroke="#ffd24d" strokeWidth="2" strokeLinecap="round" />
      <circle cx="52" cy="44" r="3" fill="#ff3da6" />
    </svg>
  );
}

/* ── Pronunciation — soundwave / speaker ────────────────────────── */
export function PronounceWaveSvg({ size = 56, className = "" }) {
  return (
    <svg {...box(size)} className={className} aria-hidden="true">
      <Defs id="pwave" from="#78b4ff" to="#9b5cff" />
      <polygon points="10,26 22,26 34,16 34,48 22,38 10,38" fill="url(#pwave-g)" />
      <polygon points="10,26 22,26 34,16 34,48 22,38 10,38" fill="url(#pwave-hl)" />
      <path d="M40 22 Q46 32 40 42" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      <path d="M46 18 Q56 32 46 46" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" opacity="0.8" />
      <path d="M52 14 Q66 32 52 50" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" opacity="0.5" />
    </svg>
  );
}

/* ── Shield emblem for paused / locked states ───────────────────── */
export function PausedShieldSvg({ size = 56, className = "" }) {
  return (
    <svg {...box(size)} className={className} aria-hidden="true">
      <Defs id="pshd" from="#ffb650" to="#ff8a3d" />
      <path
        d="M32 6 L54 14 V32 Q54 48 32 58 Q10 48 10 32 V14 Z"
        fill="url(#pshd-g)"
      />
      <path
        d="M32 6 L54 14 V32 Q54 48 32 58 Q10 48 10 32 V14 Z"
        fill="url(#pshd-hl)"
      />
      <rect x="26" y="24" width="4" height="14" rx="1.4" fill="#0a0218" />
      <rect x="34" y="24" width="4" height="14" rx="1.4" fill="#0a0218" />
    </svg>
  );
}

/* ── Speech-Missions badge (used on segmented tab and locked card) */
export function SpeechMissionsBadgeSvg({ size = 56, className = "" }) {
  return (
    <svg {...box(size)} className={className} aria-hidden="true">
      <Defs id="smb" from="#ff3da6" to="#9b5cff" />
      <circle cx="32" cy="32" r="26" fill="url(#smb-g)" />
      <circle cx="32" cy="32" r="26" fill="url(#smb-hl)" />
      <rect x="26" y="18" width="12" height="22" rx="6" fill="#fff" />
      <path d="M20 30 Q20 42 32 42 Q44 42 44 30" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      <rect x="30" y="42" width="4" height="6" fill="#fff" />
      <rect x="24" y="48" width="16" height="3" rx="1.5" fill="#fff" />
    </svg>
  );
}

/* ── Map category key → illustration component ──────────────────── */
export const CATEGORY_ILLUSTRATION = {
  grammar: GrammarBookSvg,
  writing: WritingPencilSvg,
  speaking: SpeakingMicSvg,
  vocab: VocabDictSvg,
  ielts: IeltsCapSvg,
  pronounce: PronounceWaveSvg,
};
