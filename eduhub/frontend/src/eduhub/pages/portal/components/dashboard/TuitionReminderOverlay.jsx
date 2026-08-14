// @ts-nocheck
/**
 * TuitionReminderOverlay.jsx — Server-controlled Tuition Reminder
 *
 * Calls GET /api/tuition/reminder/me to determine whether and what to show.
 * The backend decides all eligibility; this component is a pure renderer.
 *
 * Full-screen premium takeover with backdrop — not a bottom sheet.
 * Supports both server-side and client-side dismissal strategies.
 *
 * Props:
 *   isAuthed — boolean (only prop needed)
 */

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, GraduationCap, ArrowRight, Loader2 } from "lucide-react";

const BACKEND          = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
const CLIENT_SNOOZE_KEY = "eduhub_tuition_reminder_snoozed_v2";

// ── Design tokens (sapphire / violet — distinct from green TopUp palette) ──────
const SAPPHIRE = "#4f46e5";
const VIOLET   = "#7c3aed";
const GRAD     = `linear-gradient(135deg, ${SAPPHIRE} 0%, ${VIOLET} 100%)`;
const SURFACE  = "rgba(79,70,229,0.08)";
const BORDER   = "rgba(79,70,229,0.3)";
const TEXT     = "#f8fafc";
const MUTED    = "rgba(248,250,252,0.62)";

const KM_FONT = "'Noto Sans Khmer','Kantumruy Pro','Khmer OS',system-ui,sans-serif";

function authHeaders() {
  try {
    const t = localStorage.getItem("student_session_token");
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
}

function isClientSnoozed() {
  try {
    const raw = sessionStorage.getItem(CLIENT_SNOOZE_KEY);
    if (!raw) return false;
    const { until } = JSON.parse(raw);
    return !!until && Date.now() < until;
  } catch { return false; }
}

function setClientSnooze(hours = 6) {
  try {
    sessionStorage.setItem(
      CLIENT_SNOOZE_KEY,
      JSON.stringify({ until: Date.now() + hours * 3_600_000 })
    );
  } catch {}
}

export default function TuitionReminderOverlay({ isAuthed }) {
  const [visible,    setVisible]    = useState(false);
  const [payload,    setPayload]    = useState(null);  // full server response when show=true
  const [dismissing, setDismissing] = useState(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!isAuthed || fetchedRef.current) return;
    if (isClientSnoozed()) return;
    fetchedRef.current = true;

    (async () => {
      try {
        const res = await fetch(`${BACKEND}/api/tuition/reminder/me`, {
          credentials: "include",
          headers: { "Content-Type": "application/json", ...authHeaders() },
        });
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (!data?.show) return;
        setPayload(data);
        // Small delay so the main page renders before the overlay appears
        setTimeout(() => setVisible(true), 900);
      } catch { /* backend unavailable — silent */ }
    })();
  }, [isAuthed]);

  const handleDismiss = async () => {
    if (dismissing) return;
    const strategy = payload?.dismiss_strategy;
    if (strategy === "server") {
      setDismissing(true);
      try {
        await fetch(`${BACKEND}/api/tuition/reminder/dismiss`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", ...authHeaders() },
        });
      } catch {}
      setDismissing(false);
    } else {
      setClientSnooze(payload?.snooze_hours ?? 6);
    }
    setVisible(false);
  };

  const handlePayNow = async () => {
    await handleDismiss();
    window.location.href = "/portal?tuition=pay";
  };

  if (!visible || !payload) return null;

  const titleKm   = payload.title_km   || "ថ្លៃសិក្សា";
  const titleEn   = payload.title_en   || "Tuition Reminder";
  const bodyKm    = payload.body_km    || "";
  const bodyEn    = payload.body_en    || "";
  const buttonKm  = payload.button_km  || "បង់ប្រាក់ឥឡូវ";
  const buttonEn  = payload.button_en  || "Pay Now";
  const snoozeKm  = payload.dismiss_label_km || "ពន្យារពេល";

  return (
    <AnimatePresence>
      {/* Full-screen backdrop — tapping outside dismisses */}
      <motion.div
        key="tuition-reminder-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
        style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(10px)" }}
        onClick={handleDismiss}
        data-testid="tuition-reminder-overlay"
        aria-modal="true"
        role="dialog"
        aria-label={titleEn}
      >
        {/* Card — slides up from bottom, centers on sm+ */}
        <motion.div
          initial={{ opacity: 0, y: 64 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 64 }}
          transition={{ type: "spring", damping: 26, stiffness: 240 }}
          className="relative w-full max-w-sm rounded-3xl overflow-hidden"
          style={{
            background: "#0f0e1a",
            border: `1px solid ${BORDER}`,
            boxShadow: `0 32px 80px rgba(79,70,229,0.4), 0 0 0 1px rgba(79,70,229,0.15)`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* ── Gradient header ─────────────────────────────────────────────── */}
          <div className="relative px-5 pt-5 pb-4" style={{ background: GRAD }}>
            {/* Decorative sparkles */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <div className="absolute top-3 right-14 h-2 w-2 rounded-full bg-white/25" />
              <div className="absolute top-7 right-8 h-1.5 w-1.5 rounded-full bg-white/15" />
              <div className="absolute top-2 right-5 h-1 w-1 rounded-full bg-white/20" />
              <div className="absolute bottom-3 left-10 h-1.5 w-1.5 rounded-full bg-white/10" />
            </div>

            <div className="relative flex items-center gap-3">
              <div
                className="h-12 w-12 rounded-2xl flex items-center justify-center shrink-0"
                style={{ background: "rgba(255,255,255,0.18)", backdropFilter: "blur(8px)" }}
              >
                <GraduationCap className="h-6 w-6 text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <p
                  className="text-[16px] font-bold text-white leading-tight"
                  style={{ fontFamily: KM_FONT }}
                >
                  {titleKm}
                </p>
                <p className="text-[11.5px] text-white/70 mt-0.5 font-medium">
                  {titleEn}
                </p>
              </div>
              <button
                onClick={handleDismiss}
                className="h-8 w-8 rounded-full flex items-center justify-center shrink-0 transition-all"
                style={{ background: "rgba(255,255,255,0.18)" }}
                data-testid="tuition-reminder-dismiss"
                aria-label="Dismiss"
              >
                <X className="h-4 w-4 text-white" />
              </button>
            </div>
          </div>

          {/* ── Body ────────────────────────────────────────────────────────── */}
          <div className="px-5 py-5 space-y-4">
            {/* Bilingual copy */}
            <div className="space-y-2">
              {bodyKm && (
                <p
                  className="text-[13.5px] leading-relaxed"
                  style={{ color: TEXT, fontFamily: KM_FONT }}
                >
                  {bodyKm}
                </p>
              )}
              {bodyEn && bodyEn !== bodyKm && (
                <p className="text-[11.5px] leading-relaxed" style={{ color: MUTED }}>
                  {bodyEn}
                </p>
              )}
            </div>

            {/* Amount chip (if server provides it) */}
            {payload.amount_usd && (
              <div
                className="rounded-xl px-4 py-2.5 flex items-center justify-between"
                style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
              >
                <span className="text-[11px]" style={{ color: MUTED, fontFamily: KM_FONT }}>
                  ចំនួនទឹកប្រាក់
                </span>
                <span className="text-[15px] font-bold" style={{ color: TEXT }}>
                  ${Number(payload.amount_usd).toFixed(2)} USD
                </span>
              </div>
            )}

            {/* CTA buttons */}
            <div className="flex gap-2.5 pt-1">
              <button
                onClick={handleDismiss}
                disabled={dismissing}
                className="flex-1 rounded-2xl py-3 text-[12.5px] font-bold transition-all"
                style={{
                  background: SURFACE,
                  border: `1px solid ${BORDER}`,
                  color: dismissing ? "rgba(248,250,252,0.3)" : MUTED,
                  cursor: dismissing ? "not-allowed" : "pointer",
                }}
                data-testid="tuition-reminder-snooze-btn"
              >
                {dismissing
                  ? <Loader2 className="h-4 w-4 animate-spin inline" />
                  : <span style={{ fontFamily: KM_FONT }}>{snoozeKm}</span>}
              </button>

              <button
                onClick={handlePayNow}
                disabled={dismissing}
                className="flex-[2] rounded-2xl py-3 text-[13px] font-bold text-white flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
                style={{ background: GRAD, cursor: dismissing ? "not-allowed" : "pointer" }}
                data-testid="tuition-reminder-pay-btn"
              >
                <span style={{ fontFamily: KM_FONT }}>{buttonKm}</span>
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>

            {/* English pay label */}
            {buttonEn && buttonEn !== buttonKm && (
              <p className="text-center text-[10.5px]" style={{ color: MUTED }}>
                {buttonEn}
              </p>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
