/**
 * canvasSchema.js — Campaign Design Studio 2.0 canvas document schema (v2).
 *
 * Lives at `config.content.canvas` inside the SAME generic
 * `promotional_banner` ExperienceConfig documents the form-era studio wrote
 * — the backend's content/appearance/motion domains are free-form dicts, so
 * schemaVersion 2 requires ZERO backend changes and coexists with every
 * legacy document. Detection contract (see promotionConfigResolver.js):
 *   content.canvas.schemaVersion >= 2  ->  canvas rendering path
 *   otherwise                          ->  legacy path, byte-identical
 *
 * COORDINATE SYSTEM
 * ─────────────────
 * Every frame is percentage-based and CENTER-anchored:
 *   x, y  — center of the layer, % of canvas width/height (0-100)
 *   w     — width, % of canvas width
 *   h     — height, % of canvas height (images/components; text auto-sizes)
 * Font/component sizing uses "canvas units" (cu): 1cu = canvasWidth / 100.
 * Because both the Studio stage and the student Dashboard render through
 * the SAME CampaignCanvasRenderer with the same math, what the author sees
 * is exactly what ships — at any device width.
 *
 * LAYER TYPES
 *   background — singleton base layer: theme surface / solid / gradient fill,
 *                optional image (cover|contain|stretch|tile + blur), overlay
 *   image      — artwork layer. `role` implements the four artwork modes:
 *                  "hero"        free transform, NEVER cropped (object-fit
 *                                contain inside its frame)
 *                  "poster"      full-bleed professional artwork, fit modes
 *                                contain|fitWidth|fitHeight|center|original,
 *                                never auto-cropped, never repositioned
 *                  "decor"       decorative asset (composition mode)
 *   text       — typography layer, styled by typographyStyles.js styleId
 *   component  — parametric marketing component (MarketingComponents.jsx)
 *   effect     — ambient particle/light effect (sparkles, rays, confetti...)
 */

export const CANVAS_SCHEMA_VERSION = 2;

export const CANVAS_ASPECTS = [
  { id: "21/9", label: "Banner 21:9", w: 21, h: 9 },
  { id: "16/9", label: "Wide 16:9", w: 16, h: 9 },
  { id: "3/1", label: "Slim 3:1", w: 3, h: 1 },
  { id: "4/3", label: "Classic 4:3", w: 4, h: 3 },
];

export const ARTWORK_MODES = [
  { id: "background", label: "Background", hint: "Textures, gradients, background illustrations" },
  { id: "hero", label: "Hero Artwork", hint: "Transparent PNG/WebP/SVG assets — never cropped" },
  { id: "poster", label: "Poster", hint: "Professionally designed artwork rendered exactly" },
  { id: "composition", label: "Composition", hint: "Multiple independent artwork assets" },
];

export const POSTER_FITS = [
  { id: "contain", label: "Contain" },
  { id: "fitWidth", label: "Fit Width" },
  { id: "fitHeight", label: "Fit Height" },
  { id: "center", label: "Center" },
  { id: "original", label: "Original Resolution" },
];

export const BACKGROUND_IMAGE_FITS = [
  { id: "cover", label: "Cover" },
  { id: "contain", label: "Contain" },
  { id: "stretch", label: "Stretch" },
  { id: "tile", label: "Tile" },
];

export const SHADOW_PRESETS = {
  none: null,
  soft: { x: 0, y: 6, blur: 18, color: "#000000", opacity: 30 },
  crisp: { x: 0, y: 3, blur: 6, color: "#000000", opacity: 40 },
  long: { x: 10, y: 14, blur: 24, color: "#000000", opacity: 26 },
  ambient: { x: 0, y: 0, blur: 34, color: "#000000", opacity: 36 },
  lifted: { x: 0, y: 18, blur: 40, color: "#000000", opacity: 34 },
  poster: { x: 0, y: 24, blur: 60, color: "#000000", opacity: 42 },
};

export const EFFECT_TYPES = [
  { id: "sparkles", label: "Sparkles" },
  { id: "premiumDust", label: "Gold Dust" },
  { id: "lightRays", label: "Light Rays" },
  { id: "confetti", label: "Confetti" },
  { id: "academicParticles", label: "Academic Particles" },
  { id: "ribbons", label: "Ribbons" },
  { id: "spotlight", label: "Spotlight" },
  { id: "luxurySmoke", label: "Luxury Smoke" },
];

/** Built-in campaign surfaces — the emerald product family plus premium
 * seasonal alternates. `auto` follows the student's day/night theme via the
 * emeraldDay/emeraldNight pair (same contract as promotionThemes.js). */
export const CANVAS_SURFACES = [
  {
    id: "emeraldAuto", label: "Emerald (Auto Day/Night)",
    day: "radial-gradient(120% 100% at 100% 0%, rgba(217,184,114,0.14) 0%, transparent 55%), linear-gradient(155deg, #FAF7EF 0%, #F3ECD9 45%, #E9E0C4 100%)",
    night: "radial-gradient(120% 100% at 100% 0%, rgba(217,184,114,0.12) 0%, transparent 55%), linear-gradient(155deg, #0B1712 0%, #0E1F18 50%, #123F2C 100%)",
    inkDay: "#0E1F18", inkNight: "#F4F0E2",
  },
  {
    id: "emeraldNight", label: "Emerald Night",
    day: "radial-gradient(120% 100% at 100% 0%, rgba(217,184,114,0.12) 0%, transparent 55%), linear-gradient(155deg, #0B1712 0%, #0E1F18 50%, #123F2C 100%)",
    night: "radial-gradient(120% 100% at 100% 0%, rgba(217,184,114,0.12) 0%, transparent 55%), linear-gradient(155deg, #0B1712 0%, #0E1F18 50%, #123F2C 100%)",
    inkDay: "#F4F0E2", inkNight: "#F4F0E2",
  },
  {
    id: "champagne", label: "Champagne Silk",
    day: "radial-gradient(130% 120% at 0% 0%, rgba(212,168,67,0.20) 0%, transparent 55%), linear-gradient(150deg, #FDFBF4 0%, #F6EDD8 55%, #EADCB8 100%)",
    night: "radial-gradient(130% 120% at 0% 0%, rgba(212,168,67,0.16) 0%, transparent 55%), linear-gradient(150deg, #171207 0%, #241B0B 55%, #171207 100%)",
    inkDay: "#2A2007", inkNight: "#F8EFD9",
  },
  {
    id: "midnightRoyal", label: "Midnight Royal",
    day: "radial-gradient(130% 110% at 0% 0%, rgba(58,110,165,0.18) 0%, transparent 50%), linear-gradient(150deg, #0C1220 0%, #16233C 55%, #0C1220 100%)",
    night: "radial-gradient(130% 110% at 0% 0%, rgba(58,110,165,0.18) 0%, transparent 50%), linear-gradient(150deg, #0C1220 0%, #16233C 55%, #0C1220 100%)",
    inkDay: "#EDF2FA", inkNight: "#EDF2FA",
  },
  {
    id: "celebrationGold", label: "Celebration Gold",
    day: "radial-gradient(130% 110% at 0% 0%, rgba(178,58,72,0.10) 0%, transparent 50%), linear-gradient(150deg, #1A1420 0%, #2D1F3E 55%, #1A1420 100%)",
    night: "radial-gradient(130% 110% at 0% 0%, rgba(178,58,72,0.10) 0%, transparent 50%), linear-gradient(150deg, #1A1420 0%, #2D1F3E 55%, #1A1420 100%)",
    inkDay: "#F8EFD9", inkNight: "#F8EFD9",
  },
  {
    id: "rubyFestival", label: "Ruby Festival",
    day: "radial-gradient(120% 110% at 100% 0%, rgba(217,184,114,0.20) 0%, transparent 55%), linear-gradient(155deg, #3B0F16 0%, #611F2A 55%, #2C0A10 100%)",
    night: "radial-gradient(120% 110% at 100% 0%, rgba(217,184,114,0.20) 0%, transparent 55%), linear-gradient(155deg, #3B0F16 0%, #611F2A 55%, #2C0A10 100%)",
    inkDay: "#FBEFE0", inkNight: "#FBEFE0",
  },
];

export function getCanvasSurface(surfaceId) {
  return CANVAS_SURFACES.find((s) => s.id === surfaceId) || CANVAS_SURFACES[0];
}

let _uid = 0;
export function newLayerId(prefix = "layer") {
  _uid += 1;
  return `${prefix}-${Date.now().toString(36)}-${_uid}${Math.random().toString(36).slice(2, 6)}`;
}

export const DEFAULT_EFFECTS = {
  shadow: { enabled: false, preset: "soft", x: 0, y: 6, blur: 18, color: "#000000", opacity: 30 },
  glow: { enabled: false, color: "#D9B872", blur: 24, opacity: 55 },
  blur: 0,
  radius: 0,
};

export function makeBackgroundLayer(overrides = {}) {
  return {
    id: newLayerId("bg"),
    type: "background",
    name: "Background",
    visible: true,
    locked: false,
    fill: { kind: "surface", surfaceId: "emeraldAuto", color: "#0E1F18", css: "" },
    image: { src: "", fit: "cover", blur: 0, opacity: 100 },
    overlay: { enabled: false, color: "#0B1712", opacity: 24, gradientCss: "" },
    ...overrides,
  };
}

export function makeImageLayer(overrides = {}) {
  return {
    id: newLayerId("img"),
    type: "image",
    name: overrides.name || "Artwork",
    role: "hero", // hero | poster | decor
    src: "",
    assetId: null,
    naturalWidth: null,
    naturalHeight: null,
    frame: { x: 72, y: 50, w: 30, h: 70 },
    rotation: 0,
    opacity: 100,
    flipH: false,
    posterFit: "contain",
    visible: true,
    locked: false,
    effects: JSON.parse(JSON.stringify(DEFAULT_EFFECTS)),
    ...overrides,
  };
}

export function makeTextLayer(overrides = {}) {
  return {
    id: newLayerId("txt"),
    type: "text",
    name: overrides.name || "Text",
    text: "Your headline",
    styleId: "premiumLuxury",
    size: 7,               // font-size in canvas units (1cu = canvasWidth/100)
    align: "left",
    colorOverride: "",
    maxLines: 3,
    lang: "auto",
    frame: { x: 28, y: 40, w: 48 },
    rotation: 0,
    opacity: 100,
    visible: true,
    locked: false,
    effects: JSON.parse(JSON.stringify(DEFAULT_EFFECTS)),
    ...overrides,
  };
}

export function makeComponentLayer(componentId, overrides = {}) {
  return {
    id: newLayerId("cmp"),
    type: "component",
    name: overrides.name || componentId,
    componentId,
    props: {},
    size: 3.4,             // component base scale in canvas units
    frame: { x: 24, y: 72, w: 26 },
    rotation: 0,
    opacity: 100,
    visible: true,
    locked: false,
    effects: JSON.parse(JSON.stringify(DEFAULT_EFFECTS)),
    ...overrides,
  };
}

export function makeEffectLayer(effectId, overrides = {}) {
  return {
    id: newLayerId("fx"),
    type: "effect",
    name: overrides.name || effectId,
    effectId,
    intensity: "medium",
    colorOverride: "",
    opacity: 100,
    visible: true,
    locked: false,
    ...overrides,
  };
}

export function makeDefaultCanvas() {
  return {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    aspect: "21/9",
    artworkMode: "composition",
    safeArea: { x: 6, y: 10, w: 88, h: 80 },
    motion: { preset: "layeredElegant", enabled: true, idle: true },
    layers: [makeBackgroundLayer()],
  };
}

/** True when this ExperienceConfig should take the canvas rendering path. */
export function isCanvasConfig(config) {
  const v = config?.content?.canvas?.schemaVersion;
  return Number.isFinite(v) && v >= 2;
}

/** Defensive normalization — fills defaults so renderer never crashes on a
 * hand-edited or partially-migrated document. Non-destructive. */
export function normalizeCanvas(canvas) {
  if (!canvas || typeof canvas !== "object") return makeDefaultCanvas();
  const layers = Array.isArray(canvas.layers) ? canvas.layers.filter(Boolean) : [];
  const hasBackground = layers.some((l) => l.type === "background");
  return {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    aspect: canvas.aspect || "21/9",
    artworkMode: canvas.artworkMode || "composition",
    safeArea: canvas.safeArea || { x: 6, y: 10, w: 88, h: 80 },
    motion: { preset: "layeredElegant", enabled: true, idle: true, ...(canvas.motion || {}) },
    layers: hasBackground ? layers : [makeBackgroundLayer(), ...layers],
  };
}

export function getAspectRatioCss(aspectId) {
  const a = CANVAS_ASPECTS.find((x) => x.id === aspectId) || CANVAS_ASPECTS[0];
  return `${a.w} / ${a.h}`;
}

/** frame -> absolute positioning style (center-anchored, %-based).
 * Shared by CampaignCanvasRenderer AND the Studio's interaction overlay so
 * hit-boxes always align exactly with rendered layers. */
export function frameToStyle(frame, rotation = 0, extraTransform = "") {
  const f = frame || { x: 50, y: 50, w: 40 };
  return {
    position: "absolute",
    left: `${f.x}%`,
    top: `${f.y}%`,
    width: `${f.w}%`,
    ...(Number.isFinite(f.h) ? { height: `${f.h}%` } : null),
    transform: `translate(-50%, -50%)${rotation ? ` rotate(${rotation}deg)` : ""}${extraTransform}`,
    transformOrigin: "center center",
  };
}

/** Builds the CSS filter/box-shadow bundle for a layer's effects. Images use
 * drop-shadow (follows alpha silhouette — premium for transparent PNGs). */
export function getLayerEffectStyles(layer, { isImage = false } = {}) {
  const fx = layer?.effects || {};
  const filters = [];
  const style = {};
  const shadow = fx.shadow?.enabled ? { ...SHADOW_PRESETS[fx.shadow.preset || "soft"], ...fx.shadow } : null;
  const glow = fx.glow?.enabled ? fx.glow : null;

  const hexA = (hex, pct) => {
    const a = Math.round(Math.max(0, Math.min(100, pct ?? 100)) * 2.55).toString(16).padStart(2, "0");
    return `${hex}${a}`;
  };

  if (isImage) {
    if (shadow) filters.push(`drop-shadow(${shadow.x || 0}px ${shadow.y || 6}px ${shadow.blur || 18}px ${hexA(shadow.color || "#000000", shadow.opacity)})`);
    if (glow) filters.push(`drop-shadow(0 0 ${glow.blur || 24}px ${hexA(glow.color || "#D9B872", glow.opacity)})`);
  } else {
    const shadows = [];
    if (shadow) shadows.push(`${shadow.x || 0}px ${shadow.y || 6}px ${shadow.blur || 18}px ${hexA(shadow.color || "#000000", shadow.opacity)}`);
    if (glow) shadows.push(`0 0 ${glow.blur || 24}px ${hexA(glow.color || "#D9B872", glow.opacity)}`);
    if (shadows.length) style.boxShadow = shadows.join(", ");
  }
  if (Number.isFinite(fx.blur) && fx.blur > 0) filters.push(`blur(${fx.blur}px)`);
  if (filters.length) style.filter = filters.join(" ");
  if (Number.isFinite(fx.radius) && fx.radius > 0) {
    style.borderRadius = fx.radius;
    if (!isImage) style.overflow = "hidden";
  }
  return style;
}

const canvasSchema = {
  CANVAS_SCHEMA_VERSION, CANVAS_ASPECTS, ARTWORK_MODES, POSTER_FITS,
  BACKGROUND_IMAGE_FITS, SHADOW_PRESETS, EFFECT_TYPES, CANVAS_SURFACES,
  getCanvasSurface, newLayerId, makeBackgroundLayer, makeImageLayer,
  makeTextLayer, makeComponentLayer, makeEffectLayer, makeDefaultCanvas,
  isCanvasConfig, normalizeCanvas, getAspectRatioCss, frameToStyle,
  getLayerEffectStyles,
};
export default canvasSchema;
