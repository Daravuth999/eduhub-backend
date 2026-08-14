/**
 * adaptiveTypography.js — the ONE small helper module the Phase 0 audit
 * flagged as having no existing precedent to extend anywhere in this
 * codebase (no i18n system, no Khmer-aware line-breaking, no shared
 * adaptive-fit helper). Scoped narrowly on purpose: viewport-responsive
 * clamp() sizing per text role, plus script-aware line-height/wrap rules —
 * not a full bidi/shaping engine this project has never needed before.
 *
 * Khmer quality contract:
 *   - line-height comes from index.css's ALREADY-ESTABLISHED :lang(km)
 *     rule (1.7) rather than inventing a second value — this module reuses
 *     that number, it doesn't duplicate it.
 *   - word-break stays "normal" (never "break-all") — breaking Khmer
 *     mid-grapheme-cluster is exactly what produces "broken glyphs."
 *     `overflow-wrap: anywhere` is the safety net for genuinely unbreakable
 *     tokens (long URLs), not the primary wrap strategy.
 *   - the caller (PromotionTypography.jsx) is responsible for setting the
 *     `lang="km"` DOM attribute alongside these styles — that's what lets
 *     the browser's own Unicode line-breaking (UAX#14) find correct Khmer
 *     syllable boundaries; no library reimplements that here.
 */

// Same Unicode block boundaries fonts.css's Kantumruy Pro @font-face already
// scopes to (U+1780-17FF Khmer, U+19E0-19FF Khmer Symbols) — compared as
// numeric code points rather than a regex character class so the range
// bounds can't be mistyped/misrendered as literal glyphs.
const KHMER_CODE_START = 0x1780;
const KHMER_CODE_END = 0x17ff;
const KHMER_SYMBOL_START = 0x19e0;
const KHMER_SYMBOL_END = 0x19ff;
const LATIN_RANGE = /[A-Za-z]/;

function hasKhmerChar(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i);
    if (
      (code >= KHMER_CODE_START && code <= KHMER_CODE_END) ||
      (code >= KHMER_SYMBOL_START && code <= KHMER_SYMBOL_END)
    ) {
      return true;
    }
  }
  return false;
}

/** "km" | "en" | "mixed" — used to pick line-height and the lang attribute. */
export function detectScript(text) {
  if (!text) return "en";
  const khmer = hasKhmerChar(text);
  const latin = LATIN_RANGE.test(text);
  if (khmer && latin) return "mixed";
  if (khmer) return "km";
  return "en";
}

// clamp() keeps sizing viewport-adaptive without a per-breakpoint media
// query ladder — "adaptive sizing rather than fixed CSS values" per the
// approved directive.
const ROLE_CLAMP = {
  eyebrow: "clamp(0.65rem, 1.6vw, 0.8rem)",
  headline: "clamp(1.35rem, 4.2vw, 2.4rem)",
  subhead: "clamp(0.95rem, 2.4vw, 1.25rem)",
  body: "clamp(0.8rem, 1.8vw, 0.95rem)",
};

export function getAdaptiveFontSize(role) {
  return ROLE_CLAMP[role] || ROLE_CLAMP.body;
}

/** Khmer (and mixed Khmer+English) need the taller line-height its stacked
 * diacritics require — matches index.css's :lang(km) rule (1.7) so a
 * Promotion text layer never disagrees with every other Khmer string in
 * the app. Latin-only content keeps the tighter 1.3 headline-friendly value. */
export function getAdaptiveLineHeight(script) {
  return script === "en" ? 1.3 : 1.7;
}

/** Safe-wrap style for one text layer. Returns a plain style object the
 * caller spreads onto the element, plus the detected script so the caller
 * can also set `lang`/`className="font-khmer"` where relevant. */
export function getSafeWrapStyle(role, text, maxLines) {
  const script = detectScript(text);
  const style = {
    fontSize: getAdaptiveFontSize(role),
    lineHeight: getAdaptiveLineHeight(script),
    overflowWrap: "anywhere",
    wordBreak: "normal",
    hyphens: "none",
  };
  if (Number.isFinite(maxLines) && maxLines > 0) {
    Object.assign(style, {
      display: "-webkit-box",
      WebkitLineClamp: maxLines,
      WebkitBoxOrient: "vertical",
      overflow: "hidden",
    });
  }
  return { style, script };
}

export default { detectScript, getAdaptiveFontSize, getAdaptiveLineHeight, getSafeWrapStyle };
