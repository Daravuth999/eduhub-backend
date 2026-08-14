/**
 * experienceThemes.js — Reward Experience Engine v1: theme + config registry.
 *
 * Pure data + pure functions. NO reward logic here — everything in this
 * module is presentational. A campaign carries an optional `experience`
 * object; campaigns without one resolve to "classic" (legacy popup,
 * byte-identical rendering, the shell renders nothing extra).
 */

export const ENVIRONMENTS = {
  classic: {
    id: "classic",
    label: "Classic",
    tagline: "Original popup, no environment",
    swatch: "linear-gradient(135deg, #fff8ec, #ffe9c7)",
    defaultGlass: "solid",
    defaultParticles: "none",
    defaultLighting: "none",
    veil: "rgba(8,5,15,0.62)",
  },
  morning_angkor: {
    id: "morning_angkor",
    label: "Morning Angkor",
    tagline: "Golden dawn over the temple towers",
    swatch: "linear-gradient(160deg, #2b1230 0%, #7a3b1e 55%, #e8a24b 100%)",
    bg: "linear-gradient(180deg, #1d0f2e 0%, #4a1f33 38%, #93481f 72%, #d98e3b 100%)",
    glowA: { color: "rgba(255,190,92,0.55)", x: "50%", y: "78%", size: "62vmin" },
    glowB: { color: "rgba(255,132,64,0.25)", x: "22%", y: "40%", size: "48vmin" },
    silhouette: "angkor",
    silhouetteColor: "#150a1c",
    silhouetteOpacity: 0.9,
    defaultGlass: "warm",
    defaultParticles: "dust",
    defaultLighting: "golden",
    veil: "rgba(16,8,20,0.38)",
  },
  lotus_garden: {
    id: "lotus_garden",
    label: "Lotus Garden",
    tagline: "Calm water, soft petals",
    swatch: "linear-gradient(160deg, #06281f 0%, #0f5c46 60%, #7fc8a9 100%)",
    bg: "linear-gradient(180deg, #041d17 0%, #0a3a2c 45%, #14614a 80%, #2a8663 100%)",
    glowA: { color: "rgba(150,235,195,0.35)", x: "50%", y: "84%", size: "58vmin" },
    glowB: { color: "rgba(255,182,193,0.18)", x: "76%", y: "28%", size: "42vmin" },
    silhouette: "lotus",
    silhouetteColor: "#03130e",
    silhouetteOpacity: 0.85,
    defaultGlass: "frost",
    defaultParticles: "petals",
    defaultLighting: "soft",
    veil: "rgba(3,16,12,0.36)",
  },
  royal_heritage: {
    id: "royal_heritage",
    label: "Royal Heritage",
    tagline: "Deep crimson and royal gold",
    swatch: "linear-gradient(160deg, #3a0d12 0%, #7a1622 60%, #d4a843 100%)",
    bg: "linear-gradient(180deg, #23070b 0%, #4b0f18 48%, #6d1622 82%, #832031 100%)",
    glowA: { color: "rgba(212,168,67,0.34)", x: "50%", y: "20%", size: "56vmin" },
    glowB: { color: "rgba(255,96,96,0.16)", x: "18%", y: "72%", size: "44vmin" },
    silhouette: "heritage",
    silhouetteColor: "#170307",
    silhouetteOpacity: 0.9,
    defaultGlass: "midnight",
    defaultParticles: "sparkles",
    defaultLighting: "spotlight",
    veil: "rgba(20,4,8,0.40)",
  },
  vip_luxury: {
    id: "vip_luxury",
    label: "VIP Luxury",
    tagline: "Black velvet, gold bokeh",
    swatch: "linear-gradient(160deg, #0a0a0c 0%, #17141c 60%, #b98a2e 100%)",
    bg: "linear-gradient(180deg, #07070a 0%, #0f0d14 55%, #171320 100%)",
    glowA: { color: "rgba(212,168,67,0.28)", x: "78%", y: "22%", size: "50vmin" },
    glowB: { color: "rgba(150,120,255,0.10)", x: "16%", y: "76%", size: "46vmin" },
    silhouette: null,
    bokeh: "gold",
    defaultGlass: "midnight",
    defaultParticles: "sparkles",
    defaultLighting: "spotlight",
    veil: "rgba(4,4,7,0.42)",
  },
  academic_hall: {
    id: "academic_hall",
    label: "Academic Hall",
    tagline: "Library light through tall windows",
    swatch: "linear-gradient(160deg, #101c33 0%, #1e3a5c 60%, #cfe4ff 100%)",
    bg: "linear-gradient(180deg, #0b1524 0%, #14263e 50%, #1f3b57 100%)",
    glowA: { color: "rgba(255,236,190,0.24)", x: "50%", y: "10%", size: "64vmin" },
    glowB: { color: "rgba(120,180,255,0.14)", x: "80%", y: "70%", size: "44vmin" },
    silhouette: "columns",
    silhouetteColor: "#060d18",
    silhouetteOpacity: 0.88,
    beams: true,
    defaultGlass: "frost",
    defaultParticles: "dust",
    defaultLighting: "soft",
    veil: "rgba(6,10,18,0.40)",
  },
  festival_celebration: {
    id: "festival_celebration",
    label: "Festival Celebration",
    tagline: "Evening festival lights",
    swatch: "linear-gradient(160deg, #2a0f3e 0%, #6d1d63 60%, #ffc857 100%)",
    bg: "linear-gradient(180deg, #1b0930 0%, #3c1150 45%, #6d1d63 85%, #8f2a5e 100%)",
    glowA: { color: "rgba(255,200,87,0.30)", x: "30%", y: "24%", size: "46vmin" },
    glowB: { color: "rgba(94,224,255,0.16)", x: "76%", y: "64%", size: "48vmin" },
    silhouette: null,
    bokeh: "festival",
    defaultGlass: "warm",
    defaultParticles: "confetti",
    defaultLighting: "aurora",
    veil: "rgba(18,6,28,0.38)",
  },
  modern_studio: {
    id: "modern_studio",
    label: "Modern Learning Studio",
    tagline: "Clean, focused, contemporary",
    swatch: "linear-gradient(160deg, #0e1420 0%, #1c2a3f 60%, #6ea8d8 100%)",
    bg: "linear-gradient(180deg, #0c111c 0%, #131e2e 55%, #1b2c42 100%)",
    glowA: { color: "rgba(110,168,216,0.22)", x: "72%", y: "18%", size: "56vmin" },
    glowB: { color: "rgba(212,168,67,0.10)", x: "18%", y: "78%", size: "44vmin" },
    silhouette: null,
    grid: true,
    defaultGlass: "frost",
    defaultParticles: "dust",
    defaultLighting: "soft",
    veil: "rgba(8,12,20,0.40)",
  },
};

export const ENVIRONMENT_IDS = Object.keys(ENVIRONMENTS);

export const GLASS_PRESETS = {
  solid: {
    label: "Solid (original)",
    bg: "linear-gradient(180deg, #fff8ec 0%, #ffe9c7 100%)",
    blur: 0,
    border: "rgba(255,255,255,0)",
    ink: "#1a1420",
    inkSoft: "#5b4632",
    chipBg: "rgba(0,0,0,0.06)",
    chipBorder: "rgba(0,0,0,0.1)",
    clockBg: "rgba(255,255,255,0.7)",
  },
  warm: {
    label: "Warm glass",
    bg: "linear-gradient(180deg, rgba(255,248,236,0.86) 0%, rgba(255,229,193,0.78) 100%)",
    blur: 18,
    border: "rgba(255,224,164,0.55)",
    ink: "#241505",
    inkSoft: "#6a4e2e",
    chipBg: "rgba(120,80,20,0.10)",
    chipBorder: "rgba(120,80,20,0.18)",
    clockBg: "rgba(255,255,255,0.75)",
  },
  frost: {
    label: "Frost glass",
    bg: "linear-gradient(180deg, rgba(255,255,255,0.80) 0%, rgba(238,246,246,0.70) 100%)",
    blur: 20,
    border: "rgba(255,255,255,0.60)",
    ink: "#101820",
    inkSoft: "#41525e",
    chipBg: "rgba(20,60,70,0.08)",
    chipBorder: "rgba(20,60,70,0.16)",
    clockBg: "rgba(255,255,255,0.8)",
  },
  midnight: {
    label: "Midnight glass",
    bg: "linear-gradient(180deg, rgba(26,20,34,0.72) 0%, rgba(14,10,22,0.80) 100%)",
    blur: 22,
    border: "rgba(212,168,67,0.35)",
    ink: "#f6eeda",
    inkSoft: "rgba(246,238,218,0.72)",
    chipBg: "rgba(255,255,255,0.08)",
    chipBorder: "rgba(255,255,255,0.14)",
    clockBg: "rgba(255,255,255,0.14)",
  },
};

export const GLASS_STYLES = ["auto", "warm", "frost", "midnight", "solid"];
export const LIGHTING_STYLES = ["auto", "soft", "golden", "aurora", "spotlight", "morning", "sunset", "studio", "cool", "none"];
export const REVEAL_STYLES = ["cinematic", "float", "bloom", "fade", "scale", "slide", "classic"];
export const PARTICLE_STYLES = ["auto", "dust", "fireflies", "petals", "sparkles", "confetti", "mist", "rays", "none"];
export const POPUP_SIZES = { compact: "330px", standard: "375px", grand: "430px" };
export const PARTICLE_INTENSITIES = ["subtle", "premium", "celebration"];
export const DECOR_ANIMS = ["none", "float", "pulse", "spin", "drift", "sway"];
export const LIGHT_DIRECTIONS = ["top", "left", "right", "bottom", "center"];
export const CTA_STYLES = ["solid", "gradient", "glass", "outline"];
export const CTA_ANIMS = ["none", "pulse", "shimmer"];
export const FONT_FAMILIES = {
  default: "inherit",
  serif: "Georgia, 'Times New Roman', serif",
  display: "'Trebuchet MS', 'Segoe UI', sans-serif",
  rounded: "'Comic Sans MS', 'Segoe UI', system-ui, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const clamp = (n, lo, hi, d) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return d;
  return Math.min(hi, Math.max(lo, v));
};
const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);

// Like clamp(), but for fields that use a SENTINEL value (always -1 here)
// to mean "unset — use the preset/theme default", distinct from any real
// in-range value. Plain clamp() cannot represent that: -1 is a finite
// number, so clamp(-1, 0, 40, -1) clamps it INTO [0,40] (-> 0) instead of
// returning the sentinel — meaning every field normalized this way silently
// turns into an explicit "0" the moment it survives a second pass through
// normalizeExperience(). That happens on every real render, because the
// resolver is called at multiple nested levels (parent state ->
// RewardExperiencePreview's own memo -> RewardExperienceShell's own memo)
// and is assumed throughout this module to be idempotent. Concretely this
// collapsed glass_config.opacity (sentinel -1) to 0.2 and glass_config.radius
// (sentinel -1) to 0 on the very next render, making the reward card render
// at 20% opacity with square corners regardless of what any admin
// configured — the actual cause of the "washed out, detached" glass panel.
const clampAuto = (n, lo, hi) => {
  const v = Number(n);
  if (v === -1) return -1;
  if (!Number.isFinite(v)) return -1;
  return Math.min(hi, Math.max(lo, v));
};

export function normalizeDecoration(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = raw.kind === "custom" ? "custom" : "builtin";
  const d = {
    id: String(raw.id || `dec_${Math.random().toString(36).slice(2, 9)}`),
    kind,
    asset: kind === "builtin" ? String(raw.asset || "").slice(0, 40) : "",
    url: kind === "custom" ? String(raw.url || "").slice(0, 1000) : "",
    name: String(raw.name || "").slice(0, 60),
    x: clamp(raw.x, 0, 100, 50),
    y: clamp(raw.y, 0, 100, 50),
    size: clamp(raw.size, 16, 400, 72),
    rotation: clamp(raw.rotation, -180, 180, 0),
    opacity: clamp(raw.opacity, 0, 1, 1),
    glow: clamp(raw.glow, 0, 1, 0),
    blur: clamp(raw.blur, 0, 12, 0),
    shadow: clamp(raw.shadow, 0, 1, 0),
    flip: !!raw.flip,
    locked: !!raw.locked,
    visible: raw.visible !== false,
    group: String(raw.group || "").slice(0, 40),
    anim: pick(raw.anim, DECOR_ANIMS, "none"),
    anim_speed: clamp(raw.anim_speed, 0.25, 4, 1),
    layer: raw.layer === "front" ? "front" : "back",
  };
  if (d.kind === "builtin" && !d.asset) return null;
  if (d.kind === "custom" && !d.url) return null;
  return d;
}

const hexOk = (v) => typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v);

export function normalizeGlassConfig(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    frost: clampAuto(r.frost, 0, 40),          // -1 = use preset default, survives re-normalization
    opacity: clampAuto(r.opacity, 0.2, 1),
    radius: clampAuto(r.radius, 0, 48),
    border: pick(r.border, ["auto", "none", "soft", "gold", "glow"], "auto"),
    reflection: r.reflection !== false,
    depth: clamp(r.depth, 0, 1, 0.6),
  };
}

export function normalizeLightingConfig(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    intensity: clamp(r.intensity, 0, 1, 0.6),
    direction: pick(r.direction, LIGHT_DIRECTIONS, "top"),
    color: hexOk(r.color) ? r.color : "",
    blur: clamp(r.blur, 0, 40, 20),
    opacity: clamp(r.opacity, 0, 1, 0.7),
  };
}

export function normalizeTypography(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    title_font: pick(r.title_font, Object.keys(FONT_FAMILIES), "default"),
    title_weight: clamp(r.title_weight, 400, 900, 900),
    title_spacing: clamp(r.title_spacing, -2, 8, 0),
    title_color: hexOk(r.title_color) ? r.title_color : "",
    title_shadow: clamp(r.title_shadow, 0, 1, 0),
    align: pick(r.align, ["center", "left"], "center"),
  };
}

export function normalizeCta(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    style: pick(r.style, CTA_STYLES, "solid"),
    radius: clamp(r.radius, 0, 40, 40),
    glow: clamp(r.glow, 0, 1, 0.4),
    shadow: clamp(r.shadow, 0, 1, 0.5),
    animation: pick(r.animation, CTA_ANIMS, "shimmer"),
  };
}

/** Normalize any raw experience value into a full, safe config object. */
export function normalizeExperience(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    version: 2,
    environment: pick(r.environment, ENVIRONMENT_IDS, "classic"),
    glass: pick(r.glass, GLASS_STYLES, "auto"),
    lighting: pick(r.lighting, LIGHTING_STYLES, "auto"),
    reveal: pick(r.reveal, REVEAL_STYLES, "cinematic"),
    particles: pick(r.particles, PARTICLE_STYLES, "auto"),
    particle_intensity: pick(r.particle_intensity, PARTICLE_INTENSITIES, "premium"),
    backdrop_blur: clamp(r.backdrop_blur, 0, 24, 10),
    env_intensity: clamp(r.env_intensity, 0, 1, 1),
    ambient_color: typeof r.ambient_color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(r.ambient_color) ? r.ambient_color : "",
    popup_size: pick(r.popup_size, Object.keys(POPUP_SIZES), "standard"),
    glass_config: normalizeGlassConfig(r.glass_config),
    lighting_config: normalizeLightingConfig(r.lighting_config),
    typography: normalizeTypography(r.typography),
    cta: normalizeCta(r.cta),
    decorations: dedupeDecorationIds(
      (Array.isArray(r.decorations) ? r.decorations : [])
        .map(normalizeDecoration).filter(Boolean),
    ).slice(0, 40),
  };
}

// Bug report: "same artwork rendered twice" in both the Designer preview and
// the live student popup. Root cause — every decoration is keyed by `d.id`
// (RewardDecorationLayer, RewardExperiencePreview's edit handles), but
// nothing ever collapsed two decoration objects sharing the same `id`.
// React's `key` only affects reconciliation identity; duplicate keys in a
// `.map()` output still render as two separate DOM nodes (React only logs a
// console warning). A colliding id can reach `experience.decorations` via a
// stale template merge, a copy/paste import, or a race between two admin
// tabs saving the same campaign — any of those leaves two entries with one
// id, and the SAME asset then paints twice, one after another in the array,
// exactly matching the reported symptom. Fixed at the single choke point
// every decoration list passes through (`normalizeExperience`), keeping the
// LAST entry for a given id so an in-progress edit always wins over a stale
// duplicate.
function dedupeDecorationIds(list) {
  const byId = new Map();
  for (const d of list) byId.set(d.id, d);
  return [...byId.values()];
}

/** Default experience for NEW campaigns (existing campaigns resolve to classic). */
export function defaultExperience() {
  return normalizeExperience({ environment: "morning_angkor" });
}

/** Resolve "auto" fields against the chosen environment. */
export function resolveExperience(exp) {
  const env = ENVIRONMENTS[exp.environment] || ENVIRONMENTS.classic;
  return {
    ...exp,
    env,
    glassResolved: exp.glass === "auto" ? env.defaultGlass : exp.glass,
    lightingResolved: exp.lighting === "auto" ? env.defaultLighting : exp.lighting,
    particlesResolved: exp.particles === "auto" ? env.defaultParticles : exp.particles,
  };
}

/** CSS custom properties driving the shell's re-skin layer. */
export function themeVars(exp, accent) {
  const res = resolveExperience(exp);
  const glass = GLASS_PRESETS[res.glassResolved] || GLASS_PRESETS.solid;
  const gc = exp.glass_config || normalizeGlassConfig(null);
  const ty = exp.typography || normalizeTypography(null);
  const cta = exp.cta || normalizeCta(null);
  // The reward CARD must stay a crisp, readable glass surface — heavy
  // atmospheric blur belongs to the environment behind it (--rxp-veil-blur),
  // not the card's own backdrop-filter. Presets/the "Frost level" slider
  // still range up to 40px (frost) for backward compatibility with saved
  // campaigns, but the blur radius actually painted on the card is capped
  // to a premium-glass range; frostiness beyond that reads through the
  // card's own semi-opaque background gradient instead, never through more
  // blur (which is what produced the washed-out, unreadable "foggy plastic"
  // look this cap fixes).
  const frost = gc.frost >= 0 ? gc.frost : glass.blur;
  const cardBlur = Math.min(frost, 6);
  const borderMap = {
    none: "rgba(255,255,255,0)",
    soft: "rgba(255,255,255,0.35)",
    gold: "rgba(212,168,67,0.55)",
    glow: `${accent || "#D4A843"}88`,
  };
  const border = gc.border === "auto" ? glass.border : (borderMap[gc.border] || glass.border);
  const shadowA = 0.25 + gc.depth * 0.45;
  return {
    "--rxp-accent": accent || "#D4A843",
    "--rxp-veil": res.env.veil || "rgba(8,5,15,0.62)",
    "--rxp-veil-blur": `${exp.backdrop_blur}px`,
    "--rxp-glass-bg": glass.bg,
    "--rxp-glass-blur": `${cardBlur}px`,
    "--rxp-glass-border": border,
    "--rxp-glass-radius": gc.radius >= 0 ? `${gc.radius}px` : "28px",
    "--rxp-glass-opacity": gc.opacity >= 0 ? String(gc.opacity) : "1",
    "--rxp-card-shadow": `0 ${Math.round(16 + gc.depth * 28)}px ${Math.round(50 + gc.depth * 50)}px -18px rgba(0,0,0,${shadowA.toFixed(2)})`,
    "--rxp-reflection": gc.reflection ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0)",
    "--rxp-ink": glass.ink,
    "--rxp-ink-soft": glass.inkSoft,
    "--rxp-chip-bg": glass.chipBg,
    "--rxp-chip-border": glass.chipBorder,
    "--rxp-clock-bg": glass.clockBg,
    "--rxp-card-w": POPUP_SIZES[exp.popup_size] || POPUP_SIZES.standard,
    "--rxp-env-opacity": String(exp.env_intensity),
    // typography (title + subtitle scale from it)
    "--rxp-title-font": FONT_FAMILIES[ty.title_font] || "inherit",
    "--rxp-title-weight": String(ty.title_weight),
    "--rxp-title-spacing": `${ty.title_spacing / 10}em`,
    "--rxp-title-color": ty.title_color || glass.ink,
    "--rxp-title-shadow": ty.title_shadow > 0 ? `0 2px ${Math.round(2 + ty.title_shadow * 10)}px rgba(0,0,0,${(ty.title_shadow * 0.55).toFixed(2)})` : "none",
    "--rxp-text-align": ty.align,
    // CTA
    "--rxp-cta-radius": `${cta.radius}px`,
    "--rxp-cta-shadow": `0 ${Math.round(4 + cta.shadow * 12)}px ${Math.round(10 + cta.shadow * 18)}px ${accent || "#D4A843"}${Math.round(30 + cta.shadow * 60).toString(16).padStart(2, "0")}`,
    "--rxp-cta-glow": String(cta.glow),
  };
}
