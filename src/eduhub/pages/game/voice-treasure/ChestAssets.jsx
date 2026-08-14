/**
 * ChestAssets.jsx — original layered-SVG chest family. ONE reusable
 * geometry tree drives every chest state via the `data-state` attribute on
 * the .vt-chest-stage wrapper. CSS keyframes in VoiceTreasure.css animate
 * the sequence: hover → glow → latch jiggle → lid lift → rays → particles
 * → card emergence → confirmed reward. The component itself NEVER triggers
 * a backend claim; it is purely presentational.
 */
import { firstVoiceCard } from "./chestAssets";

export function ChestSVG({ state = "sealed", testId = "vt-chest-svg" }) {
  // Allowed state attribute set. Anything unknown collapses to "sealed".
  const safe = [
    "sealed", "glowing", "processing", "reconciliation_required",
    "opening", "completed", "confirmed_failed", "ineligible",
  ].includes(state) ? state : "sealed";

  return (
    <div className="vt-chest-stage" data-state={safe} data-testid={testId}>
      {/* Golden rays — only visible at opening / completed. */}
      <svg className="vt-rays" viewBox="0 0 220 220" aria-hidden="true">
        <defs>
          <radialGradient id="vt-rays-g" cx="50%" cy="62%" r="60%">
            <stop offset="0%"  stopColor="#ffe7a4" stopOpacity="0.95" />
            <stop offset="60%" stopColor="#ffc94d" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#ffc94d" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="110" cy="130" r="100" fill="url(#vt-rays-g)" />
        {[...Array(14)].map((_, i) => {
          const a = (i * (360 / 14)) * (Math.PI / 180);
          const x2 = 110 + Math.cos(a - Math.PI / 2) * 110;
          const y2 = 130 + Math.sin(a - Math.PI / 2) * 110;
          return <line key={i} x1="110" y1="130" x2={x2} y2={y2} stroke="#ffe19a" strokeOpacity="0.55" strokeWidth="2" />;
        })}
      </svg>

      {/* Particles — only visible during the opening sequence. */}
      <svg className="vt-particles" viewBox="0 0 220 220" aria-hidden="true">
        {[
          [60, 110], [80, 80], [110, 70], [140, 80], [160, 110],
          [70, 140], [150, 140], [95, 95], [125, 95], [110, 100],
        ].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={i % 2 ? 3 : 2.2} fill={i % 3 ? "#ffe19a" : "#6ad6ff"} opacity="0.9" />
        ))}
      </svg>

      {/* Chest body. */}
      <svg viewBox="0 0 220 220" aria-hidden="true">
        <defs>
          <linearGradient id="vt-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a06438" />
            <stop offset="55%" stopColor="#7b4423" />
            <stop offset="100%" stopColor="#4b2912" />
          </linearGradient>
          <linearGradient id="vt-lid-g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#b87545" />
            <stop offset="100%" stopColor="#7b4423" />
          </linearGradient>
          <linearGradient id="vt-gold" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffe19a" />
            <stop offset="55%" stopColor="#d4a843" />
            <stop offset="100%" stopColor="#8e6a1c" />
          </linearGradient>
        </defs>

        {/* Shadow */}
        <ellipse cx="110" cy="200" rx="80" ry="8" fill="#000" opacity="0.45" />

        {/* Body */}
        <path d="M34 110 H186 V186 a12 12 0 0 1 -12 12 H46 a12 12 0 0 1 -12 -12 Z" fill="url(#vt-body)" />
        {/* Bands */}
        <rect x="34" y="118" width="152" height="6" fill="#3a2210" />
        <rect x="34" y="170" width="152" height="6" fill="#3a2210" />
        <rect x="38" y="120" width="6" height="60" fill="#3a2210" />
        <rect x="176" y="120" width="6" height="60" fill="#3a2210" />
        {/* Hinges */}
        <circle cx="46" cy="106" r="5" fill="url(#vt-gold)" />
        <circle cx="174" cy="106" r="5" fill="url(#vt-gold)" />

        {/* Reward card emerges from inside the chest BEFORE the lid graphic in z-order so the lid can cover it when closed. */}
        <g className="vt-card">
          <rect x="78" y="60" width="64" height="86" rx="10" fill="#1d2356" stroke="url(#vt-gold)" strokeWidth="2.5" />
          <circle cx="110" cy="98" r="18" fill="none" stroke="url(#vt-gold)" strokeWidth="2.5" />
          <path d="M110 86 v20 M99 94 a11 11 0 0 0 22 0" fill="none" stroke="#ffe19a" strokeWidth="3" strokeLinecap="round" />
        </g>

        {/* Lid */}
        <g className="vt-lid">
          <path d="M34 110 a76 60 0 0 1 152 0 Z" fill="url(#vt-lid-g)" />
          <path d="M34 110 a76 60 0 0 1 152 0" fill="none" stroke="#3a2210" strokeWidth="4" />
          {/* Lock plate */}
          <rect x="98" y="92" width="24" height="22" rx="3" fill="url(#vt-gold)" stroke="#5a3e0e" strokeWidth="1.5" />
          {/* Latch (animated) */}
          <g className="vt-latch">
            <rect x="103" y="92" width="14" height="18" rx="3" fill="#ffe7a4" stroke="#5a3e0e" strokeWidth="1.2" />
          </g>
        </g>
      </svg>

      {/* Confirmed reward sticker (only meaningful at state=completed). */}
      <svg className="vt-card" viewBox="0 0 220 220" aria-hidden="true">
        <text x="110" y="62" textAnchor="middle" fontSize="11"
              fill="#ffe19a" style={{ letterSpacing: "0.08em" }}>FIRST VOICE CARD</text>
      </svg>
    </div>
  );
}

export function FirstVoiceCardMark({ size = 120, testId = "vt-first-voice-card-mark" }) {
  return (
    <img
      src={firstVoiceCard}
      alt="First Voice Card collectible"
      draggable="false"
      width={size} height={size * 1.5}
      data-testid={testId}
      style={{ borderRadius: 14, boxShadow: "0 12px 28px rgba(0,0,0,0.45)" }}
    />
  );
}

export default ChestSVG;
