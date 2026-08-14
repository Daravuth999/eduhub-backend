/**
 * QuietLibraryArt.tsx — Portal-only hand-crafted SVG illustration set.
 *
 * Phase 1 "Quiet Library" art direction. These are PURELY presentational,
 * dependency-free inline SVGs scoped to /portal/me. They consume the
 * portal-theme.css custom properties (--color-*, --color-surface, etc.)
 * so they adapt automatically to the Daylight / Midnight palettes that
 * the global theme controller resolves. No external assets, no raster
 * images, no animation loops (static = battery/thermal friendly, matching
 * the AuroraBackdrop performance guardrail).
 *
 * Nothing here touches data, props of business components, hooks, routing,
 * audio, payment, rewards, or any protected system.
 */
import type { CSSProperties } from "react";

interface ArtProps {
  className?: string;
  style?: CSSProperties;
}

/**
 * QuietHorizonBackdrop — a calm dawn-over-the-hills editorial scene.
 * Anchored to the top of the portal surface, it gives warmth and depth
 * behind the hero without noise. Soft sun, two layered hills, a faint
 * pair of birds. All tones are derived from the active theme tokens.
 */
export function QuietHorizonBackdrop({ className, style }: ArtProps) {
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 412 440"
      preserveAspectRatio="xMidYMin slice"
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="ql-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--color-surface-2)" />
          <stop offset="1" stopColor="var(--color-bg)" />
        </linearGradient>
        <radialGradient id="ql-sun" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="var(--color-accent-warm)" stopOpacity="0.42" />
          <stop offset="0.6" stopColor="var(--color-accent-warm)" stopOpacity="0.16" />
          <stop offset="1" stopColor="var(--color-accent-warm)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* sky wash */}
      <rect width="412" height="440" fill="url(#ql-sky)" />

      {/* soft rising sun */}
      <circle cx="322" cy="104" r="118" fill="url(#ql-sun)" />
      <circle cx="322" cy="104" r="46" fill="var(--color-accent-warm)" opacity="0.30" />

      {/* distant hill */}
      <path
        d="M0 304 C 90 256, 152 296, 232 276 C 312 256, 360 290, 412 274 L412 440 L0 440 Z"
        fill="var(--color-accent)"
        opacity="0.10"
      />
      {/* nearer hill */}
      <path
        d="M0 352 C 80 324, 172 362, 252 342 C 332 322, 382 352, 412 340 L412 440 L0 440 Z"
        fill="var(--color-accent)"
        opacity="0.16"
      />

      {/* faint birds */}
      <g
        stroke="var(--color-ink-mute)"
        strokeWidth="1.4"
        fill="none"
        opacity="0.32"
        strokeLinecap="round"
      >
        <path d="M58 122 q 8 -7 16 0 q 8 -7 16 0" />
        <path d="M116 150 q 6 -5 12 0 q 6 -5 12 0" />
      </g>
    </svg>
  );
}

/**
 * LearningCompanionArt — a small stack of books with a calm potted plant.
 * Used as a quiet companion motif in the StudentHero. Decorative only.
 */
export function LearningCompanionArt({ className, style }: ArtProps) {
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 160 160"
      fill="none"
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      {/* grounding shadow */}
      <ellipse cx="78" cy="140" rx="58" ry="9" fill="var(--color-ink)" opacity="0.06" />

      {/* book stack */}
      <rect x="38" y="104" width="76" height="16" rx="3" fill="var(--color-accent-warm)" opacity="0.85" />
      <rect x="44" y="88"  width="76" height="16" rx="3" fill="var(--color-accent)"      opacity="0.90" />
      <rect x="36" y="72"  width="76" height="16" rx="3" fill="var(--color-good)"        opacity="0.85" />
      {/* page edges */}
      <line x1="40" y1="80" x2="112" y2="80" stroke="var(--color-surface)" strokeWidth="1.5" opacity="0.5" />
      <line x1="48" y1="96" x2="120" y2="96" stroke="var(--color-surface)" strokeWidth="1.5" opacity="0.5" />

      {/* potted plant */}
      <path d="M120 118 h22 l-3 20 h-16 z" fill="var(--color-accent-warm)" opacity="0.65" />
      <path
        d="M131 118 C 125 98 113 96 117 84 C 127 90 132 102 131 118"
        fill="var(--color-excellent)"
        opacity="0.85"
      />
      <path
        d="M131 118 C 136 100 148 98 146 86 C 136 90 132 104 131 118"
        fill="var(--color-excellent)"
        opacity="0.65"
      />
    </svg>
  );
}
