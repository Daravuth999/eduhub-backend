/**
 * TuitionReminderStudio.jsx — Smart Tuition Fee Push Notification Reminder
 *
 * v10.2 (2026-05) — Author Studio tab for sending Khmer/English bilingual
 * tuition fee reminders to students based on their NextDueDate from GAS.
 *
 * Architecture decisions (after full audit):
 *
 *   SOURCE OF TRUTH: student.NextDueDate lives in Google Sheets, served via
 *   GAS_PORTAL_URL?action=getStudentData per student. There is no batch
 *   tuition endpoint. We fetch per student (same call the portal makes).
 *
 *   PUSH ENGINE: uses POST /api/push/send-studio with target:"students" +
 *   studentIds:[id]. This is the SAME endpoint PushStudio uses — supports
 *   custom title, body, url, stores history, returns sent/failed counts.
 *   The existing push-reminder endpoint hardcodes the title so we use
 *   send-studio to pass our Khmer titles through.
 *
 *   DUPLICATE GUARD: tracks sent IDs in sessionStorage keyed by date so
 *   teachers cannot accidentally double-send on the same day.
 *
 *   NO BACKEND CHANGES: zero new endpoints. Zero sw.js changes. Zero
 *   manifest changes. Zero AuthContext changes.
 *
 * Protected systems: all untouched. Only new file + StudioPage.jsx wiring.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock, Send, RefreshCw, CheckCircle2, XCircle,
  AlertTriangle, Loader2, ChevronDown, ChevronUp, Bell,
  Filter, Users, Hourglass, Ban, UserX, Search,
  CreditCard, MinusCircle, PlusCircle, CalendarRange,
  Database, Receipt, BarChart3,
} from "lucide-react";
import { listStudents, deactivateStudent } from "../eduhub/auth/studentAuthService";
import { getToken } from "./api";
import {
  getTuitionAccounts, updateTuitionAccount,
  getTuitionConfig, saveTuitionConfig,
  getReminderConfig, saveReminderConfig,
  recordManualPayment,
  getTuitionDashboard, getTuitionReceipts, getMigrationStatus,
  runMigrationDryRun, runMigrationImport, runTuitionCutover,
} from "./tuitionAdminApi";

/* ── constants ────────────────────────────────────────────────────────────── */
const BASE = process.env.REACT_APP_BACKEND_URL || "";

// GAS portal URL — same as portal/lib/api.ts SCRIPT_URL
const GAS_PORTAL_URL =
  "https://script.google.com/macros/s/AKfycbw_hGdyYmWukTCzaZoxuKMv34mYpQMXd7JtSFzpMpRjGd947eM70u-a1xTUJYA894FwAQ/exec";

// Timezone label for display — data is fetched as-is from GAS
const TZ_LABEL = "Asia/Phnom_Penh";

// SessionStorage key for duplicate-send guard (keyed by date string)
const SENT_KEY_PREFIX = "tuition_sent_";

/* ── design tokens (match existing Studio palette exactly) ────────────────── */
const css = {
  bg:           "#0a0a0f",
  card:         "rgba(255,255,255,0.04)",
  border:       "rgba(255,255,255,0.08)",
  borderFocus:  "rgba(212,168,67,0.45)",
  text:         "#F4E5C1",
  textMuted:    "rgba(244,229,193,0.55)",
  aurora:       "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
  red:          "#ef4444",
  green:        "#86efac",
  amber:        "#fbbf24",
};

const inputStyle = {
  background: "rgba(255,255,255,0.03)",
  border: `1px solid ${css.border}`,
  color: css.text,
  outline: "none",
};

/* ── Khmer numeral + date helpers ────────────────────────────────────────── */

const KHMER_DIGITS = { "0":"០","1":"១","2":"២","3":"៣","4":"៤","5":"៥","6":"៦","7":"៧","8":"៨","9":"៩" };

function toKhmerNumber(value) {
  return String(value).replace(/[0-9]/g, d => KHMER_DIGITS[d] || d);
}

const KH_DAYS   = ["អាទិត្យ","ចន្ទ","អង្គារ","ពុធ","ព្រហស្បតិ៍","សុក្រ","សៅរ៍"];
const KH_MONTHS = ["មករា","កុម្ភៈ","មីនា","មេសា","ឧសភា","មិថុនា","កក្កដា","សីហា","កញ្ញា","តុលា","វិច្ឆិកា","ធ្នូ"];

/**
 * formatDateKhmer — converts a Date object to full Khmer date string.
 * Returns null (never a fallback string) if the date is invalid.
 * Example: ថ្ងៃ ព្រហស្បតិ៍ ទី២១ ខែឧសភា ឆ្នាំ២០២៦
 */
function formatDateKhmer(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return null;
  return `ថ្ងៃ ${KH_DAYS[date.getDay()]} ទី${toKhmerNumber(date.getDate())} ខែ${KH_MONTHS[date.getMonth()]} ឆ្នាំ${toKhmerNumber(date.getFullYear())}`;
}

/**
 * calcOverdueDays — returns integer days between dueDate and today.
 * Both dates normalized to midnight (start-of-day) to avoid hour offsets.
 * Returns null if dueDate is not a valid Date.
 */
function calcOverdueDays(dueDate) {
  if (!(dueDate instanceof Date) || isNaN(dueDate.getTime())) return null;
  const today = new Date(); const due = dueDate;
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dueDay   = new Date(due.getFullYear(),   due.getMonth(),   due.getDate());
  return Math.floor((todayDay - dueDay) / (1000 * 60 * 60 * 24));
}

/* ── tuition push message templates ─────────────────────────────────────── */

/** Reminder messages (Send button) — uses full Khmer date. */
/**
 * buildReminderMessage — builds a Khmer reminder push from a real Date object.
 * Returns null if dueDateObj is not a valid Date — caller must skip that student.
 * No fallback body, no placeholder date, no generic message.
 */
function buildReminderMessage(dueDateObj, isToday) {
  if (!(dueDateObj instanceof Date) || isNaN(dueDateObj.getTime())) return null;
  const khmerDate = formatDateKhmer(dueDateObj); // always non-null for a valid Date
  if (isToday) {
    return {
      title: "បង់ថ្លៃសិក្សាថ្ងៃនេះ",
      body: "ការបង់ថ្លៃសិក្សារបស់អ្នកដល់ថ្ងៃកំណត់នៅថ្ងៃនេះ! សូមបង់ប្រាក់នៅថ្ងៃនេះ ដើម្បីបន្តប្រើគណនីសិក្សារបស់អ្នកដោយមិនមានការរំខាន។",
      actionText: "បង់ប្រាក់",
      url: "/portal",
    };
  }
  return {
    title: "រំលឹកបង់ប្រាក់",
    body: `ថ្លៃសិក្សារបស់អ្នកនឹងដល់ថ្ងៃកំណត់នៅ${khmerDate}។ សូមត្រៀមបង់ប្រាក់មុនថ្ងៃកំណត់ ដើម្បីរក្សាសិទ្ធិចូលរៀនរបស់អ្នក។`,
    actionText: "បង់ប្រាក់",
    url: "/portal",
  };
}

// Keep buildMessages as a thin wrapper for the preview panel only (no push path uses it)
function buildMessages(dueDateObj) {
  return {
    beforeDue: buildReminderMessage(dueDateObj, false) || { title: "រំលឹកបង់ប្រាក់", body: "—", url: "/portal" },
    dueToday:  buildReminderMessage(dueDateObj, true)  || { title: "បង់ថ្លៃសិក្សាថ្ងៃនេះ", body: "—", url: "/portal" },
  };
}

/**
 * buildRestrictionMessage — Khmer restriction push sent when teacher clicks
 * Deactivate in the Tuition dashboard.
 *
 * STRICT DATA RULES (per prompt):
 *   • Never uses fallback dates, mock data, or hardcoded values.
 *   • If dueDate is missing/invalid → returns null (caller must skip push).
 *   • overdueDays === 0  → due-today restriction message.
 *   • overdueDays > 0   → overdue restriction message with Khmer numeral count.
 *   • overdueDays < 0   → student restricted before due date — no overdue message.
 *
 * @param {Date|null} dueDateObj — parsed Date from student.NextDueDate
 * @returns {{ title: string, body: string, url: string } | null}
 */
function buildRestrictionMessage(dueDateObj) {
  if (!(dueDateObj instanceof Date) || isNaN(dueDateObj.getTime())) {
    // Missing or invalid tuition date — do not send misleading notification
    console.warn("[TuitionRestriction] Invalid or missing due date — push skipped.");
    return null;
  }

  const overdueDays = calcOverdueDays(dueDateObj);
  const khmerToday  = formatDateKhmer(new Date());

  if (overdueDays === 0) {
    // Restricted exactly on the due date
    return {
      title: "គណនីត្រូវបានបង្កក",
      body:  "សូមបង់ថ្លៃសិក្សារបស់អ្នក ដើម្បីដំណើរការគណនីឡើងវិញ។",
      url:   "/portal",
    };
  }

  if (overdueDays > 0) {
    // Restricted after due date — show real overdue day count + today in Khmer
    const khmerDays = toKhmerNumber(overdueDays);
    return {
      title: "គណនីត្រូវបានបង្កក",
      body:  `សូមបង់ថ្លៃសិក្សាដែលពុំទាន់បង់ ហួសសុពលភាពចំនួន ${khmerDays} ថ្ងៃ គិតត្រឹម${khmerToday} ដើម្បីដំណើរការគណនីឡើងវិញ។`,
      url:   "/portal",
    };
  }

  // overdueDays < 0 — restricted before due date (e.g. manual action)
  // Do not invent an overdue message. No notification needed for this case.
  console.warn("[TuitionRestriction] Student restricted before due date — no overdue push sent.", { overdueDays });
  return null;
}

/* ── date helpers ────────────────────────────────────────────────────────── */

/**
 * parseDateStr — robust multi-format parser for dates coming from GAS.
 *
 * GAS Google Sheets can return dates in many formats depending on the
 * cell format and locale setting:
 *   "2026-05-21"   ISO (dashes)          ← new Date() handles this
 *   "2026.05.21"   dot-separated         ← new Date() returns Invalid Date
 *   "05/21/2026"   US slash format       ← new Date() handles this
 *   "21/05/2026"   Khmer/EU slash        ← new Date() misparses (wrong month)
 *   "May 21, 2026" long form             ← new Date() handles this
 *
 * Strategy: normalize dots to dashes, then parse. Fall back to raw
 * new Date() for any other format.
 */
function parseDateStr(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (!s) return null;

  // Handle full ISO timestamp from GAS Date serialization: "2026-05-31T17:00:00.000Z"
  // Slice to date part only, then parse as local midnight to avoid UTC shift.
  const isoFull = s.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (isoFull) {
    const d = new Date(`${isoFull[1]}-${isoFull[2]}-${isoFull[3]}T00:00:00`);
    if (!isNaN(d.getTime())) return d;
  }

  // Handle dot-separated: "2026.05.21" → "2026-05-21"
  const dotYMD = s.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (dotYMD) {
    const d = new Date(`${dotYMD[1]}-${dotYMD[2].padStart(2,"0")}-${dotYMD[3].padStart(2,"0")}T00:00:00`);
    if (!isNaN(d.getTime())) return d;
  }

  // Handle DD.MM.YYYY (day first dot-separated)
  const dotDMY = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotDMY) {
    const d = new Date(`${dotDMY[3]}-${dotDMY[2].padStart(2,"0")}-${dotDMY[1].padStart(2,"0")}T00:00:00`);
    if (!isNaN(d.getTime())) return d;
  }

  // Handle ISO with dashes: "2026-05-21"
  const dashYMD = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dashYMD) {
    const d = new Date(`${dashYMD[1]}-${dashYMD[2].padStart(2,"0")}-${dashYMD[3].padStart(2,"0")}T00:00:00`);
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}

function daysUntil(dateStr) {
  const due = parseDateStr(dateStr);
  if (!due) return null;
  const now = new Date();
  // Compare calendar days in local time (Cambodia = UTC+7, matches GAS dates)
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = dueDay - nowDay;
  return Math.round(diff / (1000 * 60 * 60 * 24));
}

function formatDueDate(dateStr) {
  const d = parseDateStr(dateStr);
  if (!d) return dateStr || "—";
  return d.toLocaleDateString("en-US", {
    weekday: "short", year: "numeric", month: "short", day: "numeric",
  });
}

// Compact format for the table (e.g. "2026.05.28" stays readable)
function formatDueDateShort(dateStr) {
  const d = parseDateStr(dateStr);
  if (!d) return dateStr || "—";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}.${m}.${day}`;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/* ── duplicate-send guard ────────────────────────────────────────────────── */
function getSentToday() {
  try {
    const raw = sessionStorage.getItem(SENT_KEY_PREFIX + todayKey());
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

function markSentToday(ids) {
  try {
    const current = getSentToday();
    ids.forEach((id) => current.add(id));
    sessionStorage.setItem(SENT_KEY_PREFIX + todayKey(), JSON.stringify([...current]));
  } catch { /* quota — ignore */ }
}

/* ── push API helper (mirrors PushStudio's pushApi) ─────────────────────── */
async function pushSendStudio({ title, body, url, studentIds }) {
  const headers = { "Content-Type": "application/json" };
  const tok = getToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(`${BASE}/api/push/send-studio`, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({
      title,
      body,
      url: url || "/portal",
      target: "students",
      studentIds,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data; // { sent, failed }
}

/* ── Tuition update API helper ───────────────────────────────────────────── */
/**
 * callTuitionUpdate — calls PATCH /api/teacher/students/{id}/tuition.
 *
 * Never fakes success. On HTTP error, throws with the server's detail message.
 *
 * @param {string} studentInternalId — the MongoDB student_id (UUID)
 * @param {object} body              — { action, currentNextDueDate?, customDueDate?, paymentAmount? }
 * @returns {{ ok, tuitionStatus, lastPaymentDate, nextDueDate, paymentAmount }}
 */
async function callTuitionUpdate(studentInternalId, body) {
  const headers = { "Content-Type": "application/json" };
  const tok = getToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(`${BASE}/api/teacher/students/${studentInternalId}/tuition`, {
    method: "PATCH",
    credentials: "include",
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || `HTTP ${res.status}`);
  }
  return data; // { ok, tuitionStatus, lastPaymentDate, nextDueDate, ... }
}

/* ── GAS tuition data fetcher ────────────────────────────────────────────── */
async function fetchStudentTuition(studentId) {
  const u = new URL(GAS_PORTAL_URL);
  u.searchParams.set("action", "getStudentData");
  u.searchParams.set("studentId", studentId);
  // Add cache-busting so GAS doesn't return stale data
  u.searchParams.set("t", String(Date.now()));
  const res = await fetch(u.toString(), { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return {
    NextDueDate: data.NextDueDate || null,
    TuitionStatus: data.TuitionStatus || null,
    PaymentAmount: data.PaymentAmount || null,
  };
}

/* ── status badge logic ──────────────────────────────────────────────────── */
function getStatusInfo(days, tuitionStatus, isActive) {
  const st = (tuitionStatus || "").toLowerCase();
  if (!isActive) return { label: "Deactivated", color: "#6b7280", emoji: "⛔", category: "deactivated" };
  if (st === "paid") return { label: "Paid", color: css.green, emoji: "✅", category: "paid" };
  if (days === null) return { label: "No date", color: css.textMuted, emoji: "—", category: "none" };
  if (days < -30) return { label: `Long overdue ${Math.abs(days)}d`, color: "#b91c1c", emoji: "🔴", category: "longoverdue" };
  if (days < 0)  return { label: `Overdue ${Math.abs(days)}d`, color: css.red, emoji: "🔴", category: "overdue" };
  if (days === 0) return { label: "Due today", color: css.red, emoji: "🚨", category: "today" };
  if (days <= 5) return { label: `Due in ${days}d`, color: css.amber, emoji: "⚠️", category: "soon" };
  return { label: `${days} days`, color: css.green, emoji: "🟢", category: "future" };
}

/* ── shared UI primitives ────────────────────────────────────────────────── */
function Card({ children, style }) {
  return (
    <div className="rounded-2xl border p-4"
         style={{ background: css.card, border: `1px solid ${css.border}`, ...style }}>
      {children}
    </div>
  );
}

function StatusBadge({ days, tuitionStatus, isActive }) {
  const info = getStatusInfo(days, tuitionStatus, isActive);
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold"
          style={{ background: `${info.color}18`, color: info.color, border: `1px solid ${info.color}30` }}>
      {info.emoji} {info.label}
    </span>
  );
}

function SectionTitle({ children }) {
  return (
    <h3 className="text-[13px] font-bold uppercase tracking-widest mb-3"
        style={{ color: css.textMuted }}>
      {children}
    </h3>
  );
}

/* ── All Mongo admin API calls go through tuitionAdminApi.js ─────────────── */

/* ── Mongo admin panel ───────────────────────────────────────────────────── */
function MongoPanel() {
  const [subTab, setSubTab] = useState("accounts");

  // ── accounts ──────────────────────────────────────────────────────────────
  const [accounts,   setAccounts]   = useState([]);
  const [accLoading, setAccLoading] = useState(false);
  const [editingId,  setEditingId]  = useState(null);
  const [editForm,   setEditForm]   = useState({});
  const [patchBusy,  setPatchBusy]  = useState(null);
  const [patchErr,   setPatchErr]   = useState(null);

  // ── global config ─────────────────────────────────────────────────────────
  const [gConfigForm, setGConfigForm] = useState({
    default_monthly_amount: 25,
    default_reward_points: 10,
    payment_push_enabled: true,
    reward_push_enabled: true,
  });
  const [gConfigBusy, setGConfigBusy] = useState(false);
  const [gConfigMsg,  setGConfigMsg]  = useState(null);

  // ── reminder config ───────────────────────────────────────────────────────
  const [rConfigForm, setRConfigForm] = useState({
    enabled: true,
    audience: "all_unpaid",
    due_window_days: 7,
    title_km: "ថ្លៃសិក្សា",
    title_en: "Tuition Reminder",
    body_km: "",
    body_en: "",
    frequency_hours: 24,
    dismiss_strategy: "client",
    snooze_hours: 6,
    button_km: "បង់ប្រាក់ឥឡូវ",
    button_en: "Pay Now",
    dismiss_label_km: "ពន្យារពេល",
  });
  const [rConfigBusy, setRConfigBusy] = useState(false);
  const [rConfigMsg,  setRConfigMsg]  = useState(null);

  // ── manual payment ────────────────────────────────────────────────────────
  const [manualForm, setManualForm] = useState({ student_id: "", amount_usd: "", months_covered: 1, note: "" });
  const [manualBusy, setManualBusy] = useState(false);
  const [manualResult, setManualResult] = useState(null);

  // ── migration ─────────────────────────────────────────────────────────────
  const [dryRunResult,    setDryRunResult]    = useState(null);
  const [dryRunBusy,      setDryRunBusy]      = useState(false);
  const [importResult,    setImportResult]    = useState(null);
  const [importBusy,      setImportBusy]      = useState(false);
  const [cutoverResult,   setCutoverResult]   = useState(null);
  const [cutoverBusy,     setCutoverBusy]     = useState(false);
  const [cutoverArmed,    setCutoverArmed]    = useState(false);

  // ── dashboard / receipts ──────────────────────────────────────────────────
  const [dashboard,  setDashboard]  = useState(null);
  const [receipts,   setReceipts]   = useState([]);
  const [migStatus,  setMigStatus]  = useState(null);
  const [dashLoading,setDashLoading]= useState(false);
  const [dashError,  setDashError]  = useState(null);

  const mountRef = useRef(true);
  useEffect(() => () => { mountRef.current = false; }, []);

  // ── loaders ───────────────────────────────────────────────────────────────
  const loadAccounts = useCallback(async () => {
    setAccLoading(true);
    try {
      const d = await getTuitionAccounts();
      if (mountRef.current) setAccounts(Array.isArray(d.accounts) ? d.accounts : []);
    } catch (e) {
      console.error("[TuitionStudio] loadAccounts:", e);
      if (mountRef.current) setAccounts([]);
    }
    finally { if (mountRef.current) setAccLoading(false); }
  }, []);

  const loadGConfig = useCallback(async () => {
    try {
      const d = await getTuitionConfig();
      if (!mountRef.current) return;
      setGConfigForm({
        default_monthly_amount: d.default_monthly_amount ?? 25,
        default_reward_points:  d.default_reward_points  ?? 10,
        payment_push_enabled:   d.payment_push_enabled   ?? true,
        reward_push_enabled:    d.reward_push_enabled    ?? true,
      });
    } catch (e) { console.error("[TuitionStudio] loadGConfig:", e); }
  }, []);

  const loadRConfig = useCallback(async () => {
    try {
      const d = await getReminderConfig();
      if (!mountRef.current) return;
      setRConfigForm({
        enabled:          d.enabled          ?? true,
        audience:         d.audience         ?? "all_unpaid",
        due_window_days:  d.due_window_days  ?? 7,
        title_km:         d.title_km         ?? "ថ្លៃសិក្សា",
        title_en:         d.title_en         ?? "Tuition Reminder",
        body_km:          d.body_km          ?? "",
        body_en:          d.body_en          ?? "",
        frequency_hours:  d.frequency_hours  ?? 24,
        dismiss_strategy: d.dismiss_strategy ?? "client",
        snooze_hours:     d.snooze_hours     ?? 6,
        button_km:        d.button_km        ?? "បង់ប្រាក់ឥឡូវ",
        button_en:        d.button_en        ?? "Pay Now",
        dismiss_label_km: d.dismiss_label_km ?? "ពន្យារពេល",
      });
    } catch (e) { console.error("[TuitionStudio] loadRConfig:", e); }
  }, []);

  const loadDashboard = useCallback(async () => {
    if (!mountRef.current) return;
    setDashLoading(true); setDashError(null);
    try {
      const [dash, rcp, mig] = await Promise.all([
        getTuitionDashboard(),
        getTuitionReceipts(),
        getMigrationStatus(),
      ]);
      if (!mountRef.current) return;
      setDashboard(dash?.ok ? dash : null);
      setReceipts(Array.isArray(rcp?.receipts) ? rcp.receipts : []);
      setMigStatus(mig?.ok ? mig : null);
    } catch (e) {
      console.error("[TuitionStudio] loadDashboard:", e);
      if (mountRef.current) {
        setDashError(
          e?.status === 401 || e?.status === 403
            ? "Session expired. Please sign in to Author Studio again."
            : "Unable to load tuition data. Please try again."
        );
      }
    } finally {
      if (mountRef.current) setDashLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAccounts();
    loadGConfig();
    loadRConfig();
    loadDashboard();
  }, [loadAccounts, loadGConfig, loadRConfig, loadDashboard]);

  // ── sub-tabs ──────────────────────────────────────────────────────────────
  const MONGO_TABS = [
    { key: "accounts",  label: "Accounts" },
    { key: "config",    label: "Global Config" },
    { key: "reminder",  label: "Reminder Builder" },
    { key: "manual",    label: "Manual Payment" },
    { key: "migration", label: "Migration" },
    { key: "dashboard", label: "Dashboard" },
  ];

  const fmtAmt  = (v) => v != null ? `$${Number(v).toFixed(2)}` : "—";
  const fmtDate = (s) => { try { return s ? new Date(s).toLocaleDateString() : "—"; } catch { return s || "—"; } };

  return (
    <div className="grid gap-4" data-testid="tuition-mongo-panel">
      {/* Sub-tab bar */}
      <div className="flex flex-wrap gap-1.5">
        {MONGO_TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setSubTab(key)}
            className="rounded-xl px-3 py-1.5 text-[11.5px] font-bold transition-all"
            style={{
              background: subTab === key ? css.aurora  : "rgba(255,255,255,0.04)",
              color:      subTab === key ? "#1a1420"   : css.textMuted,
              border:     `1px solid ${subTab === key ? "transparent" : css.border}`,
              cursor: "pointer",
            }}
          >{label}</button>
        ))}
      </div>

      {/* ═══════════════════════ ACCOUNTS ═══════════════════════ */}
      {subTab === "accounts" && (
        <Card>
          <div className="flex items-center justify-between mb-3">
            <SectionTitle>Tuition Accounts ({accounts.length})</SectionTitle>
            <button onClick={loadAccounts} disabled={accLoading}
                    className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11.5px] font-bold"
                    style={{ background: accLoading ? "rgba(255,255,255,0.04)" : css.aurora,
                             color: accLoading ? css.textMuted : "#1a1420", cursor: accLoading ? "not-allowed" : "pointer" }}>
              {accLoading ? <><Loader2 className="h-3.5 w-3.5 animate-spin"/>Loading…</> : <><RefreshCw className="h-3.5 w-3.5"/>Refresh</>}
            </button>
          </div>
          {patchErr && <p className="text-[12px] mb-2 px-2 py-1 rounded-lg" style={{ color: css.red, background: "rgba(239,68,68,0.08)" }}>⚠ {patchErr}</p>}
          {accounts.length === 0 && !accLoading && (
            <p className="text-[12px] text-center py-4" style={{ color: css.textMuted }}>No accounts found. Run migration import first.</p>
          )}
          <div className="space-y-2">
            {accounts.map((acc) => (
              <div key={acc.student_id} className="rounded-xl border" style={{ background: "rgba(255,255,255,0.02)", borderColor: css.border }}>
                {/* Row */}
                <div className="flex items-center gap-2 px-3 py-2.5 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <span className="text-[12.5px] font-bold" style={{ color: css.text }}>{acc.clean_id || acc.student_id?.slice(0,8)}</span>
                    {acc.display_name && <span className="text-[10.5px] ml-2" style={{ color: css.textMuted }}>{acc.display_name}</span>}
                  </div>
                  <span className="text-[10.5px] px-2 py-0.5 rounded-full"
                        style={{ background: (acc.tuition_status||"").toLowerCase()==="paid" ? "rgba(134,239,172,0.1)" : "rgba(239,68,68,0.1)",
                                 color: (acc.tuition_status||"").toLowerCase()==="paid" ? css.green : css.red }}>
                    {acc.tuition_status||"—"}
                  </span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                        style={{ background: "rgba(255,255,255,0.05)", color: css.textMuted }}>
                    {acc.data_source||"gas"}
                  </span>
                  <span className="text-[10.5px]" style={{ color: css.textMuted }}>ndd:{acc.next_due_date||"—"}</span>
                  <span className="text-[10.5px]" style={{ color: css.green }}>{acc.monthly_amount!=null?fmtAmt(acc.monthly_amount):"—"}</span>
                  <button
                    onClick={() => {
                      if (editingId === acc.student_id) { setEditingId(null); setPatchErr(null); return; }
                      setEditingId(acc.student_id);
                      setPatchErr(null);
                      setEditForm({
                        monthly_amount:          acc.monthly_amount          ?? "",
                        billing_anchor_day:      acc.billing_anchor_day      ?? "",
                        next_due_date:           acc.next_due_date           ?? "",
                        tuition_enabled:         acc.tuition_enabled         ?? true,
                        reward_override_points:  acc.reward_override_points  ?? "",
                      });
                    }}
                    className="text-[11px] px-2.5 py-1 rounded-lg"
                    style={{ background: "rgba(255,255,255,0.06)", color: css.textMuted, cursor: "pointer" }}
                  >{editingId === acc.student_id ? "Cancel" : "Edit"}</button>
                </div>

                {/* Inline edit form */}
                {editingId === acc.student_id && (
                  <div className="px-3 pb-3 pt-1 border-t grid grid-cols-2 gap-2" style={{ borderColor: css.border }}>
                    {[
                      { label: "Monthly Amount (USD)", key: "monthly_amount", type: "number", min: 0, step: "0.01", placeholder: "" },
                      { label: "Anchor Day (1–31)",    key: "billing_anchor_day", type: "number", min: 1, max: 31, placeholder: "" },
                    ].map(({ label, key, type, min, max, step, placeholder }) => (
                      <label key={key} className="flex flex-col gap-1">
                        <span className="text-[10px]" style={{ color: css.textMuted }}>{label}</span>
                        <input type={type} value={editForm[key]} min={min} max={max} step={step} placeholder={placeholder}
                               onChange={(e) => setEditForm((f) => ({ ...f, [key]: e.target.value }))}
                               className="rounded-lg px-2 py-1.5 text-[12px]" style={inputStyle} />
                      </label>
                    ))}
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px]" style={{ color: css.textMuted }}>Next Due Date</span>
                      <input type="date" value={editForm.next_due_date}
                             onChange={(e) => setEditForm((f) => ({ ...f, next_due_date: e.target.value }))}
                             className="rounded-lg px-2 py-1.5 text-[12px]" style={inputStyle} />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px]" style={{ color: css.textMuted }}>Reward Override (pts, blank=default)</span>
                      <input type="number" value={editForm.reward_override_points} min="0" placeholder="default"
                             onChange={(e) => setEditForm((f) => ({ ...f, reward_override_points: e.target.value }))}
                             className="rounded-lg px-2 py-1.5 text-[12px]" style={inputStyle} />
                    </label>
                    <label className="flex items-center gap-2 col-span-2 cursor-pointer select-none">
                      <input type="checkbox" checked={!!editForm.tuition_enabled}
                             onChange={(e) => setEditForm((f) => ({ ...f, tuition_enabled: e.target.checked }))}
                             className="h-4 w-4 rounded" />
                      <span className="text-[11.5px]" style={{ color: css.text }}>Tuition Pay enabled</span>
                    </label>
                    <button
                      onClick={async () => {
                        setPatchBusy(acc.student_id); setPatchErr(null);
                        try {
                          const body = {};
                          if (editForm.monthly_amount !== "")         body.monthly_amount         = Number(editForm.monthly_amount);
                          if (editForm.billing_anchor_day !== "")     body.billing_anchor_day     = Number(editForm.billing_anchor_day);
                          if (editForm.next_due_date !== "")          body.next_due_date          = editForm.next_due_date;
                          if (editForm.reward_override_points !== "") body.reward_override_points = Number(editForm.reward_override_points);
                          body.tuition_enabled = editForm.tuition_enabled;
                          await updateTuitionAccount(acc.student_id, body);
                          setEditingId(null);
                          await loadAccounts();
                        } catch (e) {
                          setPatchErr(e.message);
                        } finally {
                          setPatchBusy(null);
                        }
                      }}
                      disabled={patchBusy === acc.student_id}
                      className="col-span-2 rounded-xl py-2 text-[12px] font-bold"
                      style={{ background: patchBusy === acc.student_id ? "rgba(255,255,255,0.05)" : css.aurora,
                               color: patchBusy === acc.student_id ? css.textMuted : "#1a1420",
                               cursor: patchBusy === acc.student_id ? "not-allowed" : "pointer" }}
                      data-testid="mongo-account-save-btn"
                    >
                      {patchBusy === acc.student_id ? <><Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1"/>Saving…</> : "Save Changes"}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ═══════════════════════ GLOBAL CONFIG ═══════════════════════ */}
      {subTab === "config" && (
        <Card>
          <SectionTitle>Global Tuition Config</SectionTitle>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px]" style={{ color: css.textMuted }}>Default Monthly Amount (USD)</span>
              <input type="number" value={gConfigForm.default_monthly_amount} min="0" step="0.01"
                     onChange={(e) => setGConfigForm((f) => ({ ...f, default_monthly_amount: Number(e.target.value) }))}
                     className="rounded-lg px-2 py-1.5 text-[12px]" style={inputStyle}
                     data-testid="mongo-default-amount" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px]" style={{ color: css.textMuted }}>Default Reward Points</span>
              <input type="number" value={gConfigForm.default_reward_points} min="0"
                     onChange={(e) => setGConfigForm((f) => ({ ...f, default_reward_points: Number(e.target.value) }))}
                     className="rounded-lg px-2 py-1.5 text-[12px]" style={inputStyle}
                     data-testid="mongo-default-reward" />
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={!!gConfigForm.payment_push_enabled}
                     onChange={(e) => setGConfigForm((f) => ({ ...f, payment_push_enabled: e.target.checked }))} />
              <span className="text-[11.5px]" style={{ color: css.text }}>Payment-confirmed push</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={!!gConfigForm.reward_push_enabled}
                     onChange={(e) => setGConfigForm((f) => ({ ...f, reward_push_enabled: e.target.checked }))} />
              <span className="text-[11.5px]" style={{ color: css.text }}>Reward-credited push</span>
            </label>
          </div>
          {gConfigMsg && (
            <p className="text-[11.5px] mt-2" style={{ color: gConfigMsg.ok ? css.green : css.red }}>
              {gConfigMsg.ok ? "✓ Saved" : `⚠ ${gConfigMsg.err}`}
            </p>
          )}
          <button
            onClick={async () => {
              setGConfigBusy(true); setGConfigMsg(null);
              try {
                await saveTuitionConfig(gConfigForm);
                await loadGConfig();
                setGConfigMsg({ ok: true });
              } catch (e) {
                setGConfigMsg({ ok: false, err: e.message });
              } finally {
                setGConfigBusy(false);
              }
            }}
            disabled={gConfigBusy}
            className="mt-3 rounded-xl px-4 py-2 text-[12px] font-bold"
            style={{ background: gConfigBusy ? "rgba(255,255,255,0.05)" : css.aurora,
                     color: gConfigBusy ? css.textMuted : "#1a1420",
                     cursor: gConfigBusy ? "not-allowed" : "pointer" }}
            data-testid="mongo-config-save-btn"
          >
            {gConfigBusy ? <><Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1"/>Saving…</> : "Save Config"}
          </button>
        </Card>
      )}

      {/* ═══════════════════════ REMINDER BUILDER ═══════════════════════ */}
      {subTab === "reminder" && (
        <div className="grid lg:grid-cols-2 gap-4">
          {/* Form */}
          <Card>
            <SectionTitle>Reminder Overlay Builder</SectionTitle>
            <div className="space-y-3">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={!!rConfigForm.enabled}
                       onChange={(e) => setRConfigForm((f) => ({ ...f, enabled: e.target.checked }))} />
                <span className="text-[12px] font-bold" style={{ color: css.text }}>Overlay enabled</span>
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px]" style={{ color: css.textMuted }}>Audience</span>
                  <select value={rConfigForm.audience}
                          onChange={(e) => setRConfigForm((f) => ({ ...f, audience: e.target.value }))}
                          className="rounded-lg px-2 py-1.5 text-[12px]" style={inputStyle}>
                    <option value="all_unpaid">All unpaid</option>
                    <option value="overdue_only">Overdue only</option>
                    <option value="due_soon">Due within window</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px]" style={{ color: css.textMuted }}>Due window (days)</span>
                  <input type="number" value={rConfigForm.due_window_days} min="1" max="30"
                         onChange={(e) => setRConfigForm((f) => ({ ...f, due_window_days: Number(e.target.value) }))}
                         className="rounded-lg px-2 py-1.5 text-[12px]" style={inputStyle} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px]" style={{ color: css.textMuted }}>Frequency (hours)</span>
                  <input type="number" value={rConfigForm.frequency_hours} min="1"
                         onChange={(e) => setRConfigForm((f) => ({ ...f, frequency_hours: Number(e.target.value) }))}
                         className="rounded-lg px-2 py-1.5 text-[12px]" style={inputStyle} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px]" style={{ color: css.textMuted }}>Dismiss strategy</span>
                  <select value={rConfigForm.dismiss_strategy}
                          onChange={(e) => setRConfigForm((f) => ({ ...f, dismiss_strategy: e.target.value }))}
                          className="rounded-lg px-2 py-1.5 text-[12px]" style={inputStyle}>
                    <option value="client">Client (session)</option>
                    <option value="server">Server (per-student)</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px]" style={{ color: css.textMuted }}>Snooze hours (client)</span>
                  <input type="number" value={rConfigForm.snooze_hours} min="1"
                         onChange={(e) => setRConfigForm((f) => ({ ...f, snooze_hours: Number(e.target.value) }))}
                         className="rounded-lg px-2 py-1.5 text-[12px]" style={inputStyle} />
                </label>
              </div>

              {/* Bilingual copy */}
              {[
                { labelKm: "Title (Khmer)", labelEn: "Title (English)", km: "title_km", en: "title_en" },
                { labelKm: "Body (Khmer)",  labelEn: "Body (English)",  km: "body_km",  en: "body_en", multi: true },
                { labelKm: "Pay button (Khmer)", labelEn: "Pay button (English)", km: "button_km", en: "button_en" },
                { labelKm: "Dismiss label (Khmer)", labelEn: "", km: "dismiss_label_km", en: null },
              ].map(({ labelKm, labelEn, km, en, multi }) => (
                <div key={km} className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px]" style={{ color: css.textMuted }}>{labelKm}</span>
                    {multi
                      ? <textarea value={rConfigForm[km]} rows={3}
                                  onChange={(e) => setRConfigForm((f) => ({ ...f, [km]: e.target.value }))}
                                  className="rounded-lg px-2 py-1.5 text-[12px] resize-y" style={inputStyle} />
                      : <input type="text" value={rConfigForm[km]}
                               onChange={(e) => setRConfigForm((f) => ({ ...f, [km]: e.target.value }))}
                               className="rounded-lg px-2 py-1.5 text-[12px]" style={inputStyle} />}
                  </label>
                  {en && (
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px]" style={{ color: css.textMuted }}>{labelEn}</span>
                      {multi
                        ? <textarea value={rConfigForm[en]} rows={3}
                                    onChange={(e) => setRConfigForm((f) => ({ ...f, [en]: e.target.value }))}
                                    className="rounded-lg px-2 py-1.5 text-[12px] resize-y" style={inputStyle} />
                        : <input type="text" value={rConfigForm[en]}
                                 onChange={(e) => setRConfigForm((f) => ({ ...f, [en]: e.target.value }))}
                                 className="rounded-lg px-2 py-1.5 text-[12px]" style={inputStyle} />}
                    </label>
                  )}
                </div>
              ))}

              {rConfigMsg && (
                <p className="text-[11.5px]" style={{ color: rConfigMsg.ok ? css.green : css.red }}>
                  {rConfigMsg.ok ? "✓ Saved" : `⚠ ${rConfigMsg.err}`}
                </p>
              )}
              <button
                onClick={async () => {
                  setRConfigBusy(true); setRConfigMsg(null);
                  try {
                    await saveReminderConfig(rConfigForm);
                    await loadRConfig();
                    setRConfigMsg({ ok: true });
                  } catch (e) {
                    setRConfigMsg({ ok: false, err: e.message });
                  } finally {
                    setRConfigBusy(false);
                  }
                }}
                disabled={rConfigBusy}
                className="w-full rounded-xl py-2.5 text-[12px] font-bold"
                style={{ background: rConfigBusy ? "rgba(255,255,255,0.05)" : css.aurora,
                         color: rConfigBusy ? css.textMuted : "#1a1420", cursor: rConfigBusy ? "not-allowed" : "pointer" }}
                data-testid="mongo-reminder-save-btn"
              >
                {rConfigBusy ? <><Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1"/>Saving…</> : "Save Reminder Config"}
              </button>
            </div>
          </Card>

          {/* Mobile preview */}
          <div>
            <p className="text-[11px] font-bold mb-2" style={{ color: css.textMuted }}>Mobile Preview</p>
            <div className="rounded-[32px] overflow-hidden border-4 border-[rgba(255,255,255,0.12)] bg-black max-w-[240px] mx-auto shadow-2xl">
              {/* Phone status bar */}
              <div className="h-6 bg-[#111] flex items-center justify-center">
                <div className="h-2.5 w-14 bg-[#222] rounded-full" />
              </div>
              {/* Preview card */}
              <div className="bg-[#0f0e1a] min-h-[320px] relative">
                {/* Backdrop hint */}
                <div className="absolute inset-0 bg-black/60" style={{ backdropFilter: "blur(4px)" }} />
                {/* Card */}
                <div className="relative m-3 rounded-2xl overflow-hidden"
                     style={{ border: "1px solid rgba(79,70,229,0.3)", boxShadow: "0 12px 32px rgba(79,70,229,0.3)" }}>
                  {/* Header */}
                  <div className="px-3 pt-3 pb-2.5" style={{ background: "linear-gradient(135deg,#4f46e5,#7c3aed)" }}>
                    <div className="flex items-center gap-2">
                      <div className="h-7 w-7 rounded-xl bg-white/20 flex items-center justify-center">
                        <span className="text-[11px]">🎓</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[9px] font-bold text-white truncate">{rConfigForm.title_km || "ថ្លៃសិក្សា"}</p>
                        <p className="text-[7px] text-white/70 truncate">{rConfigForm.title_en || "Tuition Reminder"}</p>
                      </div>
                      <div className="h-4 w-4 rounded-full bg-white/20 flex items-center justify-center">
                        <span className="text-[7px] text-white">✕</span>
                      </div>
                    </div>
                  </div>
                  {/* Body */}
                  <div className="px-3 py-2.5 bg-[#0f0e1a] space-y-2">
                    {rConfigForm.body_km && <p className="text-[8px] leading-snug" style={{ color: "#f8fafc" }}>{rConfigForm.body_km}</p>}
                    {rConfigForm.body_en && <p className="text-[7px] leading-snug" style={{ color: "rgba(248,250,252,0.55)" }}>{rConfigForm.body_en}</p>}
                    <div className="flex gap-1.5 pt-1">
                      <div className="flex-1 rounded-lg py-1.5 text-center text-[7px]"
                           style={{ background: "rgba(79,70,229,0.08)", border: "1px solid rgba(79,70,229,0.3)", color: "rgba(248,250,252,0.6)" }}>
                        {rConfigForm.dismiss_label_km || "ពន្យារពេល"}
                      </div>
                      <div className="flex-[2] rounded-lg py-1.5 text-center text-[7px] font-bold text-white"
                           style={{ background: "linear-gradient(135deg,#4f46e5,#7c3aed)" }}>
                        {rConfigForm.button_km || "បង់ប្រាក់ឥឡូវ"}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              {/* Home bar */}
              <div className="h-5 bg-[#111] flex items-center justify-center">
                <div className="h-1 w-16 bg-[#333] rounded-full" />
              </div>
            </div>
            <p className="text-[10px] text-center mt-2" style={{ color: css.textMuted }}>
              Dismiss: <strong style={{ color: css.text }}>{rConfigForm.dismiss_strategy}</strong>
              {" "}· Snooze: <strong style={{ color: css.text }}>{rConfigForm.snooze_hours}h</strong>
              {" "}· Freq: <strong style={{ color: css.text }}>{rConfigForm.frequency_hours}h</strong>
            </p>
          </div>
        </div>
      )}

      {/* ═══════════════════════ MANUAL PAYMENT ═══════════════════════ */}
      {subTab === "manual" && (
        <Card>
          <SectionTitle>Record Manual Payment</SectionTitle>
          <div className="space-y-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px]" style={{ color: css.textMuted }}>Student ID (MongoDB student_id)</span>
              <input type="text" value={manualForm.student_id} placeholder="e.g. 64abc123…"
                     onChange={(e) => setManualForm((f) => ({ ...f, student_id: e.target.value }))}
                     className="rounded-lg px-3 py-1.5 text-[12px]" style={inputStyle}
                     data-testid="mongo-manual-student-id" />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[10.5px]" style={{ color: css.textMuted }}>Amount (USD)</span>
                <input type="number" value={manualForm.amount_usd} min="0" step="0.01" placeholder="25.00"
                       onChange={(e) => setManualForm((f) => ({ ...f, amount_usd: e.target.value }))}
                       className="rounded-lg px-2 py-1.5 text-[12px]" style={inputStyle}
                       data-testid="mongo-manual-amount" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10.5px]" style={{ color: css.textMuted }}>Months covered</span>
                <input type="number" value={manualForm.months_covered} min="1" max="24"
                       onChange={(e) => setManualForm((f) => ({ ...f, months_covered: Number(e.target.value) }))}
                       className="rounded-lg px-2 py-1.5 text-[12px]" style={inputStyle}
                       data-testid="mongo-manual-months" />
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px]" style={{ color: css.textMuted }}>Note (optional)</span>
              <input type="text" value={manualForm.note} placeholder="Cash payment, etc."
                     onChange={(e) => setManualForm((f) => ({ ...f, note: e.target.value }))}
                     className="rounded-lg px-3 py-1.5 text-[12px]" style={inputStyle} />
            </label>

            {manualResult && (
              <div className="rounded-xl p-3 text-[11.5px]"
                   style={{ background: manualResult.ok ? "rgba(134,239,172,0.08)" : "rgba(239,68,68,0.08)",
                            border: `1px solid ${manualResult.ok ? "rgba(134,239,172,0.25)" : "rgba(239,68,68,0.25)"}`,
                            color: manualResult.ok ? css.green : css.red }}>
                {manualResult.ok
                  ? <>✓ Payment recorded · receipt: <code className="text-[10px]">{manualResult.data?.receipt_id?.slice(-12)}</code></>
                  : <>⚠ {manualResult.error}</>}
              </div>
            )}

            <button
              onClick={async () => {
                if (!manualForm.student_id || !manualForm.amount_usd) {
                  setManualResult({ ok: false, error: "Student ID and amount are required." });
                  return;
                }
                setManualBusy(true); setManualResult(null);
                try {
                  const data = await recordManualPayment({
                    student_id:     manualForm.student_id,
                    amount_usd:     Number(manualForm.amount_usd),
                    months_covered: Number(manualForm.months_covered) || 1,
                    note:           manualForm.note || null,
                  });
                  setManualResult({ ok: true, data });
                  setManualForm({ student_id: "", amount_usd: "", months_covered: 1, note: "" });
                } catch (e) {
                  setManualResult({ ok: false, error: e.message });
                } finally {
                  setManualBusy(false);
                }
              }}
              disabled={manualBusy}
              className="w-full rounded-xl py-2.5 text-[12px] font-bold"
              style={{ background: manualBusy ? "rgba(255,255,255,0.05)" : css.aurora,
                       color: manualBusy ? css.textMuted : "#1a1420", cursor: manualBusy ? "not-allowed" : "pointer" }}
              data-testid="mongo-manual-submit-btn"
            >
              {manualBusy ? <><Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1"/>Recording…</> : "Record Payment"}
            </button>
          </div>
        </Card>
      )}

      {/* ═══════════════════════ MIGRATION ═══════════════════════ */}
      {subTab === "migration" && (
        <div className="space-y-4">
          {/* Migration status chips */}
          {migStatus && (
            <Card>
              <SectionTitle>Current Migration Status</SectionTitle>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Total",        value: migStatus.total_records      ?? "—" },
                  { label: "GAS source",   value: migStatus.gas_count          ?? "—" },
                  { label: "Mongo shadow", value: migStatus.mongo_shadow_count ?? "—" },
                  { label: "Mongo live",   value: migStatus.mongo_count        ?? "—" },
                  { label: "Paid",         value: migStatus.paid_count         ?? "—", color: css.green },
                  { label: "Unpaid",       value: migStatus.unpaid_count       ?? "—", color: css.red   },
                ].map(({ label, value, color }) => (
                  <div key={label} className="rounded-xl p-2.5 text-center"
                       style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${css.border}` }}>
                    <p className="text-[15px] font-bold" style={{ color: color || css.text }}>{String(value)}</p>
                    <p className="text-[9.5px] mt-0.5" style={{ color: css.textMuted }}>{label}</p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Step 1: Dry run */}
          <Card>
            <SectionTitle>Step 1 · Dry Run (read-only preview)</SectionTitle>
            <p className="text-[11.5px] mb-3" style={{ color: css.textMuted }}>
              Scans active students and reports which would be new, missing, invalid, or already-in-Mongo — writes nothing.
            </p>
            <button
              onClick={async () => {
                setDryRunBusy(true); setDryRunResult(null);
                try {
                  const d = await runMigrationDryRun();
                  setDryRunResult({ ok: true, data: d });
                } catch (e) {
                  setDryRunResult({ ok: false, error: e.message });
                } finally {
                  setDryRunBusy(false);
                }
              }}
              disabled={dryRunBusy}
              className="rounded-xl px-4 py-2 text-[12px] font-bold"
              style={{ background: dryRunBusy ? "rgba(255,255,255,0.05)" : css.aurora,
                       color: dryRunBusy ? css.textMuted : "#1a1420", cursor: dryRunBusy ? "not-allowed" : "pointer" }}
              data-testid="mongo-dry-run-btn"
            >
              {dryRunBusy ? <><Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1"/>Running…</> : "Run Dry Run"}
            </button>
            {dryRunResult && (
              <div className="mt-3 rounded-xl p-3 text-[11px]"
                   style={{ background: dryRunResult.ok ? "rgba(134,239,172,0.05)" : "rgba(239,68,68,0.05)",
                            border: `1px solid ${dryRunResult.ok ? "rgba(134,239,172,0.2)" : "rgba(239,68,68,0.2)"}` }}>
                {dryRunResult.ok ? (
                  <>
                    <p className="font-bold mb-1.5" style={{ color: css.green }}>
                      Dry-run complete · {dryRunResult.data.total} students
                    </p>
                    {[
                      { key: "new",      color: css.green, label: "New (will import)" },
                      { key: "conflict", color: css.amber, label: "Conflict (already Mongo)" },
                      { key: "invalid",  color: css.red,   label: "Invalid date" },
                      { key: "missing",  color: css.red,   label: "Missing Mongo record" },
                    ].map(({ key, color, label }) => (
                      dryRunResult.data[key]?.length > 0 && (
                        <div key={key} className="mb-1.5">
                          <span className="font-semibold" style={{ color }}>{label}: {dryRunResult.data[key].length}</span>
                          <div className="ml-2 mt-0.5 space-y-0.5">
                            {dryRunResult.data[key].slice(0,5).map((item) => (
                              <span key={item.student_id || item.clean_id} className="block text-[10px]" style={{ color: css.textMuted }}>
                                {item.clean_id || item.student_id?.slice(0,8)}{item.reason ? ` — ${item.reason}` : ""}
                              </span>
                            ))}
                            {dryRunResult.data[key].length > 5 && (
                              <span className="block text-[10px]" style={{ color: css.textMuted }}>…and {dryRunResult.data[key].length - 5} more</span>
                            )}
                          </div>
                        </div>
                      )
                    ))}
                  </>
                ) : (
                  <p style={{ color: css.red }}>⚠ {dryRunResult.error}</p>
                )}
              </div>
            )}
          </Card>

          {/* Step 2: Import */}
          <Card>
            <SectionTitle>Step 2 · Import (GAS → mongo_shadow)</SectionTitle>
            <p className="text-[11.5px] mb-3" style={{ color: css.textMuted }}>
              Flips all GAS records to <code className="text-[10px]">mongo_shadow</code>.
              Idempotent — safe to run multiple times. Does not affect already-shadow or already-mongo records.
            </p>
            <button
              onClick={async () => {
                setImportBusy(true); setImportResult(null);
                try {
                  const d = await runMigrationImport();
                  setImportResult({ ok: true, data: d });
                  await loadDashboard();
                } catch (e) {
                  setImportResult({ ok: false, error: e.message });
                } finally {
                  setImportBusy(false);
                }
              }}
              disabled={importBusy}
              className="rounded-xl px-4 py-2 text-[12px] font-bold"
              style={{ background: importBusy ? "rgba(255,255,255,0.05)" : css.aurora,
                       color: importBusy ? css.textMuted : "#1a1420", cursor: importBusy ? "not-allowed" : "pointer" }}
              data-testid="mongo-import-btn"
            >
              {importBusy ? <><Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1"/>Importing…</> : "Run Import"}
            </button>
            {importResult && (
              <p className="mt-2 text-[11.5px]"
                 style={{ color: importResult.ok ? css.green : css.red }}>
                {importResult.ok
                  ? `✓ ${importResult.data.modified} records updated to mongo_shadow`
                  : `⚠ ${importResult.error}`}
              </p>
            )}
          </Card>

          {/* Step 3: Cutover */}
          <Card>
            <SectionTitle>Step 3 · Cutover (mongo_shadow → mongo)</SectionTitle>
            <p className="text-[11.5px] mb-3" style={{ color: css.textMuted }}>
              Promotes all shadow records to <code className="text-[10px]">mongo</code> (primary).
              After cutover, the GAS fallback is disabled — the backend fails closed if the finalizer is missing.
              <strong style={{ color: css.amber }}> Irreversible without a rollback migration.</strong>
            </p>
            {!cutoverArmed ? (
              <button
                onClick={() => setCutoverArmed(true)}
                className="rounded-xl px-4 py-2 text-[12px] font-bold"
                style={{ background: "rgba(239,68,68,0.15)", color: css.red, border: "1px solid rgba(239,68,68,0.35)", cursor: "pointer" }}
                data-testid="mongo-cutover-arm-btn"
              >
                Arm Cutover (requires confirmation)
              </button>
            ) : (
              <div className="space-y-2">
                <p className="text-[11.5px] font-bold" style={{ color: css.red }}>⚠ Are you sure? This promotes all shadow records to Mongo primary.</p>
                <div className="flex gap-2">
                  <button onClick={() => setCutoverArmed(false)}
                          className="rounded-xl px-3 py-1.5 text-[11.5px] font-bold"
                          style={{ background: "rgba(255,255,255,0.05)", color: css.textMuted, border: `1px solid ${css.border}`, cursor: "pointer" }}>
                    Cancel
                  </button>
                  <button
                    onClick={async () => {
                      setCutoverBusy(true); setCutoverResult(null);
                      try {
                        const d = await runTuitionCutover({ confirm: true });
                        setCutoverResult({ ok: true, data: d });
                        setCutoverArmed(false);
                        await loadDashboard();
                      } catch (e) {
                        setCutoverResult({ ok: false, error: e.message });
                      } finally {
                        setCutoverBusy(false);
                      }
                    }}
                    disabled={cutoverBusy}
                    className="rounded-xl px-4 py-1.5 text-[11.5px] font-bold"
                    style={{ background: "rgba(239,68,68,0.2)", color: css.red, border: "1px solid rgba(239,68,68,0.4)", cursor: cutoverBusy ? "not-allowed" : "pointer" }}
                    data-testid="mongo-cutover-confirm-btn"
                  >
                    {cutoverBusy ? <><Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1"/>Cutting over…</> : "Confirm Cutover"}
                  </button>
                </div>
              </div>
            )}
            {cutoverResult && (
              <p className="mt-2 text-[11.5px]"
                 style={{ color: cutoverResult.ok ? css.green : css.red }}>
                {cutoverResult.ok
                  ? `✓ ${cutoverResult.data.modified} records promoted to Mongo primary`
                  : `⚠ ${cutoverResult.error}`}
              </p>
            )}
          </Card>
        </div>
      )}

      {/* ═══════════════════════ DASHBOARD ═══════════════════════ */}
      {subTab === "dashboard" && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <button
              onClick={loadDashboard}
              disabled={dashLoading}
              className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-bold"
              style={{ background: dashLoading ? "rgba(255,255,255,0.04)" : css.aurora,
                       color: dashLoading ? css.textMuted : "#1a1420", cursor: dashLoading ? "not-allowed" : "pointer" }}
              data-testid="mongo-refresh-btn"
            >
              {dashLoading ? <><Loader2 className="h-4 w-4 animate-spin"/>Loading…</> : <><RefreshCw className="h-4 w-4"/>Refresh</>}
            </button>
            {dashError && <span className="text-[12px]" style={{ color: css.red }}>⚠ {dashError}</span>}
          </div>

          {migStatus && (
            <Card>
              <SectionTitle>Migration Status</SectionTitle>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: "Total",        value: migStatus.total_records      ?? "—" },
                  { label: "GAS",          value: migStatus.gas_count          ?? "—" },
                  { label: "Shadow",       value: migStatus.mongo_shadow_count ?? "—" },
                  { label: "Mongo",        value: migStatus.mongo_count        ?? "—" },
                  { label: "Paid",         value: migStatus.paid_count         ?? "—", color: css.green },
                  { label: "Unpaid",       value: migStatus.unpaid_count       ?? "—", color: css.red   },
                ].map(({ label, value, color }) => (
                  <div key={label} className="rounded-xl p-3 text-center"
                       style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${css.border}` }}>
                    <p className="text-[18px] font-bold" style={{ color: color || css.text }}>{String(value)}</p>
                    <p className="text-[10.5px] mt-0.5" style={{ color: css.textMuted }}>{label}</p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {dashboard && (
            <Card>
              <SectionTitle>Live Dashboard · MongoDB</SectionTitle>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[
                  { label: "Total paid",      value: dashboard.total_paid        ?? "—", color: css.green },
                  { label: "Total unpaid",    value: dashboard.total_unpaid      ?? "—", color: css.red   },
                  { label: "Total pending",   value: dashboard.total_pending     ?? "—", color: css.amber },
                  { label: "Revenue (USD)",   value: fmtAmt(dashboard.total_revenue_usd), color: css.green },
                  { label: "Paid this month", value: dashboard.paid_this_month   ?? "—", color: css.green },
                  { label: "Overdue",         value: dashboard.total_overdue     ?? "—", color: css.red   },
                ].map(({ label, value, color }) => (
                  <div key={label} className="rounded-xl p-3"
                       style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${css.border}` }}>
                    <p className="text-[16px] font-bold" style={{ color }}>{String(value)}</p>
                    <p className="text-[10.5px] mt-0.5" style={{ color: css.textMuted }}>{label}</p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {receipts.length > 0 && (
            <Card>
              <SectionTitle>Receipt History ({receipts.length}) — immutable</SectionTitle>
              <div className="overflow-x-auto">
                <table className="w-full text-[11.5px]" style={{ borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ color: css.textMuted, borderBottom: `1px solid ${css.border}` }}>
                      {["Receipt","Student","Amount","Method","New Due","Pts","Date","Ack"].map((h) => (
                        <th key={h} className="text-left pb-2 pr-3 font-semibold whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {receipts.map((r) => (
                      <tr key={r.receipt_id} style={{ borderBottom: `1px solid ${css.border}` }}>
                        <td className="py-2 pr-3 font-mono text-[10px]" style={{ color: css.textMuted }}>{(r.receipt_id||"").slice(-8)}</td>
                        <td className="py-2 pr-3" style={{ color: css.text }}>{r.clean_id || r.student_id?.slice(0,8) || "—"}</td>
                        <td className="py-2 pr-3 font-bold" style={{ color: css.green }}>{fmtAmt(r.amount_usd)}</td>
                        <td className="py-2 pr-3" style={{ color: css.textMuted }}>{r.method||"—"}</td>
                        <td className="py-2 pr-3" style={{ color: css.text }}>{r.new_due_date||"—"}</td>
                        <td className="py-2 pr-3" style={{ color: "#fbbf24" }}>{r.reward_points!=null?`+${r.reward_points}`:"—"}</td>
                        <td className="py-2 pr-3 whitespace-nowrap" style={{ color: css.textMuted }}>{fmtDate(r.confirmed_at)}</td>
                        <td className="py-2" style={{ color: r.acknowledged_at ? css.green : css.amber }}>
                          {r.acknowledged_at ? "✓" : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {!dashLoading && !dashError && !dashboard && receipts.length === 0 && (
            <div className="text-center py-8" style={{ color: css.textMuted }}>
              <Database className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-[13px]">No Mongo tuition data yet.</p>
              <p className="text-[11px] mt-1">Payments will appear here once students pay via KHQR or manual entry.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Main component
   ═══════════════════════════════════════════════════════════════════════════ */
export default function TuitionReminderStudio() {
  // ── student roster from MongoDB (same as StudentManager)
  const [students, setStudents] = useState([]);
  const [rosterLoading, setRosterLoading] = useState(true);
  const [rosterError, setRosterError] = useState(null);

  // ── tuition data fetched per-student from GAS
  const [tuitionMap, setTuitionMap] = useState({}); // studentId → { NextDueDate, TuitionStatus, ... }
  const [scanLoading, setScanLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState({ done: 0, total: 0 });
  const [scanDone, setScanDone] = useState(false);
  const [scanError, setScanError] = useState(null);

  // ── filter
  const [filterCategory, setFilterCategory] = useState("all"); // all | today | soon | future | overdue | longoverdue | paid | deactivated | none
  const [filterGroup, setFilterGroup] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  // ── selection
  const [selected, setSelected] = useState(new Set()); // set of student_id strings

  // ── send state
  const [sendingIds, setSendingIds] = useState(new Set());
  const [sendResults, setSendResults] = useState({}); // studentId → { ok, sent, failed, error }
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [bulkSending, setBulkSending] = useState(false);

  // ── deactivation state (uses existing deactivateStudent from studentAuthService)
  const [confirmDeact, setConfirmDeact] = useState(null); // student object
  const [deactBusyId, setDeactBusyId] = useState(null);
  const [deactResults, setDeactResults] = useState({}); // studentId → { ok, error }

  // ── tuition management state (v10.3)
  const [tuitionBusy, setTuitionBusy] = useState({}); // studentId → action string | null
  const [tuitionLog, setTuitionLog] = useState({});   // studentId → { ok, msg } | { ok:false, error }
  const [customDueDateInput, setCustomDueDateInput] = useState({}); // studentId → "YYYY-MM-DD"

  // ── preview expand
  const [previewOpen, setPreviewOpen] = useState(false);

  // ── panel tab: "gas" (existing GAS scan) | "mongo" (Mongo data panel)
  const [activeStudioTab, setActiveStudioTab] = useState("gas");

  const sentTodayRef = useRef(getSentToday());

  // ── load student roster
  useEffect(() => {
    let cancelled = false;
    listStudents()
      .then((s) => { if (!cancelled) setStudents(Array.isArray(s) ? s : []); })
      .catch((e) => { if (!cancelled) setRosterError(e?.message || "Failed to load students"); })
      .finally(() => { if (!cancelled) setRosterLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // ── unique groups
  const groups = useMemo(() =>
    Array.from(new Set(students.map((s) => (s.group || "").trim()).filter(Boolean))).sort(),
  [students]);

  // ── enriched student list (merge tuition data in)
  const enriched = useMemo(() =>
    students.map((s) => {
      const id = s.clean_id || s.student_id || "";
      const tuition = tuitionMap[id] || {};
      const days = daysUntil(tuition.NextDueDate);
      const isActive = s.is_active !== false;
      return { ...s, id, ...tuition, days, isActive };
    }),
  [students, tuitionMap]);

  // ── filtered list (includes search + all filter categories)
  const filtered = useMemo(() => {
    return enriched.filter((s) => {
      // Search filter
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchId = (s.id || "").toLowerCase().includes(q);
        const matchName = (s.display_name || "").toLowerCase().includes(q);
        if (!matchId && !matchName) return false;
      }
      // Group filter
      if (filterGroup !== "all" && (s.group || "") !== filterGroup) return false;
      if (filterCategory === "all") return true;
      if (!scanDone && filterCategory !== "deactivated") return true;
      // Special filters
      if (filterCategory === "deactivated") return !s.isActive;
      if (filterCategory === "unpaid") {
        // Active + not paid + has a due date
        return s.isActive && s.days !== null && (s.TuitionStatus || "").toLowerCase() !== "paid";
      }
      const info = getStatusInfo(s.days, s.TuitionStatus, s.isActive);
      return info.category === filterCategory;
    });
  }, [enriched, filterGroup, filterCategory, searchQuery, scanDone]);

  // ── scan all students for tuition data from GAS
  const handleScan = useCallback(async () => {
    if (students.length === 0) return;
    setScanLoading(true);
    setScanDone(false);
    setScanError(null);
    setScanProgress({ done: 0, total: students.length });
    const results = {};
    // Fetch in parallel with a concurrency cap of 4 to avoid GAS rate limits
    const CONCURRENCY = 4;
    const queue = [...students];
    let done = 0;
    async function worker() {
      while (queue.length > 0) {
        const s = queue.shift();
        if (!s) break;
        const id = s.clean_id || s.student_id || "";
        try {
          const data = await fetchStudentTuition(id);
          results[id] = data;
        } catch (e) {
          results[id] = { NextDueDate: null, TuitionStatus: null, PaymentAmount: null, error: e.message };
        }
        done++;
        setScanProgress({ done, total: students.length });
      }
    }
    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      setTuitionMap(results);
      setScanDone(true);
      sentTodayRef.current = getSentToday();
    } catch (e) {
      setScanError(e?.message || "Scan failed");
    } finally {
      setScanLoading(false);
    }
  }, [students]);

  // ── toggle selection
  const toggleSelect = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(filtered.map((s) => s.id)));
  }, [filtered]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // ── auto-select due-today
  const autoSelectToday = useCallback(() => {
    const ids = enriched
      .filter((s) => getStatusInfo(s.days, s.TuitionStatus, s.isActive).category === "today")
      .map((s) => s.id);
    setSelected(new Set(ids));
  }, [enriched]);

  // ── auto-select due soon (≤5 days, not today)
  const autoSelectSoon = useCallback(() => {
    const ids = enriched
      .filter((s) => {
        const cat = getStatusInfo(s.days, s.TuitionStatus, s.isActive).category;
        return cat === "soon" || cat === "today";
      })
      .map((s) => s.id);
    setSelected(new Set(ids));
  }, [enriched]);

  // ── auto-select overdue (any overdue including long overdue)
  const autoSelectOverdue = useCallback(() => {
    const ids = enriched
      .filter((s) => {
        const cat = getStatusInfo(s.days, s.TuitionStatus, s.isActive).category;
        return cat === "overdue" || cat === "longoverdue";
      })
      .map((s) => s.id);
    setSelected(new Set(ids));
  }, [enriched]);

  // ── tuition management handler (v10.3)
  // Updates GAS via the backend endpoint, then patches tuitionMap locally so
  // the UI reflects the change immediately without a full rescan.
  const handleTuitionAction = useCallback(async (student, action) => {
    const id = student.id; // clean_id
    const internalId = student.student_id; // MongoDB UUID — used for the API call

    if (!internalId) {
      setTuitionLog((prev) => ({ ...prev, [id]: { ok: false, error: "Missing student_id — cannot update." } }));
      return;
    }

    // Block concurrent actions on the same student
    if (tuitionBusy[id]) return;
    setTuitionBusy((prev) => ({ ...prev, [id]: action }));
    setTuitionLog((prev) => { const n = { ...prev }; delete n[id]; return n; });

    const body = { action, currentNextDueDate: student.NextDueDate || null };
    if (action === "set_custom_due_date") {
      const custom = (customDueDateInput[id] || "").trim();
      if (!custom) {
        setTuitionLog((prev) => ({ ...prev, [id]: { ok: false, error: "Enter a date (YYYY-MM-DD) first." } }));
        setTuitionBusy((prev) => { const n = { ...prev }; delete n[id]; return n; });
        return;
      }
      body.customDueDate = custom;
    }

    try {
      const result = await callTuitionUpdate(internalId, body);

      // Patch tuitionMap locally — no full rescan needed
      setTuitionMap((prev) => {
        const existing = prev[id] || {};
        const patch = {};
        if (result.tuitionStatus    != null) patch.TuitionStatus    = result.tuitionStatus;
        if (result.lastPaymentDate  != null) patch.LastPaymentDate  = result.lastPaymentDate;
        if (result.nextDueDate      != null) patch.NextDueDate      = result.nextDueDate;
        if (result.paymentAmount    != null) patch.PaymentAmount    = result.paymentAmount;
        return { ...prev, [id]: { ...existing, ...patch } };
      });

      const labelMap = {
        mark_paid:           "✅ Marked Paid",
        mark_unpaid:         "↩ Marked Unpaid",
        extend_one_month:    `➕ Extended → ${result.nextDueDate || ""}`,
        set_custom_due_date: `📅 Due date → ${result.nextDueDate || ""}`,
      };
      setTuitionLog((prev) => ({ ...prev, [id]: { ok: true, msg: labelMap[action] || "Updated" } }));

      // Clear custom date input after successful set
      if (action === "set_custom_due_date") {
        setCustomDueDateInput((prev) => { const n = { ...prev }; delete n[id]; return n; });
      }
    } catch (e) {
      setTuitionLog((prev) => ({ ...prev, [id]: { ok: false, error: e.message || "Update failed" } }));
    } finally {
      setTuitionBusy((prev) => { const n = { ...prev }; delete n[id]; return n; });
    }
  }, [tuitionBusy, customDueDateInput]);

  // ── deactivate one student (uses exact same deactivateStudent from studentAuthService)
  // After deactivation fires a Khmer restriction push using the real NextDueDate.
  // If NextDueDate is missing or invalid the push is silently skipped — no fallback data.
  const handleDeactivate = useCallback(async (student) => {
    setDeactBusyId(student.student_id);
    try {
      // 1. Deactivate via existing endpoint — always runs first, independent of push
      await deactivateStudent(student.student_id);

      // 2. Update local roster immediately
      setStudents((prev) =>
        prev.map((s) =>
          s.student_id === student.student_id ? { ...s, is_active: false } : s
        )
      );
      setDeactResults((prev) => ({ ...prev, [student.id]: { ok: true } }));

      // 3. Fire Khmer restriction push using REAL tuition due date only
      //    Per strict data rules: no fallback, no mock, no invented date.
      const dueDateObj = parseDateStr(student.NextDueDate); // Date | null

      if (!dueDateObj) {
        // NextDueDate is missing — skip push, log warning, do not invent a date
        console.warn("[TuitionRestriction] Missing tuition due date — push skipped.", {
          studentId: student.id,
          NextDueDate: student.NextDueDate,
        });
      } else {
        const msg = buildRestrictionMessage(dueDateObj);
        if (msg) {
          // msg is null when overdueDays < 0 (restricted before due) — safe to skip
          await pushSendStudio({
            title: msg.title,
            body:  msg.body,
            url:   msg.url,
            studentIds: [student.id],
          });
        }
      }
    } catch (e) {
      setDeactResults((prev) => ({
        ...prev,
        [student.id]: { ok: false, error: e.message },
      }));
    } finally {
      setDeactBusyId(null);
      setConfirmDeact(null);
    }
  }, []);

  // ── send reminder to one student
  const handleSendOne = useCallback(async (student) => {
    const id = student.id;
    if (sentTodayRef.current.has(id)) {
      setSendResults((prev) => ({
        ...prev,
        [id]: { ok: false, error: "Already sent today. Use manual resend if needed." },
      }));
      return;
    }

    // Parse real NextDueDate — null if missing or invalid
    const dueDateObj = parseDateStr(student.NextDueDate);
    if (!dueDateObj) {
      console.warn("[TuitionReminder] Missing or invalid NextDueDate — push skipped.", {
        studentId: id, NextDueDate: student.NextDueDate,
      });
      setSendResults((prev) => ({
        ...prev,
        [id]: { ok: false, error: "No valid due date — push skipped." },
      }));
      return;
    }

    const isToday = student.days === 0;
    const msg = buildReminderMessage(dueDateObj, isToday);
    // msg is always non-null here because dueDateObj is valid, but guard anyway
    if (!msg) {
      setSendResults((prev) => ({ ...prev, [id]: { ok: false, error: "Could not build message." } }));
      return;
    }

    setSendingIds((prev) => new Set([...prev, id]));
    try {
      const res = await pushSendStudio({ title: msg.title, body: msg.body, url: msg.url, studentIds: [id] });
      setSendResults((prev) => ({ ...prev, [id]: { ok: true, sent: res.sent, failed: res.failed } }));
      markSentToday([id]);
      sentTodayRef.current.add(id);
    } catch (e) {
      setSendResults((prev) => ({ ...prev, [id]: { ok: false, error: e.message } }));
    } finally {
      setSendingIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  }, []);

  // ── bulk send (requires confirmation)
  // Each student receives a message built from their OWN real NextDueDate.
  // No placeholder, no shared body, no fallback date.
  // Students with missing/invalid NextDueDate are individually skipped.
  const handleBulkSend = useCallback(async () => {
    setConfirmOpen(false);
    setBulkSending(true);

    const toSend      = [...selected].filter((id) => !sentTodayRef.current.has(id));
    const alreadySent = [...selected].filter((id) =>  sentTodayRef.current.has(id));

    // Mark already-sent as skipped immediately
    if (alreadySent.length > 0) {
      setSendResults((prev) => {
        const next = { ...prev };
        alreadySent.forEach((id) => { next[id] = { ok: false, error: "Already sent today (skipped)." }; });
        return next;
      });
    }

    // One request per student — each gets a message from their own real due date
    for (const id of toSend) {
      const student = enriched.find((s) => s.id === id);
      if (!student) continue;

      // Strict data rule: real NextDueDate required — no fallback
      const dueDateObj = parseDateStr(student.NextDueDate);
      if (!dueDateObj) {
        console.warn("[TuitionBulkSend] Missing or invalid NextDueDate — student skipped.", {
          studentId: id, NextDueDate: student.NextDueDate,
        });
        setSendResults((prev) => ({
          ...prev,
          [id]: { ok: false, error: "No valid due date — skipped." },
        }));
        continue;
      }

      const isToday = student.days === 0;
      const msg = buildReminderMessage(dueDateObj, isToday);
      if (!msg) {
        setSendResults((prev) => ({ ...prev, [id]: { ok: false, error: "Could not build message — skipped." } }));
        continue;
      }

      try {
        const res = await pushSendStudio({
          title: msg.title, body: msg.body, url: msg.url, studentIds: [id],
        });
        setSendResults((prev) => ({ ...prev, [id]: { ok: true, sent: res.sent ?? 1 } }));
        markSentToday([id]);
        sentTodayRef.current.add(id);
      } catch (e) {
        setSendResults((prev) => ({ ...prev, [id]: { ok: false, error: e.message } }));
      }
    }

    setBulkSending(false);
  }, [selected, enriched]);

  // ── category counts (for filter badges)
  const counts = useMemo(() => {
    const c = { today: 0, soon: 0, future: 0, overdue: 0, longoverdue: 0, paid: 0, none: 0, deactivated: 0, unpaid: 0 };
    enriched.forEach((s) => {
      if (!s.isActive) { c.deactivated++; return; }
      const cat = getStatusInfo(s.days, s.TuitionStatus, s.isActive).category;
      if (c[cat] !== undefined) c[cat]++;
      // unpaid = active + not paid + has any due date status except paid/none
      if (s.isActive && s.days !== null && (s.TuitionStatus || "").toLowerCase() !== "paid") {
        c.unpaid++;
      }
    });
    return c;
  }, [enriched]);

  // ── preview message for a specific student
  const previewStudent = selected.size === 1
    ? enriched.find((s) => selected.has(s.id))
    : null;

  const previewMsg = previewStudent
    ? buildMessages(parseDateStr(previewStudent.NextDueDate))
    : buildMessages(null);
  const previewIsToday = previewStudent?.days === 0;

  /* ────────────────────────────────────────────────────────────────────────
     Render
     ────────────────────────────────────────────────────────────────────── */
  return (
    <div className="grid gap-5 max-w-[900px]" data-testid="tuition-reminder-studio">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <CalendarClock className="h-5 w-5" style={{ color: "#D4A843" }} />
          <h2 className="text-[17px] font-bold" style={{ color: css.text }}>
            Smart Tuition Reminder
          </h2>
        </div>
        <p className="text-[12px]" style={{ color: css.textMuted }}>
          Scan students&apos; due dates from Google Sheets, preview bilingual push notifications,
          and send to one, selected, or all eligible students.
          Timezone: {TZ_LABEL}. Duplicate-send guard is active per day.
        </p>

        {/* ── Panel tab switcher ──────────────────────────────────────────── */}
        <div className="flex gap-2 mt-4">
          {[
            { key: "gas",   label: "GAS Scan",    icon: <BarChart3  className="h-3.5 w-3.5" /> },
            { key: "mongo", label: "Mongo Data",  icon: <Database   className="h-3.5 w-3.5" /> },
          ].map(({ key, label, icon }) => (
            <button
              key={key}
              onClick={() => setActiveStudioTab(key)}
              className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-[12px] font-bold transition-all"
              style={{
                background: activeStudioTab === key ? css.aurora   : "rgba(255,255,255,0.04)",
                color:      activeStudioTab === key ? "#1a1420"    : css.textMuted,
                border:     `1px solid ${activeStudioTab === key ? "transparent" : css.border}`,
                cursor: "pointer",
              }}
              data-testid={`tuition-tab-${key}`}
            >
              {icon}{label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Mongo Data Panel ──────────────────────────────────────────────── */}
      {activeStudioTab === "mongo" && <MongoPanel />}

      {/* ── GAS Scan panel (existing, unchanged) ──────────────────────── */}
      {activeStudioTab === "gas" && <>

      {/* ── Step 1: Scan ─────────────────────────────────────────────────── */}
      <Card>
        <SectionTitle>Step 1 — Scan tuition dates from Google Sheets</SectionTitle>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handleScan}
            disabled={scanLoading || rosterLoading}
            className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-bold transition-all"
            style={{
              background: scanLoading ? "rgba(255,255,255,0.06)" : css.aurora,
              color: scanLoading ? css.textMuted : "#1a1420",
              cursor: scanLoading ? "not-allowed" : "pointer",
            }}
            data-testid="tuition-scan-btn"
          >
            {scanLoading ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Scanning…</>
            ) : (
              <><RefreshCw className="h-4 w-4" /> Scan {students.length} students</>
            )}
          </button>
          {scanLoading && (
            <span className="text-[12px]" style={{ color: css.textMuted }}>
              {scanProgress.done} / {scanProgress.total} fetched
            </span>
          )}
          {scanDone && !scanLoading && (
            <span className="text-[12px]" style={{ color: css.green }}>
              ✓ Scan complete — {students.length} students loaded
            </span>
          )}
          {scanError && (
            <span className="text-[12px]" style={{ color: css.red }}>⚠ {scanError}</span>
          )}
          {rosterError && (
            <span className="text-[12px]" style={{ color: css.red }}>⚠ Roster: {rosterError}</span>
          )}
        </div>
        {scanDone && (
          <div className="flex flex-wrap gap-2 mt-3" data-testid="tuition-count-badges">
            {[
              { key: "today",       label: "Due today",    color: css.red      },
              { key: "soon",        label: "Due ≤5 days",  color: css.amber    },
              { key: "future",      label: ">5 days",      color: css.green    },
              { key: "overdue",     label: "Overdue",      color: css.red      },
              { key: "longoverdue", label: "Long overdue", color: "#b91c1c"    },
              { key: "unpaid",      label: "Unpaid active",color: css.amber    },
              { key: "paid",        label: "Paid",         color: css.green    },
              { key: "deactivated", label: "Deactivated",  color: "#6b7280"    },
              { key: "none",        label: "No date",      color: css.textMuted},
            ].map(({ key, label, color }) => (
              <button
                key={key}
                onClick={() => setFilterCategory(filterCategory === key ? "all" : key)}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-bold transition-all"
                style={{
                  background: filterCategory === key ? `${color}20` : "rgba(255,255,255,0.04)",
                  color: filterCategory === key ? color : css.textMuted,
                  border: `1px solid ${filterCategory === key ? color + "50" : css.border}`,
                }}
              >
                {label}: {counts[key] ?? 0}
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* ── Step 2: Preview notification ─────────────────────────────────── */}
      <Card>
        <button
          className="w-full flex items-center justify-between"
          onClick={() => setPreviewOpen((v) => !v)}
          data-testid="tuition-preview-toggle"
        >
          <SectionTitle>Step 2 — Notification preview</SectionTitle>
          {previewOpen
            ? <ChevronUp className="h-4 w-4 shrink-0" style={{ color: css.textMuted }} />
            : <ChevronDown className="h-4 w-4 shrink-0" style={{ color: css.textMuted }} />}
        </button>
        {previewOpen && (
          <div className="grid gap-3 mt-2">
            {/* Before-due template */}
            <div className="rounded-xl p-3 border"
                 style={{ background: "rgba(212,168,67,0.06)", borderColor: "rgba(212,168,67,0.2)" }}>
              <div className="text-[11px] font-bold mb-1" style={{ color: "#D4A843" }}>
                TEMPLATE A — More than 5 days before due date
              </div>
              <div className="text-[12px] font-bold" style={{ color: css.text }}>
                📣 {previewMsg.beforeDue.title}
              </div>
              <div className="text-[11.5px] mt-1 whitespace-pre-wrap" style={{ color: css.textMuted }}>
                {previewStudent
                  ? previewMsg.beforeDue.body
                  : previewMsg.beforeDue.body}
              </div>
              <div className="text-[10px] mt-1.5" style={{ color: css.textMuted }}>
                Action: {previewMsg.beforeDue.actionText} · Opens: /portal
              </div>
            </div>
            {/* Due-today template */}
            <div className="rounded-xl p-3 border"
                 style={{ background: "rgba(239,68,68,0.06)", borderColor: "rgba(239,68,68,0.2)" }}>
              <div className="text-[11px] font-bold mb-1" style={{ color: css.red }}>
                TEMPLATE B — Due today
              </div>
              <div className="text-[12px] font-bold" style={{ color: css.text }}>
                🚨 {previewMsg.dueToday.title}
              </div>
              <div className="text-[11.5px] mt-1 whitespace-pre-wrap" style={{ color: css.textMuted }}>
                {previewMsg.dueToday.body}
              </div>
              <div className="text-[10px] mt-1.5" style={{ color: css.textMuted }}>
                Action: {previewMsg.dueToday.actionText} · Opens: /portal
              </div>
            </div>
            <p className="text-[11px]" style={{ color: css.textMuted }}>
              Template selection is automatic: students due today receive Template B.
              All others receive Template A with their actual due date inserted.
              Individual and bulk sends both use each student's real due date. Students with missing or invalid due dates are skipped.
            </p>
          </div>
        )}
      </Card>

      {/* ── Step 3: Student list + send ──────────────────────────────────── */}
      <Card>
        <SectionTitle>Step 3 — Select students and send</SectionTitle>

        {/* Search box */}
        <div className="flex items-center gap-2 mb-2 rounded-xl px-3 py-2"
             style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${css.border}` }}>
          <Search className="h-3.5 w-3.5 shrink-0" style={{ color: css.textMuted }} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by Student ID or Name…"
            className="flex-1 bg-transparent text-[12px] outline-none"
            style={{ color: css.text }}
            data-testid="tuition-search"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery("")} style={{ color: css.textMuted }}>
              <XCircle className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Filter row */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Filter className="h-3.5 w-3.5 shrink-0" style={{ color: css.textMuted }} />
          {/* Group filter */}
          <select
            value={filterGroup}
            onChange={(e) => setFilterGroup(e.target.value)}
            className="rounded-xl px-3 py-1.5 text-[12px]"
            style={{ ...inputStyle, cursor: "pointer" }}
            data-testid="tuition-group-filter"
          >
            <option value="all">All groups</option>
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>

          {/* Quick-select buttons */}
          <button onClick={autoSelectToday}
                  className="rounded-full px-3 py-1 text-[11px] font-bold transition-all"
                  style={{ background: "rgba(239,68,68,0.12)", color: css.red, border: `1px solid ${css.red}30` }}
                  data-testid="tuition-select-today">
            🚨 Due today ({counts.today ?? 0})
          </button>
          <button onClick={autoSelectSoon}
                  className="rounded-full px-3 py-1 text-[11px] font-bold transition-all"
                  style={{ background: "rgba(251,191,36,0.12)", color: css.amber, border: `1px solid ${css.amber}30` }}
                  data-testid="tuition-select-soon">
            ⚠️ Due ≤5 days ({(counts.today ?? 0) + (counts.soon ?? 0)})
          </button>
          <button onClick={autoSelectOverdue}
                  className="rounded-full px-3 py-1 text-[11px] font-bold transition-all"
                  style={{ background: "rgba(185,28,28,0.12)", color: "#b91c1c", border: "1px solid rgba(185,28,28,0.3)" }}
                  data-testid="tuition-select-overdue">
            🔴 Overdue ({(counts.overdue ?? 0) + (counts.longoverdue ?? 0)})
          </button>
          <button onClick={selectAll}
                  className="rounded-full px-3 py-1 text-[11px] font-bold transition-all"
                  style={{ background: "rgba(255,255,255,0.04)", color: css.textMuted, border: `1px solid ${css.border}` }}
                  data-testid="tuition-select-all">
            <Users className="inline h-3 w-3 mr-1" />All visible ({filtered.length})
          </button>
          {selected.size > 0 && (
            <button onClick={clearSelection}
                    className="rounded-full px-3 py-1 text-[11px] font-bold"
                    style={{ color: css.red, border: `1px solid ${css.red}30`, background: "rgba(239,68,68,0.06)" }}>
              Clear ({selected.size})
            </button>
          )}
        </div>

        {/* Student table */}
        {rosterLoading ? (
          <div className="flex items-center gap-2 py-4" style={{ color: css.textMuted }}>
            <Loader2 className="h-4 w-4 animate-spin" /> Loading students…
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-4 text-[12px]" style={{ color: css.textMuted }}>
            No students match the current filter.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((s) => {
              const isSelected = selected.has(s.id);
              const isSending = sendingIds.has(s.id);
              const result = sendResults[s.id];
              const sentAlready = sentTodayRef.current.has(s.id);
              const info = getStatusInfo(s.days, s.TuitionStatus, s.isActive);
              const canSend = s.isActive && scanDone && s.NextDueDate &&
                info.category !== "paid" && info.category !== "none" && info.category !== "deactivated";
              const isDeactivated = !s.isActive;
              const deactResult = deactResults[s.id];
              const isDeactBusy = deactBusyId === s.student_id;
              const canDeactivate = s.isActive && scanDone &&
                (info.category === "today" || info.category === "overdue" || info.category === "longoverdue");

              return (
                <div key={s.id}
                     className="rounded-2xl transition-all"
                     style={{
                       background: isSelected
                         ? "rgba(212,168,67,0.10)"
                         : isDeactivated
                         ? "rgba(0,0,0,0.25)"
                         : "rgba(255,255,255,0.03)",
                       border: isSelected
                         ? "1px solid rgba(212,168,67,0.4)"
                         : `1px solid ${css.border}`,
                       opacity: isDeactivated ? 0.55 : 1,
                     }}
                     data-testid={`tuition-row-${s.id}`}>

                  {/* ── Top row: checkbox + name + status badge ── */}
                  <div className="flex items-start gap-2.5 p-3 pb-2">
                    {/* Checkbox */}
                    <div className="pt-0.5 shrink-0">
                      {s.isActive ? (
                        <button
                          onClick={() => toggleSelect(s.id)}
                          className="h-5 w-5 rounded-md grid place-items-center transition-all"
                          style={{
                            background: isSelected ? css.aurora : "rgba(255,255,255,0.07)",
                            border: isSelected ? "none" : `1px solid ${css.border}`,
                          }}
                          data-testid={`tuition-check-${s.id}`}
                        >
                          {isSelected && <span style={{ color: "#1a1420", fontSize: 11, fontWeight: 900 }}>✓</span>}
                        </button>
                      ) : (
                        <span className="text-[14px]">⛔</span>
                      )}
                    </div>

                    {/* Name + ID + group */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-bold truncate" style={{ color: css.text }}>
                          {s.display_name || s.id}
                        </span>
                        {s.group && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold"
                                style={{ background: "rgba(255,255,255,0.06)", color: css.textMuted }}>
                            {s.group}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] mt-0.5" style={{ color: css.textMuted }}>{s.id}</div>
                    </div>

                    {/* Status badge */}
                    <div className="shrink-0">
                      <StatusBadge days={s.days} tuitionStatus={s.TuitionStatus} isActive={s.isActive} />
                    </div>
                  </div>

                  {/* ── Due date row ── */}
                  {scanDone && (
                    <div className="px-3 pb-2 flex items-center gap-1.5">
                      <CalendarClock className="h-3 w-3 shrink-0" style={{ color: css.textMuted }} />
                      <span className="text-[11px]" style={{ color: s.NextDueDate ? css.text : css.textMuted }}>
                        {s.NextDueDate
                          ? (formatDateKhmer(parseDateStr(s.NextDueDate)) || formatDueDateShort(s.NextDueDate))
                          : "គ្មានកាលបរិច្ឆេទ"}
                      </span>
                    </div>
                  )}

                  {/* ── Action buttons ── */}
                  {!isDeactivated && (
                    <div className="px-3 pb-3 flex flex-col gap-2 border-t"
                         style={{ borderColor: "rgba(255,255,255,0.05)" }}>

                      {/* Row 1: Send + Paid + Unpaid + +1Mo */}
                      <div className="flex items-center gap-1.5 flex-wrap pt-2">

                        {/* Send reminder */}
                        {result ? (
                          result.ok ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1.5 rounded-xl"
                                  style={{ background: "rgba(134,239,172,0.10)", color: css.green }}>
                              <CheckCircle2 className="h-3.5 w-3.5" /> Sent
                              <button onClick={() => {
                                sentTodayRef.current.delete(s.id);
                                setSendResults((prev) => { const n = { ...prev }; delete n[s.id]; return n; });
                              }} className="ml-0.5 opacity-50 hover:opacity-100" title="Reset">↺</button>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] px-2 py-1.5 rounded-xl"
                                  style={{ background: "rgba(239,68,68,0.08)", color: css.red }}>
                              <XCircle className="h-3 w-3" /> {result.error?.slice(0, 20)}
                            </span>
                          )
                        ) : (
                          <button
                            onClick={() => handleSendOne(s)}
                            disabled={!canSend || isSending || sentAlready}
                            className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-bold transition-all"
                            style={{
                              background: !canSend || sentAlready ? "rgba(255,255,255,0.03)" : "rgba(212,168,67,0.15)",
                              color: !canSend || sentAlready ? css.textMuted : "#D4A843",
                              border: `1px solid ${!canSend || sentAlready ? css.border : "rgba(212,168,67,0.35)"}`,
                              cursor: !canSend || isSending || sentAlready ? "not-allowed" : "pointer",
                              minHeight: "32px",
                            }}
                            data-testid={`tuition-send-one-${s.id}`}
                            title={sentAlready ? "Already sent today" : !canSend ? "No due date or already paid" : "Send reminder"}
                          >
                            {isSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : sentAlready ? <><Ban className="h-3.5 w-3.5" /> Sent</>
                              : <><Send className="h-3.5 w-3.5" /> Send</>}
                          </button>
                        )}

                        {/* Mark Paid */}
                        <button
                          onClick={() => handleTuitionAction(s, "mark_paid")}
                          disabled={!!tuitionBusy[s.id]}
                          className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-bold transition-all"
                          style={{
                            background: "rgba(134,239,172,0.13)",
                            color: css.green,
                            border: "1px solid rgba(134,239,172,0.35)",
                            cursor: tuitionBusy[s.id] ? "not-allowed" : "pointer",
                            minHeight: "32px",
                          }}
                          title="Mark as Paid — advances NextDueDate by 1 month"
                          data-testid={`tuition-mark-paid-${s.id}`}
                        >
                          {tuitionBusy[s.id] === "mark_paid"
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <CreditCard className="h-3.5 w-3.5" />}
                          Paid
                        </button>

                        {/* Mark Unpaid */}
                        <button
                          onClick={() => handleTuitionAction(s, "mark_unpaid")}
                          disabled={!!tuitionBusy[s.id]}
                          className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-bold transition-all"
                          style={{
                            background: "rgba(239,68,68,0.10)",
                            color: css.red,
                            border: "1px solid rgba(239,68,68,0.30)",
                            cursor: tuitionBusy[s.id] ? "not-allowed" : "pointer",
                            minHeight: "32px",
                          }}
                          title="Mark as Unpaid"
                          data-testid={`tuition-mark-unpaid-${s.id}`}
                        >
                          {tuitionBusy[s.id] === "mark_unpaid"
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <MinusCircle className="h-3.5 w-3.5" />}
                          Unpaid
                        </button>

                        {/* Extend 1 Month */}
                        <button
                          onClick={() => handleTuitionAction(s, "extend_one_month")}
                          disabled={!!tuitionBusy[s.id]}
                          className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-bold transition-all"
                          style={{
                            background: "rgba(251,191,36,0.10)",
                            color: css.amber,
                            border: "1px solid rgba(251,191,36,0.30)",
                            cursor: tuitionBusy[s.id] ? "not-allowed" : "pointer",
                            minHeight: "32px",
                          }}
                          title="Extend NextDueDate by 1 month"
                          data-testid={`tuition-extend-${s.id}`}
                        >
                          {tuitionBusy[s.id] === "extend_one_month"
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <PlusCircle className="h-3.5 w-3.5" />}
                          +1 Mo
                        </button>

                        {/* Deactivate */}
                        {canDeactivate && !deactResult && (
                          <button
                            onClick={() => setConfirmDeact(s)}
                            disabled={isDeactBusy}
                            className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-bold transition-all"
                            style={{
                              background: "rgba(239,68,68,0.08)",
                              color: css.red,
                              border: "1px solid rgba(239,68,68,0.25)",
                              cursor: isDeactBusy ? "not-allowed" : "pointer",
                              minHeight: "32px",
                            }}
                            data-testid={`tuition-deact-${s.id}`}
                            title="Deactivate this student (overdue)"
                          >
                            {isDeactBusy
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <><UserX className="h-3.5 w-3.5" /> Deactivate</>}
                          </button>
                        )}
                        {deactResult && (
                          deactResult.ok
                            ? <span className="text-[11px]" style={{ color: "#6b7280" }}>⛔ Deactivated</span>
                            : <span className="text-[11px]" style={{ color: css.red }}>✗ {deactResult.error?.slice(0,25)}</span>
                        )}
                      </div>

                      {/* Row 2: Custom date setter */}
                      <div className="flex items-center gap-1.5">
                        <CalendarRange className="h-3.5 w-3.5 shrink-0" style={{ color: css.textMuted }} />
                        <input
                          type="date"
                          value={customDueDateInput[s.id] || ""}
                          onChange={(e) => setCustomDueDateInput((prev) => ({ ...prev, [s.id]: e.target.value }))}
                          className="rounded-xl px-2.5 py-1.5 text-[11px] flex-1"
                          style={{
                            background: "rgba(255,255,255,0.05)",
                            border: `1px solid ${customDueDateInput[s.id] ? "rgba(212,168,67,0.4)" : css.border}`,
                            color: css.text,
                            outline: "none",
                            minHeight: "32px",
                          }}
                          data-testid={`tuition-custom-date-input-${s.id}`}
                        />
                        <button
                          onClick={() => handleTuitionAction(s, "set_custom_due_date")}
                          disabled={!!tuitionBusy[s.id] || !customDueDateInput[s.id]}
                          className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-bold transition-all shrink-0"
                          style={{
                            background: customDueDateInput[s.id] ? "rgba(212,168,67,0.15)" : "rgba(255,255,255,0.03)",
                            color: customDueDateInput[s.id] ? "#D4A843" : css.textMuted,
                            border: `1px solid ${customDueDateInput[s.id] ? "rgba(212,168,67,0.4)" : css.border}`,
                            cursor: (tuitionBusy[s.id] || !customDueDateInput[s.id]) ? "not-allowed" : "pointer",
                            minHeight: "32px",
                          }}
                          title="Set custom NextDueDate"
                          data-testid={`tuition-set-date-${s.id}`}
                        >
                          {tuitionBusy[s.id] === "set_custom_due_date"
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : "Set date"}
                        </button>
                      </div>

                      {/* Result toast */}
                      {tuitionLog[s.id] && (
                        <div className="flex items-center gap-1.5 rounded-xl px-3 py-2"
                             style={{
                               background: tuitionLog[s.id].ok ? "rgba(134,239,172,0.08)" : "rgba(239,68,68,0.08)",
                               border: `1px solid ${tuitionLog[s.id].ok ? "rgba(134,239,172,0.2)" : "rgba(239,68,68,0.2)"}`,
                             }}>
                          {tuitionLog[s.id].ok ? (
                            <>
                              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color: css.green }} />
                              <span className="text-[11px] font-bold flex-1" style={{ color: css.green }}>
                                {tuitionLog[s.id].msg}
                              </span>
                            </>
                          ) : (
                            <>
                              <XCircle className="h-3.5 w-3.5 shrink-0" style={{ color: css.red }} />
                              <span className="text-[11px] flex-1" style={{ color: css.red }}>
                                {tuitionLog[s.id].error?.slice(0, 60)}
                              </span>
                            </>
                          )}
                          <button
                            onClick={() => setTuitionLog((prev) => { const n = { ...prev }; delete n[s.id]; return n; })}
                            className="shrink-0 text-[11px] px-1 opacity-50 hover:opacity-100"
                            style={{ color: css.textMuted }}
                          >✕</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Bulk send bar */}
        {selected.size > 0 && (
          <div className="mt-4 flex items-center gap-3 flex-wrap rounded-xl p-3 border"
               style={{ background: "rgba(212,168,67,0.07)", borderColor: "rgba(212,168,67,0.25)" }}>
            <Bell className="h-4 w-4 shrink-0" style={{ color: "#D4A843" }} />
            <span className="text-[12px] font-bold flex-1" style={{ color: css.text }}>
              {selected.size} student{selected.size === 1 ? "" : "s"} selected
              {(() => {
                const alreadySentCount = [...selected].filter((id) => sentTodayRef.current.has(id)).length;
                return alreadySentCount > 0
                  ? ` · ${alreadySentCount} already sent today (will be skipped)`
                  : "";
              })()}
            </span>
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={bulkSending}
              className="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-[12px] font-bold transition-all"
              style={{
                background: bulkSending ? "rgba(255,255,255,0.06)" : css.aurora,
                color: bulkSending ? css.textMuted : "#1a1420",
                cursor: bulkSending ? "not-allowed" : "pointer",
              }}
              data-testid="tuition-bulk-send-btn"
            >
              {bulkSending
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</>
                : <><Send className="h-4 w-4" /> Send to {selected.size} students</>}
            </button>
          </div>
        )}
      </Card>

      {/* ── Confirm modal ────────────────────────────────────────────────── */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center"
             style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
             data-testid="tuition-confirm-modal">
          <div className="rounded-2xl border p-6 max-w-[400px] w-full mx-4"
               style={{ background: "#0d0a16", border: `1px solid ${css.borderFocus}` }}>
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="h-5 w-5 shrink-0" style={{ color: css.amber }} />
              <h3 className="text-[15px] font-bold" style={{ color: css.text }}>
                Confirm bulk send
              </h3>
            </div>
            <p className="text-[12px] mb-4" style={{ color: css.textMuted }}>
              You are about to send tuition reminders to{" "}
              <strong style={{ color: css.text }}>{selected.size} student{selected.size === 1 ? "" : "s"}</strong>.
              {" "}Students already reminded today will be skipped.
              This action will record in push history and cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmOpen(false)}
                className="rounded-xl px-4 py-2 text-[12px] font-bold"
                style={{ background: "rgba(255,255,255,0.05)", color: css.textMuted, border: `1px solid ${css.border}` }}
              >
                Cancel
              </button>
              <button
                onClick={handleBulkSend}
                className="rounded-xl px-4 py-2 text-[12px] font-bold"
                style={{ background: css.aurora, color: "#1a1420" }}
                data-testid="tuition-confirm-yes"
              >
                Yes, send reminders
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Deactivation confirm modal ────────────────────────────────────── */}
      {confirmDeact && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
             style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)" }}
             onClick={() => setConfirmDeact(null)}
             data-testid="tuition-deact-modal">
          <div onClick={(e) => e.stopPropagation()}
               className="rounded-2xl max-w-sm w-full p-5"
               style={{ background: "#0d0a16", border: "1px solid rgba(239,68,68,0.45)" }}>
            <div className="flex items-center gap-2 mb-2">
              <UserX className="h-5 w-5 shrink-0" style={{ color: css.red }} />
              <h4 className="text-[13.5px] font-bold" style={{ color: css.text }}>
                Deactivate student?
              </h4>
            </div>
            <p className="text-[12px] leading-relaxed mb-1" style={{ color: css.textMuted }}>
              Are you sure you want to deactivate{" "}
              <strong style={{ color: css.text }}>{confirmDeact.clean_id || confirmDeact.id}</strong>
              {" "}({confirmDeact.display_name}) because tuition payment is overdue?
            </p>
            <p className="text-[11px] mb-4" style={{ color: "rgba(239,68,68,0.7)" }}>
              Their sessions will be deleted. Their ID can be reused for a new student later.
              This uses the same deactivate function as the Students tab.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDeact(null)}
                className="rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider"
                style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${css.border}`, color: css.text }}
                data-testid="tuition-deact-cancel"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeactivate(confirmDeact)}
                className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider"
                style={{ background: "rgba(239,68,68,0.18)", color: css.red, border: "1px solid rgba(239,68,68,0.4)" }}
                data-testid="tuition-deact-confirm"
              >
                {deactBusyId === confirmDeact.student_id && <Loader2 className="h-3 w-3 animate-spin" />}
                Confirm Deactivate
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Info footer ──────────────────────────────────────────────────── */}
      <div className="text-[11px]" style={{ color: css.textMuted }}>
        <strong style={{ color: css.text }}>Data source:</strong> Google Sheets via{" "}
        <code className="text-[10px]" style={{ color: css.text }}>GAS ?action=getStudentData</code> —
        same source as Student Portal tuition display. Tuition status is read at scan time.
        Push engine: <code className="text-[10px]" style={{ color: css.text }}>/api/push/send-studio</code> (existing endpoint).
        Deactivate uses <code className="text-[10px]" style={{ color: css.text }}>DELETE /api/teacher/students/{"{id}"}</code> — same as Students tab.
        Duplicate guard: session-scoped per calendar day.
      </div>

      </>}
    </div>
  );
}
