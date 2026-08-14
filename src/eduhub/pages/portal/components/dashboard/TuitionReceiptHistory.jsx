// @ts-nocheck
/**
 * TuitionReceiptHistory.jsx — All-receipts history panel (premium)
 *
 * Loads GET /api/student/tuition/receipts (newest first, student-scoped).
 * Selecting a receipt calls onSelectReceipt(receipt_id) so the parent
 * opens TuitionReceiptOverlay for that receipt.
 *
 * Design: full-screen sapphire/violet overlay, dark-first, matches portal.
 * DO NOT modify TopUpReceiptOverlay.jsx. This file is completely independent.
 *
 * Props:
 *   onClose()                    — close the history panel
 *   onSelectReceipt(receipt_id)  — open the full receipt overlay
 */

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  X, ChevronRight, Banknote, Calendar, Star, CreditCard,
} from "lucide-react";

const BACKEND  = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
const SAPPHIRE = "#4f46e5";
const VIOLET   = "#7c3aed";
const GOLD     = "#d97706";
const KM_FONT  = "'Noto Sans Khmer','Kantumruy Pro','Khmer OS',system-ui,sans-serif";
const UI_FONT  = "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

function authHeaders() {
  try {
    const t = localStorage.getItem("student_session_token");
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
}

function fmtDate(raw) {
  if (!raw) return "—";
  try {
    const d = new Date(String(raw).replace(/\./g, "-").replace(/\//g, "-"));
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch { return raw; }
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

export default function TuitionReceiptHistory({ onClose, onSelectReceipt }) {
  const [receipts, setReceipts] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(
          `${BACKEND}/api/student/tuition/receipts?limit=20`,
          { credentials: "include", headers: { ...authHeaders() } }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json().catch(() => ({}));
        if (mounted) setReceipts(data?.receipts || []);
      } catch (err) {
        if (mounted) setError(err.message || "Failed to load receipts");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const handleSelect = (receipt) => {
    if (!receipt.receipt_id) return;
    onSelectReceipt?.(receipt.receipt_id);
  };

  return (
    <motion.div
      key="tuition-history-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      data-testid="tuition-receipt-history"
      role="dialog"
      aria-modal="true"
      aria-label="Receipt history"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10800,
        background:
          "radial-gradient(circle at 50% 0%, rgba(79,70,229,0.18), transparent 28%), " +
          "linear-gradient(180deg, rgba(2,6,23,0.92) 0%, rgba(4,10,16,0.97) 100%)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        display: "flex",
        flexDirection: "column",
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        overflow: "hidden",
        fontFamily: KM_FONT,
      }}
    >
      {/* ── Panel header ─────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 20px 14px",
          borderBottom: "1px solid rgba(79,70,229,0.20)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 34, height: 34, borderRadius: 10,
              background: `linear-gradient(135deg, ${SAPPHIRE}, ${VIOLET})`,
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: `0 4px 14px rgba(79,70,229,0.38)`,
              flexShrink: 0,
            }}
          >
            <Banknote size={16} style={{ color: "#fff" }} />
          </div>
          <div>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "#f1f5f9", fontFamily: UI_FONT }}>
              Payment Receipts
            </p>
            <p style={{ margin: 0, fontSize: 11, color: "#64748b", fontFamily: UI_FONT }}>
              {loading
                ? "Loading…"
                : error
                ? "Could not load"
                : `${receipts.length} payment${receipts.length === 1 ? "" : "s"} on record`}
            </p>
          </div>
        </div>

        <button
          onClick={onClose}
          aria-label="Close receipt history"
          data-testid="tuition-history-close-btn"
          style={{
            width: 36, height: 36, borderRadius: "50%",
            background: "rgba(255,255,255,0.07)",
            border: "1px solid rgba(255,255,255,0.12)",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", color: "#94a3b8",
            flexShrink: 0,
          }}
        >
          <X size={16} />
        </button>
      </div>

      {/* ── Panel body ───────────────────────────────────────────────── */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 16px 24px",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {/* Loading spinner */}
        {loading && (
          <div style={{ textAlign: "center", padding: "48px 0" }}>
            <div
              className="animate-spin"
              style={{
                width: 32, height: 32,
                border: `3px solid rgba(79,70,229,0.18)`,
                borderTopColor: SAPPHIRE,
                borderRadius: "50%",
                margin: "0 auto 12px",
              }}
            />
            <p style={{ fontSize: 13, color: "#64748b", fontFamily: KM_FONT }}>
              Loading receipts…
            </p>
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div style={{ textAlign: "center", padding: "48px 20px" }}>
            <p style={{ fontSize: 13, color: "#94a3b8", fontFamily: KM_FONT, margin: "0 0 4px" }}>
              Could not load receipts.
            </p>
            <p style={{ fontSize: 12, color: "#64748b", fontFamily: UI_FONT, margin: 0 }}>
              Please check your connection and try again.
            </p>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && receipts.length === 0 && (
          <div
            style={{ textAlign: "center", padding: "52px 24px" }}
            data-testid="tuition-history-empty"
          >
            <div
              style={{
                width: 52, height: 52,
                margin: "0 auto 14px",
                borderRadius: 16,
                background: "rgba(79,70,229,0.10)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <Banknote size={24} style={{ color: SAPPHIRE, opacity: 0.55 }} />
            </div>
            <p style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 700, color: "#e2e8f0", fontFamily: KM_FONT }}>
              No digital receipts yet
            </p>
            <p style={{ margin: 0, fontSize: 12, color: "#64748b", fontFamily: UI_FONT, lineHeight: 1.55 }}>
              Receipts appear here after your first confirmed KHQR payment.
              Historical payments without digital evidence are not shown.
            </p>
          </div>
        )}

        {/* Receipt list — newest first (sorted by backend) */}
        {!loading && !error && receipts.map((r) => (
          <button
            key={r.receipt_id || r.confirmed_at}
            onClick={() => handleSelect(r)}
            data-testid="tuition-history-receipt-item"
            style={{
              width: "100%",
              textAlign: "left",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(79,70,229,0.16)",
              borderRadius: 14,
              padding: "12px 14px",
              marginBottom: 8,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            {/* Receipt icon */}
            <div
              style={{
                width: 38, height: 38, borderRadius: 10, flexShrink: 0,
                background: `linear-gradient(135deg, ${SAPPHIRE}, ${VIOLET})`,
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: `0 3px 10px rgba(79,70,229,0.30)`,
              }}
            >
              <CreditCard size={16} style={{ color: "#fff" }} />
            </div>

            {/* Receipt info */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* Top row: amount + reward */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: "#f1f5f9", fontFamily: UI_FONT }}>
                  ${typeof r.amount_usd === "number" ? r.amount_usd.toFixed(2) : (r.amount_usd || "—")}
                  <span style={{ fontSize: 11, fontWeight: 600, color: "#64748b", marginLeft: 5 }}>USD</span>
                </span>
                {r.reward_status === "credited" && r.reward_points > 0 && (
                  <span
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 3,
                      fontSize: 11, fontWeight: 700, color: GOLD,
                    }}
                  >
                    <Star size={11} /> +{Number(r.reward_points).toLocaleString()} pts
                  </span>
                )}
              </div>

              {/* Bottom row: date · method · next due */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "3px 8px", alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "#64748b", fontFamily: UI_FONT }}>
                  {fmtDate(r.confirmed_at)}
                </span>
                <span style={{ fontSize: 11, color: "#334155" }}>·</span>
                <span style={{ fontSize: 11, color: "#64748b", fontFamily: UI_FONT }}>
                  {fmtMethod(r.method)}
                </span>
                {r.new_due_date && (
                  <>
                    <span style={{ fontSize: 11, color: "#334155" }}>·</span>
                    <span style={{ fontSize: 11, color: "#64748b", display: "flex", alignItems: "center", gap: 3 }}>
                      <Calendar size={10} />
                      Next: {fmtDate(r.new_due_date)}
                    </span>
                  </>
                )}
              </div>
              {/* Renders nothing for legacy pre-backfill receipts — no fake data */}
              {r.invoice_number && (
                <p style={{ margin: "3px 0 0", fontSize: 10.5, color: "#475569", fontFamily: "'SF Mono','Roboto Mono',ui-monospace,Menlo,Consolas,monospace" }}>
                  {r.invoice_number}
                </p>
              )}
            </div>

            <ChevronRight size={15} style={{ color: "#475569", flexShrink: 0 }} />
          </button>
        ))}

        {/* Legacy note */}
        {!loading && !error && receipts.length > 0 && (
          <p
            style={{
              margin: "8px 4px 0",
              fontSize: 11,
              color: "#475569",
              fontFamily: UI_FONT,
              lineHeight: 1.5,
              textAlign: "center",
            }}
          >
            Historical payments without digital payment evidence are not shown.
          </p>
        )}
      </div>
    </motion.div>
  );
}
