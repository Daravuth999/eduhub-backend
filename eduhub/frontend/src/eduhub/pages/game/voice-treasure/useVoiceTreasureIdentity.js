/**
 * useVoiceTreasureIdentity.js
 *
 * Sets the document title and renders the Voice Treasure identity header
 * inside every Voice Treasure screen so the game can NEVER appear as
 * "Lucky Spin" inside its own routes. This is purely a presentational
 * override; the actual Lucky Spin feature and the global bottom-nav
 * architecture are NOT modified. If Voice Treasure must technically remain
 * under the Spin nav category, the identity header below makes the
 * student-facing identity unambiguous.
 */
import { useEffect } from "react";

export function useVoiceTreasureTitle(suffix) {
  useEffect(() => {
    const prev = document.title;
    document.title = suffix ? `Voice Treasure · ${suffix}` : "Voice Treasure";
    return () => { document.title = prev; };
  }, [suffix]);
}

/**
 * Pass B.2 — replace the primary 🎙️ emoji identity with an original
 * hand-authored SVG (treasure key crossed with a microphone). No external
 * artwork, no Lottie fabrication. Lucide is available but the identity
 * mark is intentionally bespoke so the brand is not stock-iconified.
 */
function VoiceTreasureIdentityMark() {
  return (
    <svg
      width="38"
      height="38"
      viewBox="0 0 40 40"
      role="img"
      aria-hidden="true"
      data-testid="vt-identity-mark"
      style={{ display: "block" }}
    >
      <defs>
        <linearGradient id="vt-id-bg" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6ad6ff" />
          <stop offset="1" stopColor="#9a7bff" />
        </linearGradient>
        <linearGradient id="vt-id-gold" x1="0" y1="0" x2="0" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffe19a" />
          <stop offset="1" stopColor="#d4a843" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="40" height="40" rx="12" fill="url(#vt-id-bg)" />
      {/* original mic + sparkle key — no Nintendo trade dress */}
      <g transform="translate(11 7)">
        <rect x="4.5" y="0" width="9" height="15" rx="4.5" fill="url(#vt-id-gold)" />
        <path d="M2 11.5 a7.5 7.5 0 0 0 14 0" fill="none" stroke="url(#vt-id-gold)" strokeWidth="2" strokeLinecap="round" />
        <line x1="9" y1="19" x2="9" y2="24" stroke="url(#vt-id-gold)" strokeWidth="2" strokeLinecap="round" />
        <line x1="5" y1="24" x2="13" y2="24" stroke="url(#vt-id-gold)" strokeWidth="2" strokeLinecap="round" />
      </g>
      <circle cx="32" cy="9" r="1.6" fill="#ffe19a" />
      <circle cx="6.5" cy="30" r="1.2" fill="#ffe19a" />
    </svg>
  );
}

export function VoiceTreasureIdentity({ subtitle = "" }) {
  return (
    <header className="vt-identity" data-testid="vt-identity-header">
      <div
        aria-hidden="true"
        data-testid="vt-identity-mark-wrap"
        style={{ width: 38, height: 38, borderRadius: 12, overflow: "hidden",
          display: "grid", placeItems: "center" }}
      >
        <VoiceTreasureIdentityMark />
      </div>
      <div>
        <div className="vt-brand" data-testid="vt-brand-title">Voice Treasure</div>
        {subtitle ? <div className="vt-brand-sub" data-testid="vt-brand-subtitle">{subtitle}</div> : null}
      </div>
    </header>
  );
}
