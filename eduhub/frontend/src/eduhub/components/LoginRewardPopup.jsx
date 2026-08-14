/**
 * LoginRewardPopup.jsx — premium floating reward popup for students.
 *
 * v1.1 (premium animation upgrade — corrected hook-order patch)
 * ----------------------------------------------------------------
 * Adds, around the existing reward popup, a *wrapper-based* visual
 * layer so any artwork (default SVG, PNG, JPG, WebP, GIF) lights up
 * with the same premium feel without baking effects into the image.
 *
 * What's new vs. baseline:
 *   • RewardArtworkStage   — breathing aura + drifting sparkles + on-open
 *                            burst + post-claim success burst, layered
 *                            BEHIND/AROUND the existing <img> or
 *                            <FallbackArt>. All layers pointer-events:none.
 *   • AnimatedClaimButton  — sweeping shimmer + soft glow + tap feedback,
 *                            preserves every existing state (idle,
 *                            claiming, disabled, retry, error).
 *   • PointsReadout        — gentle count-up + flash on successful claim
 *                            (the credited amount itself is unchanged —
 *                            backend remains the source of truth).
 *   • RewardCountdown      — optional, OFF by default, never blocks claim
 *                            unless backend already enforces expiry.
 *
 * React hook-order fix (vs. the previously-reverted v1.0 patch):
 *   The earlier patch declared a `useEffect` inside RewardCountdown
 *   AFTER an `if (!enabled || !targetMs) return null;` early-return,
 *   which caused the production build to fail with
 *     "React Hook 'useEffect' is called conditionally."
 *   In this version every hook (useState/useEffect/useMemo/useRef/
 *   useCallback + custom hook) is declared unconditionally at the top
 *   of its component, *before* any conditional return. Booleans such as
 *   `enabled`, `targetMs`, `isZero`, etc. are still computed at the top
 *   so we can early-return at the bottom without skipping a hook.
 *
 * Strict safety guarantees (per surgery brief):
 *   • Claim API behaviour is byte-identical to v1: `claimLoginReward(id)`
 *     is called once per tap, idempotency / single-claim / push are
 *     untouched.
 *   • Backend reward crediting is unchanged. The success count-up is a
 *     purely cosmetic readout of the already-credited amount returned by
 *     the server (or the campaign's announced amount as fallback).
 *   • All animations are CSS-only. No canvas, no Lottie, no new npm dep.
 *   • prefers-reduced-motion → static glow only, particles hidden,
 *     button shimmer disabled. Layout/interactivity unchanged.
 *   • All particle/glow elements use `pointer-events: none` so taps land
 *     on the underlying buttons (Claim, Maybe later, Close, backdrop).
 *   • Backward compatible: campaigns missing the new animation_enabled /
 *     particle_intensity / countdown_* fields render with safe defaults
 *     (animation ON, intensity "premium", countdown OFF).
 *   • Styles are scoped to `.lrp-*` class names + a single <style> tag
 *     so no global CSS leaks. Service worker, AuthContext, claim API,
 *     and push pipeline are not touched.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import {
  getActiveLoginReward,
  claimLoginReward,
  readDismiss,
  writeDismiss,
  clearDismiss,
} from "../lib/loginRewardApi";
import { haptic } from "../lib/haptics";
import RewardExperienceShell from "./rewardExperience/RewardExperienceShell";

/* ─────────────────────────────────────────────────────────────────────── */
/* utilities                                                                */
/* ─────────────────────────────────────────────────────────────────────── */

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(!!mq.matches);
    update();
    if (mq.addEventListener) mq.addEventListener("change", update);
    else if (mq.addListener) mq.addListener(update);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", update);
      else if (mq.removeListener) mq.removeListener(update);
    };
  }, []);
  return reduced;
}

function intensityToParticleCount(intensity) {
  switch ((intensity || "premium").toLowerCase()) {
    case "subtle":      return 6;
    case "celebration": return 16;
    case "premium":
    default:            return 12;
  }
}

function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/* ─────────────────────────────────────────────────────────────────────── */
/* fallback artwork                                                         */
/* ─────────────────────────────────────────────────────────────────────── */
function FallbackArt({ accent = "#D4A843" }) {
  return (
    <svg viewBox="0 0 160 160" width="160" height="160" aria-hidden="true">
      <defs>
        <radialGradient id="lrp_grad" cx="50%" cy="40%">
          <stop offset="0%" stopColor={accent} stopOpacity="1" />
          <stop offset="100%" stopColor={accent} stopOpacity="0.15" />
        </radialGradient>
      </defs>
      <circle cx="80" cy="80" r="64" fill="url(#lrp_grad)" />
      <path d="M52 72h56v44H52z" fill="#fff" stroke="#1a1420" strokeWidth="2.5" />
      <path d="M46 60h68v14H46z" fill={accent} stroke="#1a1420" strokeWidth="2.5" />
      <path d="M80 60v56" stroke="#1a1420" strokeWidth="2.5" />
      <path d="M62 60c-10-16 10-26 18-10 8-16 28-6 18 10" fill="none" stroke="#1a1420" strokeWidth="2.5" />
      <circle cx="36" cy="42" r="4" fill={accent} />
      <circle cx="126" cy="50" r="3" fill={accent} />
      <circle cx="120" cy="118" r="3" fill={accent} />
      <circle cx="40" cy="120" r="3.5" fill={accent} />
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* RewardArtworkStage — animated wrapper around ANY artwork                */
/* ─────────────────────────────────────────────────────────────────────── */
function RewardArtworkStage({
  artworkUrl,
  accent,
  intensity,
  enabled,
  reducedMotion,
  successBurst,
  onImageError,
}) {
  // -- All hooks declared unconditionally at the top --
  const particleCount = enabled && !reducedMotion ? intensityToParticleCount(intensity) : 0;

  // Deterministic-per-mount layout for sparkle positions so they don't
  // recompute every state change but DO vary between popup mounts.
  const sparkles = useMemo(() => {
    const out = [];
    for (let i = 0; i < particleCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 64 + Math.random() * 38;           // px from center
      const x = 50 + (Math.cos(angle) * radius) / 2;    // %
      const y = 50 + (Math.sin(angle) * radius) / 2;    // %
      const size = 4 + Math.random() * 6;
      const delay = Math.random() * 2.2;
      const dur = 2.6 + Math.random() * 2.4;
      const drift = (Math.random() - 0.5) * 18;
      const isStar = Math.random() < 0.42;
      out.push({ x, y, size, delay, dur, drift, isStar, key: i });
    }
    return out;
  }, [particleCount]);

  // Soft on-open burst — fires once when this stage mounts.
  const [openBurst, setOpenBurst] = useState(false);
  useEffect(() => {
    setOpenBurst(true);
    const t = setTimeout(() => setOpenBurst(false), 950);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="lrp-stage" data-testid="lrp-artwork-stage" data-intensity={intensity}>
      {/* Breathing aura — visible even when animation disabled (static halo). */}
      <div
        className={`lrp-aura ${enabled && !reducedMotion ? "lrp-aura-breathe" : ""}`}
        style={{
          background: `radial-gradient(circle at 50% 50%, ${accent}55 0%, ${accent}22 38%, transparent 72%)`,
        }}
        aria-hidden="true"
      />

      {/* Orbiting accent ring — pure CSS, hidden in reduced-motion. */}
      {enabled && !reducedMotion && (
        <div
          className="lrp-ring"
          aria-hidden="true"
          style={{ borderColor: `${accent}55` }}
        />
      )}

      {/* Drifting sparkle particles. pointer-events:none via .lrp-particles. */}
      {sparkles.length > 0 && (
        <div className="lrp-particles" aria-hidden="true">
          {sparkles.map((p) => (
            <span
              key={p.key}
              className={p.isStar ? "lrp-sparkle lrp-sparkle-star" : "lrp-sparkle"}
              style={{
                left: `${p.x}%`,
                top: `${p.y}%`,
                width: `${p.size}px`,
                height: `${p.size}px`,
                animationDelay: `${p.delay}s`,
                animationDuration: `${p.dur}s`,
                background: p.isStar ? accent : `${accent}cc`,
                ["--lrp-drift"]: `${p.drift}px`,
                color: accent,
              }}
            />
          ))}
        </div>
      )}

      {/* Gentle on-open burst pulse */}
      {openBurst && enabled && !reducedMotion && (
        <div
          className="lrp-open-burst"
          aria-hidden="true"
          style={{ borderColor: `${accent}99`, boxShadow: `0 0 36px ${accent}88` }}
        />
      )}

      {/* Stronger success burst after claim */}
      {successBurst && enabled && !reducedMotion && (
        <div className="lrp-success-burst" aria-hidden="true">
          <div className="lrp-success-ring" style={{ borderColor: accent }} />
          <div
            className="lrp-success-ring lrp-success-ring-2"
            style={{ borderColor: `${accent}88` }}
          />
        </div>
      )}

      {/* The artwork itself — unchanged behaviour. */}
      <div className="lrp-art-holder">
        {artworkUrl ? (
          <img
            src={artworkUrl}
            alt="Reward"
            data-testid="lrp-artwork"
            onError={onImageError}
            className="lrp-art-img"
          />
        ) : (
          <FallbackArt accent={accent} />
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* AnimatedClaimButton — preserves all states + adds shimmer + glow         */
/* ─────────────────────────────────────────────────────────────────────── */
function AnimatedClaimButton({
  accent,
  label,
  onClick,
  disabled,
  testid,
  enabled,
  reducedMotion,
}) {
  const animate = enabled && !reducedMotion && !disabled;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-testid={testid}
      className={`lrp-claim-btn ${animate ? "lrp-claim-btn-animate" : ""}`}
      style={{
        background: accent,
        color: "#1a1420",
        boxShadow: `0 10px 22px ${accent}66`,
      }}
    >
      {/* Shimmer sweep — purely decorative, pointer-events:none */}
      {animate && <span className="lrp-shimmer" aria-hidden="true" />}
      <span className="lrp-claim-btn-label">{label}</span>
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* RewardCountdown — optional, safe                                         */
/*                                                                           */
/*  HOOK-ORDER NOTE                                                          */
/*  ----------------                                                         */
/*  The previous (reverted) patch placed a `useEffect` AFTER an              */
/*  `if (!enabled || !targetMs) return null;` early-return, which is the     */
/*  exact lint rule `react-hooks/rules-of-hooks` forbids and which broke     */
/*  the production build. This version follows the strict rule:              */
/*                                                                           */
/*    1. Every hook (useState / useEffect / useMemo / useCallback / useRef   */
/*       / custom hook) is declared at the top of the component.             */
/*    2. We compute booleans (`enabled`, `isZero`, …) before any return.     */
/*    3. Conditional returns happen only AFTER all hooks have run.           */
/* ─────────────────────────────────────────────────────────────────────── */
function RewardCountdown({
  campaign,
  openedAt,
  reducedMotion,
  onZero,
}) {
  const enabled = !!(campaign && campaign.countdown_enabled);
  const mode = (campaign?.countdown_mode || "none").toLowerCase();
  const label = campaign?.countdown_label || "Claim before it expires";
  const urgencyText = campaign?.urgency_text || "";

  // -- HOOK 1 --
  // Resolve target ms whenever inputs change. Returns null when the
  // timer should not appear — the component still calls all hooks
  // before deciding to render nothing.
  const targetMs = useMemo(() => {
    if (!enabled) return null;
    if (mode === "campaign_end") {
      const t = campaign?.end_at ? Date.parse(campaign.end_at) : NaN;
      return Number.isFinite(t) ? t : null;
    }
    if (mode === "expires_after_open") {
      const secs = Number(campaign?.countdown_seconds);
      if (!Number.isFinite(secs) || secs <= 0) return null;
      return (openedAt || Date.now()) + secs * 1000;
    }
    return null;
  }, [enabled, mode, campaign?.end_at, campaign?.countdown_seconds, openedAt]);

  // -- HOOK 2 --
  const [now, setNow] = useState(() => Date.now());

  // -- HOOK 3 --
  // Tick interval. No-ops when the timer is disabled / has no target.
  useEffect(() => {
    if (!enabled || !targetMs) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled, targetMs]);

  // Derived (non-hook) computations — safe to do before the early return.
  const remainSec = targetMs ? Math.max(0, Math.floor((targetMs - now) / 1000)) : 0;
  const isZero = !!targetMs && remainSec === 0;

  // -- HOOK 4 --
  // Notify parent exactly when we cross to zero. Declared unconditionally;
  // body itself is a no-op when the timer is disabled / not at zero, so
  // call order is preserved across every render.
  useEffect(() => {
    if (!enabled) return;
    if (!isZero) return;
    if (typeof onZero === "function") onZero(mode);
    // We only react to the boolean `isZero` flipping true. `mode` /
    // `onZero` are stable per popup mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isZero, enabled]);

  // ── ALL HOOKS DECLARED ABOVE THIS LINE ──────────────────────────────
  // Safe to early-return now.
  if (!enabled || !targetMs) return null;
  // expires_after_open: when zero, silently hide so no fake urgency.
  if (isZero && mode === "expires_after_open") return null;

  return (
    <div
      className={`lrp-countdown ${reducedMotion ? "" : "lrp-countdown-pulse"}`}
      data-testid="lrp-countdown"
      data-mode={mode}
      data-state={isZero ? "zero" : "ticking"}
      role="timer"
      aria-live="polite"
    >
      <span className="lrp-countdown-label" data-testid="lrp-countdown-label">
        {label}
      </span>
      <span className="lrp-countdown-clock" data-testid="lrp-countdown-clock">
        {fmtClock(remainSec)}
      </span>
      {urgencyText && (
        <span className="lrp-countdown-urgency" data-testid="lrp-countdown-urgency">
          {urgencyText}
        </span>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* useCountUp — small hook to animate the success points readout            */
/* ─────────────────────────────────────────────────────────────────────── */
function useCountUp(target, active, durationMs = 900, reducedMotion = false) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!active) { setValue(0); return undefined; }
    if (reducedMotion) { setValue(target); return undefined; }
    let raf = 0;
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / durationMs);
      const eased = 1 - Math.pow(1 - k, 3);
      setValue(Math.round(target * eased));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, active, durationMs, reducedMotion]);
  return value;
}

/* ─────────────────────────────────────────────────────────────────────── */
/* PointsReadout — count-up + flash on success                              */
/* ─────────────────────────────────────────────────────────────────────── */
function PointsReadout({ target, active, accent, reducedMotion, animationEnabled }) {
  const value = useCountUp(target, active, 900, reducedMotion);
  const display = active ? value : target;
  return (
    <div
      className="lrp-points-wrap"
      data-testid="lrp-reward-amount"
      style={{ color: accent }}
    >
      {active && animationEnabled && !reducedMotion && (
        <span className="lrp-points-flash" aria-hidden="true" />
      )}
      <span aria-hidden="true">+</span>
      <span className="lrp-points-num" data-testid="lrp-reward-amount-num">
        {display}
      </span>
      <span className="lrp-points-suffix">PTS</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* main popup                                                              */
/* ─────────────────────────────────────────────────────────────────────── */
/* ─────────────────────────────────────────────────────────────────────── */
/* Reward-kind v1.0.2 — voucher teaser (pre-claim) + reveal (post-claim)     */
/* ─────────────────────────────────────────────────────────────────────── */
const LRP_TEMPLATE_GRADIENTS = {
  royal_purple_gold: ["#2A1A4A", "#D4A843"],
  ocean_blue_glass: ["#0B2545", "#5EE0FF"],
  emerald_learning_pass: ["#053B2C", "#34D399"],
  black_diamond_premium: ["#0A0A0A", "#E5E4E2"],
  warm_ivory_gift_card: ["#F4ECD8", "#C28B3A"],
  festival_celebration: ["#5B1A50", "#FFC857"],
};
function lrpGradientFor(style) {
  const g = LRP_TEMPLATE_GRADIENTS[style] || LRP_TEMPLATE_GRADIENTS.royal_purple_gold;
  return `linear-gradient(135deg, ${g[0]}, ${g[1]})`;
}
function lrpFormatExpiry(iso) {
  if (!iso) return "No expiry";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "No expiry";
  try {
    return "Expires " + d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "Expires " + d.toISOString().slice(0, 10);
  }
}
/** Safe artwork guard mirroring the backend allow-list (https / app-relative only). */
function lrpSafeArtwork(url) {
  const raw = (url || "").trim();
  if (!raw || raw.length > 1000) return "";
  if (/[\s"'`<>]/.test(raw)) return "";
  const low = raw.toLowerCase();
  if (/^(javascript:|data:|vbscript:|file:|blob:|about:|http:\/\/)/.test(low)) return "";
  if (low.includes("<svg") || low.includes("<script")) return "";
  if (raw.startsWith("//")) return "";
  if (!(raw.startsWith("https://") || raw.startsWith("/"))) return "";
  return raw;
}

/** Pre-claim teaser: shows the student what voucher they're about to unlock. */
function VoucherTeaser({ preview, accent, bothRewards }) {
  const p = preview || {};
  const grad = lrpGradientFor(p.template);
  return (
    <div
      data-testid="lrp-voucher-teaser"
      style={{
        marginTop: 12,
        borderRadius: 14,
        padding: "12px 14px",
        background: grad,
        color: "#fff",
        textAlign: "left",
        boxShadow: "0 8px 20px rgba(0,0,0,0.25)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", opacity: 0.85 }}>
        {bothRewards ? "Points + Book Voucher" : "Book Voucher"}
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, marginTop: 2 }}>
        {p.discount_label || "Book Voucher"}
      </div>
      <div style={{ fontSize: 12, opacity: 0.9, marginTop: 2 }}>
        {p.title || "Book Voucher"}
        {p.applies_to_all_books
          ? " · works with all books"
          : p.eligible_book_count
            ? ` · ${p.eligible_book_count} eligible book${p.eligible_book_count === 1 ? "" : "s"}`
            : ""}
      </div>
      <div
        aria-hidden
        style={{
          position: "absolute", right: -18, top: -18, width: 84, height: 84,
          borderRadius: "50%", background: accent, opacity: 0.18,
        }}
      />
    </div>
  );
}

/** Post-claim reveal: artwork, coupon code (DOM text), discount, expiry,
 *  eligible-books summary, and the Use / Save-for-later actions. */
function VoucherReveal({ voucher, accent, message, duplicate, onUse, onSave }) {
  const [copied, setCopied] = useState(false);
  const v = voucher || {};
  const art = lrpSafeArtwork(v.artwork_url);
  const useArt = (v.artwork_mode === "custom_url") && !!art;
  const grad = lrpGradientFor(v.template_style);
  const code = v.coupon_code || "";

  const copyCode = useCallback(async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the code is shown as selectable text anyway */
    }
  }, [code]);

  const eligibilityText = v.applies_to_all_books
    ? "Works with all books"
    : (v.eligible_books && v.eligible_books.length
        ? `Valid on ${v.eligible_books.length} selected book${v.eligible_books.length === 1 ? "" : "s"}`
        : "Works with all books");

  return (
    <div data-testid="lrp-voucher-reveal" style={{ marginTop: 6 }}>
      {message ? (
        <p data-testid="lrp-success-message" className="lrp-success-msg">{message}</p>
      ) : null}

      {/* Voucher card */}
      <div
        style={{
          position: "relative",
          borderRadius: 16,
          overflow: "hidden",
          textAlign: "left",
          color: useArt ? "#fff" : "#fff",
          background: useArt ? "#101622" : grad,
          minHeight: 116,
          boxShadow: "0 12px 28px rgba(0,0,0,0.3)",
        }}
      >
        {useArt ? (
          <img
            src={art}
            alt=""
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
        ) : null}
        <div
          aria-hidden
          style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(0,0,0,0.05) 30%, rgba(0,0,0,0.66))" }}
        />
        <div style={{ position: "relative", padding: "14px 16px" }}>
          <div style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", opacity: 0.9 }}>
            {v.title || "Book Voucher"}
          </div>
          <div data-testid="lrp-voucher-discount" style={{ fontSize: 22, fontWeight: 900, lineHeight: 1.1, marginTop: 2 }}>
            {v.discount_label || "Discount"}
          </div>
          {v.subtitle ? (
            <div style={{ fontSize: 12, opacity: 0.9, marginTop: 2 }}>{v.subtitle}</div>
          ) : null}
          <div style={{ fontSize: 11, opacity: 0.92, marginTop: 6 }}>
            {eligibilityText} · {lrpFormatExpiry(v.expires_at)}
          </div>
        </div>
      </div>

      {/* Coupon code as selectable DOM text + copy */}
      <div
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 10, marginTop: 10, padding: "10px 12px", borderRadius: 12,
          background: "rgba(212,168,67,0.10)", border: `1px dashed ${accent}`,
        }}
      >
        <div style={{ textAlign: "left", minWidth: 0 }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: "#9a8350" }}>
            Coupon code
          </div>
          <code
            data-testid="lrp-voucher-code"
            style={{
              fontSize: 18, fontWeight: 800, letterSpacing: "0.08em",
              color: "#3a2e12", userSelect: "all", wordBreak: "break-all",
            }}
          >
            {code || "—"}
          </code>
        </div>
        <button
          type="button"
          onClick={copyCode}
          data-testid="lrp-voucher-copy"
          style={{
            flexShrink: 0, fontSize: 12, fontWeight: 700, padding: "8px 12px",
            borderRadius: 9, border: "none", cursor: "pointer",
            background: accent, color: "#1a1420",
          }}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>

      {/* Actions */}
      <button
        type="button"
        onClick={onUse}
        data-testid="lrp-voucher-use"
        className="lrp-claim-btn"
        style={{ background: accent, color: "#1a1420", boxShadow: `0 10px 22px ${accent}66`, marginTop: 12 }}
      >
        <span className="lrp-claim-btn-label">{v.cta_label || "Use Voucher"}</span>
      </button>
      <button
        type="button"
        onClick={onSave}
        data-testid="lrp-voucher-save"
        className="lrp-maybe-later"
      >
        Save for later
      </button>
    </div>
  );
}

export default function LoginRewardPopup() {
  // -- ALL HOOKS DECLARED UNCONDITIONALLY AT THE TOP OF THE COMPONENT --
  const { student, renderStudent, isBootstrapping, refreshPoints } = useAuth() || {};
  const location = useLocation();
  const navigate = useNavigate();
  const reducedMotion = usePrefersReducedMotion();

  // Auth gate: we require a confirmed student session BEFORE making any
  // API call. We accept either the legacy GAS `student` (with studentId/
  // password) or the Render-side `renderStudent` (with student_id /
  // clean_id). Either signal means "logged in".
  const isAuthed = useMemo(() => {
    if (isBootstrapping) return false;
    if (student && (student.studentId || student.student_id)) return true;
    if (renderStudent && (renderStudent.clean_id || renderStudent.student_id)) return true;
    return false;
  }, [student, renderStudent, isBootstrapping]);

  const [campaign, setCampaign] = useState(null);
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState(null);
  const [pendingMsg, setPendingMsg] = useState(null);
  const [success, setSuccess] = useState(null);          // { points, message }
  const [imgFailed, setImgFailed] = useState(false);
  const [hardExpired, setHardExpired] = useState(false); // backend-aligned expiry only
  const fetchedKeyRef = useRef(null);

  // Task B — sequential Login Reward campaigns. These refs let us safely
  // re-check the backend for the NEXT eligible campaign after a claim is
  // closed, without re-fetch storms or infinite loops:
  //   inFlightRef          — a fetch is currently running (skip re-entry).
  //   lastLoadRef          — timestamp of the last load (debounce guard).
  //   claimedThisSessionRef — campaign ids already claimed+closed this
  //                           session; we never auto-reopen them even if the
  //                           backend is briefly slow to exclude them. Backend
  //                           remains the source of truth for eligibility —
  //                           this is purely a UI loop guard.
  //   openRef / claimingRef — current open / claiming state read inside the
  //                           load callback without stale closures.
  const inFlightRef = useRef(false);
  const lastLoadRef = useRef(0);
  const claimedThisSessionRef = useRef(new Set());
  const openRef = useRef(false);
  const claimingRef = useRef(false);
  useEffect(() => { openRef.current = open; }, [open]);
  useEffect(() => { claimingRef.current = claiming; }, [claiming]);

  // Identity used as a fetch-once key (so we don't re-fetch on every render
  // but DO re-fetch if the student logs out / in again).
  const identityKey = useMemo(() => {
    const a = student?.studentId || student?.student_id || "";
    const b = renderStudent?.clean_id || renderStudent?.student_id || "";
    return `${a}|${b}`;
  }, [student, renderStudent]);

  // Hide on routes where a celebratory popup would be disruptive (login
  // page, raw library reader full-bleed view, Author Studio).
  const routeAllows = useMemo(() => {
    const p = (location?.pathname || "/").toLowerCase();
    if (p.startsWith("/login")) return false;
    if (p.startsWith("/studio")) return false;
    if (p.startsWith("/library/read")) return false;
    return true;
  }, [location]);

  // Reusable loader (Task B). Asks the backend for the highest-priority
  // eligible UNCLAIMED Login Reward campaign and opens the popup for it.
  // The backend (`/login-campaigns/active`) is the single source of truth:
  // it already hides campaigns the student has truly credited, so calling
  // this again after a claim naturally surfaces the next eligible campaign
  // (or nothing). Guards prevent re-entry, rapid repeats, and reopening a
  // campaign already handled in this session.
  const loadActiveCampaign = useCallback(async ({ force = false } = {}) => {
    if (!isAuthed || !routeAllows) return;
    if (!identityKey || identityKey === "|") return;
    // Never override a popup the student is currently looking at / claiming.
    if (openRef.current || claimingRef.current) return;
    if (inFlightRef.current) return;
    const nowTs = Date.now();
    if (!force && nowTs - lastLoadRef.current < 800) return; // debounce
    lastLoadRef.current = nowTs;
    inFlightRef.current = true;
    try {
      const data = await getActiveLoginReward();
      const c = data?.campaign;
      if (!c || !c.id) return;
      // Loop guard: a campaign already claimed+closed this session is never
      // auto-reopened (backend is still the authority on eligibility).
      if (claimedThisSessionRef.current.has(c.id)) return;
      // Dismiss memory (UI-only suppression).
      const d = readDismiss(c.id);
      const mode = c.dismiss_mode || "next_login";
      if (d) {
        if (mode === "never") return;
        if (mode === "after_24h") {
          const elapsed = Date.now() - (d.at || 0);
          if (elapsed < 24 * 60 * 60 * 1000) return;
        }
        // next_login → show again on this fresh mount.
      }
      // Fresh campaign — reset any stale per-campaign UI state.
      setSuccess(null);
      setClaimError(null);
      setHardExpired(false);
      setImgFailed(false);
      setCampaign(c);
      setOpen(true);
      setOpenedAt(Date.now());
      const cs = (c.claim_status || "").toLowerCase();
      if (cs === "pending" || cs === "stale_pending") {
        setPendingMsg(
          "Reward is still processing. Please wait a moment and tap Retry.",
        );
      } else {
        setPendingMsg(null);
      }
    } catch (err) {
      // Silent: never block the app if the rewards endpoint fails.
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[LoginRewardPopup] active fetch failed:", err?.message || err);
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [isAuthed, routeAllows, identityKey]);

  // Initial fetch — once per identity (logout/login re-triggers it).
  useEffect(() => {
    if (!isAuthed || !routeAllows) return undefined;
    if (!identityKey || identityKey === "|") return undefined;
    if (fetchedKeyRef.current === identityKey) return undefined;
    fetchedKeyRef.current = identityKey;
    // New identity → reset the session loop guard.
    claimedThisSessionRef.current = new Set();
    loadActiveCampaign({ force: true });
    return undefined;
  }, [isAuthed, routeAllows, identityKey, loadActiveCampaign]);

  // Task B bridge — the Login Mystery popup dispatches this event once its
  // flow resolves (claimed-today on cold start, or fresh reveal closed) so a
  // normal Login Reward campaign can surface in the same session.
  useEffect(() => {
    const handler = () => { loadActiveCampaign({ force: false }); };
    window.addEventListener("eduhub:login-rewards-refresh", handler);
    return () => window.removeEventListener("eduhub:login-rewards-refresh", handler);
  }, [loadActiveCampaign]);

  const handleDismiss = useCallback(() => {
    if (!campaign) return;
    writeDismiss(campaign.id, campaign.dismiss_mode || "next_login");
    setOpen(false);
  }, [campaign]);

  const handleClaim = useCallback(async () => {
    if (!campaign || claiming) return;
    haptic.tick();
    setClaiming(true); setClaimError(null); setPendingMsg(null);
    try {
      const res = await claimLoginReward(campaign.id);
      // v1.1 — explicit response handling.
      //
      //   { success:true, status:"credited", ... }      → success
      //   { success:true, duplicate:true, already_claimed:true, status:"credited" } → success
      //   { success:false, status:"pending", ... }      → safe retry-later message
      //   non-2xx (HTTPException)                       → caught below
      if (res?.success && (res?.status === "credited" || res?.already_claimed)) {
        const pts = Number(res?.points_awarded || campaign.reward_points || 0);
        // Reward-kind v1.0.2 — the claim response carries the issued voucher
        // (for "voucher" and "points_voucher" campaigns). The coupon code is
        // backend-generated and revealed here. reward_kind drives the layout.
        const kind = (res?.reward_kind || campaign.reward_kind || "points");
        setSuccess({
          points: pts,
          message: res?.success_message || campaign.success_message || "Your reward has been credited!",
          duplicate: !!res?.duplicate || !!res?.already_claimed,
          reward_kind: kind,
          voucher: res?.voucher || null,
        });
        haptic.success();
        clearDismiss(campaign.id);
        try { if (typeof refreshPoints === "function") refreshPoints(); } catch { /* ignore */ }
      } else if (res?.status === "pending") {
        // Backend returned 202 — another in-flight attempt still owns the row.
        setPendingMsg(
          res?.detail ||
            "Reward is still processing. Please wait a moment and tap Claim again.",
        );
      } else {
        setClaimError(res?.detail || "Could not claim reward. Please try again.");
      }
    } catch (err) {
      // HTTP error path: surface the backend detail message so the student
      // sees a friendly retry hint (e.g. "Points credit failed: …").
      setClaimError(err?.message || "Could not claim reward. Please try again.");
    } finally {
      setClaiming(false);
    }
  }, [campaign, claiming, refreshPoints]);

  // Task B — closing a SUCCESSFUL claim re-checks the backend for the next
  // eligible Login Reward campaign. The just-claimed campaign is recorded in
  // the session loop guard and the popup state is cleared before re-fetching,
  // so the backend can hand us the next campaign (or nothing). No reward is
  // re-credited here — this only drives popup visibility.
  const handleSuccessClose = useCallback(() => {
    const claimedId = campaign?.id;
    if (claimedId) claimedThisSessionRef.current.add(claimedId);
    setOpen(false);
    setSuccess(null);
    setCampaign(null);
    setClaimError(null);
    setPendingMsg(null);
    // openRef is updated by its effect on the next render; force a re-check
    // shortly after so we don't race the close.
    setTimeout(() => { loadActiveCampaign({ force: true }); }, 350);
  }, [campaign, loadActiveCampaign]);

  // Called by RewardCountdown when it hits zero. We only honour it for
  // "campaign_end" because that matches backend-enforced expiry.
  const handleCountdownZero = useCallback((mode) => {
    if (mode === "campaign_end") setHardExpired(true);
  }, []);

  // ── ALL HOOKS DECLARED ABOVE THIS LINE ──────────────────────────────
  // Safe to early-return now without breaking hook order on next render.
  if (!open || !campaign) return null;

  const accent = campaign.accent_color || "#D4A843";
  const showArt = campaign.artwork_url && !imgFailed;
  const animationEnabled = campaign.animation_enabled !== false; // default ON
  const intensity = (campaign.particle_intensity || "premium").toLowerCase();

  // Reward-kind v1.0.2 — drive the popup layout. Pre-claim uses the
  // campaign's reward_kind + voucher_preview; post-claim uses the actual
  // claim result (success.reward_kind + success.voucher).
  const rewardKind = (success?.reward_kind || campaign.reward_kind || "points");
  const kindHasPoints = rewardKind === "points" || rewardKind === "points_voucher";
  const kindHasVoucher = rewardKind === "voucher" || rewardKind === "points_voucher";
  const voucherPreview = campaign.voucher_preview || null;
  const goUseVoucher = () => {
    const code = success?.voucher?.coupon_code || "";
    if (campaign?.id) claimedThisSessionRef.current.add(campaign.id);
    setOpen(false);
    try {
      navigate(`/library?voucher=${encodeURIComponent(code)}`);
    } catch {
      window.location.assign(`/library?voucher=${encodeURIComponent(code)}`);
    }
  };

  const claimDisabled = claiming || hardExpired;
  const claimLabel = claiming
    ? "Claiming…"
    : hardExpired
      ? "Expired"
      : pendingMsg
        ? "Retry"
        : claimError
          ? "Retry"
          : (campaign.cta_text || "Claim Reward");

  return (
    // Reward Experience Engine v1 — purely presentational wrapper. With no
    // campaign.experience configured it renders children as-is (legacy
    // pixel-identical). Claim logic, countdown, dismiss and API calls below
    // are untouched.
    <RewardExperienceShell
      experience={campaign.experience}
      accent={accent}
      phase={success ? "success" : "idle"}
      reducedMotion={reducedMotion}
    >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lrp-title"
      data-testid="login-reward-popup"
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: "rgba(8,5,15,0.62)", backdropFilter: "blur(6px)" }}
    >
      {/* dim background catch — clicking outside dismisses (UI-only) */}
      <button
        aria-label="Close reward popup"
        data-testid="lrp-backdrop"
        onClick={success ? handleSuccessClose : handleDismiss}
        className="absolute inset-0 cursor-default"
        style={{ background: "transparent" }}
      />

      <div
        className="lrp-card"
        style={{
          background: "linear-gradient(180deg, #fff8ec 0%, #ffe9c7 100%)",
          color: "#1a1420",
          boxShadow: "0 24px 60px -12px rgba(0,0,0,0.55)",
        }}
      >
        <button
          onClick={success ? handleSuccessClose : handleDismiss}
          aria-label="Dismiss"
          data-testid="lrp-close-btn"
          className="lrp-close-btn"
          style={{ background: "rgba(0,0,0,0.08)", color: "#1a1420" }}
        >
          ×
        </button>

        {/* ─── Hero artwork stage ──────────────────────────────────────── */}
        <div className="lrp-hero">
          <RewardArtworkStage
            artworkUrl={showArt ? campaign.artwork_url : ""}
            accent={accent}
            intensity={intensity}
            enabled={animationEnabled}
            reducedMotion={reducedMotion}
            successBurst={!!success}
            onImageError={() => setImgFailed(true)}
          />
        </div>

        {/* ─── Content ─────────────────────────────────────────────────── */}
        <div className="px-5 pb-5 text-center">
          <div
            className="lrp-badge"
            data-testid="lrp-badge"
            style={{ background: accent, color: "#1a1420" }}
          >
            Login Reward
          </div>

          <h2 id="lrp-title" data-testid="lrp-title" className="lrp-title">
            {success ? "🎉 You got it!" : (campaign.title || "Welcome back!")}
          </h2>

          {!success && (
            <p data-testid="lrp-subtitle" className="lrp-subtitle">
              {campaign.subtitle || "Claim your surprise learning points today."}
            </p>
          )}

          {/* Points readout — only for point-bearing campaigns. A
              voucher-only campaign hides this entirely (see teaser below). */}
          {kindHasPoints && (
            <PointsReadout
              target={success ? success.points : Number(campaign.reward_points ?? 0)}
              active={!!success}
              accent={accent}
              reducedMotion={reducedMotion}
              animationEnabled={animationEnabled}
            />
          )}

          {/* Pre-claim voucher teaser (voucher-only or points+voucher). */}
          {!success && kindHasVoucher && (
            <VoucherTeaser
              preview={voucherPreview}
              accent={accent}
              bothRewards={kindHasPoints}
            />
          )}

          {success ? (
            <>
              {kindHasVoucher && success.voucher ? (
                <VoucherReveal
                  voucher={success.voucher}
                  accent={accent}
                  message={success.message}
                  duplicate={success.duplicate}
                  onUse={goUseVoucher}
                  onSave={handleSuccessClose}
                />
              ) : (
                <>
                  <p data-testid="lrp-success-message" className="lrp-success-msg">
                    {success.message}
                  </p>
                  <button
                    onClick={handleSuccessClose}
                    data-testid="lrp-done-btn"
                    className="lrp-claim-btn lrp-done-btn"
                    style={{ background: accent, color: "#1a1420", boxShadow: `0 10px 22px ${accent}66` }}
                  >
                    <span className="lrp-claim-btn-label">Done</span>
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              {claimError && (
                <div
                  data-testid="lrp-claim-error"
                  className="lrp-claim-error"
                  style={{
                    background: "rgba(255,80,80,0.12)",
                    border: "1px solid rgba(255,80,80,0.35)",
                    color: "#b91c1c",
                  }}
                >
                  {claimError}
                </div>
              )}
              {pendingMsg && !claimError && (
                <div
                  data-testid="lrp-pending-msg"
                  className="lrp-claim-error"
                  style={{
                    background: "rgba(96,165,250,0.14)",
                    border: "1px solid rgba(96,165,250,0.4)",
                    color: "#1d4ed8",
                  }}
                >
                  {pendingMsg}
                </div>
              )}

              {/* Optional countdown — never blocks claim unless backend agrees */}
              <RewardCountdown
                campaign={campaign}
                openedAt={openedAt || Date.now()}
                reducedMotion={reducedMotion}
                onZero={handleCountdownZero}
              />

              <AnimatedClaimButton
                accent={accent}
                label={claimLabel}
                onClick={handleClaim}
                disabled={claimDisabled}
                testid="lrp-claim-btn"
                enabled={animationEnabled}
                reducedMotion={reducedMotion}
              />

              <button
                onClick={handleDismiss}
                data-testid="lrp-dismiss-btn"
                className="lrp-maybe-later"
              >
                Maybe later
              </button>
            </>
          )}
        </div>
      </div>

      {/* ─── scoped styles (single tag, .lrp-* prefix, no global leakage) ─ */}
      <style>{`
        .lrp-card {
          position: relative;
          width: 100%;
          max-width: 360px;
          border-radius: 28px;
          overflow: hidden;
          animation: lrp-pop 420ms cubic-bezier(.2,.7,.2,1);
        }
        .lrp-close-btn {
          position: absolute;
          top: 12px; right: 12px;
          z-index: 30;
          display: grid;
          place-items: center;
          height: 36px; width: 36px;
          border-radius: 9999px;
          border: none;
          cursor: pointer;
        }
        .lrp-hero {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 28px 0 4px;
        }
        .lrp-stage {
          position: relative;
          height: 200px;
          width: 200px;
          display: grid;
          place-items: center;
        }
        .lrp-aura {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          filter: blur(8px);
          pointer-events: none;
        }
        .lrp-aura-breathe { animation: lrp-breathe 3.6s ease-in-out infinite; }
        .lrp-ring {
          position: absolute;
          inset: 12px;
          border-radius: 50%;
          border: 1px dashed;
          opacity: 0.55;
          pointer-events: none;
          animation: lrp-spin 18s linear infinite;
        }
        .lrp-particles {
          position: absolute;
          inset: 0;
          pointer-events: none;
        }
        .lrp-sparkle {
          position: absolute;
          border-radius: 50%;
          transform: translate(-50%, -50%);
          opacity: 0;
          animation-name: lrp-float;
          animation-timing-function: ease-in-out;
          animation-iteration-count: infinite;
          box-shadow: 0 0 6px currentColor;
          pointer-events: none;
        }
        .lrp-sparkle-star {
          border-radius: 0;
          clip-path: polygon(
            50% 0, 61% 35%, 98% 35%, 68% 57%,
            79% 91%, 50% 70%, 21% 91%, 32% 57%,
            2% 35%, 39% 35%
          );
        }
        .lrp-open-burst {
          position: absolute;
          inset: 18px;
          border-radius: 50%;
          border: 2px solid;
          pointer-events: none;
          animation: lrp-burst 900ms ease-out forwards;
        }
        .lrp-success-burst {
          position: absolute;
          inset: 0;
          pointer-events: none;
        }
        .lrp-success-ring {
          position: absolute;
          inset: 20px;
          border-radius: 50%;
          border: 2px solid;
          opacity: 0;
          animation: lrp-success-ring 1.2s ease-out forwards;
        }
        .lrp-success-ring-2 { animation-delay: 180ms; }

        .lrp-art-holder {
          position: relative;
          z-index: 2;
          display: grid;
          place-items: center;
        }
        .lrp-art-img {
          height: 160px;
          width: auto;
          object-fit: contain;
          filter: drop-shadow(0 12px 20px rgba(0,0,0,0.25));
        }

        .lrp-badge {
          display: inline-block;
          font-size: 10.5px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          border-radius: 9999px;
          padding: 2px 10px;
        }
        .lrp-title {
          font-size: 20px;
          font-weight: 900;
          margin-top: 8px;
          line-height: 1.15;
        }
        .lrp-subtitle {
          font-size: 12.5px;
          color: #5b4632;
          margin-top: 4px;
          line-height: 1.35;
        }

        .lrp-points-wrap {
          position: relative;
          margin-top: 12px;
          font-size: 36px;
          font-weight: 900;
          line-height: 1;
          display: inline-flex;
          align-items: baseline;
          gap: 2px;
        }
        .lrp-points-flash {
          position: absolute;
          inset: -10px -22px;
          border-radius: 16px;
          background: radial-gradient(closest-side, currentColor 0%, transparent 70%);
          opacity: 0;
          animation: lrp-flash 900ms ease-out forwards;
          pointer-events: none;
        }
        .lrp-points-num { display: inline-block; min-width: 1ch; }
        .lrp-points-suffix {
          font-size: 18px;
          font-weight: 800;
          letter-spacing: 0.02em;
          margin-left: 4px;
          opacity: 0.85;
        }

        .lrp-claim-btn {
          position: relative;
          margin-top: 16px;
          width: 100%;
          border-radius: 9999px;
          padding: 12px 16px;
          font-size: 13px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          border: none;
          cursor: pointer;
          overflow: hidden;
          transition: transform 120ms ease, opacity 120ms ease;
          isolation: isolate;
        }
        .lrp-claim-btn:disabled { opacity: 0.7; cursor: default; }
        .lrp-claim-btn:active:not(:disabled) { transform: scale(0.98); }
        .lrp-claim-btn-animate { animation: lrp-glow-pulse 2.4s ease-in-out infinite; }
        .lrp-claim-btn-label { position: relative; z-index: 2; }
        .lrp-shimmer {
          position: absolute;
          inset: 0;
          z-index: 1;
          pointer-events: none;
          background: linear-gradient(
            105deg,
            transparent 30%,
            rgba(255,255,255,0.55) 50%,
            transparent 70%
          );
          transform: translateX(-120%);
          animation: lrp-shimmer 2.6s ease-in-out infinite;
        }
        .lrp-done-btn { margin-top: 16px; }

        .lrp-maybe-later {
          margin-top: 8px;
          background: transparent;
          border: none;
          color: #5b4632;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          cursor: pointer;
        }

        .lrp-claim-error {
          margin-top: 12px;
          border-radius: 10px;
          padding: 8px 12px;
          font-size: 11.5px;
        }

        .lrp-success-msg {
          font-size: 12.5px;
          color: #5b4632;
          margin-top: 8px;
          line-height: 1.4;
        }

        .lrp-countdown {
          margin-top: 14px;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          border-radius: 9999px;
          background: rgba(0,0,0,0.06);
          border: 1px solid rgba(0,0,0,0.1);
          font-size: 11px;
          font-weight: 700;
          color: #4a2f10;
          flex-wrap: wrap;
          justify-content: center;
          max-width: 100%;
        }
        .lrp-countdown-clock {
          font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
          font-size: 12px;
          letter-spacing: 0.04em;
          color: #1a1420;
          background: rgba(255,255,255,0.7);
          border-radius: 6px;
          padding: 2px 6px;
        }
        .lrp-countdown-urgency {
          font-size: 10.5px;
          font-weight: 700;
          color: #b35900;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .lrp-countdown-pulse[data-state="ticking"] .lrp-countdown-clock {
          animation: lrp-clock-pulse 1.2s ease-in-out infinite;
        }
        .lrp-countdown[data-state="zero"] .lrp-countdown-clock {
          background: rgba(220,80,80,0.18);
          color: #991b1b;
        }

        /* keyframes */
        @keyframes lrp-pop {
          0%   { transform: scale(0.85) translateY(20px); opacity: 0; }
          70%  { transform: scale(1.02) translateY(0);    opacity: 1; }
          100% { transform: scale(1) translateY(0);       opacity: 1; }
        }
        @keyframes lrp-breathe {
          0%, 100% { transform: scale(1);    opacity: 0.85; }
          50%      { transform: scale(1.07); opacity: 1;    }
        }
        @keyframes lrp-spin {
          0%   { transform: rotate(0deg);   }
          100% { transform: rotate(360deg); }
        }
        @keyframes lrp-float {
          0%   { opacity: 0; transform: translate(-50%, -50%) translateY(0)            scale(0.6); }
          25%  { opacity: 1; }
          75%  { opacity: 0.9; }
          100% { opacity: 0; transform: translate(-50%, -50%) translateY(-18px) translateX(var(--lrp-drift, 0)) scale(1.05); }
        }
        @keyframes lrp-burst {
          0%   { transform: scale(0.7); opacity: 1; }
          80%  { opacity: 0.5; }
          100% { transform: scale(1.4); opacity: 0; }
        }
        @keyframes lrp-success-ring {
          0%   { transform: scale(0.5); opacity: 1; }
          100% { transform: scale(1.8); opacity: 0; }
        }
        @keyframes lrp-shimmer {
          0%   { transform: translateX(-120%); }
          55%  { transform: translateX(120%);  }
          100% { transform: translateX(120%);  }
        }
        @keyframes lrp-glow-pulse {
          0%,100% { filter: brightness(1)    drop-shadow(0 0 0 transparent); }
          50%     { filter: brightness(1.08) drop-shadow(0 0 14px rgba(255,225,154,0.55)); }
        }
        @keyframes lrp-flash {
          0%   { opacity: 0.85; transform: scale(0.85); }
          100% { opacity: 0;    transform: scale(1.35); }
        }
        @keyframes lrp-clock-pulse {
          0%, 100% { transform: scale(1);    }
          50%      { transform: scale(1.05); }
        }

        /* Respect reduced motion — strip every motion, keep static glow. */
        @media (prefers-reduced-motion: reduce) {
          .lrp-aura-breathe,
          .lrp-ring,
          .lrp-particles,
          .lrp-open-burst,
          .lrp-success-burst,
          .lrp-shimmer,
          .lrp-claim-btn-animate,
          .lrp-countdown-pulse[data-state="ticking"] .lrp-countdown-clock,
          .lrp-points-flash {
            animation: none !important;
          }
          .lrp-card { animation: none !important; }
        }
      `}</style>
    </div>
    </RewardExperienceShell>
  );
}
