// TelegramGlyph.jsx — Premium inline Telegram paper-plane SVG.
//
// v13 (Premium Native Shell, Jan-2026) — drop-in icon used by:
//   • Header.jsx   (desktop, sm+)
//   • Sidebar.jsx  (Help & Support row)
//
// Design notes (per problem statement):
//   • Inline React SVG — no external dependency, no PNG.
//   • Clean paper-plane silhouette (no emoji-shaped flag).
//   • Cyan / blue gradient with subtle outer glow.
//   • Pure decoration — pointer-events controlled by the parent <a>/<button>.
//
// The component takes a size prop (square, in px) and an optional
// className for spacing tweaks. It NEVER controls the link itself;
// the Telegram destination is supplied by the parent <a href=…>.
import React from "react";

export default function TelegramGlyph({ size = 22, className = "", title }) {
  const gradId = React.useId();
  const glowId = React.useId();
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={className}
      role={title ? "img" : "presentation"}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : "true"}
      focusable="false"
      data-testid="telegram-glyph"
    >
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"  stopColor="#5BD0FF" />
          <stop offset="55%" stopColor="#2AA9F0" />
          <stop offset="100%" stopColor="#1582D8" />
        </linearGradient>
        <radialGradient id={glowId} cx="50%" cy="50%" r="55%">
          <stop offset="0%"  stopColor="rgba(91,208,255,0.55)" />
          <stop offset="70%" stopColor="rgba(91,208,255,0.10)" />
          <stop offset="100%" stopColor="rgba(91,208,255,0)" />
        </radialGradient>
      </defs>

      {/* Outer soft glow — premium feel, no animation */}
      <circle cx="16" cy="16" r="15.5" fill={`url(#${glowId})`} />

      {/* Glass circle background */}
      <circle
        cx="16"
        cy="16"
        r="13.5"
        fill={`url(#${gradId})`}
        stroke="rgba(255,255,255,0.22)"
        strokeWidth="0.8"
      />

      {/* Paper-plane glyph — single white shape with a folded crease */}
      <g transform="translate(7.5 8.2)">
        <path
          d="M16.3 0.55 1.05 6.45c-1.05.4-1.05 1.55 .15 1.85l3.95 1.2 1.55 4.65c.2 .6 .85 .75 1.3 .35l2.25-1.9 4.05 3
             c.65 .45 1.4 .15 1.55-.6L18.0 1.6c.2-.95-.6-1.55-1.7-1.05Z"
          fill="#FFFFFF"
          stroke="rgba(0,0,0,0.06)"
          strokeWidth="0.3"
          strokeLinejoin="round"
        />
        <path
          d="M5.15 9.5 13.85 4.0 8.0 11.05Z"
          fill="rgba(0,40,80,0.25)"
        />
      </g>
    </svg>
  );
}
