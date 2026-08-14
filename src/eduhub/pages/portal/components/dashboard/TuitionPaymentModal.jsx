// @ts-nocheck
/**
 * TuitionPaymentModal.jsx — EduHub Tuition KHQR Payment Modal
 *
 * Student-facing modal for paying tuition via CamRapidPay KHQR.
 * Sapphire/violet palette — distinct from the green TopUpReceiptOverlay.
 *
 * Props:
 *   studentId       — portal StudentID (clean_id / GAS student ID)
 *   studentName     — student display name (Author Studio "Name" field), for the QR card header
 *   currentNdd      — current NextDueDate string from student data (for display + receipt)
 *   paymentAmount   — number | undefined (USD amount from student data)
 *   activeIntent    — { intent_id, status, ... } | null/undefined — from GET /api/student/tuition's
 *                     `active_intent` field. When present on mount, the modal resumes straight into
 *                     the existing intent instead of showing the initial "Generate KHQR" screen.
 *   onClose()       — called when user dismisses modal
 *   onConfirmed(receiptId) — called when payment is confirmed
 *
 * Public contract: does NOT modify TopUpReceiptOverlay, wallet_service, or any
 * existing payment flow. Calls POST /api/student/tuition/intent and polls
 * GET /api/student/tuition/intent/{id} for status.
 *
 * Persistent Resume (production reliability fix): a duplicate-intent 409
 * from POST /intent (INTENT_ACTIVE) and a truthy `activeIntent` prop on
 * mount both route through the SAME resumeIntent() — GET /intent/{id}
 * always regenerates a fresh qr_image server-side (never persisted), so
 * either path resumes into a real, scannable QR, never a dead-end error.
 *
 * Storage: sessionStorage["eduhub_tuition_receipt_pending_v1"] for cross-render
 * receipt hand-off to TuitionReceiptOverlay.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, QrCode, CheckCircle2, Loader2,
  RefreshCw, AlertTriangle, ShieldCheck, Clock4,
  CreditCard, Smartphone, ScanLine,
} from "lucide-react";
import { haptic } from "../../../../lib/haptics";

const BACKEND = process.env.REACT_APP_BACKEND_URL || "";
const POLL_MS = 3000;
const CHECK_DEBOUNCE_MS = 4000;
const TUITION_RECEIPT_KEY = "eduhub_tuition_receipt_pending_v1";

// ── Design tokens (sapphire/violet palette) ──────────────────────────────────
const SAPPHIRE = "#4f46e5";
const VIOLET   = "#7c3aed";
const GRAD     = `linear-gradient(135deg, ${SAPPHIRE} 0%, ${VIOLET} 100%)`;
const SURFACE  = "rgba(79,70,229,0.08)";
const BORDER   = "rgba(79,70,229,0.25)";
const TEXT     = "#f8fafc";
const MUTED    = "rgba(248,250,252,0.55)";

// Khmer font stack
const KM_FONT = "'Noto Sans Khmer','Kantumruy Pro','Khmer OS',system-ui,sans-serif";

function km(extra) {
  return {
    fontFamily: KM_FONT,
    letterSpacing: 0,
    textTransform: "none",
    lineHeight: 1.55,
    ...extra,
  };
}

function authHeaders() {
  try {
    const t = localStorage.getItem("student_session_token");
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${BACKEND}${path}`, {
    ...opts,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      (data.detail && data.detail.message) ||
      (typeof data.detail === "string" ? data.detail : "") ||
      `HTTP ${res.status}`;
    throw Object.assign(new Error(message), { data });
  }
  return data;
}

export function saveTuitionReceipt(receiptId) {
  try {
    sessionStorage.setItem(TUITION_RECEIPT_KEY, JSON.stringify({ receipt_id: receiptId }));
  } catch { /* quota — ignore */ }
}

export function consumeTuitionReceipt() {
  try {
    const raw = sessionStorage.getItem(TUITION_RECEIPT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(TUITION_RECEIPT_KEY);
    const parsed = JSON.parse(raw);
    return parsed?.receipt_id || null;
  } catch {
    return null;
  }
}

// ── Default tuition amount if not provided (fallback only) ────────────────────
const DEFAULT_USD = 25;
const KHR_PER_USD = 4100;

// Short, fast auto-advancing reveal of the one known fact (payment
// succeeded) — NOT a claim the backend is separately reporting each step.
const SUCCESS_STEPS = [
  { km: "ការទូទាត់បានផ្ទៀងផ្ទាត់", en: "Payment verified" },
  { km: "បង្កើតបង្កាន់ដៃ",         en: "Receipt created" },
  { km: "កាបូបលុយបានធ្វើបច្ចុប្បន្នភាព", en: "Wallet updated" },
];
const SUCCESS_STEP_MS = 650;

export default function TuitionPaymentModal({
  studentId,
  studentName,
  currentNdd,
  paymentAmount,
  activeIntent,
  onClose,
  onConfirmed,
}) {
  const amountUsd = typeof paymentAmount === "number" && paymentAmount > 0
    ? paymentAmount
    : DEFAULT_USD;
  const amountKhr = Math.round(amountUsd * KHR_PER_USD);

  // idle | resuming | creating | qr | done | error | expired
  const [phase, setPhase]         = useState(activeIntent?.intent_id ? "resuming" : "idle");
  const [intent, setIntent]       = useState(null);
  const [errorMsg, setErrorMsg]   = useState("");
  const [checking, setChecking]   = useState(false);
  const [lastCheck, setLastCheck] = useState(0);
  const [timeLeft, setTimeLeft]   = useState(null);
  const [wasResumed, setWasResumed] = useState(false);
  const [successStep, setSuccessStep] = useState(0);
  const pollRef = useRef(null);
  const mountRef = useRef(true);
  const successTimersRef = useRef([]);

  useEffect(() => {
    mountRef.current = true;
    return () => {
      mountRef.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
      successTimersRef.current.forEach(clearTimeout);
    };
  }, []);

  // Countdown timer from intent.expires_at
  useEffect(() => {
    if (!intent?.expires_at || phase !== "qr") return;
    const tick = () => {
      const diff = Math.max(0, Math.round((new Date(intent.expires_at) - Date.now()) / 1000));
      if (mountRef.current) setTimeLeft(diff);
      if (diff <= 0 && mountRef.current && phase === "qr") {
        setPhase("expired");
        if (pollRef.current) clearInterval(pollRef.current);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [intent?.expires_at, phase]);

  const enterDone = useCallback((receiptId) => {
    haptic.success();
    setPhase("done");
    setSuccessStep(0);
    saveTuitionReceipt(receiptId);
    successTimersRef.current.forEach(clearTimeout);
    successTimersRef.current = SUCCESS_STEPS.map((_, i) =>
      setTimeout(() => { if (mountRef.current) setSuccessStep(i + 1); }, SUCCESS_STEP_MS * (i + 1)),
    );
    successTimersRef.current.push(
      setTimeout(() => {
        if (mountRef.current) onConfirmed?.(receiptId);
      }, SUCCESS_STEP_MS * SUCCESS_STEPS.length + 700),
    );
  }, [onConfirmed]);

  const startPoll = useCallback((intentId) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      if (!mountRef.current) return;
      try {
        const data = await apiFetch(`/api/student/tuition/intent/${intentId}`);
        if (!mountRef.current) return;
        if (data.status === "completed") {
          clearInterval(pollRef.current);
          enterDone(data.receipt_id);
        } else if (data.status === "expired") {
          clearInterval(pollRef.current);
          setPhase("expired");
        }
      } catch { /* poll silently */ }
    }, POLL_MS);
  }, [enterDone]);

  // Shared resume path — GET /intent/{id} always regenerates qr_image for a
  // still-pending intent server-side, so this is a real, scannable QR, not
  // just a status object. Used by both the mount-time auto-resume effect
  // and the 409 INTENT_ACTIVE handler below (single source of truth).
  const resumeIntent = useCallback(async (intentId, { fromMount } = {}) => {
    try {
      const resumed = await apiFetch(`/api/student/tuition/intent/${intentId}`);
      if (!mountRef.current) return;
      if (resumed.status === "pending" && resumed.qr_image) {
        setIntent(resumed);
        setWasResumed(true);
        setPhase("qr");
        startPoll(intentId);
        return;
      }
      if (resumed.status === "completed") {
        enterDone(resumed.receipt_id);
        return;
      }
      if (resumed.status === "expired") {
        setPhase("expired");
        return;
      }
      // Cancelled/unknown — let the student start fresh rather than loop.
      setPhase("idle");
    } catch {
      // Resume attempt itself failed. From mount, fail open to a clean
      // "idle" start (never strand the student on a blank/loading modal) —
      // handled locally, never rethrown, regardless of mount state.
      // From the 409 catch (fromMount unset), rethrow so the caller falls
      // through to its normal error display instead — see createIntent.
      if (fromMount) {
        if (mountRef.current) setPhase("idle");
        return;
      }
      throw new Error("resume-failed");
    }
  }, [startPoll, enterDone]);

  // Mount-time auto-resume: "whenever Tuition page opens" — no manual tap,
  // no initial "Generate KHQR" flash if an active intent already exists.
  useEffect(() => {
    if (activeIntent?.intent_id) {
      resumeIntent(activeIntent.intent_id, { fromMount: true });
    }
    // Intentionally run once on mount only — activeIntent is a snapshot
    // from the page's own load, not a value this effect should re-run on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createIntent = useCallback(async () => {
    setPhase("creating");
    setErrorMsg("");
    setWasResumed(false);
    try {
      const data = await apiFetch("/api/student/tuition/intent", {
        method: "POST",
        body: JSON.stringify({
          method:      "khqr",
          amount_usd:  amountUsd,
          amount_khr:  amountKhr,
          current_ndd: currentNdd || null,
        }),
      });
      if (!mountRef.current) return;
      setIntent(data);
      setPhase("qr");
      startPoll(data.intent_id);
    } catch (err) {
      if (!mountRef.current) return;
      // A 409 INTENT_ACTIVE means the student already has a live, unexpired
      // KHQR intent (e.g. they generated one, closed the modal, and tapped
      // Generate again) — resume it instead of dead-ending on an error the
      // student has no way to act on.
      const detail = err.data?.detail;
      const resumeIntentId = detail && typeof detail === "object" ? detail.intent_id : null;
      if (detail?.code === "INTENT_ACTIVE" && resumeIntentId) {
        try {
          await resumeIntent(resumeIntentId);
          return;
        } catch {
          // Resume attempt itself failed — fall through to the normal
          // error display below rather than silently doing nothing.
        }
      }
      if (!mountRef.current) return;
      setErrorMsg(err.message || "Failed to create payment");
      setPhase("error");
    }
  }, [amountUsd, amountKhr, currentNdd, startPoll, resumeIntent]);

  const manualCheck = useCallback(async () => {
    if (!intent?.intent_id || checking) return;
    const now = Date.now();
    if (now - lastCheck < CHECK_DEBOUNCE_MS) return;
    setChecking(true);
    setLastCheck(now);
    try {
      const data = await apiFetch(`/api/student/tuition/intent/${intent.intent_id}`);
      if (!mountRef.current) return;
      if (data.status === "completed") {
        if (pollRef.current) clearInterval(pollRef.current);
        enterDone(data.receipt_id);
      }
    } catch { /* user-visible via intent status */ }
    finally { if (mountRef.current) setChecking(false); }
  }, [intent, checking, lastCheck, enterDone]);

  const fmtTime = (s) => {
    if (s == null) return "--:--";
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      data-testid="tuition-payment-modal"
    >
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0, scale: 0.93, y: 24 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.93, y: 24 }}
          transition={{ type: "spring", damping: 22, stiffness: 260 }}
          className="relative w-full max-w-sm rounded-3xl overflow-hidden"
          style={{
            background: "#0f0e1a",
            border: `1px solid ${BORDER}`,
            boxShadow: `0 24px 64px rgba(79,70,229,0.25)`,
          }}
        >
          {/* Header */}
          <div className="relative px-5 pt-5 pb-4 flex items-center gap-3"
               style={{ background: SURFACE, borderBottom: `1px solid ${BORDER}` }}>
            <div className="h-10 w-10 rounded-2xl flex items-center justify-center shrink-0"
                 style={{ background: GRAD }}>
              <CreditCard className="h-5 w-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-bold" style={{ color: TEXT }}>
                បង់ថ្លៃសិក្សា
              </p>
              <p className="text-[11px]" style={{ color: MUTED, fontFamily: KM_FONT }}>
                ${amountUsd.toFixed(2)} · {amountKhr.toLocaleString()} ៛
              </p>
            </div>
            <button
              onClick={onClose}
              className="h-8 w-8 rounded-full flex items-center justify-center transition-all"
              style={{ background: "rgba(255,255,255,0.06)", color: MUTED }}
              data-testid="tuition-modal-close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div className="px-5 py-5 space-y-4">

            {/* ── Resuming: brief loading state while the mount-time resume
                 fetch is in flight — never flash the initial screen first ── */}
            {phase === "resuming" && (
              <div className="flex flex-col items-center py-8 gap-3" data-testid="tuition-resuming">
                <Loader2 className="h-8 w-8 animate-spin" style={{ color: SAPPHIRE }} />
                <p className="text-[13px]" style={{ color: MUTED, ...km() }}>
                  កំពុងបន្តការទូទាត់…
                </p>
              </div>
            )}

            {/* ── Idle: show payment info + start button ── */}
            {phase === "idle" && (
              <div className="space-y-4">
                <div className="rounded-2xl p-4 space-y-2"
                     style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
                  <div className="flex justify-between items-center">
                    <span className="text-[11px] font-medium" style={{ color: MUTED }}>ចំនួនទឹកប្រាក់</span>
                    <span className="text-[15px] font-bold" style={{ color: TEXT }}>
                      ${amountUsd.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-[11px] font-medium" style={{ color: MUTED }}>ជារៀល</span>
                    <span className="text-[13px] font-bold" style={{ color: TEXT }}>
                      {amountKhr.toLocaleString()} ៛
                    </span>
                  </div>
                  {currentNdd && (
                    <div className="flex justify-between items-center">
                      <span className="text-[11px] font-medium" style={{ color: MUTED }}>ថ្ងៃបង់ប្រាក់</span>
                      <span className="text-[11px]" style={{ color: TEXT }}>{currentNdd}</span>
                    </div>
                  )}
                </div>

                <div className="rounded-xl p-3 flex items-center gap-2.5"
                     style={{ background: "rgba(79,70,229,0.06)", border: `1px solid ${BORDER}` }}>
                  <QrCode className="h-4 w-4 shrink-0" style={{ color: SAPPHIRE }} />
                  <p className="text-[11.5px]" style={{ color: MUTED, fontFamily: KM_FONT }}>
                    ស្កេន QR code KHQR ដើម្បីបង់ប្រាក់ជាមួយ ABA, ACLEDA, Wing ឬ Bakong
                  </p>
                </div>

                <button
                  onClick={createIntent}
                  className="w-full rounded-2xl py-3.5 font-bold text-[14px] text-white transition-all active:scale-[0.98]"
                  style={{ background: GRAD }}
                  data-testid="tuition-modal-pay-btn"
                >
                  <span style={km()}>បង់ប្រាក់ KHQR</span>
                </button>
              </div>
            )}

            {/* ── Creating intent ── */}
            {phase === "creating" && (
              <div className="flex flex-col items-center py-6 gap-3">
                <Loader2 className="h-8 w-8 animate-spin" style={{ color: SAPPHIRE }} />
                <p className="text-[13px]" style={{ color: MUTED, ...km() }}>
                  កំពុងបង្កើត QR code…
                </p>
              </div>
            )}

            {/* ── QR code ready — premium KHQR card ── */}
            {phase === "qr" && intent && (
              <div className="space-y-4">
                {/* Resume banner — calm, not an error dialog */}
                {wasResumed && (
                  <div className="rounded-xl px-3 py-2 flex items-center gap-2"
                       style={{ background: "rgba(79,70,229,0.06)", border: `1px solid ${BORDER}` }}
                       data-testid="tuition-resume-banner">
                    <RefreshCw className="h-3.5 w-3.5 shrink-0" style={{ color: SAPPHIRE }} />
                    <p className="text-[11px]" style={{ color: MUTED, ...km() }}>
                      បន្តការទូទាត់ថ្លៃសិក្សា · Continue your pending tuition payment
                    </p>
                  </div>
                )}

                {/* Premium KHQR card — light "paper" card inset into the dark
                    modal shell, same visual language as TuitionReceiptOverlay's
                    receipt card (serrated edge, light sweep) for consistency
                    across the whole tuition flow. */}
                <div className="relative rounded-3xl overflow-hidden"
                     style={{
                       background: "linear-gradient(180deg, #ffffff 0%, #f8f7ff 55%, #f0eeff 100%)",
                       border: "1px solid rgba(167,139,250,0.35)",
                       boxShadow: "0 16px 40px rgba(79,70,229,0.22)",
                     }}
                     data-testid="tuition-khqr-card">
                  {/* Card header — text/icon KHQR badge, not the licensed Bakong mark */}
                  <div className="flex items-center justify-between px-4 pt-4 pb-3">
                    <div className="flex items-center gap-1.5">
                      <div className="h-6 w-6 rounded-lg flex items-center justify-center"
                           style={{ background: GRAD }}>
                        <ScanLine className="h-3.5 w-3.5 text-white" />
                      </div>
                      <span className="text-[12px] font-extrabold tracking-wide" style={{ color: "#1e1b4b" }}>
                        KHQR
                      </span>
                    </div>
                    {timeLeft != null && (
                      <div className="flex items-center gap-1 rounded-full px-2.5 py-1"
                           style={{
                             background: timeLeft <= 60 ? "rgba(239,68,68,0.10)" : "rgba(79,70,229,0.08)",
                           }}
                           data-testid="tuition-qr-countdown">
                        <Clock4 className="h-3 w-3" style={{ color: timeLeft <= 60 ? "#dc2626" : SAPPHIRE }} />
                        <span className="text-[11px] font-bold"
                              style={{ color: timeLeft <= 60 ? "#dc2626" : "#1e1b4b" }}>
                          {fmtTime(timeLeft)}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Dashed tear line */}
                  <div className="mx-4" style={{ borderTop: "1.5px dashed rgba(79,70,229,0.25)" }} />

                  {/* QR — large, centered, generous margin (payload/encoding untouched) */}
                  <div className="flex justify-center py-5">
                    {intent.qr_image ? (
                      <img
                        src={intent.qr_image}
                        alt="KHQR Payment Code"
                        className="w-52 h-52 object-contain"
                        data-testid="tuition-qr-image"
                      />
                    ) : (
                      <div className="w-52 h-52 flex items-center justify-center">
                        <QrCode className="h-16 w-16" style={{ color: SAPPHIRE }} />
                      </div>
                    )}
                  </div>

                  {/* Dashed tear line */}
                  <div className="mx-4" style={{ borderTop: "1.5px dashed rgba(79,70,229,0.25)" }} />

                  {/* Payment info — no invoice number here: it does not
                      exist yet, only after payment succeeds. */}
                  <div className="px-4 py-3 space-y-1.5">
                    {studentName && (
                      <div className="flex justify-between items-center">
                        <span className="text-[10.5px] font-medium" style={{ color: "#6b7280" }}>Student</span>
                        <span className="text-[11.5px] font-semibold" style={{ color: "#1e1b4b" }}>{studentName}</span>
                      </div>
                    )}
                    {currentNdd && (
                      <div className="flex justify-between items-center">
                        <span className="text-[10.5px] font-medium" style={{ color: "#6b7280" }}>Billing period</span>
                        <span className="text-[11.5px] font-semibold" style={{ color: "#1e1b4b" }}>{currentNdd}</span>
                      </div>
                    )}
                    <div className="flex justify-between items-center pt-1">
                      <span className="text-[10.5px] font-medium" style={{ color: "#6b7280" }}>Amount</span>
                      <div className="text-right">
                        <p className="text-[15px] font-extrabold" style={{ color: "#1e1b4b" }}>
                          {amountKhr.toLocaleString()} ៛
                        </p>
                        <p className="text-[10.5px] font-medium" style={{ color: "#6b7280" }}>
                          (${amountUsd.toFixed(2)} USD)
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Live status — real client-observable states only */}
                <div className="flex items-center justify-center gap-2" data-testid="tuition-qr-status">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60"
                          style={{ background: SAPPHIRE }} />
                    <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: SAPPHIRE }} />
                  </span>
                  <span className="text-[11.5px] font-semibold" style={{ color: TEXT, ...km() }}>
                    {checking
                      ? "កំពុងពិនិត្យការទូទាត់… · Checking payment…"
                      : "កំពុងរង់ចាំការទូទាត់ · Waiting for payment"}
                  </span>
                </div>

                {/* Security badge */}
                <div className="flex items-center justify-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" style={{ color: SAPPHIRE }} />
                  <span className="text-[10.5px] font-medium" style={{ color: MUTED, ...km() }}>
                    CamRapidPay KHQR · ការផ្ទៀងផ្ទាត់ស្វ័យប្រវត្តិ
                  </span>
                </div>

                {/* I've paid button */}
                <button
                  onClick={manualCheck}
                  disabled={checking}
                  className="w-full rounded-2xl py-3 font-bold text-[13px] transition-all"
                  style={{
                    background: checking ? "rgba(255,255,255,0.04)" : SURFACE,
                    border: `1px solid ${BORDER}`,
                    color: checking ? MUTED : TEXT,
                    cursor: checking ? "not-allowed" : "pointer",
                  }}
                  data-testid="tuition-ive-paid-btn"
                >
                  {checking
                    ? <span className="flex items-center justify-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" /> <span style={km()}>កំពុងពិនិត្យ…</span>
                      </span>
                    : <span className="flex items-center justify-center gap-2">
                        <Smartphone className="h-4 w-4" /> <span style={km()}>ខ្ញុំបានបង់ប្រាក់រួចរាល់</span>
                      </span>}
                </button>
              </div>
            )}

            {/* ── Payment confirmed — success reveal ── */}
            {phase === "done" && (
              <div className="flex flex-col items-center py-6 gap-3" data-testid="tuition-done">
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", damping: 16 }}
                  className="h-16 w-16 rounded-full flex items-center justify-center"
                  style={{ background: "rgba(79,70,229,0.15)", border: `2px solid ${SAPPHIRE}` }}
                >
                  <CheckCircle2 className="h-8 w-8" style={{ color: SAPPHIRE }} />
                </motion.div>
                <p className="text-[15px] font-bold" style={{ color: TEXT, ...km() }}>
                  ការបង់ប្រាក់ជោគជ័យ!
                </p>
                <div className="min-h-[36px] flex flex-col items-center gap-1" data-testid="tuition-success-steps">
                  {SUCCESS_STEPS.slice(0, successStep).map((step) => (
                    <motion.p
                      key={step.en}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="text-[11.5px]"
                      style={{ color: MUTED, ...km() }}
                    >
                      {step.km} · {step.en}
                    </motion.p>
                  ))}
                </div>
              </div>
            )}

            {/* ── Expired ── */}
            {phase === "expired" && (
              <div className="space-y-4">
                <div className="flex flex-col items-center py-4 gap-3">
                  <AlertTriangle className="h-8 w-8" style={{ color: "#f59e0b" }} />
                  <p className="text-[13px] font-bold" style={{ color: TEXT, ...km() }}>
                    QR code បានផុតកំណត់
                  </p>
                  <p className="text-[11.5px] text-center" style={{ color: MUTED, ...km() }}>
                    ការទូទាត់បានលើសកំណត់ពេលវេលា។ សូមសាកល្បងម្តងទៀត។
                  </p>
                </div>
                <button
                  onClick={() => { setPhase("idle"); setIntent(null); setTimeLeft(null); setWasResumed(false); }}
                  className="w-full rounded-2xl py-3 font-bold text-[13px] text-white"
                  style={{ background: GRAD }}
                  data-testid="tuition-generate-new-btn"
                >
                  <span className="flex items-center justify-center gap-2">
                    <RefreshCw className="h-4 w-4" />
                    <span style={km()}>ព្យាយាមម្តងទៀត</span>
                  </span>
                </button>
              </div>
            )}

            {/* ── Error ── */}
            {phase === "error" && (
              <div className="space-y-4">
                <div className="flex flex-col items-center py-4 gap-3">
                  <AlertTriangle className="h-8 w-8" style={{ color: "#ef4444" }} />
                  <p className="text-[13px] font-bold" style={{ color: TEXT }}>
                    មានបញ្ហាបច្ចេកទេស
                  </p>
                  <p className="text-[11px] text-center rounded-xl px-3 py-2"
                     style={{ color: "#fca5a5", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
                    {errorMsg || "Payment provider unavailable"}
                  </p>
                </div>
                <button
                  onClick={() => { setPhase("idle"); setErrorMsg(""); }}
                  className="w-full rounded-2xl py-3 font-bold text-[13px] text-white"
                  style={{ background: GRAD }}
                >
                  <span style={km()}>ព្យាយាមម្តងទៀត</span>
                </button>
              </div>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
