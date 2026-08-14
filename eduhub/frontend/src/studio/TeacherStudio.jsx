/**
 * TeacherStudio.jsx — Author Studio Teacher tab.
 *
 * v9.6 (2026-02) — Treasury credit surgery (audit fix).
 *   PointsTab now performs an ACTUAL on-server credit FROM the treasury
 *   wallet (default stu092) TO the target student via the existing
 *   PointsBackend `sendPoints` route, BEFORE firing the push notification.
 *
 * v9.7 (2026-02) — Restriction sheet-write surgery (audit fix).
 *   ROOT CAUSE: AuthContext's restriction watchdog strictly checks for the
 *   literal string "TRUE" in column G of the Scores Sheet. RestrictionTab
 *   was only firing a push — never writing the column. So the OS banner
 *   appeared but the in-app restriction overlay never did.
 *
 * v10.0 (2026-02) — MongoDB-authoritative status workflow.
 *   RestrictionTab now calls Render PATCH /api/teacher/students/{id}/status
 *   which writes to the new student_status Mongo collection (source of
 *   truth), mirrors to the Scores Sheet automatically (so the existing
 *   AuthContext watchdog keeps working), and fans out the push — all in
 *   ONE server-side transaction. The student's PWA polls the new
 *   /api/student/status/{id} every 3 s via StatusEnforcer, so enforcement
 *   lag drops from up to 15 s to ≤ 3 s with no manual sheet overwrite ever.
 *
 * v11.0 (2026-07) — Platform Reconstruction Phase 1: PointsTab now calls
 *   grantTreasuryPoints() (POST /api/points/grant), not the old client-side
 *   treasuryCreditPoints() — the treasury password no longer ships to the
 *   browser. See api.js's v11.0 note for the full rationale.
 */
import { useState, useCallback, useMemo } from "react";
import {
  GraduationCap,
  Coins,
  ShieldAlert,
  ShieldCheck,
  BellRing,
  Info,
  Send,
  Loader2,
  CheckCircle2,
  X,
  Wallet,
  Users,
  Hourglass,
} from "lucide-react";
import {
  teacherPushPoints,
  teacherPushReminder,
  grantTreasuryPoints,
  setStudentStatus,
  TREASURY_ID,
} from "./api";
// v10.0 — Student Management panel
import StudentManager from "./components/StudentManager";
// v10.1 — shared student picker dropdown
import { StudentPicker, useStudentList } from "./components/StudioPickers";

/* -------------------- design tokens (match PushStudio) -------------------- */
const css = {
  bg: "#0a0a0f",
  card: "rgba(255,255,255,0.04)",
  border: "rgba(255,255,255,0.08)",
  borderStrong: "rgba(255,255,255,0.16)",
  text: "#F4E5C1",
  textMuted: "rgba(244,229,193,0.55)",
  aurora: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
  danger: "rgba(239, 68, 68, 0.9)",
};

const inputStyle = {
  background: "rgba(255,255,255,0.03)",
  border: `1px solid ${css.border}`,
  color: css.text,
  outline: "none",
};

/* ========================================================================== */
/* Root                                                                        */
/* ========================================================================== */
export default function TeacherStudio() {
  const [tab, setTab] = useState("students");

  const tabs = [
    { key: "students",    label: "Students",    Icon: Users },
    { key: "points",      label: "Points",      Icon: Coins },
    { key: "restriction", label: "Restriction", Icon: ShieldAlert },
    { key: "reminder",    label: "Reminder",    Icon: BellRing },
    { key: "diagnostics", label: "Diagnostics", Icon: Info },
  ];

  return (
    <div data-testid="teacher-studio" className="rounded-3xl overflow-hidden"
         style={{ background: css.bg, border: `1px solid ${css.border}`,
                  fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>
      {/* ---- header ----------------------------------------------------- */}
      <div className="px-6 py-5 flex items-center gap-3"
           style={{ borderBottom: `1px solid ${css.border}` }}>
        <div className="grid place-items-center h-9 w-9 rounded-xl"
             style={{ background: "rgba(212,168,67,0.12)",
                      border: "1px solid rgba(212,168,67,0.35)" }}>
          <GraduationCap className="h-4 w-4" style={{ color: "#D4A843" }} />
        </div>
        <div>
          <h2 className="text-[15px] font-semibold" style={{ color: css.text }}>
            Teacher Studio
          </h2>
          <p className="text-[11px]" style={{ color: css.textMuted }}>
            Manage students and send targeted push notifications.
          </p>
        </div>
        <div className="flex-1" />
        <span className="hidden sm:inline-flex text-[10.5px] uppercase tracking-[0.18em] px-2.5 py-1 rounded-full"
              style={{ color: "#1a1420", background: css.aurora,
                       border: `1px solid ${css.border}` }}
              data-testid="teacher-role-badge">
          Teacher
        </span>
      </div>

      {/* ---- inner tabs ------------------------------------------------- */}
      <nav className="flex gap-1.5 px-6 pt-4 pb-1 overflow-x-auto sm:flex-wrap sm:overflow-visible"
           style={{ scrollbarWidth: "thin" }}
           data-testid="teacher-tabs">
        {tabs.map(({ key, label, Icon }) => {
          const active = tab === key;
          return (
            <button key={key} onClick={() => setTab(key)}
                    data-testid={`teacher-tab-${key}`}
                    className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[11px] font-bold uppercase tracking-wider transition-all shrink-0"
                    style={{
                      background: active ? css.aurora : "rgba(45,31,62,0.65)",
                      color: active ? "#1a1420" : css.text,
                      border: active
                        ? "1px solid rgba(255,225,154,0.6)"
                        : "1px solid rgba(212,168,67,0.25)",
                      boxShadow: active
                        ? "0 6px 14px rgba(212,168,67,0.35)"
                        : "none",
                      minHeight: 36,
                    }}>
              <Icon className="h-3 w-3" /> {label}
            </button>
          );
        })}
      </nav>

      <div className="px-6 py-5">
        {tab === "students"    && <StudentManager />}
        {tab === "points"      && <PointsTab />}
        {tab === "restriction" && <RestrictionTab />}
        {tab === "reminder"    && <ReminderTab />}
        {tab === "diagnostics" && <DiagnosticsTab />}
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Tab 1 — Points                                                              */
/* v9.6: real treasury → student credit + push                                 */
/* ========================================================================== */
function PointsTab() {
  const [studentId, setStudentId] = useState("");
  const [delta, setDelta] = useState("");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(null);
  const [error, setError] = useState(null);
  const [pushNote, setPushNote] = useState(null);
  // v10.1 — load students for the picker
  const { students, loading: stuLoading, error: stuError } = useStudentList();

  const onSend = useCallback(async () => {
    setError(null); setSuccess(null); setPushNote(null);
    const id = studentId.trim();
    const n = Number(delta);
    if (!id) { setError("Student ID is required"); return; }
    if (!Number.isInteger(n) || n === 0) {
      setError("Delta must be a non-zero integer");
      return;
    }
    setBusy(true);
    try {
      // STEP 1 — for credits (n > 0), perform a REAL on-server transfer
      // from the treasury wallet first. If the treasury credit fails, we
      // do NOT fire the push (no point notifying a credit that didn't
      // happen). Deductions skip this step and behave as before — push
      // only — because the treasury wallet only credits, it doesn't
      // debit, and the GAS sheet has no atomic "deduct from student"
      // route.
      if (n > 0) {
        const credit = await grantTreasuryPoints({ studentId: id, amount: n });
        if (!credit || !credit.success) {
          setError(
            (credit && credit.message) ||
              "Treasury credit failed. The push was NOT sent.",
          );
          return;
        }
      }

      // STEP 2 — fire the existing teacher push (server-rendered copy).
      try {
        await teacherPushPoints(id, n);
      } catch (pushErr) {
        if (n > 0) {
          setSuccess(`Credited +${n} points to ${id} from ${TREASURY_ID}.`);
          setPushNote(
            `Push delivery failed (${pushErr?.message || "unknown error"}). ` +
            `The student's balance still updated; their app will pick it up ` +
            `via the safety-net poll within ~20 s.`,
          );
          return;
        }
        throw pushErr;
      }

      const sign = n > 0 ? "+" : "";
      if (n > 0) {
        setSuccess(
          `Credited ${sign}${n} points to ${id} from treasury (${TREASURY_ID}) — ` +
          `student notified.`,
        );
      } else {
        setSuccess(
          `Push sent — student notified of ${sign}${n} points. ` +
          `(Deductions are NOT auto-applied; adjust the sheet manually if needed.)`,
        );
      }
    } catch (e) {
      setError(e.message || "Send failed");
    } finally {
      setBusy(false);
    }
  }, [studentId, delta]);

  return (
    <div className="grid gap-4 max-w-[640px]" data-testid="teacher-points">
      <Field label="Student">
        <StudentPicker
          value={studentId}
          onChange={setStudentId}
          students={students}
          loading={stuLoading}
          error={stuError}
          testid="teacher-points-student-picker"
        />
      </Field>

      <Field label="Delta  ·  positive = credit, negative = deduct">
        <input type="number" value={delta}
               onChange={(e) => setDelta(e.target.value)}
               placeholder="e.g. +50 or -20"
               data-testid="teacher-points-delta"
               className="w-full rounded-xl px-3.5 py-2.5 text-[13px]"
               style={inputStyle} />
      </Field>

      <div className="flex items-center gap-2 text-[11px]" style={{ color: css.textMuted }}>
        <Wallet className="h-3 w-3" style={{ color: "#D4A843" }} />
        Credits debit the treasury wallet
        <span style={{ color: css.text, fontFamily: "ui-monospace, monospace" }}>{TREASURY_ID}</span>
        {/* Credentials now live server-side only (SL_TREASURY_PASSWORD on
            Render) — the client can't know in advance whether they're
            configured. If they're missing, the server returns a clear 503
            and onSend() surfaces it via the normal error banner below. */}
      </div>

      <div>
        <PrimaryButton onClick={onSend} loading={busy}
                       testid="teacher-points-send-btn"
                       label="Credit + Notify Student" />
      </div>

      {success && <SuccessBanner testid="teacher-points-success" message={success} />}
      {pushNote && (
        <div data-testid="teacher-points-push-note"
             className="rounded-xl px-3.5 py-2.5 text-[12px] flex items-center gap-2"
             style={{ background: "rgba(245,158,11,0.08)",
                      border: "1px solid rgba(245,158,11,0.35)",
                      color: "#fde68a" }}>
          <BellRing className="h-4 w-4" />
          {pushNote}
        </div>
      )}
      {error   && <ErrorBanner   testid="teacher-points-error"   message={error}   />}
    </div>
  );
}

/* ========================================================================== */
/* Tab 2 — Restriction                                                         */
/* v10.0: Render-authoritative MongoDB write (mirrors → GAS, fans out push,    */
/*        invalidates client session via the StatusEnforcer 3-s poll).         */
/*        UI unchanged from v9.7 — same 2-button flow (Restrict + Clear).      */
/* ========================================================================== */
function RestrictionTab() {
  const [studentId, setStudentId] = useState("");
  const [message, setMessage] = useState("");
  // v10.2 — scheduled auto-lift: ISO datetime string or "" (immediate/permanent)
  const [liftAt, setLiftAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyClear, setBusyClear] = useState(false);
  const [success, setSuccess] = useState(null);
  const [error, setError] = useState(null);
  // v10.1 — load students for the picker
  const { students, loading: stuLoading, error: stuError } = useStudentList();

  // Build a min value for the datetime-local input — must be at least 5 min
  // from now so teachers can't accidentally set a time that's already passed.
  const minDateTime = useMemo(() => {
    const d = new Date(Date.now() + 5 * 60 * 1000);
    // datetime-local format: "YYYY-MM-DDTHH:MM"
    return d.toISOString().slice(0, 16);
  }, []);

  // Convert the local datetime-local value to a full ISO string with timezone.
  const liftAtIso = useMemo(() => {
    if (!liftAt) return null;
    // datetime-local gives "YYYY-MM-DDTHH:MM" without timezone — treat as local.
    const d = new Date(liftAt);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }, [liftAt]);

  // Human-readable lift time shown in success/preview text.
  const liftAtLabel = useMemo(() => {
    if (!liftAt) return null;
    const d = new Date(liftAt);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }, [liftAt]);

  const onSend = useCallback(async () => {
    setError(null); setSuccess(null);
    const id = studentId.trim();
    if (!id) { setError("Student ID is required"); return; }
    setBusy(true);
    try {
      // v10.0 — single authoritative call. The Render route writes Mongo
      // (source of truth), mirrors to GAS for the existing AuthContext
      // watchdog, and fans out the push notification — all server-side.
      // v10.2 — liftAt is passed when the teacher schedules an auto-lift.
      const payload = {
        status: "restricted",
        reason: message.trim(),
        ...(liftAtIso ? { liftAt: liftAtIso } : {}),
      };
      const res = await setStudentStatus(id, payload);
      const gasOk    = !!(res && res.gasMirror && res.gasMirror.ok);
      const pushSent = (res && res.push && res.push.sent) || 0;
      const pushFail = (res && res.push && res.push.failed) || 0;
      const parts = [
        `Restriction applied to ${id} (Mongo + ${gasOk ? "GAS mirror ✓" : "GAS mirror ⚠"}).`,
        liftAtLabel ? `Auto-lifts on ${liftAtLabel}.` : null,
        pushSent > 0 ? `Push delivered to ${pushSent} device${pushSent === 1 ? "" : "s"}.` : null,
        pushSent === 0 && pushFail === 0
          ? "No push devices subscribed — student will see the overlay on next ≤3s poll."
          : null,
      ].filter(Boolean);
      setSuccess(parts.join(" "));
    } catch (e) {
      setError(
        `Could not apply restriction (${e?.message || "unknown error"}). ` +
        `Nothing was changed.`,
      );
    } finally {
      setBusy(false);
    }
  }, [studentId, message, liftAtIso, liftAtLabel]);

  const onClear = useCallback(async () => {
    setError(null); setSuccess(null);
    const id = studentId.trim();
    if (!id) { setError("Student ID is required"); return; }
    setBusyClear(true);
    try {
      // v10.0 — flips status back to active. Mirrors GAS to "" and fires
      // a friendly "Account reactivated" push so the student knows.
      const res = await setStudentStatus(id, { status: "active", reason: "" });
      const gasOk = !!(res && res.gasMirror && res.gasMirror.ok);
      setSuccess(
        `Restriction cleared for ${id} (Mongo + ${gasOk ? "GAS mirror ✓" : "GAS mirror ⚠"}). ` +
        `Student can log in again.`,
      );
    } catch (clearErr) {
      setError(
        `Could not clear the restriction (${clearErr?.message || "unknown error"}). Please retry.`,
      );
    } finally {
      setBusyClear(false);
    }
  }, [studentId]);

  return (
    <div className="grid gap-4 max-w-[640px]" data-testid="teacher-restriction">
      <Field label="Student">
        <StudentPicker
          value={studentId}
          onChange={setStudentId}
          students={students}
          loading={stuLoading}
          error={stuError}
          testid="teacher-restriction-student-picker"
        />
      </Field>

      <Field label={`Restriction message  ·  optional  ·  ${message.length}/200`}>
        <textarea value={message} maxLength={200} rows={3}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Leave blank to use default: 'Your account has been restricted. Contact your teacher.'"
                  data-testid="teacher-restriction-message"
                  className="w-full rounded-xl px-3.5 py-2.5 text-[13px]"
                  style={inputStyle} />
      </Field>

      {/* v10.2 — scheduled auto-lift ───────────────────────────────────── */}
      <div className="rounded-2xl border p-4"
           style={{ background: "rgba(212,168,67,0.04)", border: "1px solid rgba(212,168,67,0.18)" }}>
        <div className="flex items-center gap-2 mb-3">
          <Hourglass className="h-4 w-4 shrink-0" style={{ color: "#D4A843" }} />
          <span className="text-[11.5px] font-bold uppercase tracking-widest" style={{ color: "#D4A843" }}>
            Schedule Auto-Lift  ·  optional
          </span>
        </div>
        <p className="text-[11px] mb-3" style={{ color: css.textMuted }}>
          Set a future date and time when the restriction lifts automatically.
          Leave blank to restrict indefinitely.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {/* Date picker — type="date" works reliably on iOS Safari */}
          <Field label="Date">
            <input
              type="date"
              value={liftAt ? liftAt.slice(0, 10) : ""}
              min={minDateTime.slice(0, 10)}
              onChange={(e) => {
                const date = e.target.value; // "YYYY-MM-DD"
                const time = liftAt ? liftAt.slice(11, 16) : "08:00";
                setLiftAt(date ? `${date}T${time}` : "");
              }}
              data-testid="teacher-restriction-lift-date"
              className="w-full rounded-xl px-3 py-2.5 text-[13px]"
              style={{ ...inputStyle, colorScheme: "dark" }}
            />
          </Field>
          {/* Time selector — <select> works on every iOS version */}
          <Field label="Time">
            <select
              value={liftAt ? liftAt.slice(11, 16) : "08:00"}
              onChange={(e) => {
                const time = e.target.value;
                const date = liftAt ? liftAt.slice(0, 10) : minDateTime.slice(0, 10);
                setLiftAt(`${date}T${time}`);
              }}
              disabled={!liftAt}
              data-testid="teacher-restriction-lift-time"
              className="w-full rounded-xl px-3 py-2.5 text-[13px]"
              style={{
                ...inputStyle,
                opacity: liftAt ? 1 : 0.4,
                cursor: liftAt ? "pointer" : "not-allowed",
              }}
            >
              {["06:00","07:00","08:00","09:00","10:00","11:00",
                "12:00","13:00","14:00","15:00","16:00","17:00",
                "18:00","19:00","20:00","21:00","22:00"].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
        </div>
        {liftAtLabel && (
          <div className="flex items-center gap-1.5 text-[11.5px] mt-2 px-1"
               style={{ color: "#86efac" }}>
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
            Lifts automatically on <span className="font-semibold ml-1">{liftAtLabel}</span>
            &nbsp;— no manual action needed.
          </div>
        )}
        {liftAt && (
          <button
            type="button"
            onClick={() => setLiftAt("")}
            className="text-[11px] mt-2 px-1 transition-colors"
            style={{ color: "rgba(255,255,255,0.35)" }}
            data-testid="teacher-restriction-lift-clear"
          >
            × Clear — restrict indefinitely instead
          </button>
        )}
      </div>
      {/* ── end scheduled auto-lift ─────────────────────────────────────── */}

      <div className="flex flex-wrap gap-2">
        <DangerButton onClick={onSend} loading={busy}
                      testid="teacher-restriction-send-btn"
                      label={liftAt ? "Restrict + Auto-Lift Scheduled" : "Restrict Account + Notify"} />
        <SecondaryButton onClick={onClear} loading={busyClear}
                         testid="teacher-restriction-clear-btn"
                         icon={ShieldCheck}
                         label="Clear Restriction" />
      </div>

      <p className="text-[11px]" style={{ color: css.textMuted }}>
        Restrict writes to <span style={{ color: css.text, fontFamily: "ui-monospace, monospace" }}>MongoDB</span>
        {" "}(authoritative), mirrors to the Scores Sheet, and fires a push.
        The student&apos;s app polls every 3&nbsp;s and shows the overlay
        within seconds. If a lift time is set, the student&apos;s overlay
        disappears automatically at that moment — no manual clear needed.
      </p>

      {success && <SuccessBanner testid="teacher-restriction-success" message={success} />}
      {error   && <ErrorBanner   testid="teacher-restriction-error"   message={error}   />}
    </div>
  );
}

/* ========================================================================== */
/* Tab 3 — Reminder                                                            */
/* ========================================================================== */
function ReminderTab() {
  const [studentId, setStudentId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(null);
  const [error, setError] = useState(null);
  // v10.1 — load students for the picker
  const { students, loading: stuLoading, error: stuError } = useStudentList();

  const onSend = useCallback(async () => {
    setError(null); setSuccess(null);
    const id = studentId.trim();
    if (!id) { setError("Student ID is required"); return; }
    setBusy(true);
    try {
      await teacherPushReminder(id, message.trim());
      setSuccess("Push sent — tuition reminder delivered");
    } catch (e) {
      setError(e.message || "Send failed");
    } finally {
      setBusy(false);
    }
  }, [studentId, message]);

  return (
    <div className="grid gap-4 max-w-[640px]" data-testid="teacher-reminder">
      <Field label="Student">
        <StudentPicker
          value={studentId}
          onChange={setStudentId}
          students={students}
          loading={stuLoading}
          error={stuError}
          testid="teacher-reminder-student-picker"
        />
      </Field>

      <Field label={`Custom message  ·  optional  ·  ${message.length}/200`}>
        <textarea value={message} maxLength={200} rows={3}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Leave blank to use default: 'Your tuition payment is overdue. Please settle today.'"
                  data-testid="teacher-reminder-message"
                  className="w-full rounded-xl px-3.5 py-2.5 text-[13px]"
                  style={inputStyle} />
      </Field>

      <div>
        <PrimaryButton onClick={onSend} loading={busy}
                       testid="teacher-reminder-send-btn"
                       label="Send Reminder" />
      </div>

      {success && <SuccessBanner testid="teacher-reminder-success" message={success} />}
      {error   && <ErrorBanner   testid="teacher-reminder-error"   message={error}   />}
    </div>
  );
}

/* ========================================================================== */
/* Tab 4 — Diagnostics                                                         */
/* ========================================================================== */
function DiagnosticsTab() {
  return (
    <div className="grid gap-4" data-testid="teacher-diagnostics">
      <DiagSection title="Backend endpoints wired" testid="teacher-diag-endpoints">
{`POST  /api/teacher/students/{id}/push-points     → Points credited/updated push
POST  /api/teacher/students/{id}/push-restriction → Account restricted push
POST  /api/teacher/students/{id}/push-reminder    → Tuition reminder push
PATCH /api/teacher/students/{id}/scores           → v9.7 — writes restriction
                                                    column G + reason column S
                                                    (existing GAS updateStudent)
POST  /api/points/grant                           → v11.0 — real treasury credit,
                                                    admin-gated, password stays
                                                    server-side (was a direct
                                                    client-side GAS call in v9.6)`}
      </DiagSection>

      <DiagSection title="Treasury wallet (v11.0)" testid="teacher-diag-treasury">
{`Wallet ID: ${TREASURY_ID}

Credentials are configured SERVER-SIDE ONLY (Render env var
SL_TREASURY_PASSWORD) — never in this frontend bundle. If it's missing,
the Points tab's credit request returns a clear error naming the env var
to set; nothing here can leak or misconfigure the password.

The Points tab performs an actual on-sheet credit from the treasury
(via POST /api/points/grant, admin-gated) BEFORE firing the push
notification, so the student's balance updates for real (not just
visually).`}
      </DiagSection>

      <DiagSection title="Restriction behaviour (v9.7)" testid="teacher-diag-restriction">
{`AuthContext's watchdog strictly matches the literal string "TRUE" in
column G of the Scores Sheet. RestrictionTab now writes that value via
PATCH /api/teacher/students/{id}/scores BEFORE firing the push, so the
in-app overlay actually triggers (was: push only — overlay never fired).

Restrict + Notify  → writes restriction="TRUE", restrictionReason=<text>
                     then fires the push.
Clear Restriction  → writes restriction="", restrictionReason=""
                     no push.

Lift the restriction by clicking the new Clear Restriction button OR by
manually clearing column G in the sheet.`}
      </DiagSection>

      <DiagSection title="Push delivery" testid="teacher-diag-delivery">
{`All pushes fan out to every registered PWA device for that studentId.
Students must have push enabled in their browser/PWA to receive.

v1.4 service worker now also broadcasts an EDUHUB_PUSH_SYNC message to
every open client window, and RealtimeSyncBridge refreshes the
AuthContext points balance + restriction watchdog on receipt — so the
in-app state matches the OS banner within ~1 s.`}
      </DiagSection>

      <DiagSection title="Student ID format" testid="teacher-diag-id-format">
{`Use the exact StudentID from your Google Sheet Students tab.
Example: S001, S045, etc.`}
      </DiagSection>

      <DiagSection title="Delta format (Points tab)" testid="teacher-diag-delta">
{`Positive integer = points credited (+50 → real ${TREASURY_ID}→student credit + push)
Negative integer = points deducted (-20 → push only; manual sheet edit needed)`}
      </DiagSection>
    </div>
  );
}

function DiagSection({ title, children, testid }) {
  return (
    <section data-testid={testid}
             className="rounded-2xl p-4"
             style={{ background: css.card, border: `1px solid ${css.border}` }}>
      <div className="text-[10.5px] uppercase tracking-[0.22em] mb-2"
           style={{ color: "#D4A843" }}>
        {title}
      </div>
      <pre className="text-[12px] whitespace-pre-wrap leading-relaxed font-mono"
           style={{ color: css.textMuted }}>
        {children}
      </pre>
    </section>
  );
}

/* ========================================================================== */
/* Shared bits                                                                 */
/* ========================================================================== */
function Field({ label, children }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-[10.5px] uppercase tracking-[0.22em]"
            style={{ color: css.textMuted }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function PrimaryButton({ onClick, loading, label, testid }) {
  return (
    <button onClick={onClick} disabled={loading} data-testid={testid}
            className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider"
            style={{
              background: css.aurora,
              color: "#1a1420",
              border: "1px solid rgba(255,225,154,0.6)",
              opacity: loading ? 0.6 : 1,
              cursor: loading ? "not-allowed" : "pointer",
            }}>
      {loading
        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
        : <Send className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

function DangerButton({ onClick, loading, label, testid }) {
  return (
    <button onClick={onClick} disabled={loading} data-testid={testid}
            className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider"
            style={{
              background: css.danger,
              color: "#fff",
              border: "1px solid rgba(239,68,68,0.6)",
              opacity: loading ? 0.6 : 1,
              cursor: loading ? "not-allowed" : "pointer",
            }}>
      {loading
        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
        : <ShieldAlert className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

/**
 * SecondaryButton — outline style for non-destructive actions like
 * "Clear Restriction". Distinct from PrimaryButton (gold) and
 * DangerButton (red) so the visual hierarchy stays legible.
 */
function SecondaryButton({ onClick, loading, label, testid, icon: Icon }) {
  const Glyph = Icon || ShieldCheck;
  return (
    <button onClick={onClick} disabled={loading} data-testid={testid}
            className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider"
            style={{
              background: "rgba(255,255,255,0.04)",
              color: css.text,
              border: `1px solid ${css.borderStrong}`,
              opacity: loading ? 0.6 : 1,
              cursor: loading ? "not-allowed" : "pointer",
            }}>
      {loading
        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
        : <Glyph className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

function SuccessBanner({ message, testid }) {
  return (
    <div data-testid={testid}
         className="rounded-xl px-3.5 py-2.5 text-[12px] flex items-center gap-2"
         style={{ background: "rgba(34,197,94,0.08)",
                  border: "1px solid rgba(34,197,94,0.35)",
                  color: "#bbf7d0" }}>
      <CheckCircle2 className="h-4 w-4" />
      {message}
    </div>
  );
}

function ErrorBanner({ message, testid }) {
  return (
    <div data-testid={testid}
         className="rounded-xl px-3.5 py-2.5 text-[12px] flex items-center gap-2"
         style={{ background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.35)",
                  color: "#fecaca" }}>
      <X className="h-4 w-4" />
      {message}
    </div>
  );
}
