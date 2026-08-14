/**
 * voucherTemplates.ts -- My Portal Rewards/Referral UI Reconstruction v1
 *
 * Premium template registry for the compact voucher cards rendered in the
 * My Portal `VoucherHub` carousel. Each template is a tuple of:
 *
 *   - strip:   colour of the left vertical "VOUCHER" side strip
 *   - body:    main card background (used when no artwork_url is provided)
 *   - text:    primary readable text colour on the body
 *   - mute:    secondary readable text colour on the body
 *   - accent:  call-to-action / amount highlight colour
 *
 * Templates are referenced by the backend `template_style` slug carried
 * inside `/api/student/vouchers`. The six required slugs in the brief are
 * supported 1:1. Any unknown slug falls back to the brand-primary template
 * (`royal_purple_gold`).
 *
 * This file is pure data -- no React, no API calls, no side effects.
 */
export type VoucherTemplateKey =
  | "royal_purple_gold"
  | "ocean_blue_glass"
  | "emerald_learning_pass"
  | "black_diamond_premium"
  | "warm_ivory_gift_card"
  | "festival_celebration";

export interface VoucherTemplate {
  /** Left "VOUCHER" side strip background. */
  strip: string;
  /** Main card body background (CSS gradient or solid). */
  body: string;
  /** Primary text colour for the body. */
  text: string;
  /** Secondary / muted text colour. */
  mute: string;
  /** Highlight colour for the discount amount + Use button. */
  accent: string;
  /** Subtle border colour for the card outline. */
  border: string;
}

export const VOUCHER_TEMPLATES: Record<VoucherTemplateKey, VoucherTemplate> = {
  royal_purple_gold: {
    strip:  "linear-gradient(180deg, #6B3FA0 0%, #2A1A4A 100%)",
    body:   "linear-gradient(135deg, #221035 0%, #110820 100%)",
    text:   "#F4E5C1",
    mute:   "rgba(244,229,193,0.65)",
    accent: "#D4A843",
    border: "rgba(212,168,67,0.30)",
  },
  ocean_blue_glass: {
    strip:  "linear-gradient(180deg, #3FA8D4 0%, #0B2545 100%)",
    body:   "linear-gradient(135deg, #0B2545 0%, #051327 100%)",
    text:   "#E7F4FF",
    mute:   "rgba(231,244,255,0.65)",
    accent: "#5EE0FF",
    border: "rgba(94,224,255,0.30)",
  },
  emerald_learning_pass: {
    strip:  "linear-gradient(180deg, #34D399 0%, #053B2C 100%)",
    body:   "linear-gradient(135deg, #062E22 0%, #03190F 100%)",
    text:   "#E4FFF1",
    mute:   "rgba(228,255,241,0.65)",
    accent: "#34D399",
    border: "rgba(52,211,153,0.30)",
  },
  black_diamond_premium: {
    strip:  "linear-gradient(180deg, #2A2A2A 0%, #0A0A0A 100%)",
    body:   "linear-gradient(135deg, #161616 0%, #060606 100%)",
    text:   "#FFFFFF",
    mute:   "rgba(255,255,255,0.55)",
    accent: "#E5E4E2",
    border: "rgba(229,228,226,0.20)",
  },
  warm_ivory_gift_card: {
    strip:  "linear-gradient(180deg, #C28B3A 0%, #8C5E1A 100%)",
    body:   "linear-gradient(135deg, #F4ECD8 0%, #E6D6B0 100%)",
    text:   "#3B2A12",
    mute:   "rgba(59,42,18,0.65)",
    accent: "#8C5E1A",
    border: "rgba(140,94,26,0.30)",
  },
  festival_celebration: {
    strip:  "linear-gradient(180deg, #FFC857 0%, #5B1A50 100%)",
    body:   "linear-gradient(135deg, #3D0F36 0%, #1A061A 100%)",
    text:   "#FFE9B8",
    mute:   "rgba(255,233,184,0.70)",
    accent: "#FFC857",
    border: "rgba(255,200,87,0.30)",
  },
};

/** Resolve a backend `template_style` slug into a concrete template.
 *  Unknown / missing slugs fall back to the brand primary. */
export function resolveVoucherTemplate(
  style?: string | null,
): VoucherTemplate {
  const key = (style || "").trim() as VoucherTemplateKey;
  return VOUCHER_TEMPLATES[key] || VOUCHER_TEMPLATES.royal_purple_gold;
}

/**
 * Allowed background-image URL allow-list. We re-check client-side even
 * though the backend already sanitises with `_vrt_clean_url()`, so a
 * misbehaving response can never inject `javascript:`, `data:`, or raw
 * `<svg ...>` into a CSS context.
 *
 * Returns "" -> caller falls back to the template gradient.
 */
export function safeVoucherArtworkUrl(value?: string | null): string {
  const raw = (value == null ? "" : String(value)).trim();
  if (!raw || raw.length > 1000) return "";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\s"'`<>]/.test(raw)) return "";
  const lower = raw.toLowerCase();
  const bad = ["javascript:", "data:", "vbscript:", "file:", "blob:", "about:", "http://"];
  if (bad.some((p) => lower.startsWith(p))) return "";
  if (lower.includes("<svg") || lower.includes("<script")) return "";
  if (raw.startsWith("//")) return "";
  if (!(raw.startsWith("https://") || raw.startsWith("/"))) return "";
  return raw;
}
