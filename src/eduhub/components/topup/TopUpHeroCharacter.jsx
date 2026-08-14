/**
 * TopUpHeroCharacter.jsx — hand-crafted SVG rabbit-human hero
 * ============================================================
 * • Cute scholar rabbit, premium-cartoon, glossy gold sign in paw
 * • Blinking eyes (CSS) every ~4.5 s
 * • Subtle vertical float (CSS) every ~4.2 s
 * • Right ear twitch (CSS) every ~8 s
 * • Three sparkles around the head pulse on a stagger
 * • Respects prefers-reduced-motion (animations disabled)
 * • Zero new dependency — pure inline SVG + CSS
 *
 * Mounted only by PointsPurchaseModal.jsx (PICK screen only).
 */

import "./topupHero.css";

export default function TopUpHeroCharacter({ size = 140 }) {
  return (
    <div
      data-topup-hero
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        position: "relative",
        margin: "0 auto",
        filter: "drop-shadow(0 12px 18px rgba(167,139,250,0.32)) drop-shadow(0 0 22px rgba(212,168,67,0.22))",
      }}
    >
      <svg viewBox="0 0 200 200" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <defs>
          {/* Body / head gradient */}
          <radialGradient id="furGrad" cx="50%" cy="40%" r="60%">
            <stop offset="0%"  stopColor="#fef3c7" />
            <stop offset="55%" stopColor="#fde68a" />
            <stop offset="100%" stopColor="#d4a843" />
          </radialGradient>
          {/* Ear inner */}
          <linearGradient id="earInner" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fbbf9c" />
            <stop offset="100%" stopColor="#f59e9e" />
          </linearGradient>
          {/* Cheek blush */}
          <radialGradient id="blush" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#fca5a5" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#fca5a5" stopOpacity="0" />
          </radialGradient>
          {/* Gold sign */}
          <linearGradient id="signGold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#fff3c0" />
            <stop offset="50%" stopColor="#FFE19A" />
            <stop offset="100%" stopColor="#9C7A2C" />
          </linearGradient>
        </defs>

        {/* ── Floor shadow under the rabbit ── */}
        <ellipse cx="100" cy="186" rx="46" ry="5" fill="#000" opacity="0.28" />

        {/* ── Ears ── */}
        <g>
          {/* Left ear (static) */}
          <g>
            <path
              d="M70 38 Q60 12 78 8 Q92 6 88 40 Z"
              fill="url(#furGrad)"
              stroke="#d4a843"
              strokeWidth="1.2"
            />
            <path
              d="M75 36 Q70 18 82 14 Q88 12 85 38 Z"
              fill="url(#earInner)"
            />
          </g>
          {/* Right ear (animated twitch) */}
          <g className="ear--right">
            <path
              d="M130 38 Q140 12 122 8 Q108 6 112 40 Z"
              fill="url(#furGrad)"
              stroke="#d4a843"
              strokeWidth="1.2"
            />
            <path
              d="M125 36 Q130 18 118 14 Q112 12 115 38 Z"
              fill="url(#earInner)"
            />
          </g>
        </g>

        {/* ── Head ── */}
        <ellipse cx="100" cy="78" rx="46" ry="42" fill="url(#furGrad)" stroke="#b88923" strokeWidth="1" />

        {/* Cheek blushes */}
        <ellipse cx="64"  cy="92" rx="10" ry="6" fill="url(#blush)" />
        <ellipse cx="136" cy="92" rx="10" ry="6" fill="url(#blush)" />

        {/* ── Eyes (with blinking lid) ── */}
        <g>
          {/* Left eye */}
          <circle cx="82" cy="78" r="7.5" fill="#1a1420" />
          <circle cx="84" cy="76" r="2.6" fill="#fff" />
          <rect className="eye-lid" x="73" y="70" width="18" height="9" fill="url(#furGrad)" rx="3" />
          {/* Right eye */}
          <circle cx="118" cy="78" r="7.5" fill="#1a1420" />
          <circle cx="120" cy="76" r="2.6" fill="#fff" />
          <rect className="eye-lid eye-lid--right" x="109" y="70" width="18" height="9" fill="url(#furGrad)" rx="3" />
        </g>

        {/* Glasses arc — subtle scholar accent */}
        <path
          d="M73 80 Q82 86 91 80 M109 80 Q118 86 127 80 M91 80 H109"
          fill="none" stroke="#a78bfa" strokeWidth="1.5" strokeLinecap="round" opacity="0.7"
        />

        {/* Nose + mouth */}
        <path d="M97 92 Q100 95 103 92 Q100 96 97 92 Z" fill="#7c2d12" />
        <path
          d="M97 96 Q100 100 103 96 M100 99 Q98 102 96 101 M100 99 Q102 102 104 101"
          fill="none" stroke="#7c2d12" strokeWidth="1.3" strokeLinecap="round"
        />

        {/* Whiskers */}
        <g stroke="#fff" strokeOpacity="0.7" strokeWidth="0.9" strokeLinecap="round">
          <line x1="55" y1="94"  x2="74"  y2="96" />
          <line x1="55" y1="98"  x2="74"  y2="98" />
          <line x1="145" y1="94" x2="126" y2="96" />
          <line x1="145" y1="98" x2="126" y2="98" />
        </g>

        {/* ── Body (peeking) ── */}
        <path
          d="M62 132 Q100 118 138 132 L138 168 Q100 178 62 168 Z"
          fill="url(#furGrad)" stroke="#b88923" strokeWidth="1"
        />
        {/* Belly */}
        <path
          d="M78 138 Q100 132 122 138 L122 162 Q100 168 78 162 Z"
          fill="#fff7e2"
        />

        {/* ── Premium gold sign held in front ── */}
        <g className="sign" transform="translate(56 122)">
          <rect
            x="0" y="0" width="88" height="42" rx="12"
            fill="url(#signGold)"
            stroke="#9C7A2C" strokeWidth="1.4"
          />
          {/* Inner shine */}
          <rect x="3" y="3" width="82" height="36" rx="10" fill="none"
                stroke="#fff7e2" strokeOpacity="0.65" strokeWidth="0.6" />
          {/* Riel symbol "៛" — drawn as a glyph so it always renders */}
          <text
            x="44" y="29" textAnchor="middle"
            fontFamily="'Noto Sans Khmer', 'Kantumruy Pro', system-ui, sans-serif"
            fontWeight="800" fontSize="22"
            fill="#1a1420"
          >៛</text>
          {/* Coin disc on the left */}
          <circle cx="14" cy="21" r="9" fill="#1a1420" opacity="0.12" />
          <circle cx="14" cy="21" r="7"
                  fill="url(#signGold)" stroke="#9C7A2C" strokeWidth="0.6" />
          <text x="14" y="24" textAnchor="middle"
                fontFamily="ui-monospace, 'SF Mono', Menlo, monospace"
                fontSize="8" fontWeight="800" fill="#1a1420">$</text>
        </g>

        {/* ── Sparkles around the head ── */}
        <g>
          <g className="sparkle"        transform="translate(40 50)">
            <path d="M0 -7 L1.5 -1.5 L7 0 L1.5 1.5 L0 7 L-1.5 1.5 L-7 0 L-1.5 -1.5 Z" fill="#FFE19A" />
          </g>
          <g className="sparkle sparkle--2" transform="translate(160 60)">
            <path d="M0 -5 L1 -1 L5 0 L1 1 L0 5 L-1 1 L-5 0 L-1 -1 Z" fill="#a78bfa" />
          </g>
          <g className="sparkle sparkle--3" transform="translate(150 28)">
            <path d="M0 -4 L0.8 -0.8 L4 0 L0.8 0.8 L0 4 L-0.8 0.8 L-4 0 L-0.8 -0.8 Z" fill="#5eead4" />
          </g>
        </g>
      </svg>
    </div>
  );
}
