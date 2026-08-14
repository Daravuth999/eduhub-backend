// @ts-nocheck
/**
 * TuitionStrip.tsx — Tuition Membership Card (premium)
 *
 * Consolidated tuition surface for the student portal. Replaces the
 * TuitionStrip + LearningAccessSection pair that produced duplicate UI.
 *
 * Features:
 *   - Animated sapphire→violet gradient border (prefers-reduced-motion safe)
 *   - Moving light sweep + orbit gold particles around card icon
 *   - Fetches live tuition data from /api/student/tuition (Mongo-backed)
 *   - Falls back to student prop when Mongo data unavailable
 *   - CTA driven entirely by backend payment_action field (never date math)
 *   - Full CTA state matrix: pay_now | pay_early | resume_payment |
 *     under_review | unavailable | disabled
 *   - Safety net: undefined paymentAction + overdue → shows Pay Tuition
 *     (backend validates at intent-creation; this prevents silent CTA drop)
 *   - NaN-safe date parsing (invalid/missing dates → "Payment date unavailable")
 *   - Unacknowledged receipt reopens automatically on portal mount
 *   - Billing anchor day displayed on card
 *   - Dark/light adaptive via portal CSS vars (var(--color-surface) etc.)
 *   - Champagne-gold CTA edge highlight; soft pulse when overdue
 *   - Receipt history via GET /api/student/tuition/receipts
 *   - No duplicate TuitionCountdown/PaymentBanner strip
 *   - No student-facing implementation labels
 */

import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  GraduationCap, CreditCard, Clock4, CheckCircle2, AlertTriangle,
  RefreshCw, ChevronRight, Star, Calendar, Banknote,
} from "lucide-react";
import type { StudentData } from "../../types";
import { useLang } from "../../contexts/LanguageContext";
import { consumeTuitionReceipt } from "./TuitionPaymentModal";

const TuitionPaymentModal   = lazy(() => import("./TuitionPaymentModal"));
const TuitionReceiptOverlay = lazy(() => import("./TuitionReceiptOverlay"));
const TuitionReceiptHistory = lazy(() => import("./TuitionReceiptHistory"));

// ── Design tokens (sapphire/violet — distinct from green TopUp palette) ──────
const SAPPHIRE    = "#4f46e5";
const VIOLET      = "#7c3aed";
const GOLD        = "#d97706";
const GRAD        = `linear-gradient(135deg, ${SAPPHIRE} 0%, ${VIOLET} 100%)`;
const CTA_SHADOW  = `0 8px 24px rgba(79,70,229,0.35)`;
const CTA_GOLD_EDGE = `inset 0 1px 0 rgba(253,230,138,0.30)`;

const KM_FONT = "'Noto Sans Khmer','Kantumruy Pro','Khmer OS',system-ui,sans-serif";
const BACKEND = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");

function authHeaders(): Record<string, string> {
  try {
    const t = localStorage.getItem("student_session_token");
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
}

async function fetchTuitionStatus(): Promise<MongoTuition | null> {
  const res = await fetch(`${BACKEND}/api/student/tuition`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders() },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function fetchReceiptById(id: string): Promise<object | null> {
  try {
    const res = await fetch(
      `${BACKEND}/api/student/tuition/receipt/${encodeURIComponent(id)}`,
      { credentials: "include", headers: { ...authHeaders() } }
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.ok ? data : null;
  } catch { return null; }
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface MongoTuition {
  ok: boolean;
  gas_only?: boolean;
  tuition_status?: string;
  next_due_date?: string;
  last_payment_date?: string;
  payment_amount?: number;
  data_source?: string;
  feature_enabled?: boolean;
  reward_points?: number;
  billing_anchor_day?: number;
  // Backend-authoritative eligibility contract (present when Mongo is live):
  payment_action?: string; // pay_now|pay_early|resume_payment|under_review|unavailable|disabled
  payment_block_reason?: string | null;
  can_pay?: boolean;
  can_pay_ahead?: boolean;
  active_intent?: {
    intent_id?: string;
    status?: string;
    amount_usd?: number;
    amount_khr?: number;
    expires_at?: string;
  } | null;
}

interface Props { student: StudentData; }

// ── Orbit particle positions ───────────────────────────────────────────────────
const ORBIT = [
  { style: { top: -3, left: 6  }, color: GOLD,     delay: 0    },
  { style: { top: -4, left: 26 }, color: "#a78bfa", delay: 0.4 },
  { style: { top: 2,  left: -2 }, color: "#818cf8", delay: 0.8 },
];

// ── Date helpers (NaN-safe) ────────────────────────────────────────────────────
function parseTuitionDate(dateStr?: string): Date | null {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr.trim().replace(/\./g, "-").replace(/\//g, "-"));
    if (isNaN(d.getTime())) return null;
    return d;
  } catch { return null; }
}

function daysUntilDate(dateStr?: string): number | null {
  const due = parseTuitionDate(dateStr);
  if (!due) return null;
  const now = new Date();
  due.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - now.getTime()) / 86_400_000);
}

function formatDueDate(dateStr?: string): string {
  if (!dateStr) return "";
  const d = parseTuitionDate(dateStr);
  if (!d) return "Payment date unavailable";
  try {
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  } catch { return dateStr; }
}

function parseDayOfMonth(dateStr?: string): number | null {
  if (!dateStr) return null;
  const m = dateStr.match(/\d{4}[.\-\/](\d{2})[.\-\/](\d{2})/);
  return m ? parseInt(m[2], 10) : null;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ── Main component ────────────────────────────────────────────────────────────
export function TuitionStrip({ student }: Props) {
  const { lang } = useLang();
  const isEn    = lang !== "km";
  const reduce  = useReducedMotion() ?? false;

  const [mongo, setMongo]         = useState<MongoTuition | null>(null);
  const [loading, setLoading]     = useState(true);
  const [payOpen, setPayOpen]     = useState(false);
  const [receipt, setReceipt]     = useState<object | null>(null);
  const [historyOpen, setHistory] = useState(false);

  // On mount: restore pending receipt from sessionStorage, check unacknowledged,
  // and handle ?tuition=pay / ?tuition=receipt deep-links.
  useEffect(() => {
    const pendingId = consumeTuitionReceipt();
    if (pendingId) {
      fetchReceiptById(pendingId).then((r) => { if (r) setReceipt(r); });
    } else {
      (async () => {
        try {
          const res = await fetch(`${BACKEND}/api/student/tuition/unacknowledged`, {
            credentials: "include",
            headers: { ...authHeaders() },
          });
          if (!res.ok) return;
          const data = await res.json().catch(() => null);
          const rid = data?.pending?.receipt_id;
          if (rid) {
            const r = await fetchReceiptById(rid);
            if (r) setReceipt(r);
          }
        } catch { /* best-effort */ }
      })();
    }

    const params = new URLSearchParams(window.location.search);
    const tuitionParam = params.get("tuition");
    if (tuitionParam === "pay") {
      setPayOpen(true);
      const clean = new URL(window.location.href);
      clean.searchParams.delete("tuition");
      window.history.replaceState(null, "", clean.toString());
    } else if (tuitionParam === "receipt") {
      const rid = params.get("rid");
      if (rid) {
        fetchReceiptById(rid).then((r) => { if (r) setReceipt(r); });
        const clean = new URL(window.location.href);
        clean.searchParams.delete("tuition");
        clean.searchParams.delete("rid");
        window.history.replaceState(null, "", clean.toString());
      }
    }
  }, []);

  const loadMongo = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchTuitionStatus();
      setMongo(data?.ok ? data : null);
    } catch { setMongo(null); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadMongo(); }, [loadMongo]);

  // ── Merged state: prefer Mongo when available, fall back to student prop
  const tuitionStatus = mongo?.tuition_status  ?? student.TuitionStatus;
  const nextDueDate   = mongo?.next_due_date    ?? student.NextDueDate;
  const paymentAmount = mongo?.payment_amount   ?? student.PaymentAmount;
  const rewardPoints  = mongo?.reward_points;
  const billingDay    = mongo?.billing_anchor_day ?? parseDayOfMonth(nextDueDate);
  const days          = daysUntilDate(nextDueDate);

  const rawStatus = (tuitionStatus || "").toLowerCase();
  const isPaid    = rawStatus === "paid";

  // Display-only derived state — NEVER used to authorize payment creation.
  // The backend payment_action field is the sole authorization gate.
  const isOverdue = days !== null && days < 0;
  const isSoon    = !isPaid && days !== null && days >= 0 && days <= 7;
  const isToday   = !isPaid && days === 0;

  // ── Payment eligibility — backend-authoritative ────────────────────────────
  // payment_action from GET /api/student/tuition drives every CTA decision.
  // Client date math must not override or substitute for this field
  // except as a last-resort safety net when the backend is unreachable.
  const paymentAction  = mongo?.payment_action;
  const featureEnabled = mongo?.feature_enabled !== false;

  const canPay           = paymentAction === "pay_now";
  const canPayAhead      = paymentAction === "pay_early";
  const hasPendingIntent = paymentAction === "resume_payment";
  const isManualReview   = paymentAction === "under_review";

  // ── Status badge (display only) ────────────────────────────────────────────
  function getStatusConfig() {
    if (canPay && isOverdue)
      return { label: isEn ? "Overdue" : "ហួសកំណត់",  color: "#dc2626", bg: "rgba(220,38,38,0.12)",  icon: <AlertTriangle className="h-3 w-3" /> };
    if (isPaid && !isOverdue)
      return { label: isEn ? "Paid" : "បានបង់",         color: "#16a34a", bg: "rgba(22,163,74,0.12)",   icon: <CheckCircle2  className="h-3 w-3" /> };
    if (isSoon || isToday)
      return { label: isEn ? "Due Soon" : "ជិតផុត",    color: "#d97706", bg: "rgba(217,119,6,0.12)",  icon: <AlertTriangle className="h-3 w-3" /> };
    if (isOverdue)
      return { label: isEn ? "Overdue" : "ហួសកំណត់",  color: "#dc2626", bg: "rgba(220,38,38,0.12)",  icon: <AlertTriangle className="h-3 w-3" /> };
    return   { label: isEn ? "Unpaid"   : "មិនទាន់បង់", color: "#d97706", bg: "rgba(217,119,6,0.12)",  icon: <AlertTriangle className="h-3 w-3" /> };
  }

  const statusCfg = getStatusConfig();

  // ── Day label (display wording only — never drives payment authorization) ──
  function dayLabel(): string {
    if (days === null) return isEn ? "Payment date unavailable" : "ថ្ងៃបង់ប្រាក់មិនច្បាស់";
    const abs = Math.abs(days);
    const d   = abs === 1 ? "day" : "days";
    if (isPaid && days < 0)
      return isEn ? `${abs} ${d} overdue — new billing cycle` : `ហួស ${abs} ថ្ងៃ — វដ្តថ្មី`;
    if (days < 0)
      return isEn ? `${abs} ${d} overdue` : `ហួស ${abs} ថ្ងៃ`;
    if (days === 0)
      return isEn ? "Due today" : "ផុតកំណត់ថ្ងៃនេះ";
    return isEn ? `${days} ${d} remaining` : `នៅ ${days} ថ្ងៃ`;
  }

  const countdownColor = isOverdue ? "#dc2626" : (isSoon || isToday) ? "#d97706" : "var(--color-ink-mute)";

  // ── CTA renderer — driven solely by backend payment_action ──────────────
  function renderCTA() {
    if (!featureEnabled) return null;

    // disabled: global or per-student feature off
    if (paymentAction === "disabled") {
      return (
        <div
          className="w-full rounded-2xl px-4 py-3 text-center text-[12px]"
          style={{ background: "rgba(100,116,139,0.06)", color: "var(--color-ink-mute)", fontFamily: KM_FONT }}
          data-testid="tuition-disabled-notice"
        >
          {isEn ? "Tuition payment is currently unavailable" : "ការបង់ថ្លៃសិក្សាមិនមានសម្រាប់ពេលនេះ"}
        </div>
      );
    }

    // under_review: manual review in progress — no new intent
    if (paymentAction === "under_review") {
      return (
        <div
          className="w-full rounded-2xl px-4 py-3 text-center text-[13px] font-semibold"
          style={{ background: "rgba(217,119,6,0.08)", color: GOLD, fontFamily: KM_FONT }}
          data-testid="tuition-manual-review-notice"
        >
          {isEn ? "Payment under review" : "កំពុងត្រួតពិនិត្យការបង់ប្រាក់"}
        </div>
      );
    }

    // resume_payment: active pending/verifying intent — resume it
    if (paymentAction === "resume_payment") {
      return (
        <motion.button
          whileHover={reduce ? {} : { boxShadow: `0 0 32px rgba(124,58,237,0.55)` }}
          whileTap={{ scale: 0.97 }}
          className="w-full rounded-2xl text-[13px] font-bold text-white"
          style={{
            background: GRAD, minHeight: 48, fontFamily: KM_FONT,
            boxShadow: `${CTA_SHADOW}, ${CTA_GOLD_EDGE}`,
          }}
          onClick={() => setPayOpen(true)}
          data-testid="tuition-resume-payment-btn"
        >
          {isEn ? "Resume Payment · បន្តការបង់ប្រាក់" : "បន្តការបង់ប្រាក់"}
        </motion.button>
      );
    }

    // pay_now: overdue, unpaid, or paid+cycle-expired (new cycle open)
    if (paymentAction === "pay_now") {
      return (
        <motion.button
          whileHover={reduce ? {} : { boxShadow: `0 0 32px rgba(79,70,229,0.6)` }}
          whileTap={{ scale: 0.97 }}
          animate={reduce || !isOverdue ? {} : {
            boxShadow: [
              `${CTA_SHADOW}, ${CTA_GOLD_EDGE}`,
              `0 8px 28px rgba(220,38,38,0.28), 0 0 0 4px rgba(220,38,38,0.10), ${CTA_GOLD_EDGE}`,
              `${CTA_SHADOW}, ${CTA_GOLD_EDGE}`,
            ],
          }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
          className="w-full rounded-2xl text-[13px] font-bold text-white"
          style={{
            background: GRAD, minHeight: 48, fontFamily: KM_FONT,
            boxShadow: `${CTA_SHADOW}, ${CTA_GOLD_EDGE}`,
          }}
          onClick={() => setPayOpen(true)}
          data-testid="tuition-pay-btn"
        >
          {isEn ? "បង់ថ្លៃសិក្សា · Pay Tuition" : "បង់ថ្លៃសិក្សា"}
        </motion.button>
      );
    }

    // pay_early: paid current cycle, advance payment enabled
    if (paymentAction === "pay_early") {
      return (
        <motion.button
          whileHover={reduce ? {} : { boxShadow: `0 0 32px rgba(124,58,237,0.5)` }}
          whileTap={{ scale: 0.97 }}
          className="w-full rounded-2xl text-[13px] font-bold text-white"
          style={{
            background: `linear-gradient(135deg, ${VIOLET} 0%, ${SAPPHIRE} 100%)`,
            minHeight: 48,
            fontFamily: KM_FONT,
            boxShadow: `0 8px 24px rgba(124,58,237,0.3), ${CTA_GOLD_EDGE}`,
          }}
          onClick={() => setPayOpen(true)}
          data-testid="tuition-pay-ahead-btn"
        >
          {isEn ? "Pay Next Month Early" : "បង់ជាមុនសម្រាប់ខែក្រោយ"}
        </motion.button>
      );
    }

    // unavailable: paid current cycle, no advance payment enabled
    if (paymentAction === "unavailable") {
      return (
        <div
          className="w-full rounded-2xl px-4 py-3 text-center text-[12px]"
          style={{ background: "rgba(22,163,74,0.06)", color: "#16a34a", fontFamily: KM_FONT }}
          data-testid="tuition-paid-notice"
        >
          {nextDueDate
            ? (isEn
              ? `Paid for this cycle · Next payment from ${formatDueDate(nextDueDate)}`
              : `ការបង់ប្រាក់ចាប់ផ្ដើម ${formatDueDate(nextDueDate)}`)
            : (isEn ? "Tuition paid for this cycle" : "បានបង់ថ្លៃសិក្សារួចរាល់")}
        </div>
      );
    }

    // paymentAction is undefined/null — backend unreachable or state unknown.
    // Safety net: show Pay Tuition for overdue students so the action is never
    // silently hidden. The backend revalidates everything at intent creation.
    if (isOverdue) {
      return (
        <motion.button
          whileHover={reduce ? {} : { boxShadow: `0 0 32px rgba(79,70,229,0.6)` }}
          whileTap={{ scale: 0.97 }}
          className="w-full rounded-2xl text-[13px] font-bold text-white"
          style={{
            background: GRAD, minHeight: 48, fontFamily: KM_FONT,
            boxShadow: `${CTA_SHADOW}, ${CTA_GOLD_EDGE}`,
          }}
          onClick={() => setPayOpen(true)}
          data-testid="tuition-pay-btn"
        >
          {isEn ? "បង់ថ្លៃសិក្សា · Pay Tuition" : "បង់ថ្លៃសិក្សា"}
        </motion.button>
      );
    }

    // Unknown non-overdue state — offer a refresh
    return (
      <button
        onClick={loadMongo}
        className="w-full flex items-center justify-center gap-1.5 rounded-2xl text-[12px] font-semibold"
        style={{
          background: "rgba(79,70,229,0.06)",
          border: "1px solid rgba(79,70,229,0.12)",
          minHeight: 48,
          color: SAPPHIRE,
          fontFamily: KM_FONT,
        }}
        data-testid="tuition-retry-btn"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        {isEn ? "Refresh payment status" : "ធ្វើបច្ចុប្បន្នភាព"}
      </button>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <section data-testid="portal-tuition-strip">
      {/* ── Header eyebrow ──────────────────────────────────────────────── */}
      <header className="mb-3 flex items-center gap-2">
        <span className="aurora-icon-badge h-6 w-6" data-accent="indigo" aria-hidden>
          <GraduationCap className="h-3.5 w-3.5" />
        </span>
        <h2 className="lumio-eyebrow">
          {isEn ? "Tuition" : "ថ្លៃសិក្សា"}
        </h2>
      </header>

      {/* ── Animated gradient border wrapper ── */}
      <div style={{ position: "relative", padding: "1.5px", borderRadius: 20 }}>
        {/* Animated border layer */}
        <motion.div
          aria-hidden
          animate={reduce ? {} : {
            backgroundPosition: ["0% 50%", "100% 50%", "0% 50%"],
          }}
          transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 20,
            background: `linear-gradient(270deg, ${SAPPHIRE}, ${VIOLET}, #c4b5fd, #818cf8, ${SAPPHIRE})`,
            backgroundSize: "300% 300%",
            opacity: reduce ? 0.45 : 0.9,
          }}
        />

        {/* ── Membership Card ──────────────────────────────────────────── */}
        <div
          className="overflow-hidden"
          style={{
            position: "relative",
            borderRadius: 18,
            background: "var(--color-surface)",
            colorScheme: "light dark",
          }}
          data-testid="tuition-membership-card"
        >
          {/* Light sweep */}
          {!reduce && (
            <motion.div
              aria-hidden
              animate={{ x: ["-110%", "200%"] }}
              transition={{ duration: 3.8, repeat: Infinity, repeatDelay: 5, ease: "easeInOut" }}
              style={{
                position: "absolute",
                top: 0, bottom: 0, width: "28%",
                transform: "skewX(-16deg)",
                background: "linear-gradient(90deg, transparent, rgba(79,70,229,0.07), transparent)",
                pointerEvents: "none",
                zIndex: 0,
              }}
            />
          )}

          {/* Card header row */}
          <div
            className="px-4 pt-4 pb-3 flex items-center gap-3"
            style={{ borderBottom: "1px solid var(--color-line)", position: "relative", zIndex: 1 }}
          >
            {/* Icon badge with orbit particles */}
            <div style={{ position: "relative", flexShrink: 0 }}>
              <div
                className="h-10 w-10 rounded-xl flex items-center justify-center"
                style={{ background: GRAD, boxShadow: `0 4px 14px rgba(79,70,229,0.35)` }}
              >
                <CreditCard style={{ height: 18, width: 18, color: "#fff" }} />
              </div>
              {!reduce && ORBIT.map((o, i) => (
                <motion.span
                  key={i}
                  aria-hidden
                  animate={{ scale: [0.65, 1.25, 0.65], opacity: [0.45, 1, 0.45] }}
                  transition={{ duration: 2.4, repeat: Infinity, delay: o.delay, ease: "easeInOut" }}
                  style={{
                    position: "absolute",
                    width: 6, height: 6,
                    borderRadius: "50%",
                    background: o.color,
                    boxShadow: `0 0 8px ${o.color}`,
                    pointerEvents: "none",
                    ...o.style,
                  }}
                />
              ))}
            </div>

            <div className="flex-1 min-w-0">
              <p
                className="text-[13px] font-bold leading-tight"
                style={{ color: "var(--color-ink)", fontFamily: KM_FONT }}
              >
                {isEn ? "Tuition Membership" : "សមាជិកភាពសិក្សា"}
              </p>
              <p
                className="text-[11px] mt-0.5"
                style={{ color: "var(--color-ink-soft)", fontFamily: KM_FONT }}
              >
                {isEn ? "Monthly learning membership" : "សមាជិកភាពសិក្សាប្រចាំខែ"}
              </p>
            </div>

            {/* Status badge */}
            <AnimatePresence mode="wait">
              <motion.span
                key={statusCfg.label}
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85 }}
                transition={{ duration: 0.2 }}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold shrink-0"
                style={{ background: statusCfg.bg, color: statusCfg.color, fontFamily: KM_FONT }}
                data-testid="tuition-status-badge"
              >
                {statusCfg.icon}
                {statusCfg.label}
              </motion.span>
            </AnimatePresence>
          </div>

          {/* Card body */}
          <div className="px-4 py-4 space-y-3" style={{ position: "relative", zIndex: 1 }}>

            {/* Monthly tuition amount */}
            {paymentAmount != null && (
              <div className="flex items-baseline gap-1.5">
                <Banknote className="h-4 w-4 shrink-0" style={{ color: SAPPHIRE, marginTop: 2 }} />
                <span
                  className="text-[22px] font-extrabold leading-none"
                  style={{ color: "var(--color-ink)" }}
                >
                  ${Number(paymentAmount).toFixed(2)}
                </span>
                <span
                  className="text-[12px] font-normal"
                  style={{ color: "var(--color-ink-soft)" }}
                >
                  {isEn ? "/ month" : "/ ខែ"}
                </span>
              </div>
            )}

            {/* Due date + day countdown */}
            <div className="space-y-1">
              {nextDueDate && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Clock4 className="h-3.5 w-3.5 shrink-0" style={{ color: SAPPHIRE }} />
                  <span
                    className="text-[12px]"
                    style={{ color: "var(--color-ink-soft)", fontFamily: KM_FONT }}
                  >
                    {isEn ? "Next scheduled payment:" : "ថ្ងៃបង់ប្រាក់បន្ទាប់:"}
                  </span>
                  <span
                    className="text-[12px] font-semibold"
                    style={{ color: "var(--color-ink)" }}
                  >
                    {formatDueDate(nextDueDate)}
                  </span>
                </div>
              )}
              {loading ? (
                <div className="flex items-center gap-1.5">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" style={{ color: SAPPHIRE }} />
                  <span className="text-[11px]" style={{ color: "var(--color-ink-soft)" }}>
                    {isEn ? "Loading…" : "កំពុងទាញ…"}
                  </span>
                </div>
              ) : (
                <p
                  className="text-[12px] font-semibold"
                  style={{
                    color: days === null ? "var(--color-ink-mute)" : countdownColor,
                    fontFamily: KM_FONT,
                  }}
                  data-testid="tuition-day-label"
                >
                  {dayLabel()}
                </p>
              )}
            </div>

            {/* Billing anchor day */}
            {billingDay != null && (
              <div className="flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5 shrink-0" style={{ color: SAPPHIRE }} />
                <span className="text-[12px]" style={{ color: "var(--color-ink-soft)", fontFamily: KM_FONT }}>
                  {isEn
                    ? `Billing day: ${ordinal(billingDay)} of each month`
                    : `ថ្ងៃ${billingDay} នៃគ្រប់ខែ`}
                </span>
              </div>
            )}

            {/* On-time appreciation reward preview */}
            {rewardPoints != null && rewardPoints > 0 && (
              <div
                className="flex items-center gap-1.5 rounded-xl px-3 py-2"
                style={{ background: "rgba(217,119,6,0.07)", border: "1px solid rgba(217,119,6,0.18)" }}
                data-testid="tuition-reward-preview"
              >
                <Star className="h-3.5 w-3.5 shrink-0" style={{ color: GOLD }} />
                <p
                  className="text-[11.5px] font-semibold"
                  style={{ color: GOLD, fontFamily: KM_FONT }}
                >
                  {isEn
                    ? `Pay on time and earn +${rewardPoints} points`
                    : `បង់ទាន់ពេល ទទួល +${rewardPoints} ពិន្ទុ`}
                </p>
              </div>
            )}

            {/* Primary CTA */}
            {loading ? (
              <div
                className="w-full rounded-2xl flex items-center justify-center"
                style={{ background: "rgba(79,70,229,0.06)", minHeight: 48 }}
              >
                <RefreshCw className="h-4 w-4 animate-spin" style={{ color: SAPPHIRE }} />
              </div>
            ) : renderCTA()}

            {/* Secondary: View Receipts */}
            <button
              onClick={() => setHistory(true)}
              className="w-full flex items-center justify-center gap-1.5 rounded-xl text-[12px] font-semibold"
              style={{
                color: SAPPHIRE,
                background: "rgba(79,70,229,0.05)",
                border: "1px solid rgba(79,70,229,0.12)",
                minHeight: 40,
                fontFamily: KM_FONT,
              }}
              data-testid="tuition-view-receipts-btn"
            >
              {isEn ? "View Receipts" : "មើលបង្កាន់ដៃ"}
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* ── KHQR Payment Modal ──────────────────────────────────────────── */}
      {payOpen && (
        <Suspense fallback={null}>
          <TuitionPaymentModal
            studentId={student.StudentID}
            studentName={student.Name}
            currentNdd={nextDueDate}
            paymentAmount={paymentAmount}
            activeIntent={mongo?.active_intent}
            onClose={() => setPayOpen(false)}
            onConfirmed={(receiptId: string) => {
              setPayOpen(false);
              fetchReceiptById(receiptId).then((r) => { if (r) setReceipt(r); });
              loadMongo();
            }}
          />
        </Suspense>
      )}

      {/* ── Receipt History Panel ───────────────────────────────────────── */}
      {historyOpen && (
        <Suspense fallback={null}>
          <TuitionReceiptHistory
            onClose={() => setHistory(false)}
            onSelectReceipt={(receiptId: string) => {
              setHistory(false);
              fetchReceiptById(receiptId).then((r) => { if (r) setReceipt(r); });
            }}
          />
        </Suspense>
      )}

      {/* ── Receipt Overlay ─────────────────────────────────────────────── */}
      {receipt && (
        <Suspense fallback={null}>
          <TuitionReceiptOverlay
            receipt={receipt}
            onClose={() => setReceipt(null)}
          />
        </Suspense>
      )}
    </section>
  );
}
