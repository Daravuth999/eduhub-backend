/* eslint-disable react/prop-types */
// =============================================================================
// PointsGateModal.jsx  —  EduHub Reader Phase 3
//
// Inline contextual top-up modal shown when a student taps an EduTalk-related
// feature (start session, voice reply) and has insufficient points.
//
// The student NEVER leaves the book. The modal:
//   • Explains what they were trying to do and its cost
//   • Lists active top-up packages via the existing public endpoint
//     GET /api/payments/packages/public (no auth required)
//   • Highlights one recommended package (configurable in Author Studio)
//   • Shows the ABA PayWay payment instruction (manual scan flow already
//     used elsewhere in the app — we deliberately keep it simple here)
//   • Listens to AuthContext's refreshPoints / portalPoints for a balance
//     bump and auto-dismisses + auto-resumes the original feature when
//     points become sufficient (when topup_after_behaviour = "auto_start").
//
// Hard rules respected:
//   • NEVER auto-deducts points. Only the parent feature deducts after the
//     student explicitly taps to resume.
//   • Read-only on prices. No editing.
//   • Languages: Khmer / English / both, driven by cfg.topup_prompt_lang.
// =============================================================================
import React, { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../../context/AuthContext";
import PointsPurchaseModal from "../../portal/components/dashboard/PointsPurchaseModal";

// v1.5 — Normalise a package object returned by /api/payments/packages/public
// (uses `points_amount`) into the shape expected by PointsPurchaseModal's
// `preselectedPackage` prop (uses `points`).  No backend schema change.
function _normalizePackageForPurchase(p) {
  if (!p || typeof p !== "object") return null;
  return {
    _id: p._id || p.id || (p.amount_khr != null ? String(p.amount_khr) : ""),
    name: p.name || p.label || "",
    label: p.label || p.name || "",
    points: Number(p.points != null ? p.points : (p.points_amount || 0)) || 0,
    bonus_points: Number(p.bonus_points || 0) || 0,
    amount_khr: Number(p.amount_khr || 0) || 0,
    original_amount_khr: Number(p.original_amount_khr || p.amount_khr || 0) || 0,
    discounted_amount_khr: Number(p.discounted_amount_khr || 0) || 0,
    discount_active_live: !!p.discount_active_live,
    discount_pct: Number(p.discount_pct || 0) || 0,
    active: p.active !== false,
  };
}

// v1.4 — Backend URL with safe production fallback so the top-up modal can
// always reach the public packages endpoint, even when the build-time env
// variable was not injected (the symptom users hit: "Backend URL is not
// configured." / "Could not load top-up packages.").
//
// Precedence (per controlled v1.4 fix brief):
//   1. process.env.REACT_APP_BACKEND_URL
//   2. process.env.REACT_APP_API_BASE_URL
//   3. production Render fallback
//
// Trailing slash is stripped so we never produce "//api/...".
const BACKEND = (
  (typeof process !== "undefined" && process.env && process.env.REACT_APP_BACKEND_URL) ||
  (typeof process !== "undefined" && process.env && process.env.REACT_APP_API_BASE_URL) ||
  "https://eduhub-backend-td3a.onrender.com"
).replace(/\/$/, "");

const POLL_INTERVAL_MS = 6000; // gentle balance refresh while modal is open

// v1 — robust public-packages fetch.
// Root cause of "Could not load top-up packages.": the previous code
// (a) did not normalise `BACKEND` (`BACKEND="https://x/"` → `"//api/..."`
// → 404), (b) skipped `r.ok` so a 5xx HTML body would land in `.json()`
// and throw silently into the catch, and (c) had no Retry path so a
// transient network blip required reopening the modal.
//
// This helper:
//   • normalises the URL,
//   • respects an optional AbortSignal,
//   • checks `r.ok` and Content-Type,
//   • parses JSON defensively (text → JSON.parse with try/catch),
//   • returns the validated packages array or throws an Error with a
//     short user-friendly reason in `.message`.
//
// It does NOT change the public endpoint, schema, payment flow, or any
// backend route.
async function fetchTopupPackages(signal) {
  // v1.4 — BACKEND now has a production fallback (see top of file), so the
  // legacy "Backend URL is not configured." short-circuit is no longer
  // reachable and has been removed. Network/HTTP failures are still surfaced
  // as friendly errors below so the Retry button can recover.
  let r;
  try {
    r = await fetch(`${BACKEND}/api/payments/packages/public`, {
      method: "GET",
      signal,
      // public endpoint — no credentials required, matches existing behaviour
    });
  } catch (netErr) {
    const e = new Error("Network error. Check your connection and retry.");
    e.kind = "network";
    e.cause = netErr;
    throw e;
  }
  if (!r.ok) {
    const e = new Error(`Server returned ${r.status}. Please retry.`);
    e.kind = "http";
    e.status = r.status;
    throw e;
  }
  let text = "";
  try {
    text = await r.text();
  } catch (readErr) {
    const e = new Error("Empty response from server. Please retry.");
    e.kind = "read";
    e.cause = readErr;
    throw e;
  }
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (parseErr) {
    const e = new Error("Unexpected response from server. Please retry.");
    e.kind = "parse";
    e.cause = parseErr;
    throw e;
  }
  if (!data || data.ok !== true || !Array.isArray(data.packages)) {
    const e = new Error("Top-up packages are not available right now.");
    e.kind = "shape";
    throw e;
  }
  return data.packages;
}

const DEFAULT_KH =
  "មុខងារនេះត្រូវការ {cost} ពិន្ទុ។ សមតុល្យបច្ចុប្បន្នរបស់អ្នកគឺ {balance} ពិន្ទុ។ សូមបញ្ចូលពិន្ទុមុនបន្ត។";
const DEFAULT_EN =
  "This feature costs {cost} points. Your current balance is {balance} points. Please top up to continue.";

function applyTemplate(s, cost, balance) {
  return String(s || "")
    .replace(/\{cost\}/g, String(cost))
    .replace(/\{balance\}/g, String(balance));
}

function formatKHR(n) {
  const v = Math.round(Number(n || 0));
  return v.toLocaleString("en-US");
}

/**
 * @typedef {Object} PointsGateModalProps
 * @property {boolean} open
 * @property {() => void} onClose
 * @property {number} requiredPoints
 * @property {number} balance
 * @property {string} featureLabel       Short label like "Start EduTalk" / "Voice Reply"
 * @property {object} [config]           Resolved EduTalk book config (topup_*, upgrade_prompt_*)
 * @property {string} [preferredLang]    "kh" | "en"
 * @property {() => void} [onResume]     Called when balance becomes sufficient
 * @property {string} [resumeBehaviour]  "auto_start" | "return_to_book"
 */

export default function PointsGateModal({
  open,
  onClose,
  requiredPoints,
  balance,
  featureLabel,
  config,
  preferredLang,
  onResume,
  resumeBehaviour,
  // Part 2 — promotion-aware banner support.  When `promotionAware` is on
  // and `activeBanners` is non-empty, a small banner appears inside the
  // modal so the student sees the flash-sale copy at the moment of
  // top-up.  These props are optional and default to off, so existing
  // call sites (any place still calling the legacy 3-arg shape) keep
  // working exactly as before.
  promotionAware = false,
  activeBanners = [],
  triggerReason = "insufficient",
}) {
  const { refreshPoints, portalPoints, student } = useAuth() || {};
  const [packages, setPackages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [autoResumed, setAutoResumed] = useState(false);
  // v1.5 — Real-payment-modal wiring.  When the student taps a package card
  // (or the primary "បញ្ចូលពិន្ទុ / Top Up" CTA), we open the existing
  // working PointsPurchaseModal (used by the Library header top-up button)
  // with the chosen package pre-selected.  PointsGateModal NEVER creates a
  // payment intent itself; it only routes to the real payment modal.
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [preselectedPackage, setPreselectedPackage] = useState(null);

  // Resolve language to display the prompt in.
  const lang = useMemo(() => {
    const cfgLang = (config?.topup_prompt_lang || "both").toLowerCase();
    if (cfgLang === "khmer") return "kh";
    if (cfgLang === "english") return "en";
    if (preferredLang === "en") return "en";
    return "kh"; // default → Khmer (Cambodian learners)
  }, [config, preferredLang]);
  const showBoth =
    String(config?.topup_prompt_lang || "both").toLowerCase() === "both";

  const liveBalance =
    typeof portalPoints === "number" ? portalPoints : Number(balance || 0);
  const need = Math.max(0, Number(requiredPoints || 0));
  const sufficient = liveBalance >= need;
  const showPackages = config?.topup_show_packages !== false;
  const highlightRec = config?.topup_highlight_recommended !== false;
  const recLabelKh = (config?.topup_recommended_label_kh || "ស្នើ").slice(0, 40);
  const recLabelEn = (config?.topup_recommended_label_en || "Recommended").slice(0, 40);
  const behaviour = resumeBehaviour || config?.topup_after_behaviour || "auto_start";

  // -----------------------------------------------------------------------
  // Premium Smart Badge — driven entirely by Author Studio config.
  // Returns null when disabled.  Promotion-aware mode lets the badge copy
  // reflect the FIRST active promotion banner when present, otherwise
  // falls back to the admin-configured text.  Empty admin text falls back
  // to a NON-CLAIM safe default ("Best Value" / "តម្លៃល្អ") so the UI
  // never breaks on a blank config AND never invents a fake discount.
  // No payment / discount logic is touched.
  // -----------------------------------------------------------------------
  const badge = useMemo(() => {
    if (config?.topup_badge_enabled === false) return null;
    const style = String(config?.topup_badge_style || "bonus")
      .toLowerCase()
      .replace(/[^a-z_]/g, "")
      .slice(0, 30) || "bonus";
    const promoAware = config?.topup_badge_promotion_aware !== false;
    const activeBanner =
      promoAware && promotionAware &&
      Array.isArray(activeBanners) && activeBanners.length > 0
        ? activeBanners[0] || null
        : null;
    if (activeBanner) {
      const promoText =
        (lang === "en"
          ? (activeBanner.tag_text_en || activeBanner.banner_tag_en || "")
          : (activeBanner.tag_text_kh || activeBanner.banner_tag_kh || "")) || "";
      if (String(promoText).trim()) {
        return {
          text: String(promoText).trim().slice(0, 40),
          style,
          fromPromotion: true,
        };
      }
    }
    const adminText = (lang === "en"
      ? (config?.topup_badge_text_en || "")
      : (config?.topup_badge_text_kh || "")
    ).trim();
    // v1.1 — non-claim defaults.  "50% more" must come from admin or
    // active promotion, never from a hardcoded default.
    const safeDefault = lang === "en" ? "Best Value" : "តម្លៃល្អ";
    return {
      text: (adminText || safeDefault).slice(0, 40),
      style,
      fromPromotion: false,
    };
  }, [config, activeBanners, lang, promotionAware]);

  // Visual style map for the smart badge pill.  Pure CSS — no payment
  // logic, no claim about real discount.  Admin chooses the look only.
  const badgeStyleMap = {
    bonus:       { bg: "linear-gradient(135deg, #FFE19A 0%, #D4A843 100%)", color: "#1a1420" },
    recommended: { bg: "linear-gradient(135deg, #B8E2C2 0%, #6FB97F 100%)", color: "#0a2014" },
    flash_sale:  { bg: "linear-gradient(135deg, #FFB199 0%, #E85C3F 100%)", color: "#270b08" },
    premium:     { bg: "linear-gradient(135deg, #D8C2FF 0%, #7B5BD8 100%)", color: "#190a35" },
  };
  const badgeVisual = badge ? (badgeStyleMap[badge.style] || badgeStyleMap.bonus) : null;

  // Bilingual headline / CTA for the new premium banner.
  const lowHeadline = lang === "en" ? "Low on points?" : "ខ្វះពិន្ទុ?";
  const pointsCta = lang === "en" ? "Points" : "ពិន្ទុ";

  const promptKh = useMemo(
    () =>
      applyTemplate(
        config?.topup_prompt_kh || DEFAULT_KH,
        need,
        liveBalance,
      ),
    [config, need, liveBalance],
  );
  const promptEn = useMemo(
    () =>
      applyTemplate(
        config?.topup_prompt_en || DEFAULT_EN,
        need,
        liveBalance,
      ),
    [config, need, liveBalance],
  );

  // v1 — Retry counter: bumping this triggers the fetch effect.  Click
  // the Retry button in the error block to refetch without reopening
  // the modal.  No package fetch spam (we abort on cancel and only
  // refetch when the counter changes or the modal is reopened).
  const [retryCounter, setRetryCounter] = useState(0);

  // Fetch active public packages once on open (and on Retry).
  useEffect(() => {
    if (!open) return;
    setErrMsg("");
    setLoading(true);
    const ac = (typeof AbortController !== "undefined")
      ? new AbortController()
      : null;
    let cancelled = false;
    (async () => {
      try {
        const pkgs = await fetchTopupPackages(ac ? ac.signal : undefined);
        if (cancelled) return;
        setPackages(Array.isArray(pkgs) ? pkgs : []);
        setErrMsg("");
      } catch (err) {
        if (cancelled) return;
        // AbortError → ignore (cleanup happened first).
        if (err && (err.name === "AbortError" || err.kind === "abort")) return;
        setPackages([]);
        setErrMsg(
          (err && err.message) || "Could not load top-up packages.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (ac) {
        try { ac.abort(); } catch { /* noop */ }
      }
    };
  }, [open, retryCounter]);

  // Poll balance while modal is open so payment confirmations auto-detect.
  useEffect(() => {
    if (!open || typeof refreshPoints !== "function") return undefined;
    const id = setInterval(() => {
      try {
        refreshPoints();
      } catch {
        /* swallow — refreshPoints handles errors internally */
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [open, refreshPoints]);

  // Auto-resume when balance becomes sufficient.
  useEffect(() => {
    if (!open) return;
    if (autoResumed) return;
    if (!sufficient) return;
    if (behaviour === "return_to_book") {
      // Just dismiss — the student picks the action themselves.
      setAutoResumed(true);
      return;
    }
    setAutoResumed(true);
    // Small delay so the student sees the "Points added!" confirmation.
    const t = setTimeout(() => {
      if (typeof onResume === "function") onResume();
      else if (typeof onClose === "function") onClose();
    }, 900);
    return () => clearTimeout(t);
  }, [open, sufficient, autoResumed, behaviour, onResume, onClose]);

  // Reset auto-resume flag when modal reopens.
  useEffect(() => {
    if (open) setAutoResumed(false);
  }, [open]);

  if (!open) return null;

  // Recommended package = the smallest active package that delivers enough
  // points to cover the required cost, if any. Otherwise the largest.
  const sortedByPoints = [...packages].sort(
    (a, b) => (a.points || a.points_amount || 0) - (b.points || b.points_amount || 0),
  );
  const recommended =
    sortedByPoints.find((p) => (p.points || p.points_amount || 0) >= need) ||
    sortedByPoints[sortedByPoints.length - 1] ||
    null;

  // v1.1 — Resolve which package card should also wear the Smart Badge.
  // Driven by Author Studio "Badge target" config.  Falls back safely:
  // - "promotion_package_if_available" → first package with a live
  //   discount, otherwise the recommended package (never null).
  // - unknown target → recommended.
  // When `badge` is null (badge disabled) or no packages have loaded,
  // `targetPackage` is null and no per-card badge is rendered.
  const targetPackage = (() => {
    if (!badge || !Array.isArray(packages) || packages.length === 0) return null;
    const target = String(config?.topup_badge_target || "recommended_package")
      .toLowerCase()
      .replace(/[^a-z_]/g, "")
      .slice(0, 40);
    switch (target) {
      case "first_package":
        return packages[0] || null;
      case "highest_value_package":
        // Highest "value" = most points per package.  sortedByPoints
        // is ascending, so the last item is the highest.
        return sortedByPoints[sortedByPoints.length - 1] || recommended || null;
      case "promotion_package_if_available": {
        const promo = packages.find(
          (p) =>
            !!p.discount_active_live ||
            (Number(p.discounted_amount_khr || 0) > 0 &&
              Number(p.discounted_amount_khr) < Number(p.amount_khr || 0)),
        );
        return promo || recommended || null;
      }
      case "recommended_package":
      default:
        return recommended || null;
    }
  })();
  const targetPackageId = targetPackage
    ? String(
        targetPackage._id ||
        targetPackage.id ||
        targetPackage.amount_khr,
      )
    : null;

  return (
    <div
      data-testid="points-gate-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && typeof onClose === "function") onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        background: "rgba(8,5,15,0.78)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "18px",
        animation: "edutalkFadeIn 160ms ease-out",
      }}
    >
      <div
        data-testid="points-gate-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Top up your EduHub points"
        style={{
          width: "min(540px, 96vw)",
          maxHeight: "92vh",
          overflowY: "auto",
          borderRadius: "18px",
          background:
            "linear-gradient(180deg, #1f1330 0%, #14091e 60%, #0d061a 100%)",
          border: "1px solid rgba(212, 168, 67, 0.35)",
          boxShadow:
            "0 30px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,225,154,0.08) inset",
          color: "#F4E5C1",
          padding: "22px 22px 20px",
        }}
      >
        {/* Premium top banner — compact pill row inspired by the reference
            screenshot.  Soft green glow on the left, "Low on points?"
            chip, then the "Points" gold CTA pill (with Smart Badge above
            it) on the right, then the × close button.  Mobile-first
            spacing; the rich balance + needed line sits underneath. */}
        <div
          data-testid="points-gate-premium-banner"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "10px 12px",
            borderRadius: "14px",
            background:
              "linear-gradient(135deg, rgba(120,200,140,0.22) 0%, rgba(80,150,100,0.10) 60%, rgba(50,90,70,0.08) 100%)",
            border: "1px solid rgba(150,220,170,0.35)",
            boxShadow:
              "0 0 0 1px rgba(150,220,170,0.10) inset, 0 8px 22px rgba(70,150,90,0.18)",
          }}
        >
          {/* Left: ✦ + Low on points? */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "13.5px",
              fontWeight: 700,
              color: "#E6F7EB",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            data-testid="points-gate-low-headline"
          >
            <span
              aria-hidden
              style={{
                width: "22px",
                height: "22px",
                flexShrink: 0,
                borderRadius: "999px",
                background:
                  "linear-gradient(135deg, #BFEFC9 0%, #6FB97F 100%)",
                color: "#0a2014",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "12px",
                fontWeight: 800,
              }}
            >
              ✦
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {lowHeadline}
            </span>
          </div>

          {/* Right cluster: Points CTA pill + smart badge floater */}
          <div
            style={{
              position: "relative",
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <div
              data-testid="points-gate-points-pill"
              style={{
                position: "relative",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "7px 13px",
                borderRadius: "999px",
                background:
                  "linear-gradient(135deg, #FFE19A 0%, #D4A843 60%, #9C7A2C 100%)",
                color: "#1a1420",
                fontWeight: 800,
                fontSize: "13px",
                letterSpacing: "0.01em",
                boxShadow:
                  "0 4px 12px rgba(212,168,67,0.35), 0 0 0 1px rgba(255,225,154,0.45) inset",
              }}
            >
              <span aria-hidden style={{ fontSize: "11px" }}>✦</span>
              <span>{pointsCta}</span>
              {badge && badgeVisual && (
                <span
                  data-testid="points-gate-smart-badge"
                  data-badge-style={badge.style}
                  data-badge-source={badge.fromPromotion ? "promotion" : "config"}
                  style={{
                    position: "absolute",
                    top: "-9px",
                    right: "-10px",
                    background: badgeVisual.bg,
                    color: badgeVisual.color,
                    fontSize: "9.5px",
                    fontWeight: 800,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    padding: "3px 8px",
                    borderRadius: "999px",
                    whiteSpace: "nowrap",
                    boxShadow: "0 3px 8px rgba(0,0,0,0.25)",
                    border: "1px solid rgba(255,255,255,0.45)",
                  }}
                >
                  {badge.text}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              data-testid="points-gate-close"
              aria-label="Close top-up modal"
              style={{
                flexShrink: 0,
                border: "none",
                background: "rgba(244,229,193,0.08)",
                color: "#F4E5C1",
                width: "30px",
                height: "30px",
                borderRadius: "10px",
                cursor: "pointer",
                fontSize: "16px",
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* Compact identity + balance/needed line, sits under the banner. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            marginTop: "12px",
          }}
        >
          <h2
            data-testid="points-gate-title"
            style={{
              margin: 0,
              flex: 1,
              minWidth: 0,
              fontSize: "14.5px",
              fontWeight: 700,
              letterSpacing: "0.01em",
              color: "#FFE7B0",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {featureLabel || "Top up points"}
          </h2>
          <p
            style={{
              margin: 0,
              fontSize: "11.5px",
              color: "rgba(244,229,193,0.7)",
              whiteSpace: "nowrap",
            }}
            data-testid="points-gate-balance-line"
          >
            {student?.name ? `${student.name} · ` : ""}
            <span>{lang === "en" ? "Balance:" : "សមតុល្យ:"}</span>{" "}
            <strong style={{ color: "#FFE7B0" }}>{liveBalance}</strong>
            {" · "}
            <span>{lang === "en" ? "Needed:" : "ត្រូវការ:"}</span>{" "}
            <strong style={{ color: "#FFE7B0" }}>{need}</strong>
          </p>
        </div>

        {/* Prompt text */}
        <div
          style={{
            marginTop: "16px",
            padding: "12px 14px",
            borderRadius: "12px",
            background: "rgba(212,168,67,0.08)",
            border: "1px solid rgba(212,168,67,0.18)",
            fontSize: "13.5px",
            lineHeight: 1.55,
          }}
          data-testid="points-gate-prompt"
        >
          {(lang === "kh" || showBoth) && (
            <p style={{ margin: 0, color: "#F4E5C1" }}>{promptKh}</p>
          )}
          {(lang === "en" || showBoth) && (
            <p
              style={{
                margin: showBoth ? "8px 0 0" : 0,
                color: showBoth ? "rgba(244,229,193,0.85)" : "#F4E5C1",
                fontSize: showBoth ? "12.5px" : "13.5px",
              }}
            >
              {promptEn}
            </p>
          )}
          {/* Part 2 — reason-aware encouragement copy.  We intentionally keep
              this short and motivational (no scarcity, no shame).  English
              by default because the modal already shows Khmer copy above
              when topup_prompt_lang is "kh" or "both". */}
          {triggerReason && triggerReason !== "insufficient" && (
            <p
              data-testid={`points-gate-reason-copy-${triggerReason}`}
              style={{
                margin: "10px 0 0",
                fontSize: "11.5px",
                color: "rgba(244,229,193,0.78)",
                lineHeight: 1.5,
                fontStyle: "italic",
              }}
            >
              {triggerReason === "replies_left" &&
                "Keep your EduTalk Coach active — top up to continue learning this story step by step."}
              {triggerReason === "low_balance" &&
                "You're close to running out. Top up to keep listening, practicing, and asking your coach."}
              {triggerReason === "after_value" &&
                "You're making progress 👏 Top up to continue your coaching session."}
              {triggerReason === "voice" &&
                "Need Khmer help for this English answer? Top up to unlock audio explanation and continue learning."}
            </p>
          )}
        </div>

        {/* Part 2 — Promotion-aware banner.  Shown ONLY when the admin has
            promotionAware enabled AND there is at least one active banner.
            We render the first banner only — never stack multiple to keep
            the modal calm and on-brand. */}
        {promotionAware && Array.isArray(activeBanners) && activeBanners.length > 0 && (() => {
          const b = activeBanners[0] || {};
          const bannerText =
            (lang === "en"
              ? (b.banner_text_en || b.banner_text_kh)
              : (b.banner_text_kh || b.banner_text_en)) || "";
          if (!bannerText) return null;
          return (
            <div
              data-testid="points-gate-promo-banner"
              style={{
                marginTop: "12px",
                padding: "10px 12px",
                borderRadius: "10px",
                background:
                  "linear-gradient(135deg, rgba(255,225,154,0.18) 0%, rgba(212,168,67,0.10) 100%)",
                border: "1px solid rgba(255,225,154,0.45)",
                color: "#F4E5C1",
                fontSize: "12px",
                lineHeight: 1.45,
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <span aria-hidden style={{ fontSize: "13px" }}>✨</span>
              <span>{bannerText}</span>
            </div>
          );
        })()}

        {/* Sufficient confirmation banner */}
        {sufficient && (
          <div
            data-testid="points-gate-sufficient-banner"
            style={{
              marginTop: "14px",
              padding: "10px 12px",
              borderRadius: "10px",
              background:
                "linear-gradient(135deg, rgba(132,204,148,0.18) 0%, rgba(132,204,148,0.08) 100%)",
              border: "1px solid rgba(132,204,148,0.35)",
              color: "#CFEDD4",
              fontSize: "12.5px",
              fontWeight: 600,
            }}
          >
            ✓ Points added!{" "}
            {behaviour === "auto_start"
              ? `Starting ${featureLabel || "feature"}...`
              : "Tap to continue."}
          </div>
        )}

        {/* Packages */}
        {showPackages && (
          <div style={{ marginTop: "16px" }}>
            <div
              style={{
                fontSize: "11px",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "rgba(244,229,193,0.6)",
                marginBottom: "8px",
              }}
            >
              Top-up packages
            </div>

            {loading && (
              <p
                style={{
                  margin: 0,
                  fontSize: "12px",
                  color: "rgba(244,229,193,0.6)",
                }}
                data-testid="points-gate-loading"
              >
                Loading packages…
              </p>
            )}

            {!loading && errMsg && (
              <div
                data-testid="points-gate-error-block"
                style={{
                  margin: 0,
                  padding: "10px 12px",
                  borderRadius: "10px",
                  background: "rgba(232,160,160,0.10)",
                  border: "1px solid rgba(232,160,160,0.30)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                <p
                  style={{ margin: 0, fontSize: "12px", color: "#E8A0A0" }}
                  data-testid="points-gate-error"
                >
                  {errMsg}
                </p>
                <p
                  style={{
                    margin: 0,
                    fontSize: "11px",
                    color: "rgba(244,229,193,0.6)",
                    lineHeight: 1.4,
                  }}
                  data-testid="points-gate-error-reassurance"
                >
                  {lang === "en"
                    ? "Your payment is safe — packages will reload when the connection is back."
                    : "ប្រាក់របស់អ្នកនៅសុវត្ថិភាព — កញ្ចប់នឹងផ្ទុកឡើងវិញនៅពេលអ៊ីនធឺណិតមកវិញ។"}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setErrMsg("");
                    setRetryCounter((n) => n + 1);
                  }}
                  data-testid="points-gate-retry"
                  aria-label="Retry loading packages"
                  style={{
                    alignSelf: "flex-start",
                    border: "none",
                    background:
                      "linear-gradient(135deg, #FFE19A 0%, #D4A843 100%)",
                    color: "#1a1420",
                    padding: "7px 14px",
                    borderRadius: "999px",
                    fontSize: "12px",
                    fontWeight: 800,
                    cursor: "pointer",
                    boxShadow:
                      "0 3px 9px rgba(212,168,67,0.30), 0 0 0 1px rgba(255,225,154,0.45) inset",
                  }}
                >
                  {lang === "en" ? "Retry" : "ព្យាយាមម្ដងទៀត"}
                </button>
              </div>
            )}

            {!loading && !errMsg && packages.length === 0 && (
              <p
                style={{
                  margin: 0,
                  fontSize: "12px",
                  color: "rgba(244,229,193,0.6)",
                }}
                data-testid="points-gate-empty"
              >
                No top-up packages are available right now. Please contact your teacher.
              </p>
            )}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
                gap: "8px",
              }}
              data-testid="points-gate-packages"
            >
              {packages.map((p) => {
                const id = String(p._id || p.id || p.amount_khr);
                const isRec = highlightRec && recommended && id === String(recommended._id || recommended.id || recommended.amount_khr);
                const isBadgeTarget =
                  !!badge && !!targetPackageId && id === targetPackageId;
                const finalKhr = p.discounted_amount_khr || p.amount_khr;
                const original = p.original_amount_khr || p.amount_khr;
                const hasDiscount = p.discount_active_live && finalKhr < original;
                // v1.5 — handler that routes the click into the real working
                // PointsPurchaseModal with this package pre-selected.
                const handlePickPackage = () => {
                  const norm = _normalizePackageForPurchase(p);
                  if (!norm) return;
                  setPreselectedPackage(norm);
                  setPurchaseOpen(true);
                };
                return (
                  <div
                    key={id}
                    data-testid={`points-gate-package-${id}`}
                    data-badge-target={isBadgeTarget ? "true" : undefined}
                    role="button"
                    tabIndex={0}
                    aria-label={`Top up ${p.points || p.points_amount || 0} points for ${formatKHR(finalKhr)} KHR`}
                    onClick={handlePickPackage}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handlePickPackage();
                      }
                    }}
                    style={{
                      position: "relative",
                      padding: "12px 12px 10px",
                      borderRadius: "12px",
                      background: isRec
                        ? "linear-gradient(135deg, rgba(255,225,154,0.16) 0%, rgba(212,168,67,0.08) 100%)"
                        : "rgba(244,229,193,0.04)",
                      border: isRec
                        ? "1.5px solid rgba(255,225,154,0.55)"
                        : "1px solid rgba(244,229,193,0.12)",
                      cursor: "pointer",
                      outline: "none",
                      transition: "transform 0.12s ease, border-color 0.2s ease, box-shadow 0.2s ease",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = "translateY(-1px)";
                      e.currentTarget.style.boxShadow = "0 6px 14px rgba(212,168,67,0.18)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = "translateY(0)";
                      e.currentTarget.style.boxShadow = "none";
                    }}
                  >
                    {/* v1.1 — Smart Badge on the targeted package card.
                        Positioned top-LEFT so it does not collide with
                        the existing "Recommended" pill (top-right). */}
                    {isBadgeTarget && badgeVisual && (
                      <span
                        data-testid={`points-gate-package-${id}-smart-badge`}
                        data-badge-style={badge.style}
                        data-badge-source={badge.fromPromotion ? "promotion" : "config"}
                        style={{
                          position: "absolute",
                          top: "-9px",
                          left: "8px",
                          fontSize: "9.5px",
                          fontWeight: 800,
                          letterSpacing: "0.04em",
                          textTransform: "uppercase",
                          background: badgeVisual.bg,
                          color: badgeVisual.color,
                          padding: "2px 7px",
                          borderRadius: "999px",
                          boxShadow: "0 3px 8px rgba(0,0,0,0.25)",
                          border: "1px solid rgba(255,255,255,0.45)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {badge.text}
                      </span>
                    )}
                    {isRec && (
                      <span
                        style={{
                          position: "absolute",
                          top: "-9px",
                          right: "8px",
                          fontSize: "9.5px",
                          fontWeight: 800,
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          background:
                            "linear-gradient(135deg, #FFE19A 0%, #D4A843 100%)",
                          color: "#1a1420",
                          padding: "2px 7px",
                          borderRadius: "8px",
                        }}
                      >
                        {lang === "en" ? recLabelEn : recLabelKh}
                      </span>
                    )}
                    <div
                      style={{
                        fontSize: "15px",
                        fontWeight: 800,
                        color: "#FFE7B0",
                      }}
                    >
                      +{(p.points || p.points_amount || 0)} pts
                    </div>
                    <div
                      style={{
                        marginTop: "4px",
                        fontSize: "11.5px",
                        color: "rgba(244,229,193,0.75)",
                        display: "flex",
                        alignItems: "baseline",
                        gap: "6px",
                        flexWrap: "wrap",
                      }}
                    >
                      <span>{formatKHR(finalKhr)} KHR</span>
                      {hasDiscount && (
                        <span
                          style={{
                            color: "rgba(244,229,193,0.45)",
                            textDecoration: "line-through",
                            fontSize: "10.5px",
                          }}
                        >
                          {formatKHR(original)}
                        </span>
                      )}
                    </div>
                    {p.label && (
                      <div
                        style={{
                          marginTop: "4px",
                          fontSize: "10.5px",
                          color: "rgba(244,229,193,0.55)",
                          fontStyle: "italic",
                        }}
                      >
                        {String(p.label).slice(0, 40)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Payment instruction footer */}
        <div
          style={{
            marginTop: "16px",
            padding: "10px 12px",
            borderRadius: "10px",
            background: "rgba(244,229,193,0.04)",
            border: "1px dashed rgba(244,229,193,0.18)",
            fontSize: "11.5px",
            color: "rgba(244,229,193,0.65)",
            lineHeight: 1.5,
          }}
          data-testid="points-gate-payment-instruction"
        >
          Pay via ABA PayWay (same as usual). Your points will appear here
          automatically once payment is confirmed.
        </div>

        {/* Footer buttons */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: "8px",
            marginTop: "18px",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            data-testid="points-gate-cancel"
            aria-label="Cancel and close top-up modal"
            style={{
              padding: "9px 16px",
              borderRadius: "10px",
              border: "1px solid rgba(244,229,193,0.18)",
              background: "transparent",
              color: "#F4E5C1",
              fontSize: "12.5px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Close
          </button>
          {/* v1.5 — Primary CTA: open the real working PointsPurchaseModal
              with the recommended package preselected (falls back to the
              first available package, or no preselection if packages
              haven't loaded yet — PointsPurchaseModal handles that). */}
          {!sufficient && (
            <button
              type="button"
              onClick={() => {
                const pick = recommended || packages[0] || null;
                setPreselectedPackage(_normalizePackageForPurchase(pick));
                setPurchaseOpen(true);
              }}
              data-testid="points-gate-topup-cta"
              aria-label="Open top-up payment"
              style={{
                padding: "10px 18px",
                borderRadius: "999px",
                border: "1px solid rgba(255,225,154,0.55)",
                background:
                  "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
                color: "#1a1420",
                fontSize: "12.5px",
                fontWeight: 800,
                cursor: "pointer",
                letterSpacing: 0,
                whiteSpace: "nowrap",
                display: "inline-flex",
                alignItems: "baseline",
                gap: 6,
                boxShadow:
                  "0 6px 14px rgba(212,168,67,0.28), inset 0 1px 0 rgba(255,225,154,0.22)",
                fontFamily:
                  "'Noto Sans Khmer','Kantumruy Pro','Battambang','Khmer OS','Khmer OS Battambang','Hanuman','Bayon',system-ui,-apple-system,sans-serif",
              }}
            >
              <span style={{ fontFamily: "inherit" }}>បញ្ចូលពិន្ទុ</span>
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  color: "rgba(26,20,32,0.7)",
                  fontFamily: "system-ui,-apple-system,sans-serif",
                  letterSpacing: "0.04em",
                }}
              >
                Top Up
              </span>
            </button>
          )}
          {sufficient && behaviour === "return_to_book" && (
            <button
              type="button"
              onClick={() => {
                if (typeof onResume === "function") onResume();
                else if (typeof onClose === "function") onClose();
              }}
              data-testid="points-gate-resume"
              aria-label="Continue with the feature"
              style={{
                padding: "9px 18px",
                borderRadius: "10px",
                border: "1px solid rgba(255,225,154,0.55)",
                background:
                  "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
                color: "#1a1420",
                fontSize: "12.5px",
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              Continue →
            </button>
          )}
        </div>
      </div>

      {/* v1.5 — Real payment modal.  Reuses the SAME PointsPurchaseModal that
          the Library header top-up button (LibraryTopUpButton.jsx) opens, so
          there is exactly one working ABA/QR + poll + "I paid" flow in the
          app.  We do NOT duplicate payment intent creation here.  */}
      {purchaseOpen && (
        <PointsPurchaseModal
          studentId={student?.studentId || student?.id || ""}
          preselectedPackage={preselectedPackage}
          onClose={() => setPurchaseOpen(false)}
          onCredited={(pts) => {
            // Refresh balance so the existing auto-resume effect below can
            // detect "sufficient" and either auto_start or return_to_book as
            // configured by topup_after_behaviour.  We do NOT deduct here —
            // the original EduTalk feature deducts when it resumes.
            try { refreshPoints?.(); } catch { /* refreshPoints handles its own errors */ }
            setPurchaseOpen(false);
            // Note: do not call onResume here directly.  Letting the
            // auto-resume effect react to the refreshed balance keeps a
            // single source of truth and respects topup_after_behaviour.
            void pts;
          }}
          triggerReason={triggerReason || "edutalk_gate"}
          contextHeadlineKm="បញ្ចូលពិន្ទុ"
          contextBodyKm="ជ្រើសរើសកញ្ចប់ដែលអ្នកចង់បញ្ចូល ដើម្បីបន្ត។"
          currentBalance={Number(liveBalance || 0)}
          recommendedPackageId={
            recommended ? String(recommended._id || recommended.id || "") : ""
          }
        />
      )}
    </div>
  );
}
