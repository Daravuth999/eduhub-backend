// @ts-nocheck

/**
 * PointsPurchaseModal.jsx — EduHub Top-Up Payment Modal (Surgery v3)
 * =====================================================================
 * Premium, Khmer-first, mobile-perfect Top-Up modal.
 *
 * v3 (UI/Khmer surgery — 2026-05-23):
 *   • Khmer-first copy. Exact labels supplied by the product owner are
 *     used verbatim (NOT auto-translated):
 *       បញ្ចូលពិន្ទុ          (Buy Points / Top Up)
 *       ជ្រើសរើសកញ្ចប់         (Select a package)
 *       ទិញឥឡូវនេះ           (Pay)
 *       បង់ប្រាក់ជាមួយ ABA     (Open ABA app to pay)
 *       ផុតកំណត់ការបង់ប្រាក់ក្នុងរយៈ (Complete payment within)
 *       ខ្ញុំបានបង់ប្រាក់រួចរាល់   (I've paid — check now)
 *       រៀល                  (KHR / ៛)
 *
 *   • Real Khmer-capable font stack (Noto Sans Khmer + Kantumruy Pro)
 *     loaded on-demand via <link rel="stylesheet"> appended at first
 *     mount. No global CSS change required.
 *   • Tighter spacing, larger touch targets, brighter selected-package
 *     glow, secure-payment badge, refined desktop QR fold.
 *
 * v2 (payment surgery — 2026-05-22):
 *   • 3 s polling (poller scope bug fixed)
 *   • Auto-close on completed / completed_manual
 *   • Visible "checking…" feedback on the I've-paid button
 *   • NEEDS_REVIEW + EXPIRED state UX
 *   • Lottie animation with safe fallback
 *
 * Public contract (unchanged across v1/v2/v3):
 *   Props: { studentId, onClose, onCredited(pts), preselectedPackage }
 *   Path : src/eduhub/pages/portal/components/dashboard/PointsPurchaseModal.jsx
 *
 * Surgery only. No payment logic, backend logic, push pipeline,
 * matching, coupons, library, login, studio, tuition, restriction,
 * service worker, or any unrelated component is touched.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Coins, QrCode, CheckCircle2, Loader2,
  RefreshCw, AlertTriangle, Sparkles, ChevronRight,
  ShieldCheck, Clock4,
} from "lucide-react";
import TopUpLottie from "../../../../components/lottie/TopUpLottie";
import { requestPointsRefresh } from "../../../../utils/pointsSync";
import { beginCriticalOperation } from "../../../../lib/criticalOperationRegistry";
import TopUpReceiptOverlay, { saveTopUpReceipt } from "./TopUpReceiptOverlay";
import {
  getCachedPackages,
  refreshPackages,
  subscribePackages,
  getLastFetchError,
} from "../../../../utils/topUpPackagesCache";

const BACKEND = process.env.REACT_APP_BACKEND_URL || "";
const QR_IMAGE_PATH = "/aba-qr.png";
const POLL_INTERVAL_MS = 3000;        // spec: every 3 seconds
const CHECK_DEBOUNCE_MS = 4000;       // spec: 3-5 s debounce
// 1.5-2 s success auto-close

// ── Khmer font stack ─────────────────────────────────────────────────────
// Real Khmer-capable fonts. Order: web font, then OS-installed Khmer
// fonts on iPhone / Android / desktop. system-ui at the end keeps Latin
// glyphs sharp.
const KHMER_FONT_STACK = `'Noto Sans Khmer', 'Kantumruy Pro', 'Battambang', 'Khmer OS', 'Khmer OS Battambang', 'Hanuman', 'Bayon', system-ui, -apple-system, sans-serif`;

// Inline style helper for any Khmer text node.
const km = {
  fontFamily: KHMER_FONT_STACK,
  // Khmer characters MUST NOT have wide letter-spacing, uppercase, or
  // small-caps applied — letterforms break.
  letterSpacing: 0,
  textTransform: "none",
  fontFeatureSettings: '"liga", "calt"',
  lineHeight: 1.55,
};

// Inject the Google Fonts <link> once per page (idempotent, no-op on retry).
function ensureKhmerFont() {
  if (typeof document === "undefined") return;
  if (document.getElementById("eduhub-khmer-fonts")) return;

  // Preconnect first — Google Fonts best-practice
  const pc1 = document.createElement("link");
  pc1.rel = "preconnect"; pc1.href = "https://fonts.googleapis.com";
  document.head.appendChild(pc1);

  const pc2 = document.createElement("link");
  pc2.rel = "preconnect"; pc2.href = "https://fonts.gstatic.com";
  pc2.crossOrigin = "anonymous";
  document.head.appendChild(pc2);

  // The font payload itself
  const l = document.createElement("link");
  l.id = "eduhub-khmer-fonts";
  l.rel = "stylesheet";
  l.href =
    "https://fonts.googleapis.com/css2" +
    "?family=Noto+Sans+Khmer:wght@400;500;600;700;800" +
    "&family=Kantumruy+Pro:wght@400;500;600;700" +
    "&display=swap";
  document.head.appendChild(l);
}

// Surgery v2 (visibility fix): read the student session token written by
// studentAuthService at login. On iOS Safari (ITP) and on cross-site
// Vercel→Render requests with strict cookie settings, the `student_session`
// cookie is silently dropped — `credentials:"include"` alone is not enough.
// Sending the same token as an `Authorization: Bearer` header is the
// existing app-wide fallback (see studentAuthService._bearerHeaders).
// Read defensively: tolerate SSR, locked-down storage, or missing token.
function _readStudentBearer() {
  try {
    if (typeof localStorage === "undefined") return "";
    return localStorage.getItem("student_session_token") || "";
  } catch (_e) {
    return "";
  }
}

async function apiFetch(path, opts = {}) {
  // v1.1 fix (Blocker 2): use an EXPLICIT allowlist instead of matching
  // any path containing "/status". The CamRapidPay status endpoint is
  // authenticated-student-only and must send credentials. Sending
  // credentials to a genuinely public endpoint is harmless; omitting them
  // from an authenticated one breaks auth enforcement.
  const EXPLICIT_PUBLIC = ["/payments/packages/public", "/payments/camrapidpay/config", "/payments/methods/public"];
  const isPublic = EXPLICIT_PUBLIC.some(p => path.includes(p));
  // Surgery v2: dual-auth (cookie + Bearer header) for non-public paths.
  // Cookie covers desktop Chrome / Firefox; Bearer covers iOS Safari ITP
  // and any browser that strips cross-site cookies on Vercel→Render.
  const authHeaders = {};
  if (!isPublic) {
    const t = _readStudentBearer();
    if (t) authHeaders.Authorization = `Bearer ${t}`;
  }
  const r = await fetch(BACKEND + "/api" + path, {
    credentials: isPublic ? "omit" : "include",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
      ...(opts.headers || {}),
    },
    ...opts,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(
      (data.detail && data.detail.message) ||
      (typeof data.detail === "string" ? data.detail : "") ||
      `HTTP ${r.status}`,
    );
    err.status = r.status;
    err.body = data;
    throw err;
  }
  return data;
}

// ── Package card ──────────────────────────────────────────────────────────

function PackageCard({ pkg, selected, onSelect, recommended }) {
  const total = (pkg.points || 0) + (pkg.bonus_points || 0);
  const hasBonus = (pkg.bonus_points || 0) > 0;
  const isSelected = selected?._id === pkg._id;
  const isRecommended = !!recommended;
  // v4 (USD packages): display USD. Discount logic now reads the USD
  // counterparts surfaced by the backend; KHR variants stay on the doc as
  // legacy fallbacks so older clients still render something sensible.
  const hasDiscount = !!(pkg.discount_active_live && pkg.discount_pct > 0);
  const usdNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const fallbackUsd = usdNum(pkg.amount_usd) || (usdNum(pkg.amount_khr) > 0 ? usdNum(pkg.amount_khr) / 4000 : 0);
  const origUsd  = usdNum(pkg.original_amount_usd) || fallbackUsd;
  const dispUsd  = hasDiscount
    ? (usdNum(pkg.discounted_amount_usd) || origUsd)
    : (usdNum(pkg.amount_usd) || origUsd);
  const fmtUsd = (n) => `$${(Number(n) || 0).toFixed(2)}`;

  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      onClick={() => onSelect(pkg)}
      data-testid={`topup-package-${pkg._id}`}
      style={{
        position: "relative",
        width: "100%",
        background: isSelected
          ? "linear-gradient(135deg, rgba(212,168,67,0.28), rgba(167,139,250,0.14))"
          : isRecommended
            ? "linear-gradient(135deg, rgba(167,139,250,0.14), rgba(20,14,32,0.7))"
            : "rgba(20,14,32,0.65)",
        border: isSelected
          ? "1.5px solid rgba(255,225,154,0.85)"
          : isRecommended
            ? "1.5px solid rgba(167,139,250,0.55)"
            : "1px solid rgba(255,255,255,0.10)",
        borderRadius: 16,
        padding: "14px 16px",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 14,
        textAlign: "left",
        transition: "background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease",
        boxShadow: isSelected
          ? "0 0 0 1px rgba(255,225,154,0.25), 0 0 24px rgba(212,168,67,0.28), inset 0 1px 0 rgba(255,225,154,0.12)"
          : isRecommended
            ? "0 0 18px rgba(167,139,250,0.20)"
            : "none",
      }}
    >
      {/* Recommended chip — pinned top-right */}
      {isRecommended && !isSelected && (
        <span
          data-testid={`topup-recommended-${pkg._id}`}
          style={{
            position: "absolute",
            top: -8,
            right: 12,
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            background: "linear-gradient(135deg, #a78bfa 0%, #6366f1 100%)",
            color: "#fff",
            fontSize: 10,
            fontWeight: 800,
            borderRadius: 999,
            padding: "3px 9px",
            letterSpacing: "0.04em",
            boxShadow: "0 4px 14px rgba(99,102,241,0.45)",
            border: "1px solid rgba(255,255,255,0.25)",
            fontFamily: KHMER_FONT_STACK,
          }}
        >
          ⭐ ណែនាំ
        </span>
      )}
      <div style={{
        minWidth: 92,
        background: isSelected ? "rgba(212,168,67,0.22)" : "rgba(255,255,255,0.05)",
        borderRadius: 12,
        padding: "9px 10px",
        textAlign: "center",
      }}>
        <div style={{
          fontSize: 16, fontWeight: 800,
          color: isSelected ? "#FFE19A" : "#e5e7eb",
          fontVariantNumeric: "tabular-nums",
        }}>
          {hasDiscount ? (
            <>
              <span style={{ textDecoration: "line-through", opacity: 0.5, fontSize: 13 }}>
                {fmtUsd(origUsd)}
              </span>
              <span style={{ color: "#fca5a5", marginLeft: 4, fontWeight: 800 }}>
                {fmtUsd(dispUsd)}
              </span>
            </>
          ) : fmtUsd(dispUsd)}
        </div>
        <div style={{
          fontSize: 10, color: "#9ca3af", fontWeight: 700, marginTop: 1,
          letterSpacing: "0.05em",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}>
          USD
        </div>
      </div>

      <ChevronRight size={14} color={isSelected ? "#FFE19A" : "#4b5563"} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Coins size={14} color={isSelected ? "#FFE19A" : "#a78bfa"} />
          <span style={{
            fontSize: 19, fontWeight: 800,
            color: isSelected ? "#FFE19A" : "#c4b5fd",
            fontVariantNumeric: "tabular-nums",
          }}>
            {total.toLocaleString()}
          </span>
          <span style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            pts
          </span>
          {hasBonus && (
            <span
              className="topup-bonus-pulse"
              style={{
                background: "rgba(74,222,128,0.15)",
                color: "#4ade80",
                border: "1px solid rgba(74,222,128,0.32)",
                borderRadius: 6,
                padding: "1px 7px",
                fontSize: 10,
                fontWeight: 800,
              }}
            >
              +{pkg.bonus_points} bonus
            </span>
          )}
          {hasDiscount && (
            <span style={{
              background: "linear-gradient(135deg,#f97316,#ef4444)",
              color: "#fff", fontSize: 9, fontWeight: 800,
              borderRadius: 6, padding: "2px 6px",
            }}>
              {pkg.discount_label || (pkg.discount_pct + "% OFF")}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 12, color: "#9ca3af", marginTop: 3,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            ...km,
          }}
        >
          {pkg.label}
          {pkg.notes ? ` · ${pkg.notes}` : ""}
        </div>
      </div>

      {isSelected && (
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", damping: 18 }}
          style={{ flexShrink: 0 }}
        >
          <CheckCircle2 size={20} color="#FFE19A" />
        </motion.div>
      )}
    </motion.button>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────

const STEPS = {
  PICK:      "pick",
  PAY:       "pay",
  KHQR_PAY:  "khqr_pay",   // CamRapidPay KHQR provider (flag-gated)
  SUCCESS:   "success",
  REVIEW:    "review",
  EXPIRED:   "expired",
  ERROR:     "error",
};

export default function PointsPurchaseModal({
  studentId,
  onClose,
  onCredited,
  preselectedPackage = null,
  // v1.1 return-flow props (passed by PointsTopUpPopup)
  khqrReturnIntentId = null,    // non-null: open directly in KHQR checking state
  khqrEnabled = false,           // true: show KHQR btn; false/undefined: hide it
  // ── v1.3 optional props (smart trigger) ──
  triggerReason = null,         // "library" | "lucky" | "assistant" | "low" | "manual"
  contextHeadlineKm = null,     // Khmer contextual headline above the package list
  contextBodyKm = null,         // Khmer body below the headline
  currentBalance = undefined,        // student's current PTS — shown as a pill
  recommendedPackageId = null,  // _id of the package to highlight as "ណែនាំ"
}) {
  const [step, setStep]         = useState(STEPS.PICK);
  // Prefetch v1.0.1 — seed packages synchronously from the shared cache
  // so the modal renders instantly when the cache is warm. The forced
  // background refresh below keeps Author Studio values authoritative
  // and reconciles the selected package against the freshly-returned
  // active list (see ── Load packages ── effect).
  const _cachedPackages         = (() => { try { return getCachedPackages(); } catch { return null; } })();
  const _hasCachedPackages      = Array.isArray(_cachedPackages) && _cachedPackages.length > 0;
  const [packages, setPackages] = useState(_hasCachedPackages ? _cachedPackages : []);
  const [selected, setSelected] = useState(() => {
    if (preselectedPackage && _hasCachedPackages) {
      const match = _cachedPackages.find(p => p && p._id === preselectedPackage._id);
      if (match) return match;
    }
    if (preselectedPackage) return preselectedPackage;
    return _hasCachedPackages ? _cachedPackages[0] : null;
  });
  // `loading` is true ONLY when we have no cached data to render. With a
  // warm cache the modal skips the skeleton entirely; the background
  // refresh runs silently and reconciles selection when it returns.
  const [loading, setLoading]   = useState(!_hasCachedPackages);
  // Distinguishes a network/API failure (retryable) from a successful
  // response that simply returned zero active packages (true empty state).
  const [packagesFetchError, setPackagesFetchError] = useState(null);
  const [packagesRefreshing, setPackagesRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  // v3 (USD gateway restore + spinner fix): the KHQR (CamRapidPay) flow has
  // its OWN loading flag. Sharing ``creating`` with the ABA/manual confirm
  // button caused both buttons to spin when only one was tapped. The
  // student-facing rule: tapping KHQR spins ONLY the KHQR button; tapping
  // ABA/manual spins ONLY the ABA/manual button.
  const [khqrCreating, setKhqrCreating] = useState(false);
  const [intentId, setIntentId] = useState(null);
  const [refCode, setRefCode]   = useState("");
  const [error, setError]       = useState("");
  const [credited, setCredited] = useState(0);
  const [pollsRun, setPollsRun] = useState(0);
  const [lastCheckedAt, setLastCheckedAt] = useState(null);
  const [expiresAt, setExpiresAt]   = useState(null);
  const [checking, setChecking]     = useState(false);
  const [reviewMsg, setReviewMsg]   = useState("");
  const [secondsLeft, setSecondsLeft] = useState(null);

  const pollTimerRef = useRef(null);
  const checkCooldownRef = useRef(0);
  const closedRef = useRef(false);

  // -- CamRapidPay KHQR state (isolated; does not affect the ABA flow above) --
  // Note: no khqrAvailable probe state — create-intent fires only on tap.
  const [khqrIntent, setKhqrIntent]       = useState(null);  // create-intent response
  const [khqrChecking, setKhqrChecking]   = useState(false);
  const [khqrReturning, setKhqrReturning] = useState(false); // true = restored from return URL
  const khqrPollRef   = useRef(null);
  const khqrCoolRef   = useRef(0);

  // Surgery v2 (visibility fix): self-contained KHQR availability probe.
  // The patch v1.2 only had PointsTopUpPopup probe `/config` and pass the
  // flag down via the `khqrEnabled` prop. But this modal is ALSO opened
  // from 3 other entry points that don't propagate the prop:
  //   1. LibraryTopUpButton.jsx        (Library header)
  //   2. PointsGateModal.jsx           (Reader paywall)
  //   3. SmartTopUpTrigger.jsx         (contextual mid-flow trigger)
  // In all three cases the prop defaults to `false` → KHQR button never
  // appears. By probing here, every entry point gets the same answer.
  // The probe runs only when the parent didn't already say `true`.
  // Cached in sessionStorage for the rest of the session (TTL 5 min).
  const [khqrEnabledLocal, setKhqrEnabledLocal] = useState(null);
  useEffect(() => {
    if (khqrEnabled === true) {
      setKhqrEnabledLocal(true);
      return;
    }
    // Stale-while-revalidate from sessionStorage (5 min)
    let cached = null;
    try {
      const raw = sessionStorage.getItem("eduhub_khqr_config_v1");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && (Date.now() - (parsed.ts || 0)) < 5 * 60 * 1000) {
          cached = parsed;
        }
      }
    } catch { /* noop */ }
    if (cached) {
      setKhqrEnabledLocal(Boolean(cached.enabled));
    }
    // Always refresh in the background (cheap, no DB write).
    let abort = false;
    apiFetch("/payments/camrapidpay/config")
      .then(d => {
        if (abort) return;
        const next = Boolean(d?.enabled);
        setKhqrEnabledLocal(next);
        try {
          sessionStorage.setItem(
            "eduhub_khqr_config_v1",
            JSON.stringify({ enabled: next, reason: d?.reason || "", ts: Date.now() })
          );
        } catch { /* noop */ }
        // Non-sensitive debug breadcrumb so admins can see the result in
        // devtools console without exposing keys.
        if (typeof console !== "undefined") {
          console.debug(
            "[EduHub] KHQR /config:",
            { enabled: next, reason: d?.reason || "unknown" }
          );
        }
      })
      .catch(e => {
        if (abort) return;
        setKhqrEnabledLocal(false);
        if (typeof console !== "undefined") {
          console.debug(
            "[EduHub] KHQR /config probe failed:",
            { status: e?.status || 0, message: String(e?.message || e) }
          );
        }
      });
    return () => { abort = true; };
  }, [khqrEnabled]);
  // Effective availability for the rest of the component.
  const khqrIsEnabled = (khqrEnabled === true) || (khqrEnabledLocal === true);

  // ── v1.6 Payment Methods Display gate ──────────────────────────────────
  // GET /api/payments/methods/public returns the admin-controlled toggles.
  // ABA defaults to visible (existing flow); KHQR defaults to visible only
  // when both the admin toggle is ON AND the CamRapidPay provider is ready.
  // The /config probe above is still consulted as a belt-and-suspenders
  // safeguard so the KHQR button cannot appear with a broken provider.
  const [methodsCfg, setMethodsCfg] = useState({ aba: true, khqr: true, loaded: false });
  useEffect(() => {
    let abort = false;
    apiFetch("/payments/methods/public")
      .then(d => {
        if (abort) return;
        setMethodsCfg({
          aba: !!(d?.aba && d.aba.enabled !== false),
          khqr: !!(d?.khqr && d.khqr.enabled),
          loaded: true,
        });
      })
      .catch(() => {
        // Failure-mode safety: keep existing defaults (both visible) so a
        // network blip cannot silently hide working payment buttons.
        if (!abort) setMethodsCfg({ aba: true, khqr: true, loaded: true });
      });
    return () => { abort = true; };
  }, []);

  // Combined gates: ABA visible if admin toggle ON; KHQR visible if admin
  // toggle ON AND the provider-ready signal is true (from /config probe).
  const abaVisible  = methodsCfg.aba;
  const khqrVisible = methodsCfg.khqr && khqrIsEnabled;

  // ── Khmer font ──
  useEffect(() => { ensureKhmerFont(); }, []);

  // -- Return-flow recovery (v1.1) ------------------------------------------
  // Priority 1: khqrReturnIntentId prop (set by PointsTopUpPopup after it
  // detected ?khqr_intent= in the URL). This is the reliable entry path
  // because PointsTopUpPopup is always mounted in Dashboard.tsx.
  // Priority 2: sessionStorage + URL param -- defense-in-depth when the
  // modal is mounted without going through PointsTopUpPopup.
  // In both cases, the backend status endpoint decides everything.
  // Never credits from URL/prop alone.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Priority 1: prop
    if (khqrReturnIntentId) {
      let pending = null;
      try {
        const stored = sessionStorage.getItem("khqr_pending");
        if (stored) pending = JSON.parse(stored);
      } catch { /* noop */ }
      setKhqrIntent({
        payment_intent_id: khqrReturnIntentId,
        reference:         String(pending?.reference    || ""),
        expires_at:        String(pending?.expires_at   || ""),
        amount:            Number(pending?.amount       || 0),
        amount_khr:        Number(pending?.amount_khr   || 0),
        amount_usd:        Number(pending?.amount_usd   || pending?.amount || 0),
        total_points:      Number(pending?.total_points || 0),
        bonus_points:      Number(pending?.bonus_points || 0),
        payment_url: "", qr_code: "",
      });
      setExpiresAt(pending?.expires_at || null);
      setKhqrReturning(true);
      setStep(STEPS.KHQR_PAY);
      return;
    }
    // Priority 2: sessionStorage / URL (defense-in-depth)
    try {
      const urlParams = new URLSearchParams(
        typeof window !== "undefined" ? window.location.search : ""
      );
      const urlIntentId = urlParams.get("khqr_intent");
      const stored = sessionStorage.getItem("khqr_pending");
      const pending = stored ? JSON.parse(stored) : null;
      const intentId = urlIntentId || pending?.payment_intent_id;
      if (!intentId || !pending) return;
      if (pending.expires_at) {
        const exp = new Date(pending.expires_at).getTime();
        if (Date.now() > exp + 5 * 60 * 1000) {
          sessionStorage.removeItem("khqr_pending");
          return;
        }
      }
      setKhqrIntent({
        payment_intent_id: intentId,
        reference:         pending.reference   || "",
        expires_at:        pending.expires_at  || "",
        amount:            pending.amount      || 0,
        amount_khr:        pending.amount_khr  || 0,
        amount_usd:        pending.amount_usd  || pending.amount || 0,
        total_points:      pending.total_points || 0,
        bonus_points:      pending.bonus_points || 0,
        payment_url: "", qr_code: "",
      });
      setExpiresAt(pending.expires_at || null);
      setKhqrReturning(true);
      setStep(STEPS.KHQR_PAY);
      if (urlIntentId && typeof window !== "undefined" && window.history) {
        window.history.replaceState(null, "", window.location.pathname + window.location.hash);
      }
    } catch { /* sessionStorage unavailable */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // runs once on mount only

  // ── Load packages ──
  // Prefetch v1.0.1 — flow on modal mount:
  //   1. Cached packages (if any) are already in state, rendered instantly.
  //   2. ALWAYS issue ONE forced background refresh through the shared
  //      topUpPackagesCache helper. The cache module's single in-flight
  //      promise dedupes against any prefetch fired by LibraryTopUpButton.
  //   3. On success: reconcile the rendered list AND the current selection
  //      against the fresh server objects (see reconcileSelection below).
  //   4. On failure: keep cached packages visible if any; surface a real
  //      retryable error state only when there is nothing to render.
  //   5. Subscribe so any other refresh in the app updates this modal.
  //
  // We deliberately do NOT lump "fetch failed" together with "fetch
  // succeeded but zero active packages" — the UI must distinguish the
  // two (retry button vs. true empty state).
  // v1.0.2 — Reconciliation preserves the USER'S current selection.
  //   • preselectedPackage is honored ONLY during initial hydration
  //     (seeded into useState above). After that, a background refresh
  //     must NEVER yank the user back to preselectedPackage.
  //   • If the user's selected _id still exists in the fresh active list,
  //     replace `selected` with the fresh server object (same _id) so the
  //     UI never holds a stale package snapshot (price/points/bonus).
  //   • If the selected package was removed or deactivated, fall back to
  //     the first active package. If no active packages exist, clear.
  const reconcileSelection = useCallback((active) => {
    setSelected(prev => {
      if (!Array.isArray(active) || active.length === 0) return null;
      if (prev && prev._id) {
        const m = active.find(p => p && p._id === prev._id);
        if (m) return m;
        // Previous selection was removed or deactivated → fall through.
      }
      return active[0];
    });
  }, []);

  const runPackagesRefresh = useCallback(() => {
    setPackagesRefreshing(true);
    setPackagesFetchError(null);
    return refreshPackages()
      .then(active => {
        setPackages(Array.isArray(active) ? active : []);
        reconcileSelection(active);
        return active;
      })
      .catch(err => {
        setPackagesFetchError(err || new Error("Could not load packages."));
        // IMPORTANT: keep cached packages visible — do NOT clear them.
        throw err;
      })
      .finally(() => {
        setPackagesRefreshing(false);
        setLoading(false);
      });
  }, [reconcileSelection]);

  useEffect(() => {
    let alive = true;
    runPackagesRefresh().catch(() => { /* surfaced via packagesFetchError */ });
    const unsub = subscribePackages(active => {
      if (!alive) return;
      setPackages(Array.isArray(active) ? active : []);
      reconcileSelection(active);
    });
    // Surface any error already present in the cache from a prior
    // background fetch that failed before this modal mounted.
    const priorErr = getLastFetchError();
    if (priorErr && (!_hasCachedPackages)) {
      setPackagesFetchError(priorErr);
    }
    return () => { alive = false; unsub && unsub(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselectedPackage]);

  // ── Terminal-state handler ──
  const applyStatus = useCallback((data) => {
    if (closedRef.current) return false;
    const s = data?.status;
    setLastCheckedAt(Date.now());
    if (s === "completed" || s === "completed_manual") {
      const pts = Number(data.credited_points) ||
        ((selected?.points || 0) + (selected?.bonus_points || 0));
      setCredited(pts);
      try { sessionStorage.removeItem("khqr_pending"); } catch { /* noop */ }

      // v1.6: persist a receipt so the persistent congratulations overlay
      // renders on top of everything and survives a refresh until the
      // student manually confirms. Method is inferred from the active step
      // so KHQR and ABA/manual flows both populate the overlay with the
      // correct reference + amounts.
      try {
        const usingKhqr = !!khqrIntent;
        const reference = usingKhqr
          ? (khqrIntent?.reference || data?.reference || "")
          : (refCode || data?.reference || "");
        const amountUsdReceipt = usingKhqr
          ? (Number(khqrIntent?.amount_usd) || Number(khqrIntent?.amount) || 0)
          : (() => {
              const disc = Number(selected?.discounted_amount_usd);
              if (Number.isFinite(disc) && disc > 0) return disc;
              const usd = Number(selected?.amount_usd);
              if (Number.isFinite(usd) && usd > 0) return usd;
              const khr = Number(selected?.discounted_amount_khr) || Number(selected?.amount_khr) || 0;
              return khr > 0 ? Math.round((khr / 4000) * 100) / 100 : 0;
            })();
        saveTopUpReceipt({
          method: usingKhqr ? "khqr" : "aba",
          package_label: selected?.label || "Top-Up Package",
          amount_usd: amountUsdReceipt,
          base_points: Number(selected?.points) || 0,
          bonus_points: Number(selected?.bonus_points) || 0,
          total_points: pts,
          reference,
          balance_after: Number(data?.balance_after) || null,
        });
      } catch { /* receipt save must never break the credit path */ }

      setStep(STEPS.SUCCESS);
      // Points-sync v1 — fire a global refresh so every sibling view
      // (Library wallet pill, header pill, EduTalk balance, sticky
      // top-up hook, locked-book checks) reconciles against the server
      // the instant the payment is credited. Belt-and-suspenders with
      // the parent-supplied onCredited prop — both are safe to fire.
      try { requestPointsRefresh("topup_completed", { credited: pts }); } catch { /* noop */ }
      if (onCredited) onCredited(pts);
return true;
    }
    if (s === "needs_review") {
      setReviewMsg(
        data?.message ||
        "Payment is under review. If you already paid, points will be credited shortly."
      );
      try { sessionStorage.removeItem("khqr_pending"); } catch { /* noop */ }
      setStep(STEPS.REVIEW);
      return true;
    }
    if (s === "expired") {
      try { sessionStorage.removeItem("khqr_pending"); } catch { /* noop */ }
      setStep(STEPS.EXPIRED);
      return true;
    }
    return false;
  }, [selected, onCredited, khqrIntent, refCode]);

  // ── Poll every 3 seconds while on PAY ──
  useEffect(() => {
    if (step !== STEPS.PAY || !intentId) return undefined;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const data = await apiFetch(`/payments/intents/${intentId}/status`);
        setPollsRun(p => p + 1);
        applyStatus(data);
      } catch {
        // backend cold-start — keep polling
      }
    };
    tick();
    pollTimerRef.current = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [step, intentId, applyStatus]);

  // ── Visibility refresh ──
  useEffect(() => {
    if (step !== STEPS.PAY || !intentId) return undefined;
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      apiFetch(`/payments/intents/${intentId}/status`)
        .then(applyStatus)
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [step, intentId, applyStatus]);

  // ── 3-minute countdown ──
  useEffect(() => {
    if (!expiresAt || (step !== STEPS.PAY && step !== STEPS.KHQR_PAY)) {
      setSecondsLeft(null); return undefined;
    }
    const tick = () => {
      const diff = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
      if (diff <= 0) {
        setSecondsLeft(0);
        if (!closedRef.current && step === STEPS.PAY) setStep(STEPS.EXPIRED);
        return;
      }
      setSecondsLeft(diff);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt, step]);

  // ── "I've paid" with disable + spinner + debounce ──
  const checkNow = useCallback(async () => {
    if (checking) return;
    const now = Date.now();
    if (now < checkCooldownRef.current) return;
    checkCooldownRef.current = now + CHECK_DEBOUNCE_MS;
    setChecking(true);
    setError("");
    // A PWA update must never land mid-payment-confirmation — see
    // pwaUpdateController.js.
    const endCriticalOp = beginCriticalOperation("topup-aba-check");
    try {
      const data = await apiFetch(`/payments/intents/${intentId}/status`);
      setLastCheckedAt(Date.now());
      const terminal = applyStatus(data);
      if (!terminal) {
        setError("Payment not detected yet. We are still checking automatically.");
      }
    } catch (e) {
      setError(e.message || "Could not check payment yet — we keep trying.");
    } finally {
      setTimeout(() => setChecking(false), CHECK_DEBOUNCE_MS);
      endCriticalOp();
    }
  }, [checking, intentId, applyStatus]);

  // ── Create payment intent ──
  // -- CamRapidPay KHQR handler --------------------------------------------─
  // v1.1 fix (Blocker 1): the probe that called create-intent on package
  // load has been removed. create-intent creates real invoices and must only
  // fire on explicit student tap. The KHQR button is rendered by default;
  // handleConfirmKhqr is the sole entry point for create-intent.

  // Create a FRESH intent when the student taps the KHQR button.
  async function handleConfirmKhqr() {
    if (!selected || !studentId) return;
    // v3 spinner fix: use the dedicated KHQR loading flag so ONLY the KHQR
    // button shows the spinner. The ABA/manual confirm button keeps using
    // ``creating`` and is unaffected by this click.
    setKhqrCreating(true);
    setError("");
    setKhqrIntent(null);
    // A PWA update must never land mid-payment-creation — see
    // pwaUpdateController.js.
    const endCriticalOp = beginCriticalOperation("topup-khqr-create");
    try {
      const d = await apiFetch("/payments/camrapidpay/create-intent", {
        method: "POST",
        body: JSON.stringify({ package_id: selected._id }),
      });
      if (!d || d.fallback === true) {
        // Backend flag is OFF. Stay on PICK, show a gentle message.
        // Do NOT navigate away — the student can still use the ABA button.
        setError("KHQR payment is not available right now. Please use the ABA button above.");
        return;
      }
      if (!d.success) {
        setError(d.error || "Could not create KHQR payment. Please try again.");
        setStep(STEPS.ERROR);
        return;
      }
      setKhqrIntent(d);
      setExpiresAt(d.expires_at);
      setPollsRun(0);
      setLastCheckedAt(null);
      setKhqrReturning(false);
      // Persist intent so the modal can recover if the student's tab
      // is refreshed or the phone OS reloads the PWA after returning
      // from the CamRapidPay payment page.
      try {
        sessionStorage.setItem("khqr_pending", JSON.stringify({
          payment_intent_id: d.payment_intent_id,
          reference:         d.reference,
          expires_at:        d.expires_at,
          amount:            d.amount,
          amount_khr:        d.amount_khr,
          amount_usd:        d.amount_usd,
          total_points:      d.total_points,
          bonus_points:      d.bonus_points,
        }));
      } catch { /* sessionStorage unavailable — not critical */ }
      setStep(STEPS.KHQR_PAY);
    } catch (e) {
      setError(e.message || "Could not create KHQR payment. Please try again.");
      setStep(STEPS.ERROR);
    } finally {
      setKhqrCreating(false);
      endCriticalOp();
    }
  }

  // Poll the CamRapidPay status endpoint while on KHQR_PAY step.
  useEffect(() => {
    if (step !== STEPS.KHQR_PAY || !khqrIntent) return undefined;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || !khqrIntent) return;
      try {
        const d = await apiFetch(
          `/payments/camrapidpay/status/${khqrIntent.payment_intent_id}`
        );
        setPollsRun(p => p + 1);
        if (!d || cancelled) return;
        // Map CamRapidPay statuses to the existing applyStatus terminal model.
        if (d.status === "credited") {
          const pts = (d.total_points || 0) ||
            ((selected?.points || 0) + (selected?.bonus_points || 0));
          applyStatus({ status: "completed", credited_points: pts });
        } else if (d.status === "expired") {
          applyStatus({ status: "expired" });
        } else if (d.status === "manual_review") {
          applyStatus({
            status: "needs_review",
            message: "Payment is under review. Points will be credited shortly if payment succeeded.",
          });
        }
        // pending / unknown: keep polling
      } catch {
        // cold start or network hiccup - keep polling silently
      }
    };
    tick();
    khqrPollRef.current = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (khqrPollRef.current) clearInterval(khqrPollRef.current);
      khqrPollRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, khqrIntent]);

  // "I've paid" for the KHQR flow.
  const khqrCheckNow = useCallback(async () => {
    if (khqrChecking || !khqrIntent) return;
    const now = Date.now();
    if (now < khqrCoolRef.current) return;
    khqrCoolRef.current = now + CHECK_DEBOUNCE_MS;
    setKhqrChecking(true);
    setError("");
    // A PWA update must never land mid-payment-confirmation — see
    // pwaUpdateController.js.
    const endCriticalOp = beginCriticalOperation("topup-khqr-check");
    try {
      const d = await apiFetch(
        `/payments/camrapidpay/status/${khqrIntent.payment_intent_id}`
      );
      setLastCheckedAt(Date.now());
      if (!d) return;
      if (d.status === "credited") {
        const pts = (d.total_points || 0) ||
          ((selected?.points || 0) + (selected?.bonus_points || 0));
        applyStatus({ status: "completed", credited_points: pts });
      } else if (d.status === "expired") {
        applyStatus({ status: "expired" });
      } else if (d.status === "manual_review") {
        applyStatus({
          status: "needs_review",
          message: "Payment is under review. Points will be credited shortly.",
        });
      } else {
        setError("ការទូទាត់មិនទាន់ពិនិត្យឃើញ។ យើងនៅតែពិនិត្យដោយស្វ័យប្រវត្តិ។");
      }
    } catch (e) {
      setError(e.message || "Could not check payment - we keep trying automatically.");
    } finally {
      setKhqrChecking(false);
      endCriticalOp();
    }
  }, [khqrChecking, khqrIntent, selected, applyStatus]);

  async function handleConfirmPackage() {
    if (!selected || !studentId) return;
    setCreating(true);
    setError("");
    // A PWA update must never land mid-payment-creation — see
    // pwaUpdateController.js.
    const endCriticalOp = beginCriticalOperation("topup-aba-create");
    try {
      // v4 (USD packages): the ABA / manual payment-intent route still
      // matches packages by amount_khr (because real ABA notifications carry
      // KHR), so we keep submitting amount_khr. amount_usd is sent alongside
      // for future-proofing; the backend ignores unknown fields safely.
      const khrForAba =
        Number(selected.discounted_amount_khr) ||
        Number(selected.amount_khr) ||
        (Number(selected.amount_usd) > 0
          ? Math.round(Number(selected.amount_usd) * 4000)
          : 0);
      const usdForAba =
        Number(selected.discounted_amount_usd) ||
        Number(selected.amount_usd) ||
        (Number(selected.amount_khr) > 0
          ? Math.round((Number(selected.amount_khr) / 4000) * 100) / 100
          : 0);
      const data = await apiFetch("/payments/intents", {
        method: "POST",
        body: JSON.stringify({
          type:       "points",
          student_id: studentId,
          amount:     khrForAba,
          amount_khr: khrForAba,
          amount_usd: usdForAba,
          currency:   "KHR",
          pkg_id:     selected._id,
        }),
      });
      setIntentId(data.intent_id);
      setRefCode(data.reference_code);
      setExpiresAt(data.expires_at);
      setPollsRun(0);
      setLastCheckedAt(null);
      setStep(STEPS.PAY);
    } catch (e) {
      if (e.status === 423 || (e.body && e.body.detail && e.body.detail.reason === "lane_busy")) {
        setError(
          (e.body && e.body.detail && e.body.detail.message) ||
          "Payment session is currently preparing for another learner. Please try again in a moment."
        );
      } else {
        setError(e.message);
      }
      setStep(STEPS.ERROR);
    } finally {
      setCreating(false);
      endCriticalOp();
    }
  }

  // ── Cleanup ──
  useEffect(() => () => {
    closedRef.current = true;
    if (pollTimerRef.current)  clearInterval(pollTimerRef.current);
    if (khqrPollRef.current)   clearInterval(khqrPollRef.current);
  }, []);

  const totalPts = (selected?.points || 0) + (selected?.bonus_points || 0);
  // v4 (USD packages): the package's source-of-truth price is amount_usd.
  // For legacy KHR-only packages we synthesise USD at the shared 4000 rate
  // so the modal never reads $0 on a still-active KHR doc.
  const amountUSD = (() => {
    if (!selected) return 0;
    const disc = Number(selected.discounted_amount_usd);
    if (Number.isFinite(disc) && disc > 0) return disc;
    const usd = Number(selected.amount_usd);
    if (Number.isFinite(usd) && usd > 0) return usd;
    const khr = Number(selected.discounted_amount_khr) || Number(selected.amount_khr) || 0;
    return khr > 0 ? Math.round((khr / 4000) * 100) / 100 : 0;
  })();
  const amountKHR = selected?.discounted_amount_khr || selected?.amount_khr || 0;
  const fmtUsd = (n) => `$${(Number(n) || 0).toFixed(2)}`;

  const handleBackdropClick = (e) => {
    if (e.target !== e.currentTarget) return;
    if (step === STEPS.PAY) return;
    if (step === STEPS.KHQR_PAY) return;
    onClose && onClose();
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        data-testid="topup-modal"
        style={{
          position: "fixed", inset: 0, zIndex: 10000,
          background:
            "radial-gradient(120% 100% at 20% 0%, rgba(40,20,70,0.72) 0%, rgba(6,4,14,0.86) 60%)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          display: "flex",
          // Align to top with padding so on short phones the modal slides down
          // from the top rather than getting clipped below the system nav bar.
          alignItems: "flex-start",
          justifyContent: "center",
          // v1 (top-up safe-area stabilization) — add a fixed 56 px buffer
          // ON TOP OF the device safe-area inset so the modal card never
          // visually crowds the Library page header (which bleeds through
          // the semi-transparent backdrop blur). On iPhone with a 44-59 px
          // notch this lands the card 100-115 px from the top edge; on
          // Android / no-notch viewports the floor stays at 68 px. The
          // 56 px buffer corresponds to the visible Library greeting/header
          // band and was previously only 12 px, which is what produced
          // the "header partly hidden behind Library header" complaint.
          paddingTop: "calc(max(env(safe-area-inset-top, 12px), 12px) + 56px)",
          paddingBottom: "max(env(safe-area-inset-bottom, 0px), 0px)",
          paddingLeft: 16,
          paddingRight: 16,
          overflowY: "auto",
          fontFamily: KHMER_FONT_STACK,
        }}
        onClick={handleBackdropClick}
      >
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 24 }}
          transition={{ type: "spring", damping: 26, stiffness: 380 }}
          style={{
            width: "100%", maxWidth: 440,
            // Use dvh so the card respects the dynamic viewport on iOS Safari
            // (where the bottom bar appears/disappears).
            //
            // v1 (top-up safe-area stabilization) — subtract the new
            // 56 px top buffer + safe-area insets + 24 px bottom breathing
            // room from the dynamic viewport so the card never overflows
            // even on short phones. The inner overflowY:auto then
            // guarantees the package list stays scrollable.
            maxHeight:
              "calc(100dvh - env(safe-area-inset-top, 12px) - env(safe-area-inset-bottom, 0px) - 80px)",
            background:
              "radial-gradient(135% 90% at 20% 0%, rgba(50,32,78,0.96) 0%, rgba(12,8,22,0.98) 65%)",
            border: "1px solid rgba(212,168,67,0.32)",
            borderRadius: 26,
            overflowY: "auto",
            overflowX: "hidden",
            // webkit custom scrollbar — invisible by default, appears on drag
            scrollbarWidth: "none",
            WebkitScrollbar: { display: "none" },
            boxShadow:
              "0 28px 70px rgba(0,0,0,0.65), 0 0 0 1px rgba(212,168,67,0.10), inset 0 1px 0 rgba(255,225,154,0.08)",
            // Bottom margin so buy button is never hidden behind the phone nav
            marginBottom: "max(env(safe-area-inset-bottom, 16px), 16px)",
          }}
        >
          {/* Soft top edge highlight */}
          <div aria-hidden style={{
            height: 1.5,
            background:
              "linear-gradient(90deg, transparent, rgba(255,225,154,0.55), rgba(167,139,250,0.4), transparent)",
          }} />

          {/* ── Header ── */}
          <div style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "18px 20px 14px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
          }}>
            <div style={{
              width: 40, height: 40, borderRadius: 12,
              background: "linear-gradient(135deg,rgba(212,168,67,0.32),rgba(167,139,250,0.18))",
              border: "1px solid rgba(212,168,67,0.4)",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 0 16px rgba(212,168,67,0.25)",
            }}>
              <Coins size={19} color="#FFE19A" />
            </div>
            <div style={{ minWidth: 0 }}>
              <div data-testid="topup-header-title" style={{
                fontWeight: 800, fontSize: 17,
                color: "#FFE19A",
                ...km,
              }}>
                បញ្ចូលពិន្ទុ
                <span style={{
                  marginLeft: 8, fontSize: 11, fontWeight: 600,
                  color: "#a78bfa", letterSpacing: "0.02em",
                  fontFamily: "system-ui, -apple-system, sans-serif",
                }}>
                  Buy Points
                </span>
              </div>
              <div style={{
                fontSize: 11, color: "#9ca3af",
                display: "flex", alignItems: "center", gap: 5, marginTop: 2,
              }}>
                <ShieldCheck size={11} color="#5eead4" />
                <span style={{ fontFamily: "system-ui, -apple-system, sans-serif" }}>
                  {(() => {
                    // v1.6: subtitle reflects only what the admin has
                    // enabled. Empty config (loading) falls back to a
                    // safe generic label so we never flash stale text.
                    if (!methodsCfg.loaded) return "Secure · Instant credit";
                    const parts = [];
                    if (abaVisible) parts.push("ABA");
                    if (khqrVisible) parts.push("KHQR");
                    if (parts.length === 0) return "Secure · Instant credit";
                    return parts.join(" · ") + " · Instant credit";
                  })()}
                </span>
              </div>
            </div>
            <div style={{ flex: 1 }} />

            {/* Secure badge — premium pill */}
            <div aria-hidden style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              background: "rgba(94,234,212,0.12)",
              border: "1px solid rgba(94,234,212,0.32)",
              borderRadius: 999,
              padding: "3px 9px",
              fontSize: 10, fontWeight: 700,
              color: "#5eead4",
              letterSpacing: "0.04em",
              fontFamily: "system-ui, -apple-system, sans-serif",
            }}>
              <ShieldCheck size={10} /> SECURE
            </div>

            {step !== STEPS.PAY && step !== STEPS.KHQR_PAY && (
              <button
                onClick={onClose}
                data-testid="topup-close-btn"
                aria-label="Close"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  cursor: "pointer", color: "#9ca3af",
                  padding: 6, borderRadius: 10,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  marginLeft: 6,
                }}
              >
                <X size={16} />
              </button>
            )}
          </div>

          <div style={{ padding: "18px 20px 28px" }}>

            {/* ── STEP: PICK ── */}
            {step === STEPS.PICK && (
              <div>
                {loading ? (
                  <div data-testid="topup-loading-skeleton" style={{ padding: "6px 0 4px" }}>
                    <div style={{
                      fontSize: 13, color: "#FFE19A", marginBottom: 14, fontWeight: 700, ...km,
                    }}>
                      ជ្រើសរើសកញ្ចប់
                      <span style={{
                        marginLeft: 6, fontSize: 10, color: "#6b7280", fontWeight: 500,
                        fontFamily: "system-ui, -apple-system, sans-serif",
                      }}>
                        · Select a package
                      </span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
                      {[0, 1, 2].map(i => (
                        <div
                          key={i}
                          className="topup-skeleton"
                          style={{
                            height: 64,
                            border: "1px solid rgba(255,255,255,0.06)",
                            opacity: 1 - i * 0.18,
                          }}
                        />
                      ))}
                    </div>
                    <div className="topup-skeleton" style={{ height: 50, borderRadius: 16 }} />
                  </div>
                ) : packagesFetchError && packages.length === 0 ? (
                  // Prefetch v1.0.1 — distinguishes a NETWORK/API failure
                  // from a successful "zero active packages" response.
                  // Cached packages, if any, are kept visible; this branch
                  // runs only when there is nothing to render.
                  <div
                    data-testid="topup-packages-error"
                    style={{ textAlign: "center", padding: "20px 8px", color: "#fca5a5", fontSize: 13 }}
                  >
                    <AlertTriangle size={22} color="#fca5a5" style={{ margin: "0 auto 8px" }} />
                    <div style={{ marginBottom: 4, fontWeight: 700, ...km }}>មិនអាចទាញកញ្ចប់ពិន្ទុបានទេ</div>
                    <div style={{ fontSize: 11.5, color: "#9ca3af", marginBottom: 12 }}>
                      Could not load top-up packages. Check your connection and try again.
                    </div>
                    <button
                      type="button"
                      data-testid="topup-packages-retry-btn"
                      onClick={() => { runPackagesRefresh().catch(() => {}); }}
                      disabled={packagesRefreshing}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 8,
                        background: "rgba(212,168,67,0.18)",
                        color: "#FFE19A",
                        border: "1px solid rgba(212,168,67,0.55)",
                        borderRadius: 10,
                        padding: "8px 16px",
                        fontWeight: 800, fontSize: 12.5,
                        cursor: packagesRefreshing ? "default" : "pointer",
                        opacity: packagesRefreshing ? 0.7 : 1,
                        ...km,
                      }}
                    >
                      {packagesRefreshing
                        ? <Loader2 size={14} style={{ animation: "topup-spin 1s linear infinite" }} />
                        : <RefreshCw size={14} />}
                      <span>{packagesRefreshing ? "កំពុងព្យាយាម…" : "ព្យាយាមម្ដងទៀត · Retry"}</span>
                    </button>
                  </div>
                ) : packages.length === 0 ? (
                  <div
                    data-testid="topup-packages-empty"
                    style={{ textAlign: "center", padding: 24, color: "#9ca3af", fontSize: 13 }}
                  >
                    <span style={km}>មិនទាន់មានកញ្ចប់ពិន្ទុ</span><br />
                    <span style={{ fontSize: 11, color: "#6b7280" }}>No points packages configured yet.</span>
                  </div>
                ) : (
                  <>
                    {/* ── v1.3 hero + context (only when smart trigger
                          provided a reason; manual opens skip this so
                          the modal stays compact as before) ── */}
                    {false && (
                      <>
                        <div style={{ marginTop: -6, marginBottom: 4 }}>
                          <TopUpHeroCharacter size={132} />
                        </div>

                        {/* Current balance pill */}
                        {typeof currentBalance === "number" && (
                          <div
                            data-testid="topup-current-balance"
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              gap: 8,
                              margin: "0 auto 12px",
                              padding: "6px 14px",
                              borderRadius: 999,
                              background: "rgba(94,234,212,0.10)",
                              border: "1px solid rgba(94,234,212,0.32)",
                              maxWidth: "fit-content",
                            }}
                          >
                            <Coins size={13} color="#5eead4" />
                            <span style={{
                              fontSize: 11, color: "#5eead4", fontWeight: 700,
                              ...km,
                            }}>
                              ពិន្ទុបច្ចុប្បន្ន
                            </span>
                            <span style={{
                              fontSize: 14, color: "#fff", fontWeight: 800,
                              fontVariantNumeric: "tabular-nums",
                              fontFamily: "system-ui, -apple-system, sans-serif",
                            }}>
                              {Math.max(0, Math.floor(currentBalance)).toLocaleString()}
                            </span>
                            <span style={{
                              fontSize: 10, color: "#9ca3af", fontWeight: 700,
                              textTransform: "uppercase", letterSpacing: "0.05em",
                              fontFamily: "system-ui, -apple-system, sans-serif",
                            }}>
                              pts
                            </span>
                          </div>
                        )}

                        {/* Contextual headline + body */}
                        {(contextHeadlineKm || contextBodyKm) && (
                          <div
                            data-testid="topup-context-message"
                            style={{
                              textAlign: "center",
                              marginBottom: 14,
                              padding: "10px 14px",
                              borderRadius: 14,
                              background:
                                "linear-gradient(135deg, rgba(167,139,250,0.10), rgba(94,234,212,0.06))",
                              border: "1px solid rgba(167,139,250,0.22)",
                            }}
                          >
                            {contextHeadlineKm && (
                              <div style={{
                                fontSize: 14, color: "#FFE19A", fontWeight: 800,
                                marginBottom: 3, ...km,
                              }}>
                                {contextHeadlineKm}
                              </div>
                            )}
                            {contextBodyKm && (
                              <div style={{
                                fontSize: 12, color: "#c4b5fd", ...km,
                              }}>
                                {contextBodyKm}
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}

                    <div style={{
                      fontSize: 13, color: "#FFE19A", marginBottom: 14,
                      fontWeight: 700,
                      ...km,
                    }}>
                      ជ្រើសរើសកញ្ចប់
                      <span style={{
                        marginLeft: 6, fontSize: 10, color: "#6b7280", fontWeight: 500,
                        fontFamily: "system-ui, -apple-system, sans-serif",
                      }}>
                        · Select a package
                      </span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
                      {packages.map(pkg => (
                        <PackageCard
                          key={pkg._id}
                          pkg={pkg}
                          selected={selected}
                          onSelect={setSelected}
                          recommended={recommendedPackageId && pkg._id === recommendedPackageId}
                        />
                      ))}
                    </div>

                    {/* -- KHQR payment button (CamRapidPay — only when flag is ON) --
                         Students see "KHQR Payment / បង់ប្រាក់តាម KHQR".
                         The provider name CamRapidPay is NEVER shown to students. */}
                    {/* v1.6: visibility is gated by both
                         (a) admin Payment Methods toggle (methodsCfg.khqr)
                         (b) provider readiness (/config probe — khqrIsEnabled)
                         Disabled = NOT rendered at all (no greyed-out shell). */}
                    {khqrVisible && (
                      <button
                        onClick={handleConfirmKhqr}
                        disabled={!selected || khqrCreating}
                        data-testid="topup-khqr-btn"
                        style={{
                          width: "100%",
                          background: khqrCreating
                            ? "rgba(94,234,212,0.10)"
                            : "linear-gradient(135deg, rgba(6,78,59,0.90) 0%, rgba(20,83,45,0.95) 100%)",
                          border: "1px solid rgba(52,211,153,0.45)",
                          borderRadius: 16,
                          padding: "15px 18px",
                          marginBottom: 10,
                          color: "#6ee7b7",
                          fontWeight: 800,
                          fontSize: 15,
                          cursor: (!selected || khqrCreating) ? "not-allowed" : "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 10,
                          boxShadow: "0 8px 24px rgba(52,211,153,0.18), inset 0 1px 0 rgba(255,255,255,0.10)",
                          opacity: (!selected || khqrCreating) ? 0.6 : 1,
                          transition: "opacity 0.18s ease",
                          ...km,
                        }}
                      >
                        {khqrCreating ? (
                          <>
                            <Loader2 size={16} style={{ animation: "topup-spin 1s linear infinite" }} />
                            <span style={km}>កំពុងរៀបចំ…</span>
                          </>
                        ) : (
                          <>
                            {/* KHQR mark — a small green QR icon */}
                            <span aria-hidden style={{
                              display: "inline-flex", alignItems: "center", justifyContent: "center",
                              width: 26, height: 26, borderRadius: 8,
                              background: "rgba(52,211,153,0.22)",
                              border: "1px solid rgba(52,211,153,0.40)",
                            }}>
                              <QrCode size={14} color="#6ee7b7" />
                            </span>
                            {/* Student-facing label: KHQR — never "CamRapidPay" */}
                            <span style={km}>បង់ប្រាក់តាម KHQR</span>
                            <span style={{
                              fontSize: 11, color: "#34d399", fontWeight: 600,
                              fontFamily: "system-ui, -apple-system, sans-serif",
                              letterSpacing: "0.02em",
                            }}>
                              · KHQR Payment
                            </span>
                          </>
                        )}
                      </button>
                    )}

                    {error && (
                      <div data-testid="topup-pick-error" style={{
                        color: "#fbbf24", fontSize: 12, marginBottom: 12,
                        background: "rgba(251,191,36,0.08)",
                        border: "1px solid rgba(251,191,36,0.25)",
                        borderRadius: 10, padding: "8px 10px",
                        display: "flex", alignItems: "center", gap: 6,
                        ...km,
                      }}>
                        <AlertTriangle size={12} />
                        {error}
                      </div>
                    )}

                    <button
                      onClick={handleConfirmPackage}
                      disabled={!selected || creating || !abaVisible}
                      data-testid="topup-confirm-btn"
                      style={{
                        width: "100%",
                        // v1.6: when ABA is disabled by admin, this button
                        // is removed from layout entirely so the modal
                        // never offers ABA as an entry path.
                        display: abaVisible ? "flex" : "none",
                        background: selected
                          ? "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)"
                          : "rgba(255,255,255,0.05)",
                        color: selected ? "#1a1420" : "#4b5563",
                        border: "none", borderRadius: 16,
                        padding: "15px 20px",
                        fontWeight: 800, fontSize: 15,
                        cursor: selected && !creating ? "pointer" : "not-allowed",
                        alignItems: "center", justifyContent: "center", gap: 10,
                        boxShadow: selected
                          ? "0 8px 28px rgba(212,168,67,0.35), inset 0 1px 0 rgba(255,255,255,0.35)"
                          : "none",
                        ...km,
                      }}
                    >
                      {creating ? (
                        <>
                          <Loader2 size={16} style={{ animation: "topup-spin 1s linear infinite" }} />
                          <span style={km}>កំពុងរៀបចំ…</span>
                        </>
                      ) : selected ? (
                        <>
                          <QrCode size={16} />
                          <span style={km}>ទិញឥឡូវនេះ</span>
                          <span style={{
                            fontFamily: "system-ui, -apple-system, sans-serif",
                            fontWeight: 700, fontSize: 13, opacity: 0.85,
                            fontVariantNumeric: "tabular-nums",
                          }}>
                            · {fmtUsd(amountUSD)} → {totalPts} pts
                          </span>
                        </>
                      ) : (
                        <span style={km}>ជ្រើសរើសកញ្ចប់</span>
                      )}
                    </button>

                    {/* Premium polish: trust strip — only shown on PICK.
                        v1.6: dynamically reflects which methods are visible,
                        so admin-disabled methods leave NO trace in the copy. */}
                    {(abaVisible || khqrVisible) && (
                    <div
                      data-testid="topup-trust-strip"
                      aria-hidden
                      style={{
                        marginTop: 14,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 10,
                        padding: "8px 10px",
                        background: "rgba(255,255,255,0.025)",
                        border: "1px solid rgba(255,255,255,0.06)",
                        borderRadius: 12,
                        fontFamily: "system-ui, -apple-system, sans-serif",
                        flexWrap: "wrap",
                      }}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <ShieldCheck size={11} color="#5eead4" />
                        <span style={{ fontSize: 10.5, color: "#9ca3af", fontWeight: 600 }}>
                          {khqrVisible ? "Secured by KHQR" : "Secured payment"}
                        </span>
                      </span>
                      {khqrVisible && (
                        <>
                          <span style={{ color: "#374151", fontSize: 10 }}>·</span>
                          <span style={{ fontSize: 10.5, color: "#6b7280" }}>
                            ABA · Bakong · Wing · ACLEDA
                          </span>
                        </>
                      )}
                      <span style={{ color: "#374151", fontSize: 10 }}>·</span>
                      <span style={{ fontSize: 10.5, color: "#6b7280" }}>
                        Instant credit
                      </span>
                    </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── STEP: PAY ── */}
            {step === STEPS.PAY && (
              <div data-testid="topup-pay-screen">
                {/* Lottie + summary */}
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  marginBottom: 12, marginTop: -2,
                }}>
                  <TopUpLottie size={116} />
                </div>

                <div style={{
                  textAlign: "center",
                  background: "linear-gradient(135deg, rgba(212,168,67,0.14), rgba(167,139,250,0.08))",
                  border: "1px solid rgba(212,168,67,0.3)",
                  borderRadius: 16,
                  padding: "12px 14px",
                  marginBottom: 16,
                }}>
                  <div style={{
                    fontSize: 12, color: "#c4b5fd", marginBottom: 4,
                    fontWeight: 600, ...km,
                  }}>
                    {selected?.label || "Top-Up Package"}
                  </div>
                  <div>
                    <span style={{
                      fontWeight: 800, fontSize: 26, color: "#FFE19A",
                      fontVariantNumeric: "tabular-nums",
                      textShadow: "0 0 18px rgba(212,168,67,0.45)",
                    }} data-testid="topup-amount">
                      {fmtUsd(amountUSD)}
                    </span>
                    <span style={{
                      fontSize: 12, color: "#9ca3af", marginLeft: 6,
                      fontWeight: 700, letterSpacing: "0.05em",
                      fontFamily: "system-ui, -apple-system, sans-serif",
                    }}>
                      USD
                    </span>
                    <span style={{ color: "#9ca3af", fontSize: 12, marginLeft: 10 }}>
                      →{" "}
                      <span style={{ color: "#c4b5fd", fontWeight: 800, fontSize: 15 }}>
                        {totalPts}
                      </span>{" "}
                      <span style={{ fontSize: 11, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        pts
                      </span>
                      {selected?.bonus_points ? (
                        <span style={{ color: "#4ade80", marginLeft: 6, fontSize: 11, fontWeight: 700 }}>
                          (+{selected.bonus_points} bonus)
                        </span>
                      ) : null}
                    </span>
                  </div>
                </div>

                {/* Pay button — premium ABA */}
                <a
                  href={selected?.payment_link || "https://link.payway.com.kh/ABAPAYEo447481z"}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="topup-open-aba-btn"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
                    background: "linear-gradient(135deg, #003a78 0%, #0066cc 60%, #1e88e5 100%)",
                    borderRadius: 16, padding: "15px 18px",
                    marginBottom: 12, textDecoration: "none",
                    boxShadow: "0 10px 28px rgba(0,102,204,0.45), inset 0 1px 0 rgba(255,255,255,0.18)",
                    border: "1px solid rgba(255,255,255,0.2)",
                    color: "#fff", fontWeight: 800, fontSize: 15,
                    ...km,
                  }}
                >
                  <span aria-hidden style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 26, height: 26, borderRadius: 8,
                    background: "#fff",
                    color: "#003a78",
                    fontWeight: 900, fontSize: 12, letterSpacing: 0,
                    fontFamily: "system-ui, -apple-system, sans-serif",
                  }}>
                    ABA
                  </span>
                  <span style={km}>បង់ប្រាក់ជាមួយ ABA</span>
                </a>

                <details style={{ marginBottom: 14, textAlign: "center" }}>
                  <summary style={{
                    color: "#60a5fa", fontSize: 12, cursor: "pointer", marginBottom: 8,
                    listStyle: "none", display: "inline-flex", alignItems: "center", gap: 4,
                    fontFamily: "system-ui, -apple-system, sans-serif",
                  }}>
                    <QrCode size={11} /> Show QR code for desktop
                  </summary>
                  <div style={{
                    background: "#fff", borderRadius: 14, padding: 12, display: "inline-block",
                    boxShadow: "0 8px 22px rgba(0,0,0,0.3)",
                    marginTop: 6,
                  }}>
                    <img
                      src={QR_IMAGE_PATH}
                      alt="ABA KHQR"
                      style={{ width: 180, height: 180, display: "block" }}
                      onError={(e) => { e.target.style.display = "none"; }}
                    />
                  </div>
                </details>

                {/* Countdown */}
                {secondsLeft !== null && (() => {
                  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
                  const ss = String(secondsLeft % 60).padStart(2, "0");
                  const urgent = secondsLeft <= 30;
                  return (
                    <div
                      data-testid="topup-countdown"
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        gap: 8, marginBottom: 12,
                        padding: "8px 14px",
                        background: urgent ? "rgba(248,113,113,0.10)" : "rgba(251,191,36,0.06)",
                        border: `1px solid ${urgent ? "rgba(248,113,113,0.35)" : "rgba(251,191,36,0.22)"}`,
                        borderRadius: 12,
                      }}
                    >
                      <Clock4 size={14} color={urgent ? "#f87171" : "#fbbf24"} />
                      <span style={{
                        fontSize: 12, color: urgent ? "#fca5a5" : "#fbbf24",
                        ...km,
                      }}>
                        ផុតកំណត់ការបង់ប្រាក់ក្នុងរយៈ
                      </span>
                      <span style={{
                        fontWeight: 800,
                        color: urgent ? "#f87171" : "#fbbf24",
                        fontVariantNumeric: "tabular-nums",
                        fontSize: 14,
                        letterSpacing: "0.04em",
                        fontFamily: "system-ui, -apple-system, sans-serif",
                        textShadow: urgent ? "0 0 12px rgba(248,113,113,0.55)" : "none",
                      }}>
                        {mm}:{ss}
                      </span>
                    </div>
                  );
                })()}

                {/* Reference code */}
                <div style={{
                  background: "rgba(167,139,250,0.08)",
                  border: "1px solid rgba(167,139,250,0.22)",
                  borderRadius: 12,
                  padding: "9px 12px",
                  marginBottom: 14,
                  fontSize: 11,
                  textAlign: "center",
                }}>
                  <div style={{
                    color: "#9ca3af", marginBottom: 3, fontSize: 10,
                    textTransform: "uppercase", letterSpacing: "0.06em",
                    fontFamily: "system-ui, -apple-system, sans-serif",
                  }}>
                    Payment reference · for support only
                  </div>
                  <code
                    data-testid="topup-ref-code"
                    style={{
                      color: "#c4b5fd", fontWeight: 700,
                      letterSpacing: "0.04em",
                      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
                      fontSize: 12,
                    }}
                  >
                    {refCode}
                  </code>
                </div>

                {/* I've paid - check now */}
                <button
                  onClick={checkNow}
                  disabled={checking}
                  data-testid="topup-ive-paid-btn"
                  style={{
                    width: "100%",
                    background: checking
                      ? "rgba(96,165,250,0.20)"
                      : "rgba(96,165,250,0.10)",
                    color: "#93c5fd",
                    border: "1px solid rgba(96,165,250,0.38)",
                    borderRadius: 14,
                    padding: "13px 16px",
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: checking ? "wait" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    transition: "background 0.18s ease, opacity 0.18s ease",
                    opacity: checking ? 0.9 : 1,
                    ...km,
                  }}
                >
                  {checking ? (
                    <>
                      <Loader2 size={15} style={{ animation: "topup-spin 1s linear infinite" }} />
                      <span style={km}>កំពុងពិនិត្យការទូទាត់…</span>
                    </>
                  ) : (
                    <>
                      <RefreshCw size={14} />
                      <span style={km}>ខ្ញុំបានបង់ប្រាក់រួចរាល់</span>
                    </>
                  )}
                </button>

                {/* Status footer */}
                <div
                  data-testid="topup-status-footer"
                  style={{
                    marginTop: 10,
                    textAlign: "center",
                    fontSize: 11,
                    color: "#6b7280",
                    fontFamily: "system-ui, -apple-system, sans-serif",
                  }}
                >
                  {lastCheckedAt ? (
                    <>Last checked just now · Auto-checking every 3 seconds</>
                  ) : (
                    <>Auto-checking every 3 seconds…</>
                  )}
                </div>

                {error && (
                  <div
                    data-testid="topup-pay-error"
                    style={{
                      marginTop: 10,
                      color: "#fbbf24",
                      fontSize: 11.5,
                      textAlign: "center",
                      background: "rgba(251,191,36,0.08)",
                      border: "1px solid rgba(251,191,36,0.25)",
                      borderRadius: 8,
                      padding: "7px 10px",
                      ...km,
                    }}
                  >
                    {error}
                  </div>
                )}
              </div>
            )}

            {/* -- STEP: KHQR_PAY -- In-PWA KHQR checkout (v1.6) --------------
                 Student-facing labels use KHQR / Bakong / Khmer only.
                 The word "CamRapidPay" NEVER appears here. The QR is
                 rendered inline using ``khqrIntent.qr_code`` returned by
                 the backend so the student never leaves EduHub.
                 -------------------------------------------------------- */}
            {step === STEPS.KHQR_PAY && khqrIntent && (
              <div data-testid="topup-khqr-pay-screen">
                {/* In-PWA checkout header — premium EduHub-owned look */}
                <div style={{ textAlign: "center", marginBottom: 14 }}>
                  <div style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    background: "rgba(52,211,153,0.14)",
                    border: "1px solid rgba(52,211,153,0.35)",
                    borderRadius: 999, padding: "3px 11px",
                    marginBottom: 6,
                  }}>
                    <QrCode size={11} color="#34d399" />
                    <span style={{
                      fontSize: 10, color: "#34d399", fontWeight: 800,
                      letterSpacing: "0.06em",
                      fontFamily: "system-ui, -apple-system, sans-serif",
                    }}>
                      SECURE KHQR PAYMENT
                    </span>
                  </div>
                  <div style={{
                    fontWeight: 800, fontSize: 16, color: "#FFE19A",
                    ...km,
                  }}>
                    {selected?.label || "KHQR Top-Up"}
                  </div>
                  <div style={{
                    marginTop: 3, fontSize: 11, color: "#6b7280",
                    fontFamily: "system-ui, -apple-system, sans-serif",
                  }}>
                    EduHub Studio · Instant credit
                  </div>
                </div>

                {/* Package summary */}
                <div style={{
                  textAlign: "center",
                  background: "linear-gradient(135deg, rgba(52,211,153,0.10), rgba(6,78,59,0.12))",
                  border: "1px solid rgba(52,211,153,0.30)",
                  borderRadius: 16,
                  padding: "12px 14px",
                  marginBottom: 14,
                }}>
                  <div>
                    {(() => {
                      const usd =
                        Number(khqrIntent.amount_usd) ||
                        Number(khqrIntent.amount) ||
                        Number(selected?.amount_usd) ||
                        (Number(selected?.amount_khr) > 0
                          ? Math.round((Number(selected.amount_khr) / 4000) * 100) / 100
                          : 0);
                      return (
                        <>
                          <span
                            data-testid="topup-khqr-amount"
                            style={{
                              fontWeight: 800, fontSize: 26, color: "#FFE19A",
                              fontVariantNumeric: "tabular-nums",
                              textShadow: "0 0 18px rgba(212,168,67,0.45)",
                            }}
                          >
                            ${usd.toFixed(2)}
                          </span>
                          <span
                            data-testid="topup-khqr-currency"
                            style={{
                              fontSize: 12, color: "#9ca3af", marginLeft: 6,
                              fontWeight: 700, letterSpacing: "0.05em",
                              fontFamily: "system-ui, -apple-system, sans-serif",
                            }}
                          >
                            USD
                          </span>
                        </>
                      );
                    })()}
                    <span style={{ color: "#9ca3af", fontSize: 12, marginLeft: 10 }}>
                      {"→"}{" "}
                      <span style={{ color: "#c4b5fd", fontWeight: 800, fontSize: 15 }}>
                        {khqrIntent.total_points || totalPts}
                      </span>{" "}
                      <span style={{
                        fontSize: 11, color: "#9ca3af",
                        textTransform: "uppercase", letterSpacing: "0.05em",
                        fontFamily: "system-ui, -apple-system, sans-serif",
                      }}>pts</span>
                      {(khqrIntent.bonus_points || 0) > 0 && (
                        <span style={{ color: "#4ade80", marginLeft: 6, fontSize: 11, fontWeight: 700 }}>
                          (+{khqrIntent.bonus_points} bonus)
                        </span>
                      )}
                    </span>
                  </div>
                </div>

                {/* v1.6 In-PWA KHQR card — renders qr_code as <img> so the
                    student NEVER leaves EduHub. v1.6.1: prefers the new
                    backend ``qr_image`` data URI (rendered server-side
                    from the raw EMV TLV payload). Falls back to the older
                    ``qr_code`` field for backward-compat if a previous
                    backend deploy is still live. Handles three formats:
                    (1) already a data: URI         → use as-is
                    (2) raw base64 payload          → wrap as data:image/png
                    (3) missing                     → safe EduHub error
                    No fallback redirect to pay.camrapidpay.com. */}
                {!khqrReturning && (() => {
                  // v1.6.1: prefer ``qr_image`` (server-rendered data URI).
                  const qrImage = (khqrIntent.qr_image || "").trim();
                  const rawCode = (khqrIntent.qr_code || "").trim();
                  // The chosen source: if ``qr_image`` is already a data
                  // URI we use it directly; otherwise we fall back to the
                  // legacy ``qr_code`` field and try to coerce it.
                  const isDataUri = (s) => /^data:image\//i.test(s);
                  const isBase64Image = (s) =>
                    !isDataUri(s) && /^[A-Za-z0-9+/=\r\n]+$/.test(s) && s.length > 100;
                  let src = "";
                  if (isDataUri(qrImage)) {
                    src = qrImage;
                  } else if (isBase64Image(qrImage)) {
                    src = `data:image/png;base64,${qrImage.replace(/\s+/g, "")}`;
                  } else if (isDataUri(rawCode)) {
                    src = rawCode;
                  } else if (isBase64Image(rawCode)) {
                    src = `data:image/png;base64,${rawCode.replace(/\s+/g, "")}`;
                  }

                  if (!src) {
                    return (
                      <div
                        data-testid="topup-khqr-unavailable"
                        style={{
                          padding: "14px 14px",
                          background: "rgba(251,191,36,0.08)",
                          border: "1px solid rgba(251,191,36,0.30)",
                          borderRadius: 14, marginBottom: 14,
                          color: "#fde68a", fontSize: 12.5, textAlign: "center",
                          ...km,
                        }}
                      >
                        <AlertTriangle size={14} color="#fbbf24" style={{ marginRight: 6, verticalAlign: "middle" }} />
                        KHQR is temporarily unavailable. Please use another method or try again.
                      </div>
                    );
                  }

                  return (
                    <div
                      data-testid="topup-khqr-card"
                      style={{
                        display: "flex", flexDirection: "column",
                        alignItems: "center", justifyContent: "center",
                        marginBottom: 14,
                        width: "100%",
                      }}
                    >
                      <div style={{
                        background: "#ffffff",
                        borderRadius: 18,
                        padding: 14,
                        boxShadow:
                          "0 14px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(52,211,153,0.45), 0 0 28px rgba(52,211,153,0.18)",
                        position: "relative",
                        // v1.6.1 mobile-first: card sizes itself to fit
                        // the modal column up to a natural ~280 px cap so
                        // the QR is comfortably scannable on small phones
                        // while never overflowing the modal padding.
                        width: "min(86vw, 280px)",
                        maxWidth: "100%",
                        boxSizing: "border-box",
                      }}>
                        {/* Corner brackets — premium KHQR card framing */}
                        <span aria-hidden style={{
                          position: "absolute", top: 6, left: 6,
                          width: 18, height: 18,
                          borderTop: "2px solid #34d399",
                          borderLeft: "2px solid #34d399",
                          borderTopLeftRadius: 6,
                        }} />
                        <span aria-hidden style={{
                          position: "absolute", top: 6, right: 6,
                          width: 18, height: 18,
                          borderTop: "2px solid #34d399",
                          borderRight: "2px solid #34d399",
                          borderTopRightRadius: 6,
                        }} />
                        <span aria-hidden style={{
                          position: "absolute", bottom: 6, left: 6,
                          width: 18, height: 18,
                          borderBottom: "2px solid #34d399",
                          borderLeft: "2px solid #34d399",
                          borderBottomLeftRadius: 6,
                        }} />
                        <span aria-hidden style={{
                          position: "absolute", bottom: 6, right: 6,
                          width: 18, height: 18,
                          borderBottom: "2px solid #34d399",
                          borderRight: "2px solid #34d399",
                          borderBottomRightRadius: 6,
                        }} />
                        <img
                          src={src}
                          alt="KHQR"
                          data-testid="topup-khqr-qr-image"
                          style={{
                            display: "block",
                            // v1.6.1: image fills its card so the QR
                            // matches the natural size CamRapidPay /
                            // Bakong issue. ``aspectRatio: 1`` keeps it
                            // square regardless of the source PNG
                            // dimensions.
                            width: "100%",
                            height: "auto",
                            aspectRatio: "1 / 1",
                            imageRendering: "pixelated",
                          }}
                          onError={(e) => {
                            // Hide broken image; UI will fall through to the
                            // safe error block via re-render-friendly state
                            // only if necessary. Here we just hide silently
                            // so layout doesn't break.
                            e.currentTarget.style.visibility = "hidden";
                          }}
                        />
                      </div>
                      <div style={{
                        marginTop: 10, fontSize: 11.5, color: "#9ca3af",
                        textAlign: "center",
                        fontFamily: "system-ui, -apple-system, sans-serif",
                      }}>
                        EduHub Studio · KHQR · USD
                      </div>
                    </div>
                  );
                })()}

                {/* Supported banks row — shown before payment only */}
                {!khqrReturning && (
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  gap: 6, marginBottom: 12, flexWrap: "wrap",
                }}>
                  {["ABA", "Bakong", "Wing", "ACLEDA"].map(b => (
                    <span key={b} style={{
                      fontSize: 10, color: "#9ca3af", fontWeight: 600,
                      background: "rgba(255,255,255,0.05)",
                      border: "1px solid rgba(255,255,255,0.10)",
                      borderRadius: 6, padding: "2px 7px",
                      fontFamily: "system-ui, -apple-system, sans-serif",
                    }}>{b}</span>
                  ))}
                  <span style={{
                    fontSize: 9, color: "#6b7280",
                    fontFamily: "system-ui, -apple-system, sans-serif",
                  }}>+more</span>
                </div>
                )}

                {/* Scan instructions */}
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  gap: 8, marginBottom: 14,
                  padding: "10px 14px",
                  background: "rgba(52,211,153,0.06)",
                  border: "1px solid rgba(52,211,153,0.18)",
                  borderRadius: 12,
                }}>
                  <QrCode size={16} color="#34d399" />
                  <span style={{ fontSize: 12, color: "#6ee7b7", ...km }}>
                    ស្កែន KHQR ដោយ ABA / Bakong / Wing / ACLEDA
                  </span>
                </div>

                {/* v1.6: external "open CamRapidPay page" button REMOVED.
                    Students complete payment inside EduHub by scanning the
                    QR image above. The backend ``payment_url`` is no longer
                    surfaced as a default action. */}

                {/* Countdown — reuses the same timer logic as ABA flow */}
                {secondsLeft !== null && (() => {
                  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
                  const ss = String(secondsLeft % 60).padStart(2, "0");
                  const urgent = secondsLeft <= 30;
                  return (
                    <div
                      data-testid="topup-khqr-countdown"
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        gap: 8, marginBottom: 12,
                        padding: "8px 14px",
                        background: urgent ? "rgba(248,113,113,0.10)" : "rgba(52,211,153,0.06)",
                        border: `1px solid ${urgent ? "rgba(248,113,113,0.35)" : "rgba(52,211,153,0.22)"}`,
                        borderRadius: 12,
                      }}
                    >
                      <Clock4 size={14} color={urgent ? "#f87171" : "#34d399"} />
                      <span style={{ fontSize: 12, color: urgent ? "#fca5a5" : "#6ee7b7", ...km }}>
                        ផុតកំណត់ការបង់ប្រាក់ក្នុងរយៈ
                      </span>
                      <span style={{
                        fontWeight: 800,
                        color: urgent ? "#f87171" : "#34d399",
                        fontVariantNumeric: "tabular-nums",
                        fontSize: 14, letterSpacing: "0.04em",
                        fontFamily: "system-ui, -apple-system, sans-serif",
                        textShadow: urgent ? "0 0 12px rgba(248,113,113,0.55)" : "none",
                      }}>
                        {mm}:{ss}
                      </span>
                    </div>
                  );
                })()}

                {/* Waiting / Checking state label */}
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  gap: 6, marginBottom: 12,
                  padding: khqrReturning ? "10px 14px" : "0",
                  background: khqrReturning ? "rgba(52,211,153,0.08)" : "transparent",
                  border: khqrReturning ? "1px solid rgba(52,211,153,0.22)" : "none",
                  borderRadius: 12,
                  fontSize: 12, color: khqrReturning ? "#6ee7b7" : "#6b7280",
                  fontFamily: "system-ui, -apple-system, sans-serif",
                }}>
                  <Loader2 size={12} style={{ animation: "topup-spin 1.4s linear infinite", opacity: khqrReturning ? 1 : 0.6 }} />
                  {khqrReturning ? (
                    <>
                      <span style={{ fontWeight: 700 }}>Checking payment</span>
                      <span style={{ ...km, color: "#6ee7b7" }}>
                        · កំពុងពិនិត្យការបង់ប្រាក់…
                      </span>
                    </>
                  ) : (
                    <>
                      <span>Waiting for payment</span>
                      <span style={{ color: "#34d399", ...km }}>
                        · ពិន្ទុត្រូវបានបញ្ចូលដោយស្វ័យប្រវត្តិ
                      </span>
                    </>
                  )}
                </div>

                {/* Reference */}
                <div style={{
                  background: "rgba(52,211,153,0.06)",
                  border: "1px solid rgba(52,211,153,0.18)",
                  borderRadius: 12, padding: "9px 12px", marginBottom: 14,
                  fontSize: 11, textAlign: "center",
                }}>
                  <div style={{
                    color: "#9ca3af", marginBottom: 3, fontSize: 10,
                    textTransform: "uppercase", letterSpacing: "0.06em",
                    fontFamily: "system-ui, -apple-system, sans-serif",
                  }}>
                    Payment reference
                  </div>
                  <code style={{
                    color: "#6ee7b7", fontWeight: 700, letterSpacing: "0.04em",
                    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
                    fontSize: 12,
                  }}>
                    {khqrIntent.reference}
                  </code>
                </div>

                {/* I've paid — check now */}
                <button
                  onClick={khqrCheckNow}
                  disabled={khqrChecking}
                  data-testid="topup-khqr-ive-paid-btn"
                  style={{
                    width: "100%",
                    background: khqrChecking
                      ? "rgba(52,211,153,0.14)"
                      : "rgba(52,211,153,0.08)",
                    color: "#6ee7b7",
                    border: "1px solid rgba(52,211,153,0.35)",
                    borderRadius: 14, padding: "13px 16px",
                    fontSize: 14, fontWeight: 700,
                    cursor: khqrChecking ? "wait" : "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                    transition: "background 0.18s ease, opacity 0.18s ease",
                    opacity: khqrChecking ? 0.9 : 1,
                    ...km,
                  }}
                >
                  {khqrChecking ? (
                    <>
                      <Loader2 size={15} style={{ animation: "topup-spin 1s linear infinite" }} />
                      <span style={km}>កំពុងពិនិត្យការទូទាត់…</span>
                    </>
                  ) : (
                    <>
                      <RefreshCw size={14} />
                      <span style={km}>ខ្ញុំបានបង់ប្រាក់រួចរាល់</span>
                    </>
                  )}
                </button>

                {/* Status footer */}
                <div style={{
                  marginTop: 10, textAlign: "center", fontSize: 11,
                  color: "#6b7280",
                  fontFamily: "system-ui, -apple-system, sans-serif",
                }}>
                  {lastCheckedAt
                    ? "Last checked just now · Auto-checking every 3 seconds"
                    : "Auto-checking every 3 seconds…"}
                </div>

                {error && (
                  <div data-testid="topup-khqr-error" style={{
                    marginTop: 10, color: "#fbbf24", fontSize: 11.5,
                    textAlign: "center",
                    background: "rgba(251,191,36,0.08)",
                    border: "1px solid rgba(251,191,36,0.25)",
                    borderRadius: 8, padding: "7px 10px", ...km,
                  }}>
                    {error}
                  </div>
                )}
              </div>
            )}

            {/* ── STEP: SUCCESS ── */}
            {step === STEPS.SUCCESS && (
              <TopUpReceiptOverlay onConfirmed={onClose} />
            )}

            {/* ── STEP: REVIEW ── */}
            {step === STEPS.REVIEW && (
              <div data-testid="topup-review-screen" style={{ textAlign: "center", padding: "10px 0" }}>
                <Clock4 size={38} color="#a78bfa" style={{ margin: "0 auto 12px" }} />
                <div style={{ color: "#c4b5fd", fontWeight: 800, fontSize: 16, marginBottom: 8, ...km }}>
                  កំពុងពិនិត្យ
                </div>
                <div style={{
                  color: "#9ca3af", fontSize: 12.5, marginBottom: 20, padding: "0 8px",
                  ...km,
                }}>
                  ការទូទាត់របស់អ្នកកំពុងពិនិត្យ។ ប្រសិនបើអ្នកបានបង់ប្រាក់រួចហើយ ពិន្ទុនឹងបញ្ចូលក្នុងពេលឆាប់ៗ។
                </div>
                <button
                  onClick={onClose}
                  data-testid="topup-review-close-btn"
                  style={{
                    background: "rgba(167,139,250,0.14)",
                    color: "#c4b5fd",
                    border: "1px solid rgba(167,139,250,0.32)",
                    borderRadius: 10,
                    padding: "10px 22px",
                    fontWeight: 700, fontSize: 13, cursor: "pointer",
                    ...km,
                  }}
                >
                  បិទ
                </button>
              </div>
            )}

            {/* ── STEP: EXPIRED ── */}
            {step === STEPS.EXPIRED && (
              <div data-testid="topup-expired-screen" style={{ textAlign: "center", padding: "10px 0" }}>
                <AlertTriangle size={38} color="#f97316" style={{ margin: "0 auto 12px" }} />
                <div style={{ color: "#f97316", fontWeight: 800, fontSize: 16, marginBottom: 8, ...km }}>
                  ផុតកំណត់ការបង់ប្រាក់
                </div>
                <div style={{
                  color: "#9ca3af", fontSize: 12.5, marginBottom: 20, padding: "0 8px", ...km,
                }}>
                  ប្រសិនបើអ្នកបានបង់ប្រាក់រួចហើយ ប្រព័ន្ធនឹងពិនិត្យក្នុងពេលឆាប់ៗ។
                </div>
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  gap: 8, flexWrap: "wrap",
                }}>
                  <button
                    onClick={() => {
                      setError("");
                      setExpiresAt(null);
                      setIntentId(null);
                      setKhqrIntent(null);
                      setKhqrReturning(false);
                      setStep(STEPS.PICK);
                    }}
                    data-testid="topup-expired-retry-btn"
                    style={{
                      background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
                      color: "#1a1420",
                      border: "none", borderRadius: 10,
                      padding: "10px 22px",
                      fontWeight: 800, fontSize: 13, cursor: "pointer",
                      boxShadow: "0 6px 18px rgba(212,168,67,0.30)",
                      ...km,
                    }}
                  >
                    ព្យាយាមម្ដងទៀត
                  </button>
                  <button
                    onClick={onClose}
                    data-testid="topup-expired-close-btn"
                    style={{
                      background: "rgba(249,115,22,0.14)",
                      color: "#f97316",
                      border: "1px solid rgba(249,115,22,0.38)",
                      borderRadius: 10,
                      padding: "10px 22px",
                      fontWeight: 700, fontSize: 13, cursor: "pointer",
                      ...km,
                    }}
                  >
                    បិទ
                  </button>
                </div>
              </div>
            )}

            {/* ── STEP: ERROR ── */}
            {step === STEPS.ERROR && (
              <div data-testid="topup-error-screen" style={{ textAlign: "center", padding: "10px 0" }}>
                <AlertTriangle size={38} color="#f87171" style={{ margin: "0 auto 12px" }} />
                <div style={{ color: "#f87171", fontWeight: 800, marginBottom: 8, fontSize: 15, ...km }}>
                  មានបញ្ហាបណ្តោះអាសន្ន
                </div>
                <div style={{
                  color: "#9ca3af", fontSize: 12, marginBottom: 20, padding: "0 12px",
                  ...km,
                }}>
                  {error}
                </div>
                <button
                  onClick={() => { setStep(STEPS.PICK); setError(""); }}
                  data-testid="topup-error-retry-btn"
                  style={{
                    background: "rgba(248,113,113,0.1)", color: "#f87171",
                    border: "1px solid rgba(248,113,113,0.32)",
                    borderRadius: 10, padding: "10px 22px",
                    fontWeight: 700, fontSize: 13, cursor: "pointer",
                    ...km,
                  }}
                >
                  ព្យាយាមម្ដងទៀត
                </button>
              </div>
            )}
          </div>

          {/* keyframes scoped to modal */}
          <style>{`
            @keyframes topup-spin {
              from { transform: rotate(0deg); }
              to   { transform: rotate(360deg); }
            }
            @keyframes topup-shimmer {
              0%   { background-position: -200px 0; }
              100% { background-position: calc(200px + 100%) 0; }
            }
            @keyframes topup-bonus-pulse {
              0%, 100% { box-shadow: 0 0 0 0 rgba(74,222,128,0.40); }
              50%      { box-shadow: 0 0 0 6px rgba(74,222,128,0.00); }
            }
            @keyframes topup-success-halo {
              0%, 100% { box-shadow: 0 0 30px rgba(74,222,128,0.35); }
              50%      { box-shadow: 0 0 44px rgba(74,222,128,0.65); }
            }
            .topup-skeleton {
              background: linear-gradient(90deg,
                rgba(255,255,255,0.04) 0%,
                rgba(255,255,255,0.10) 50%,
                rgba(255,255,255,0.04) 100%);
              background-size: 200px 100%;
              background-repeat: no-repeat;
              animation: topup-shimmer 1.4s ease-in-out infinite;
              border-radius: 12px;
            }
            .topup-bonus-pulse { animation: topup-bonus-pulse 2.2s ease-in-out infinite; }
            .topup-success-halo { animation: topup-success-halo 2.4s ease-in-out infinite; }

            /* ── Premium success seal (Success v2.0.1) ─────────────────── */
            @keyframes topup-success-ring-pulse {
              0%   { transform: scale(0.55); opacity: 0.55; }
              70%  { transform: scale(1.15); opacity: 0; }
              100% { transform: scale(1.15); opacity: 0; }
            }
            .topup-success-seal-wrap .topup-success-ring {
              position: absolute;
              inset: 0;
              border-radius: 50%;
              border: 1.5px solid rgba(74,222,128,0.55);
              box-shadow: 0 0 24px rgba(74,222,128,0.35);
              animation: topup-success-ring-pulse 2.4s ease-out infinite;
              pointer-events: none;
            }
            .topup-success-seal-wrap .topup-success-ring-2 {
              animation-delay: 0.6s;
              border-color: rgba(167,243,208,0.45);
            }
            .topup-success-seal-wrap .topup-success-ring-3 {
              animation-delay: 1.2s;
              border-color: rgba(212,168,67,0.45);
              box-shadow: 0 0 24px rgba(212,168,67,0.30);
            }
            @keyframes topup-success-spark {
              0%, 100% { transform: scale(0.6); opacity: 0; }
              50%      { transform: scale(1);   opacity: 1; }
            }
            .topup-success-seal-wrap .topup-success-spark {
              position: absolute;
              width: 6px; height: 6px;
              border-radius: 50%;
              background: #FFE19A;
              box-shadow: 0 0 10px rgba(255,225,154,0.85);
              animation: topup-success-spark 2.2s ease-in-out infinite;
              pointer-events: none;
            }
            .topup-success-seal-wrap .topup-success-spark-1 { top: 6px;    left: 14px; animation-delay: 0.1s; }
            .topup-success-seal-wrap .topup-success-spark-2 { top: 22px;   right: 6px; animation-delay: 0.7s; background: #a7f3d0; box-shadow: 0 0 10px rgba(167,243,208,0.85); }
            .topup-success-seal-wrap .topup-success-spark-3 { bottom: 10px; left: 22px; animation-delay: 1.3s; }

            /* Reduced-motion: kill infinite pulses on the success seal. */
            @media (prefers-reduced-motion: reduce) {
              .topup-success-seal-wrap .topup-success-ring,
              .topup-success-seal-wrap .topup-success-spark,
              .topup-success-halo,
              .topup-bonus-pulse {
                animation: none !important;
              }
            }
          `}</style>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
