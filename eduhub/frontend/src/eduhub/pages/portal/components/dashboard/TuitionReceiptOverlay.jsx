// @ts-nocheck
/**
 * TuitionReceiptOverlay.jsx — Tuition Payment Receipt (premium)
 *
 * Sapphire/violet palette. Persistent: survives refresh until student
 * explicitly confirms via "បញ្ជាក់ និងបិទ · Confirm".
 *
 * Persistence contract:
 *   - X button closes WITHOUT acknowledging (receipt re-opens on next mount)
 *   - Only the Confirm button calls POST /acknowledge and closes permanently
 *   - Receipt fields include billing period, billing_anchor_day, reference,
 *     on-time appreciation reward status, and student clean_id
 *
 * DO NOT modify TopUpReceiptOverlay.jsx. This file is completely independent.
 *
 * Props:
 *   receipt   — object returned by fetchReceiptById (the full API response):
 *               { receipt_id, clean_id, amount_usd, amount_khr, method,
 *                 reference, prev_due_date, new_due_date, billing_anchor_day,
 *                 reward_points, reward_status, confirmed_at }
 *   onClose() — called when student dismisses; X does NOT acknowledge
 */

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  Calendar, CreditCard, Hash, Clock4, ShieldCheck, Star, Banknote,
  FileText, Download,
} from "lucide-react";

const BACKEND = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");

// ── Sapphire/violet palette ──────────────────────────────────────────────────
const SAPPHIRE = "#4f46e5";
const VIOLET   = "#7c3aed";
const GRAD     = `linear-gradient(135deg, ${SAPPHIRE} 0%, ${VIOLET} 100%)`;
const GOLD     = "#d97706";

const KM_FONT  = "'Noto Sans Khmer','Kantumruy Pro','Khmer OS',system-ui,sans-serif";
const UI_FONT  = "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
const MONO_FONT = "'SF Mono','Roboto Mono',ui-monospace,Menlo,Consolas,monospace";

const khmerText = { fontFamily: KM_FONT, letterSpacing: 0, lineHeight: 1.62 };

function authHeaders() {
  try {
    const t = localStorage.getItem("student_session_token");
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
}

async function acknowledge(receiptId) {
  const res = await fetch(
    `${BACKEND}/api/student/tuition/receipt/${encodeURIComponent(receiptId)}/acknowledge`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeaders() },
    }
  );
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

function fmtDate(raw) {
  if (!raw) return "—";
  try {
    const d = new Date(String(raw).replace(/\./g, "-").replace(/\//g, "-"));
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch { return raw; }
}

function fmtDatetime(raw) {
  if (!raw) return "—";
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString(undefined, {
      year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return "—"; }
}

async function fetchReceiptFile(receiptId, fmt) {
  const res = await fetch(
    `${BACKEND}/api/student/tuition/receipt/${encodeURIComponent(receiptId)}/${fmt}`,
    { credentials: "include", headers: { ...authHeaders() } },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

function fmtMethod(method) {
  if (!method) return "KHQR";
  const m = method.toUpperCase();
  if (m.includes("KHQR") || m.includes("QR")) return "KHQR";
  if (m.includes("CASH")) return "Cash";
  if (m.includes("ABA")) return "ABA Pay";
  if (m.includes("WING")) return "Wing";
  return method;
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ── Serrated receipt edge (sapphire-tinted) ───────────────────────────────────
function SerratedEdge({ flip = false }) {
  const width = 440;
  const height = 14;
  const teeth = 22;
  const step = width / teeth;
  let path = flip ? `M0 0 ` : `M0 ${height} `;
  for (let i = 0; i < teeth; i++) {
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
        <linearGradient id={`ttn-edge-${flip ? "bot" : "top"}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stopColor="#ede9fe" />
          <stop offset="50%"  stopColor="#f5f3ff" />
          <stop offset="100%" stopColor="#ede9fe" />
        </linearGradient>
      </defs>
      <path d={path} fill={`url(#ttn-edge-${flip ? "bot" : "top"})`} />
    </svg>
  );
}

// ── Tuition seal (animated sapphire/violet checkmark rings) ──────────────────
function TuitionSeal({ reduceMotion }) {
  const ringTx = reduceMotion
    ? { duration: 0 }
    : { duration: 1.85, repeat: Infinity, ease: "easeOut" };
  return (
    <div style={{ position: "relative", width: 118, height: 118, margin: "0 auto 12px" }}>
      <svg viewBox="0 0 128 128" width="118" height="118" aria-hidden focusable="false">
        <defs>
          <radialGradient id="ttn-seal-glow" cx="50%" cy="50%" r="58%">
            <stop offset="0%"   stopColor="#c4b5fd" stopOpacity="0.9" />
            <stop offset="48%"  stopColor="#7c3aed" stopOpacity="0.26" />
            <stop offset="100%" stopColor="#1e1b4b" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="ttn-seal-fill" x1="18" y1="18" x2="110" y2="110" gradientUnits="userSpaceOnUse">
            <stop offset="0%"   stopColor="#a78bfa" />
            <stop offset="52%"  stopColor="#6d28d9" />
            <stop offset="100%" stopColor="#4338ca" />
          </linearGradient>
          <linearGradient id="ttn-check-stroke" x1="42" y1="66" x2="88" y2="48" gradientUnits="userSpaceOnUse">
            <stop offset="0%"   stopColor="#ede9fe" />
            <stop offset="100%" stopColor="#f5f3ff" />
          </linearGradient>
        </defs>
        <circle cx="64" cy="64" r="61" fill="url(#ttn-seal-glow)" />
        {[0, 0.55, 1.1].map((delay, idx) => (
          <motion.circle
            key={idx}
            cx="64" cy="64" r="39"
            fill="none" stroke="#c4b5fd" strokeWidth="1.25"
            initial={{ scale: 0.86, opacity: reduceMotion ? 0 : 0.7 }}
            animate={reduceMotion ? { opacity: 0 } : { scale: 1.55, opacity: 0 }}
            transition={{ ...ringTx, delay }}
            style={{ transformOrigin: "64px 64px" }}
          />
        ))}
        <motion.circle
          cx="64" cy="64" r="38"
          fill="url(#ttn-seal-fill)"
          initial={reduceMotion ? false : { scale: 0.72, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", damping: 12, stiffness: 230 }}
          style={{ transformOrigin: "64px 64px" }}
        />
        <circle cx="64" cy="64" r="31" fill="none" stroke="rgba(237,233,254,0.26)" strokeWidth="1.5" />
        <motion.path
          d="M45 65.5 L58.5 78 L84 50"
          fill="none"
          stroke="url(#ttn-check-stroke)"
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
      aria-hidden
      initial={{ opacity: 0, scale: 0.7, y: 4 }}
      animate={{ opacity: [0, 1, 0.65, 0], scale: [0.7, 1, 0.9, 0.7], y: [4, -5, -8, -10] }}
      transition={{ duration: 2.4, repeat: Infinity, delay, ease: "easeOut" }}
      style={{
        position: "absolute",
        top, right, bottom, left,
        width: 7, height: 7,
        borderRadius: 999,
        background: "linear-gradient(135deg, #fef3c7, #a78bfa)",
        boxShadow: "0 0 14px rgba(167,139,250,0.75)",
      }}
    />
  );
}

function ReceiptRow({ label, value, icon, valueColor, mono, last }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(100px, 0.88fr) minmax(0, 1.18fr)",
        alignItems: "center",
        gap: 12,
        padding: "9px 0",
        borderBottom: last ? "none" : "1px dashed rgba(79,70,229,0.14)",
      }}
    >
      <span
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          color: "#4b5563", fontFamily: UI_FONT,
          fontSize: 12, fontWeight: 700, lineHeight: 1.3,
        }}
      >
        {icon && (
          <span style={{ display: "inline-flex", color: SAPPHIRE, flexShrink: 0 }}>{icon}</span>
        )}
        {label}
      </span>
      <span
        style={{
          justifySelf: "end", minWidth: 0, maxWidth: "100%",
          overflow: "hidden", textOverflow: "ellipsis",
          color: valueColor || "#1e293b",
          fontFamily: mono ? MONO_FONT : KM_FONT,
          fontSize: mono ? 11 : 12.5,
          fontWeight: 700,
          textAlign: "right",
          lineHeight: 1.38,
          letterSpacing: 0,
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function TuitionReceiptOverlay({ receipt, onClose }) {
  const reduceMotion = useReducedMotion() ?? false;
  const [acknowledged, setAcknowledged] = useState(false);
  const [ackErr, setAckErr]             = useState("");
  const [acking, setAcking]             = useState(false);
  const [downloading, setDownloading]   = useState(null); // "pdf" | "png" | null
  const [downloadErr, setDownloadErr]   = useState("");
  const confirmRef = useRef(null);
  const mountRef   = useRef(true);
  useEffect(() => () => { mountRef.current = false; }, []);

  useEffect(() => {
    if (!receipt || !confirmRef.current) return;
    const t = setTimeout(() => {
      try { confirmRef.current?.focus({ preventScroll: true }); } catch (_) { /* noop */ }
    }, 280);
    return () => clearTimeout(t);
  }, [receipt]);

  if (!receipt) return null;

  const {
    receipt_id,
    invoice_number,
    clean_id,
    amount_usd,
    amount_khr,
    method,
    reference,
    prev_due_date,
    new_due_date,
    billing_anchor_day: rawAnchorDay,
    reward_points = 0,
    reward_status,
    confirmed_at,
  } = receipt;

  // Derive billing_anchor_day from new_due_date if not explicit in receipt
  const anchorDayFromDate = (() => {
    if (!new_due_date) return null;
    try {
      const d = new Date(String(new_due_date).replace(/\./g, "-"));
      return isNaN(d.getTime()) ? null : d.getDate();
    } catch { return null; }
  })();
  const billingAnchorDay = rawAnchorDay ?? anchorDayFromDate;

  const handleAcknowledge = async () => {
    if (!receipt_id || acking || acknowledged) return;
    setAcking(true);
    setAckErr("");
    try {
      await acknowledge(receipt_id);
      if (!mountRef.current) return;
      setAcknowledged(true);
      setTimeout(() => { if (mountRef.current) onClose?.(); }, 1400);
    } catch (err) {
      if (!mountRef.current) return;
      setAckErr(err.message || "មានបញ្ហា — សូមព្យាយាមម្ដងទៀត");
    } finally {
      if (mountRef.current) setAcking(false);
    }
  };

  // X close: does NOT acknowledge — receipt reopens on next portal mount
  const handleClose = () => {
    onClose?.();
  };

  const handleDownload = async (fmt) => {
    if (!receipt_id || downloading) return;
    setDownloading(fmt);
    setDownloadErr("");
    try {
      const blob = await fetchReceiptFile(receipt_id, fmt);
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `${invoice_number || receipt_id}.${fmt}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setDownloadErr(err.message || `Failed to download ${fmt.toUpperCase()}`);
    } finally {
      setDownloading(null);
    }
  };

  const overlayMotion = reduceMotion
    ? { initial: false, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };
  const cardMotion = reduceMotion
    ? { initial: false, animate: { opacity: 1, y: 0, scale: 1 } }
    : { initial: { opacity: 0, y: 28, scale: 0.96 }, animate: { opacity: 1, y: 0, scale: 1 } };

  // Reward status display
  const showReward = reward_points > 0;
  const rewardCredited  = reward_status === "credited";
  const rewardProcessing = reward_status === "processing" || (showReward && !rewardCredited);

  return (
    <AnimatePresence>
      <motion.div
        key="tuition-receipt-overlay"
        {...overlayMotion}
        data-testid="tuition-receipt-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ttn-receipt-title"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 11000,
          background:
            "radial-gradient(circle at 50% 0%, rgba(79,70,229,0.22), transparent 32%), " +
            "linear-gradient(180deg, rgba(2,6,23,0.92) 0%, rgba(5,12,18,0.97) 100%)",
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
          fontFamily: KM_FONT,
        }}
      >
        <motion.div
          {...cardMotion}
          transition={{ type: "spring", damping: 26, stiffness: 360 }}
          style={{ position: "relative", width: "100%", maxWidth: 438, margin: "0 auto" }}
        >
          <SerratedEdge />

          {/* Card body */}
          <div
            style={{
              position: "relative",
              overflow: "hidden",
              background: "linear-gradient(180deg, #ffffff 0%, #f8f7ff 48%, #f0eeff 100%)",
              borderLeft:  "1px solid rgba(167,139,250,0.45)",
              borderRight: "1px solid rgba(167,139,250,0.45)",
              boxShadow:   "0 30px 80px rgba(0,0,0,0.58), 0 0 0 1px rgba(167,139,250,0.18)",
            }}
          >
            {/* Light sweep */}
            {!reduceMotion && (
              <motion.div
                aria-hidden
                initial={{ x: "-120%" }}
                animate={{ x: "120%" }}
                transition={{ duration: 2.8, repeat: Infinity, repeatDelay: 1.8, ease: "easeInOut" }}
                style={{
                  position: "absolute", top: 0, bottom: 0, width: "44%",
                  transform: "skewX(-18deg)",
                  background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.72), transparent)",
                  pointerEvents: "none",
                }}
              />
            )}

            <div style={{ position: "relative", padding: "24px 20px 20px", textAlign: "center" }}>
              {/* No X button — receipt persists until student explicitly confirms.
                  Only "បញ្ជាក់ និងបិទ · Confirm" closes this overlay. */}

              <TuitionSeal reduceMotion={reduceMotion} />

              {/* Confirmation badge */}
              <div
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  gap: 7, padding: "7px 12px",
                  borderRadius: 999,
                  background: "linear-gradient(135deg, rgba(79,70,229,0.10), rgba(124,58,237,0.10))",
                  border: "1px solid rgba(79,70,229,0.22)",
                  color: SAPPHIRE,
                  fontFamily: UI_FONT,
                  fontSize: 12, fontWeight: 800,
                }}
              >
                <ShieldCheck size={13} aria-hidden />
                Tuition payment confirmed · {fmtMethod(method)}
              </div>

              <h2
                id="ttn-receipt-title"
                style={{ margin: "14px 0 4px", color: "#1e1b4b", fontSize: 22, fontWeight: 800, ...khmerText }}
              >
                ការបង់ថ្លៃសិក្សាបានជោគជ័យ
              </h2>
              <p style={{ margin: "0 0 18px", color: "#3730a3", fontSize: 13, fontWeight: 700, ...khmerText }}>
                Tuition paid · {fmtDatetime(confirmed_at)}
              </p>

              {/* Amount tile */}
              <div
                style={{
                  borderRadius: 18, overflow: "hidden",
                  border: "1px solid rgba(79,70,229,0.20)",
                  background: "linear-gradient(180deg, rgba(237,233,254,0.85), rgba(255,255,255,0.96))",
                  textAlign: "left",
                }}
              >
                {/* Amount header */}
                <div
                  style={{
                    padding: "14px 16px 12px",
                    background: GRAD,
                    color: "#f5f3ff",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontFamily: UI_FONT, fontSize: 12, fontWeight: 800 }}>Amount paid</span>
                    <Banknote size={17} aria-hidden />
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span
                      style={{
                        fontFamily: UI_FONT, fontSize: 34, lineHeight: 1,
                        fontWeight: 900, color: "#fef3c7",
                        textShadow: "0 8px 24px rgba(0,0,0,0.22)",
                      }}
                    >
                      ${typeof amount_usd === "number" ? amount_usd.toFixed(2) : amount_usd}
                    </span>
                    <span style={{ fontFamily: UI_FONT, fontSize: 14, fontWeight: 800, color: "#c4b5fd" }}>USD</span>
                  </div>
                  {amount_khr > 0 && (
                    <p style={{ margin: "4px 0 0", fontFamily: UI_FONT, fontSize: 12, color: "rgba(237,233,254,0.75)", fontWeight: 600 }}>
                      ≈ {Number(amount_khr).toLocaleString()} ៛
                    </p>
                  )}
                </div>

                {/* Receipt detail rows */}
                <div style={{ padding: "8px 16px 12px" }}>
                  {clean_id && (
                    <ReceiptRow
                      label="Student ID"
                      value={clean_id}
                      icon={<ShieldCheck size={14} />}
                      mono
                    />
                  )}
                  <ReceiptRow
                    label="Payment method"
                    value={fmtMethod(method)}
                    icon={<CreditCard size={14} />}
                  />
                  {(prev_due_date || new_due_date) && (
                    <ReceiptRow
                      label="Billing period"
                      value={`${fmtDate(prev_due_date) || "—"} → ${fmtDate(new_due_date) || "—"}`}
                      icon={<Calendar size={14} />}
                    />
                  )}
                  {new_due_date && (
                    <ReceiptRow
                      label="Next due date"
                      value={fmtDate(new_due_date)}
                      icon={<Calendar size={14} />}
                      valueColor="#1e293b"
                    />
                  )}
                  {billingAnchorDay != null && (
                    <ReceiptRow
                      label="Billing day"
                      value={`${ordinal(billingAnchorDay)} of each month`}
                      icon={<Clock4 size={14} />}
                    />
                  )}
                  {invoice_number && (
                    <ReceiptRow
                      label="Invoice"
                      value={invoice_number}
                      icon={<FileText size={13} />}
                      mono
                    />
                  )}
                  {reference && (
                    <ReceiptRow
                      label="Reference"
                      value={reference}
                      icon={<Hash size={13} />}
                      mono
                    />
                  )}
                  <ReceiptRow
                    label="Confirmed"
                    value={fmtDatetime(confirmed_at)}
                    icon={<Clock4 size={14} />}
                    last={!showReward}
                  />

                  {/* On-time appreciation reward */}
                  {showReward && (
                    <div
                      style={{
                        marginTop: 10, padding: "10px 12px",
                        borderRadius: 12,
                        background: "rgba(217,119,6,0.07)",
                        border: "1px solid rgba(217,119,6,0.20)",
                        display: "flex", alignItems: "center", gap: 8,
                      }}
                    >
                      <Star size={15} style={{ color: GOLD, flexShrink: 0 }} aria-hidden />
                      <div>
                        <p style={{ margin: 0, fontSize: 12, fontWeight: 800, color: GOLD, fontFamily: KM_FONT }}>
                          On-time appreciation reward · +{Number(reward_points).toLocaleString()} pts
                        </p>
                        <p style={{ margin: "2px 0 0", fontSize: 11, fontWeight: 600, color: rewardCredited ? "#047857" : "#92400e", fontFamily: UI_FONT }}>
                          {rewardCredited
                            ? "Credited to your wallet ✓"
                            : "Processing — will credit shortly"}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Download PDF / PNG */}
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <button
                  type="button"
                  onClick={() => handleDownload("pdf")}
                  disabled={downloading !== null}
                  data-testid="tuition-receipt-download-pdf"
                  style={{
                    flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center",
                    gap: 6, padding: "10px 12px", borderRadius: 12,
                    border: `1px solid rgba(79,70,229,0.30)`, background: "rgba(79,70,229,0.06)",
                    color: SAPPHIRE, fontFamily: UI_FONT, fontSize: 12, fontWeight: 800,
                    cursor: downloading ? "not-allowed" : "pointer", opacity: downloading ? 0.6 : 1,
                  }}
                >
                  <FileText size={14} aria-hidden />
                  {downloading === "pdf" ? "…" : "PDF"}
                </button>
                <button
                  type="button"
                  onClick={() => handleDownload("png")}
                  disabled={downloading !== null}
                  data-testid="tuition-receipt-download-png"
                  style={{
                    flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center",
                    gap: 6, padding: "10px 12px", borderRadius: 12,
                    border: `1px solid rgba(79,70,229,0.30)`, background: "rgba(79,70,229,0.06)",
                    color: SAPPHIRE, fontFamily: UI_FONT, fontSize: 12, fontWeight: 800,
                    cursor: downloading ? "not-allowed" : "pointer", opacity: downloading ? 0.6 : 1,
                  }}
                >
                  <Download size={14} aria-hidden />
                  {downloading === "png" ? "…" : "PNG"}
                </button>
              </div>
              {downloadErr && (
                <p style={{ marginTop: 6, fontSize: 11, color: "#dc2626", ...khmerText }}>{downloadErr}</p>
              )}

              {/* Error */}
              {ackErr && (
                <p style={{ marginTop: 10, fontSize: 11, color: "#dc2626", ...khmerText }}>{ackErr}</p>
              )}

              {/* Confirm button — ONLY this button calls acknowledge */}
              <button
                ref={confirmRef}
                onClick={acknowledged ? handleClose : handleAcknowledge}
                disabled={acking}
                data-testid="tuition-receipt-confirm-btn"
                style={{
                  width: "100%",
                  minHeight: 54,
                  marginTop: 18,
                  padding: "13px 18px",
                  border: "none",
                  borderRadius: 16,
                  cursor: acking ? "not-allowed" : "pointer",
                  background: acknowledged
                    ? "rgba(79,70,229,0.15)"
                    : GRAD,
                  color: acknowledged ? SAPPHIRE : "#fff",
                  boxShadow: acknowledged
                    ? "none"
                    : "0 16px 30px rgba(79,70,229,0.30), inset 0 1px 0 rgba(255,255,255,0.18)",
                  fontSize: 15,
                  fontWeight: 900,
                  opacity: acking ? 0.7 : 1,
                  ...khmerText,
                }}
              >
                {acking ? "កំពុងរក្សា…" : acknowledged ? "✓ បានបញ្ជាក់" : "បញ្ជាក់ និងបិទ"}
                {!acking && !acknowledged && (
                  <span
                    style={{
                      display: "inline-block", marginLeft: 8,
                      fontFamily: UI_FONT, fontSize: 13, fontWeight: 800,
                    }}
                  >
                    · Confirm
                  </span>
                )}
              </button>

              <div style={{ marginTop: 10, color: "#6d28d9", fontSize: 11, fontWeight: 700, ...khmerText }}>
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
