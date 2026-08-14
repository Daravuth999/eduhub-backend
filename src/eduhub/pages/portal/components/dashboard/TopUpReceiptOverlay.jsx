// @ts-nocheck

/**
 * TopUpReceiptOverlay.jsx — v1.6.1
 * ===========================================================================
 * Persistent top-up receipt overlay that survives refresh until the student
 * explicitly confirms it.
 *
 * Storage:
 *   sessionStorage key: `eduhub_topup_receipt_pending_v1`
 *
 * Lifecycle contracts preserved:
 *   1. Any successful top-up flow calls `saveTopUpReceipt(payload)`.
 *   2. The overlay reads sessionStorage on mount and on the custom
 *      `eduhub:topup-receipt-show` window event.
 *   3. There is no automatic dismissal and no backdrop dismiss.
 *   4. Confirm clears storage, fires `requestPointsRefresh`, then calls
 *      `onConfirmed` so the parent can close any lingering modal.
 *
 * No payment, wallet, polling, KHQR, push, ledger, or backend logic is touched.
 * ===========================================================================
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Sparkles, Coins, Hash, Clock4, PackageCheck, WalletCards } from "lucide-react";
import { requestPointsRefresh } from "../../../../utils/pointsSync";

export const TOPUP_RECEIPT_STORAGE_KEY = "eduhub_topup_receipt_pending_v1";
export const TOPUP_RECEIPT_EVENT = "eduhub:topup-receipt-show";

const KHMER_FONT_STACK =
  `'Noto Sans Khmer', 'Kantumruy Pro', 'Battambang', 'Khmer OS', ` +
  `'Khmer OS Battambang', 'Hanuman', system-ui, -apple-system, sans-serif`;

const UI_FONT_STACK =
  `system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;

const MONO_FONT_STACK =
  `'SF Mono', 'Roboto Mono', ui-monospace, Menlo, Consolas, monospace`;

const khmerText = {
  fontFamily: KHMER_FONT_STACK,
  letterSpacing: 0,
  textTransform: "none",
  fontFeatureSettings: "normal",
  lineHeight: 1.62,
};

function ensureReceiptFonts() {
  if (typeof document === "undefined") return;
  if (document.getElementById("eduhub-topup-receipt-khmer-fonts")) return;

  const preconnect = document.createElement("link");
  preconnect.id = "eduhub-topup-receipt-font-preconnect";
  preconnect.rel = "preconnect";
  preconnect.href = "https://fonts.gstatic.com";
  preconnect.crossOrigin = "anonymous";
  document.head.appendChild(preconnect);

  const stylesheet = document.createElement("link");
  stylesheet.id = "eduhub-topup-receipt-khmer-fonts";
  stylesheet.rel = "stylesheet";
  stylesheet.href =
    "https://fonts.googleapis.com/css2?family=Kantumruy+Pro:wght@500;600;700;800&family=Noto+Sans+Khmer:wght@500;600;700;800&display=swap";
  document.head.appendChild(stylesheet);
}

/**
 * Persist a receipt payload and notify the overlay to refresh.
 * Safe to call from anywhere; storage failures are swallowed.
 */
export function saveTopUpReceipt(payload) {
  if (typeof window === "undefined") return;
  const data = { ...(payload || {}), _ts: Date.now() };
  try {
    sessionStorage.setItem(TOPUP_RECEIPT_STORAGE_KEY, JSON.stringify(data));
  } catch (_e) { /* noop */ }
  try {
    window.dispatchEvent(new CustomEvent(TOPUP_RECEIPT_EVENT));
  } catch (_e) { /* noop */ }
}

export function clearTopUpReceipt() {
  if (typeof window === "undefined") return;
  try { sessionStorage.removeItem(TOPUP_RECEIPT_STORAGE_KEY); } catch (_e) { /* noop */ }
}

function _readReceipt() {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(TOPUP_RECEIPT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (_e) {
    return null;
  }
}

const hasFiniteNumber = (value) => {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
};

const toNumber = (value, fallback = 0) => (
  hasFiniteNumber(value) ? Number(value) : fallback
);

const fmtUsd = (n) => `$${toNumber(n, 0).toFixed(2)}`;
const fmtPts = (n) => toNumber(n, 0).toLocaleString();

const fmtTs = (ts) => {
  try {
    const raw = hasFiniteNumber(ts) ? Number(ts) : ts;
    const d = raw ? new Date(raw) : null;
    if (!d || Number.isNaN(d.getTime())) return "Confirmed just now";
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "Confirmed just now";
  }
};

function SuccessSeal({ reduceMotion }) {
  const ringTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 1.85, repeat: Infinity, ease: "easeOut" };

  return (
    <div style={{ position: "relative", width: 118, height: 118, margin: "0 auto 12px" }}>
      <svg viewBox="0 0 128 128" width="118" height="118" aria-hidden="true" focusable="false">
        <defs>
          <radialGradient id="receipt-seal-glow" cx="50%" cy="50%" r="58%">
            <stop offset="0%" stopColor="#bbf7d0" stopOpacity="0.9" />
            <stop offset="48%" stopColor="#22c55e" stopOpacity="0.26" />
            <stop offset="100%" stopColor="#064e3b" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="receipt-seal-fill" x1="18" y1="18" x2="110" y2="110" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#86efac" />
            <stop offset="52%" stopColor="#10b981" />
            <stop offset="100%" stopColor="#047857" />
          </linearGradient>
          <linearGradient id="receipt-check-stroke" x1="42" y1="66" x2="88" y2="48" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#f7fee7" />
            <stop offset="100%" stopColor="#ecfdf5" />
          </linearGradient>
        </defs>
        <circle cx="64" cy="64" r="61" fill="url(#receipt-seal-glow)" />
        {[0, 0.55, 1.1].map((delay, index) => (
          <motion.circle
            key={index}
            cx="64"
            cy="64"
            r="39"
            fill="none"
            stroke="#bbf7d0"
            strokeWidth="1.25"
            initial={{ scale: 0.86, opacity: reduceMotion ? 0 : 0.7 }}
            animate={reduceMotion ? { opacity: 0 } : { scale: 1.55, opacity: 0 }}
            transition={{ ...ringTransition, delay }}
            style={{ transformOrigin: "64px 64px" }}
          />
        ))}
        <motion.circle
          cx="64"
          cy="64"
          r="38"
          fill="url(#receipt-seal-fill)"
          initial={reduceMotion ? false : { scale: 0.72, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", damping: 12, stiffness: 230 }}
          style={{ transformOrigin: "64px 64px" }}
        />
        <circle cx="64" cy="64" r="31" fill="none" stroke="rgba(236,253,245,0.26)" strokeWidth="1.5" />
        <motion.path
          d="M45 65.5 L58.5 78 L84 50"
          fill="none"
          stroke="url(#receipt-check-stroke)"
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={reduceMotion ? false : { pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ delay: 0.18, duration: 0.58, ease: "easeOut" }}
        />
      </svg>
      {!reduceMotion && (
        <>
          <SparkleDot top={14} left={16} delay={0.1} />
          <SparkleDot top={24} right={10} delay={0.35} />
          <SparkleDot bottom={20} left={22} delay={0.65} />
          <SparkleDot bottom={16} right={20} delay={0.9} />
        </>
      )}
    </div>
  );
}

function SparkleDot({ top, right, bottom, left, delay }) {
  return (
    <motion.span
      aria-hidden="true"
      initial={{ opacity: 0, scale: 0.7, y: 4 }}
      animate={{ opacity: [0, 1, 0.65, 0], scale: [0.7, 1, 0.9, 0.7], y: [4, -5, -8, -10] }}
      transition={{ duration: 2.4, repeat: Infinity, delay, ease: "easeOut" }}
      style={{
        position: "absolute",
        top,
        right,
        bottom,
        left,
        width: 7,
        height: 7,
        borderRadius: 999,
        background: "linear-gradient(135deg, #fef3c7, #34d399)",
        boxShadow: "0 0 14px rgba(254,243,199,0.75)",
      }}
    />
  );
}

function SerratedEdge({ flip = false }) {
  const width = 440;
  const height = 14;
  const teeth = 22;
  const step = width / teeth;
  let path = flip ? `M0 0 ` : `M0 ${height} `;

  for (let i = 0; i < teeth; i += 1) {
    const x1 = i * step;
    const mid = x1 + step / 2;
    const x2 = x1 + step;
    path += flip
      ? `L${x1} 0 L${mid} ${height} L${x2} 0 `
      : `L${x1} ${height} L${mid} 0 L${x2} ${height} `;
  }

  path += flip ? `L${width} 0 Z` : `L${width} ${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block" }}
    >
      <defs>
        <linearGradient id={`receipt-edge-${flip ? "bottom" : "top"}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#ecfdf5" />
          <stop offset="50%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#ecfdf5" />
        </linearGradient>
      </defs>
      <path d={path} fill={`url(#receipt-edge-${flip ? "bottom" : "top"})`} />
    </svg>
  );
}

/** @param {{ onConfirmed?: () => void }} props */
export default function TopUpReceiptOverlay({ onConfirmed } = {}) {
  const [receipt, setReceipt] = useState(null);
  const confirmBtnRef = useRef(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    ensureReceiptFonts();
    const load = () => setReceipt(_readReceipt());
    load();
    const handler = () => load();
    window.addEventListener(TOPUP_RECEIPT_EVENT, handler);
    // Refresh when the tab becomes visible; covers PWA cold start after
    // OS-level pause/resume.
    document.addEventListener("visibilitychange", handler);
    return () => {
      window.removeEventListener(TOPUP_RECEIPT_EVENT, handler);
      document.removeEventListener("visibilitychange", handler);
    };
  }, []);

  useEffect(() => {
    if (!receipt || !confirmBtnRef.current) return undefined;
    const timer = window.setTimeout(() => {
      try { confirmBtnRef.current.focus({ preventScroll: true }); } catch (_e) { /* noop */ }
    }, 280);
    return () => window.clearTimeout(timer);
  }, [receipt]);

  const handleConfirm = useCallback(() => {
    clearTopUpReceipt();
    try { requestPointsRefresh("topup_receipt_confirmed"); } catch (_e) { /* noop */ }
    setReceipt(null);
    if (typeof onConfirmed === "function") {
      try { onConfirmed(); } catch (_e) { /* noop */ }
    }
  }, [onConfirmed]);

  if (!receipt) return null;

  const pkgLabel = receipt.package_label || receipt.label || "Top-up package";
  const amountUsd = hasFiniteNumber(receipt.amount_usd)
    ? Number(receipt.amount_usd)
    : toNumber(receipt.amount, 0);
  const basePts = toNumber(receipt.base_points, 0);
  const bonusPts = toNumber(receipt.bonus_points, 0);
  const totalPts = hasFiniteNumber(receipt.total_points)
    ? Number(receipt.total_points)
    : basePts + bonusPts;
  const reference = receipt.reference || receipt.payment_reference || "";
  const method = String(receipt.method || "KHQR").toUpperCase();
  const confirmedAt = receipt.confirmed_at || receipt.confirmation_time || receipt.timestamp || receipt._ts;
  const balanceAfter = hasFiniteNumber(receipt.balance_after) && Number(receipt.balance_after) > 0
    ? Number(receipt.balance_after)
    : null;

  const overlayMotion = reduceMotion
    ? { initial: false, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };
  const cardMotion = reduceMotion
    ? { initial: false, animate: { opacity: 1, y: 0, scale: 1 } }
    : { initial: { opacity: 0, y: 28, scale: 0.96 }, animate: { opacity: 1, y: 0, scale: 1 } };

  return (
    <AnimatePresence>
      <motion.div
        key="topup-receipt-overlay"
        {...overlayMotion}
        data-testid="topup-receipt-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="topup-receipt-title"
        aria-describedby="topup-receipt-summary"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 11000,
          background:
            "radial-gradient(circle at 50% 0%, rgba(20,184,166,0.28), transparent 32%), linear-gradient(180deg, rgba(2,6,23,0.92) 0%, rgba(5,12,18,0.97) 100%)",
          backdropFilter: "blur(18px)",
          WebkitBackdropFilter: "blur(18px)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          paddingTop: "calc(max(env(safe-area-inset-top, 12px), 12px) + 18px)",
          paddingBottom: "calc(max(env(safe-area-inset-bottom, 16px), 16px) + 18px)",
          paddingLeft: 14,
          paddingRight: 14,
          overflowY: "auto",
          fontFamily: KHMER_FONT_STACK,
        }}
      >
        <motion.div
          {...cardMotion}
          transition={{ type: "spring", damping: 26, stiffness: 360 }}
          style={{
            position: "relative",
            width: "100%",
            maxWidth: 438,
            margin: "0 auto",
            paddingBottom: "max(env(safe-area-inset-bottom, 0px), 0px)",
          }}
        >
          <SerratedEdge />
          <div
            style={{
              position: "relative",
              overflow: "hidden",
              background:
                "linear-gradient(180deg, #ffffff 0%, #f8fffb 48%, #eefdf6 100%)",
              borderLeft: "1px solid rgba(209,250,229,0.95)",
              borderRight: "1px solid rgba(209,250,229,0.95)",
              boxShadow:
                "0 30px 80px rgba(0,0,0,0.58), 0 0 0 1px rgba(167,243,208,0.18)",
            }}
          >
            <motion.div
              aria-hidden="true"
              initial={reduceMotion ? false : { x: "-120%" }}
              animate={reduceMotion ? { opacity: 0.18 } : { x: "120%" }}
              transition={{ duration: 2.8, repeat: Infinity, repeatDelay: 1.8, ease: "easeInOut" }}
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                width: "44%",
                transform: "skewX(-18deg)",
                background:
                  "linear-gradient(90deg, transparent, rgba(255,255,255,0.72), transparent)",
                pointerEvents: "none",
              }}
            />

            <div
              style={{
                position: "relative",
                padding: "24px 20px 20px",
                textAlign: "center",
              }}
            >
              <SuccessSeal reduceMotion={reduceMotion} />

              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 7,
                  padding: "7px 12px",
                  borderRadius: 999,
                  background: "linear-gradient(135deg, rgba(5,150,105,0.12), rgba(20,184,166,0.12))",
                  border: "1px solid rgba(5,150,105,0.22)",
                  color: "#047857",
                  fontFamily: UI_FONT_STACK,
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: 0,
                }}
              >
                <Sparkles size={14} aria-hidden="true" />
                Payment confirmed · {method}
              </div>

              <h2
                id="topup-receipt-title"
                style={{
                  margin: "14px 0 4px",
                  color: "#052e1b",
                  fontSize: 25,
                  fontWeight: 800,
                  ...khmerText,
                }}
              >
                សូមអបអរសាទរ!
              </h2>
              <p
                id="topup-receipt-summary"
                style={{
                  margin: "0 0 18px",
                  color: "#14532d",
                  fontSize: 14,
                  fontWeight: 700,
                  ...khmerText,
                }}
              >
                ពិន្ទុរបស់អ្នកត្រូវបានបញ្ចូលដោយជោគជ័យ។
              </p>

              <div
                style={{
                  borderRadius: 18,
                  overflow: "hidden",
                  border: "1px solid rgba(16,185,129,0.22)",
                  background: "linear-gradient(180deg, rgba(236,253,245,0.95), rgba(255,255,255,0.96))",
                  textAlign: "left",
                }}
              >
                <div
                  style={{
                    padding: "16px 16px 14px",
                    background:
                      "linear-gradient(135deg, rgba(6,95,70,0.98) 0%, rgba(4,120,87,0.96) 48%, rgba(15,118,110,0.98) 100%)",
                    color: "#ecfdf5",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      marginBottom: 10,
                    }}
                  >
                    <span style={{ fontFamily: UI_FONT_STACK, fontSize: 12, fontWeight: 800 }}>
                      Total credited
                    </span>
                    <Coins size={18} aria-hidden="true" />
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: UI_FONT_STACK,
                        fontSize: 36,
                        lineHeight: 1,
                        fontWeight: 900,
                        color: "#fef3c7",
                        textShadow: "0 8px 24px rgba(0,0,0,0.22)",
                      }}
                    >
                      +{fmtPts(totalPts)}
                    </span>
                    <span style={{ fontFamily: UI_FONT_STACK, fontSize: 14, fontWeight: 800, color: "#bbf7d0" }}>
                      pts
                    </span>
                  </div>
                </div>

                <div style={{ padding: "8px 16px 12px" }}>
                  <ReceiptRow label="Package" value={pkgLabel} icon={<PackageCheck size={15} />} />
                  <ReceiptRow label="Amount paid" value={fmtUsd(amountUsd)} />
                  <ReceiptRow label="Base points" value={`${fmtPts(basePts)} pts`} />
                  {bonusPts > 0 && (
                    <ReceiptRow
                      label="Bonus points"
                      value={`+${fmtPts(bonusPts)} pts`}
                      valueColor="#047857"
                    />
                  )}
                  {balanceAfter !== null && (
                    <ReceiptRow
                      label="New balance"
                      value={`${fmtPts(balanceAfter)} pts`}
                      icon={<WalletCards size={15} />}
                      chip
                    />
                  )}
                  {reference && (
                    <ReceiptRow
                      label="Reference"
                      value={reference}
                      icon={<Hash size={14} />}
                      mono
                    />
                  )}
                  <ReceiptRow
                    label="Confirmed time"
                    value={fmtTs(confirmedAt)}
                    icon={<Clock4 size={14} />}
                    last
                  />
                </div>
              </div>

              <button
                ref={confirmBtnRef}
                onClick={handleConfirm}
                data-testid="topup-receipt-confirm-btn"
                style={{
                  width: "100%",
                  minHeight: 54,
                  marginTop: 18,
                  padding: "13px 18px",
                  border: "none",
                  borderRadius: 16,
                  cursor: "pointer",
                  background:
                    "linear-gradient(135deg, #fef3c7 0%, #fbbf24 42%, #d97706 100%)",
                  color: "#1c1917",
                  boxShadow:
                    "0 16px 30px rgba(217,119,6,0.24), inset 0 1px 0 rgba(255,255,255,0.56)",
                  fontSize: 15,
                  fontWeight: 900,
                  ...khmerText,
                }}
              >
                បញ្ជាក់ និងបិទ
                <span
                  style={{
                    display: "inline-block",
                    marginLeft: 8,
                    fontFamily: UI_FONT_STACK,
                    fontSize: 13,
                    fontWeight: 800,
                    letterSpacing: 0,
                  }}
                >
                  · Confirm
                </span>
              </button>

              <div
                style={{
                  marginTop: 11,
                  color: "#047857",
                  fontSize: 12,
                  fontWeight: 700,
                  ...khmerText,
                }}
              >
                វិក្កយបត្រនេះនឹងនៅទីនេះរហូតដល់អ្នកបញ្ជាក់។
              </div>
            </div>
          </div>
          <SerratedEdge flip />
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function ReceiptRow({ label, value, icon, valueColor, mono, chip, last }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(108px, 0.88fr) minmax(0, 1.18fr)",
        alignItems: "center",
        gap: 12,
        padding: "10px 0",
        borderBottom: last ? "none" : "1px dashed rgba(15,118,110,0.18)",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
          color: "#496157",
          fontFamily: UI_FONT_STACK,
          fontSize: 12,
          fontWeight: 800,
          letterSpacing: 0,
          textTransform: "none",
          lineHeight: 1.3,
        }}
      >
        {icon && <span style={{ display: "inline-flex", color: "#059669", flex: "0 0 auto" }}>{icon}</span>}
        {label}
      </span>
      <span
        style={{
          justifySelf: "end",
          minWidth: 0,
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          color: valueColor || "#0f172a",
          fontFamily: mono ? MONO_FONT_STACK : KHMER_FONT_STACK,
          fontSize: mono ? 11.5 : 13,
          fontWeight: chip ? 900 : 800,
          lineHeight: 1.38,
          textAlign: "right",
          letterSpacing: 0,
          textTransform: "none",
          padding: chip ? "5px 9px" : 0,
          borderRadius: chip ? 999 : 0,
          background: chip ? "linear-gradient(135deg, rgba(20,184,166,0.13), rgba(16,185,129,0.17))" : "transparent",
          border: chip ? "1px solid rgba(5,150,105,0.18)" : "none",
        }}
      >
        {value}
      </span>
    </div>
  );
}
