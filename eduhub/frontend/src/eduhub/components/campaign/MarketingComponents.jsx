/**
 * MarketingComponents.jsx — reusable parametric marketing components for
 * Campaign Design Studio 2.0. Rendered by CampaignCanvasRenderer for
 * `component` layers (componentId + props), replacing plain text/emoji
 * marketing with premium visual components.
 *
 * SIZING: everything is em-based; the wrapper sets fontSize = cu * size
 * (cu = canvasWidth/100), so components scale identically in the Studio
 * stage and the Dashboard at any width — the "what you see is what ships"
 * guarantee.
 *
 * INTERACTIVITY: only ctaButton is interactive; it routes through the
 * EXISTING artworkClickAction.js vocabulary via the handlers PromotionPanel
 * already owns (navigate/openTopUp). In the Studio (interactive=false) all
 * pointer behavior is disabled.
 */
import { useEffect, useMemo, useState } from "react";
import { makeArtworkClickHandler } from "../../components/artwork/artworkClickAction";

const MONO = "'JetBrains Mono', 'Noto Sans Khmer', monospace";
const SANS = "'Geist', 'Noto Sans Khmer', system-ui, sans-serif";
const DISPLAY = "'Bricolage Grotesque', 'Noto Sans Khmer', system-ui, sans-serif";
const SERIF = "'Fraunces', 'Noto Serif Khmer', serif";

const GOLD = "#D4A843";
const GOLD_GRAD = "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)";
const RUBY = "#B23A48";

function glassBg(mode) {
  return mode === "night"
    ? { background: "rgba(11,23,18,0.45)", border: "1px solid rgba(212,168,67,0.26)", color: "#F1EDE0" }
    : { background: "rgba(250,247,239,0.60)", border: "1px solid rgba(212,168,67,0.30)", color: "#12241B" };
}

/* ────────────────── Offer Badge ────────────────── */
function OfferBadge({ props: p = {} }) {
  const text = p.text || "SPECIAL OFFER";
  return (
    <div style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: "0.5em" }}>
      <svg viewBox="0 0 24 24" style={{ width: "1.5em", height: "1.5em", flexShrink: 0 }} aria-hidden>
        <defs>
          <linearGradient id="ob-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#FFE19A" /><stop offset="0.5" stopColor="#D4A843" /><stop offset="1" stopColor="#9C7A2C" />
          </linearGradient>
        </defs>
        <path d="M12 1.6l2.5 2.1 3.2-.5 1.1 3 3 1.2-.4 3.2 2 2.4-2 2.4.4 3.2-3 1.2-1.1 3-3.2-.5-2.5 2.1-2.5-2.1-3.2.5-1.1-3-3-1.2.4-3.2-2-2.4 2-2.4-.4-3.2 3-1.2 1.1-3 3.2.5z" fill="url(#ob-g)" transform="translate(0 -1) scale(0.96)" />
        <path d="M8.6 12.4l2.2 2.3 4.6-5" stroke="#231A08" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span style={{
        fontFamily: SANS, fontWeight: 800, letterSpacing: "0.12em", textTransform: "uppercase",
        fontSize: "0.72em", padding: "0.5em 1em", borderRadius: "2em",
        background: GOLD_GRAD, color: "#231A08", boxShadow: "0 0.4em 1.4em rgba(212,168,67,0.4)",
        whiteSpace: "nowrap",
      }}>{text}</span>
    </div>
  );
}

/* ────────────────── Discount Card ────────────────── */
function DiscountCard({ props: p = {}, mode }) {
  const value = p.value || "50%";
  const label = p.label || "OFF";
  const caption = p.caption || "All premium books";
  return (
    <div style={{
      ...glassBg(mode), backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
      borderRadius: "1em", padding: "0.9em 1.3em", display: "inline-flex", flexDirection: "column",
      boxShadow: "0 1em 2.4em rgba(0,0,0,0.25)", minWidth: "7em",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.3em" }}>
        <span style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: "2.3em", lineHeight: 1, letterSpacing: "-0.02em", background: GOLD_GRAD, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>{value}</span>
        <span style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: "1.05em", letterSpacing: "0.06em", color: RUBY }}>{label}</span>
      </div>
      <span style={{ fontFamily: SANS, fontWeight: 500, fontSize: "0.62em", letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.75, marginTop: "0.5em" }}>{caption}</span>
    </div>
  );
}

/* ────────────────── Limited Offer Ribbon ────────────────── */
function LimitedRibbon({ props: p = {} }) {
  const text = p.text || "LIMITED TIME";
  return (
    <div style={{ position: "relative", display: "inline-block", filter: "drop-shadow(0 0.5em 1.2em rgba(178,58,72,0.4))" }}>
      <svg viewBox="0 0 200 44" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} aria-hidden>
        <defs>
          <linearGradient id="rb-g" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#8E2836" /><stop offset="0.5" stopColor="#B23A48" /><stop offset="1" stopColor="#8E2836" />
          </linearGradient>
        </defs>
        <path d="M12 0 H188 L200 22 L188 44 H12 L0 22 Z" fill="url(#rb-g)" />
        <path d="M12 2 H188 L198.5 22 L188 42 H12 L1.5 22 Z" fill="none" stroke="rgba(255,225,154,0.55)" strokeWidth="1.4" />
      </svg>
      <span style={{
        position: "relative", fontFamily: SANS, fontWeight: 800, letterSpacing: "0.16em",
        textTransform: "uppercase", fontSize: "0.68em", color: "#FFE9CE",
        padding: "0.75em 2.2em", display: "inline-block", whiteSpace: "nowrap",
      }}>{text}</span>
    </div>
  );
}

/* ────────────────── Glass Label ────────────────── */
function GlassLabel({ props: p = {}, mode }) {
  const text = p.text || "Members only";
  return (
    <span style={{
      ...glassBg(mode), backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
      fontFamily: SANS, fontWeight: 600, fontSize: "0.8em", letterSpacing: "0.04em",
      padding: "0.55em 1.2em", borderRadius: "2em", display: "inline-block",
      boxShadow: "0 0.5em 1.6em rgba(0,0,0,0.18)", whiteSpace: "nowrap",
    }}>{text}</span>
  );
}

/* ────────────────── Countdown — live ticking ────────────────── */
function pad2(n) { return String(Math.max(0, n)).padStart(2, "0"); }

function useCountdown(endsAt) {
  const target = useMemo(() => {
    const t = endsAt ? new Date(endsAt).getTime() : Date.now() + 72 * 3600 * 1000;
    return Number.isFinite(t) ? t : Date.now() + 72 * 3600 * 1000;
  }, [endsAt]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const diff = Math.max(0, Math.floor((target - now) / 1000));
  return {
    days: Math.floor(diff / 86400),
    hours: Math.floor((diff % 86400) / 3600),
    minutes: Math.floor((diff % 3600) / 60),
    seconds: diff % 60,
    expired: diff <= 0,
  };
}

function Countdown({ props: p = {}, mode }) {
  const { days, hours, minutes, seconds, expired } = useCountdown(p.endsAt);
  const showDays = p.showDays !== false;
  const segs = showDays
    ? [[days, "Days"], [hours, "Hrs"], [minutes, "Min"], [seconds, "Sec"]]
    : [[hours + days * 24, "Hrs"], [minutes, "Min"], [seconds, "Sec"]];
  const glass = glassBg(mode);
  return (
    <div data-testid="countdown-timer" style={{ display: "inline-flex", gap: "0.45em", alignItems: "stretch" }}>
      {segs.map(([val, label], i) => (
        <div key={label} style={{ display: "flex", alignItems: "center", gap: "0.45em" }}>
          <div style={{
            ...glass, backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
            borderRadius: "0.55em", padding: "0.5em 0.55em", textAlign: "center", minWidth: "2.5em",
            boxShadow: "0 0.5em 1.4em rgba(0,0,0,0.22)",
          }}>
            <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: "1.25em", lineHeight: 1.05, fontVariantNumeric: "tabular-nums", opacity: expired ? 0.4 : 1 }}>{pad2(val)}</div>
            <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: "0.45em", letterSpacing: "0.2em", textTransform: "uppercase", opacity: 0.66, marginTop: "0.3em" }}>{label}</div>
          </div>
          {i < segs.length - 1 && <span style={{ fontFamily: MONO, fontWeight: 700, color: GOLD, fontSize: "1.05em" }}>:</span>}
        </div>
      ))}
    </div>
  );
}

/* ────────────────── VIP Badge ────────────────── */
function VipBadge({ props: p = {} }) {
  const text = p.text || "VIP";
  return (
    <div style={{ position: "relative", display: "inline-grid", placeItems: "center", width: "4.6em", height: "4.6em", filter: "drop-shadow(0 0.5em 1.4em rgba(212,168,67,0.45))" }}>
      <svg viewBox="0 0 100 100" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} aria-hidden>
        <defs>
          <linearGradient id="vip-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#FFE19A" /><stop offset="0.55" stopColor="#D4A843" /><stop offset="1" stopColor="#9C7A2C" />
          </linearGradient>
        </defs>
        <circle cx="50" cy="50" r="46" fill="none" stroke="url(#vip-g)" strokeWidth="3.4" />
        <circle cx="50" cy="50" r="38.5" fill="rgba(20,14,32,0.88)" stroke="rgba(255,225,154,0.4)" strokeWidth="1" />
        {/* laurel */}
        <g stroke="url(#vip-g)" strokeWidth="2.4" fill="none" strokeLinecap="round">
          <path d="M22 62 q-6 -14 4 -26" /><path d="M20 56 q-4 -2 -8 0" /><path d="M22 47 q-4 -3 -8 -2" /><path d="M26 39 q-3 -4 -7 -4" />
          <path d="M78 62 q6 -14 -4 -26" /><path d="M80 56 q4 -2 8 0" /><path d="M78 47 q4 -3 8 -2" /><path d="M74 39 q3 -4 7 -4" />
        </g>
        <path d="M35 34 l6 8 9 -12 9 12 6 -8 v6 l-3 14 h-24 l-3 -14 z" fill="url(#vip-g)" transform="translate(0 -6) scale(1)" />
      </svg>
      <span style={{ position: "relative", fontFamily: DISPLAY, fontWeight: 800, fontSize: "1.05em", letterSpacing: "0.14em", color: "#FFE9B8", marginTop: "1.2em" }}>{text}</span>
    </div>
  );
}

/* ────────────────── Price Card ────────────────── */
function PriceCard({ props: p = {}, mode }) {
  const price = p.price || "1,500";
  const unit = p.unit || "PTS";
  const strike = p.strike || "";
  const caption = p.caption || "per month";
  return (
    <div style={{
      ...glassBg(mode), backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
      borderRadius: "1em", padding: "1em 1.4em", display: "inline-flex", flexDirection: "column", alignItems: "flex-start",
      boxShadow: "0 1em 2.6em rgba(0,0,0,0.26)",
    }}>
      {strike && (
        <span style={{ fontFamily: MONO, fontSize: "0.66em", textDecoration: "line-through", opacity: 0.55, fontVariantNumeric: "tabular-nums" }}>{strike} {unit}</span>
      )}
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.35em" }}>
        <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: "1.9em", lineHeight: 1.05, fontVariantNumeric: "tabular-nums", background: GOLD_GRAD, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>{price}</span>
        <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: "0.72em", letterSpacing: "0.12em", color: GOLD }}>{unit}</span>
      </div>
      <span style={{ fontFamily: SANS, fontSize: "0.6em", letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.68, marginTop: "0.4em" }}>{caption}</span>
    </div>
  );
}

/* ────────────────── Social Proof ────────────────── */
function SocialProof({ props: p = {}, mode }) {
  const count = p.count || "2,400+";
  const label = p.label || "students already joined";
  const ink = mode === "night" ? "#EFEBDD" : "#14261D";
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "0.7em" }}>
      <div style={{ display: "flex" }}>
        {["#2E7D5B", "#3A6EA5", "#B23A48", "#D4A843"].map((c, i) => (
          <svg key={c} viewBox="0 0 32 32" style={{ width: "1.7em", height: "1.7em", marginLeft: i ? "-0.55em" : 0, filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.3))" }} aria-hidden>
            <circle cx="16" cy="16" r="15" fill={c} stroke="rgba(255,255,255,0.85)" strokeWidth="2" />
            <circle cx="16" cy="12.5" r="5" fill="rgba(255,255,255,0.92)" />
            <path d="M6 27 a10 8 0 0 1 20 0" fill="rgba(255,255,255,0.92)" />
          </svg>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: "0.95em", lineHeight: 1.1, color: ink }}>{count}</span>
        <span style={{ fontFamily: SANS, fontWeight: 500, fontSize: "0.58em", letterSpacing: "0.06em", color: ink, opacity: 0.7 }}>{label}</span>
      </div>
    </div>
  );
}

/* ────────────────── Highlight Number ────────────────── */
function HighlightNumber({ props: p = {}, mode }) {
  const value = p.value || "x2";
  const label = p.label || "Bonus points";
  return (
    <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center" }}>
      <span style={{
        fontFamily: DISPLAY, fontWeight: 800, fontSize: "3em", lineHeight: 0.95, letterSpacing: "-0.03em",
        background: GOLD_GRAD, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
        filter: "drop-shadow(0 0.08em 0.35em rgba(212,168,67,0.4))",
      }}>{value}</span>
      <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: "0.66em", letterSpacing: "0.18em", textTransform: "uppercase", color: mode === "night" ? "rgba(244,240,226,0.8)" : "rgba(14,31,24,0.7)", marginTop: "0.5em" }}>{label}</span>
    </div>
  );
}

/* ────────────────── CTA Button ────────────────── */
function CtaButton({ props: p = {}, mode, interactive, handlers }) {
  const label = p.label || "Learn more";
  const styleId = p.style || "gold";
  const onClick = useMemo(
    () => (interactive ? makeArtworkClickHandler({ click_action: p.action }, handlers || {}) : undefined),
    [interactive, p.action, handlers],
  );
  const visual = styleId === "glass"
    ? { ...glassBg(mode), backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)" }
    : styleId === "outline"
      ? { background: "transparent", color: GOLD, border: `0.14em solid ${GOLD}` }
      : styleId === "ruby"
        ? { background: "linear-gradient(135deg, #C74B59 0%, #B23A48 55%, #8E2836 100%)", color: "#FFEBE4", boxShadow: "0 0.6em 1.8em rgba(178,58,72,0.45)" }
        : styleId === "emerald"
          ? { background: "linear-gradient(135deg, #2E7D5B 0%, #1E5B41 55%, #123F2C 100%)", color: "#EAF6EF", boxShadow: "0 0.6em 1.8em rgba(30,91,65,0.45)" }
          : { background: GOLD_GRAD, color: "#231A08", boxShadow: "0 0.6em 1.8em rgba(212,168,67,0.42)" };

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="campaign-cta-button"
      style={{
        fontFamily: SANS, fontWeight: 800, fontSize: "0.86em", letterSpacing: "0.06em",
        padding: "0.85em 2em", borderRadius: "2.2em", border: "none",
        display: "inline-flex", alignItems: "center", gap: "0.5em",
        cursor: interactive ? "pointer" : "default",
        pointerEvents: interactive ? "auto" : "none",
        whiteSpace: "nowrap",
        transition: "box-shadow 180ms ease, filter 180ms ease",
        ...visual,
      }}
      onMouseEnter={interactive ? (e) => { e.currentTarget.style.filter = "brightness(1.06)"; } : undefined}
      onMouseLeave={interactive ? (e) => { e.currentTarget.style.filter = ""; } : undefined}
    >
      {label}
      <svg viewBox="0 0 20 20" style={{ width: "1em", height: "1em" }} aria-hidden>
        <path d="M4 10h11m-4.5-5L16 10l-5.5 5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/* ────────────────── registry ────────────────── */
export const MARKETING_COMPONENTS = {
  offerBadge: { id: "offerBadge", label: "Offer Badge", Component: OfferBadge, defaults: { text: "SPECIAL OFFER" } },
  discountCard: { id: "discountCard", label: "Discount Card", Component: DiscountCard, defaults: { value: "50%", label: "OFF", caption: "All premium books" } },
  limitedRibbon: { id: "limitedRibbon", label: "Limited Offer Ribbon", Component: LimitedRibbon, defaults: { text: "LIMITED TIME" } },
  glassLabel: { id: "glassLabel", label: "Glass Label", Component: GlassLabel, defaults: { text: "Members only" } },
  countdown: { id: "countdown", label: "Countdown", Component: Countdown, defaults: { endsAt: "", showDays: true } },
  vipBadge: { id: "vipBadge", label: "VIP Badge", Component: VipBadge, defaults: { text: "VIP" } },
  priceCard: { id: "priceCard", label: "Price Card", Component: PriceCard, defaults: { price: "1,500", unit: "PTS", strike: "", caption: "per month" } },
  socialProof: { id: "socialProof", label: "Social Proof", Component: SocialProof, defaults: { count: "2,400+", label: "students already joined" } },
  highlightNumber: { id: "highlightNumber", label: "Highlight Number", Component: HighlightNumber, defaults: { value: "x2", label: "Bonus points" } },
  ctaButton: { id: "ctaButton", label: "CTA Button", Component: CtaButton, defaults: { label: "Top Up Now", style: "gold", action: { type: "topup", value: "" } } },
};

export function getMarketingComponent(componentId) {
  return MARKETING_COMPONENTS[componentId] || null;
}

/** Layer wrapper used by CampaignCanvasRenderer. */
export default function MarketingComponentLayer({ layer, cu, mode, interactive, handlers }) {
  const entry = getMarketingComponent(layer.componentId);
  if (!entry) return null;
  const { Component } = entry;
  const props = { ...entry.defaults, ...(layer.props || {}) };
  return (
    <div style={{ fontSize: cu * (layer.size || 3.4), lineHeight: 1, display: "flex", justifyContent: "center" }}>
      <Component props={props} mode={mode} interactive={interactive} handlers={handlers} />
    </div>
  );
}
