/**
 * teleprompterConfig.js — the ONE definition of teleprompter settings shared
 * by the student player, the Author Studio configuration panel, and the
 * Teleprompter component itself. Mirrors video_schema.py's
 * default_teleprompter_config() exactly — the backend owns the authoritative
 * defaults; this copy only fills gaps client-side.
 */
export const DEFAULT_TELEPROMPTER_CONFIG = {
  mode: "auto",
  wordHighlight: true,
  sentenceHighlight: true,
  paragraphHighlight: false,
  karaoke: false,
  fontScale: 1.0,
  fontFamily: "default",
  lineSpacing: 1.9,
  autoScroll: true,
  scrollSpeed: 1.0,
  centered: false,
  showConfidence: false,
  // Bilingual (Khmer) learning layer — a student reading preference, never
  // an author-forced default: false here means every lesson opens
  // English-only until a student explicitly opts in via the teleprompter's
  // translation toggle, persisted through the same local-override
  // mechanism as fontScale/autoScroll below (readLocalOverrides/
  // writeLocalOverrides). Absent on a sentence (no translationKm) simply
  // renders nothing regardless of this flag — see Teleprompter.jsx.
  showTranslation: false,
  // "Center focus" cinematic reading mode: the active sentence stays in a
  // still, responsive-anchored reading zone while spoken text recedes
  // upward/fades behind it and upcoming text approaches from below (see
  // focusZone.js). Defaults false so this is purely additive — Author
  // Studio's preview and any other existing Teleprompter consumer render
  // exactly as before unless a caller opts in (VideoLessonPlayer.jsx does,
  // for the student experience).
  centerFocus: false,
};

export const FONT_FAMILIES = {
  default: "inherit",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'JetBrains Mono', 'Courier New', monospace",
};

export function mergeTeleprompterConfig(...layers) {
  const out = { ...DEFAULT_TELEPROMPTER_CONFIG };
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") continue;
    for (const k of Object.keys(DEFAULT_TELEPROMPTER_CONFIG)) {
      if (layer[k] !== undefined && layer[k] !== null) out[k] = layer[k];
    }
  }
  return out;
}

const OVERRIDE_KEY = "eduhub_teleprompter_prefs_v1";

/** Student-local reading preference overrides (font, spacing, scroll) —
 * layered on top of the author's lesson config, never sent to the server. */
export function readLocalOverrides() {
  try { return JSON.parse(localStorage.getItem(OVERRIDE_KEY)) || {}; } catch { return {}; }
}

export function writeLocalOverrides(overrides) {
  try { localStorage.setItem(OVERRIDE_KEY, JSON.stringify(overrides || {})); } catch { /* ignore */ }
}
