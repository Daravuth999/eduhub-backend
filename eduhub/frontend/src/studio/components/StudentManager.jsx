/**
 * StudentManager.jsx — Teacher Studio "Students" tab (v10.0).
 *
 * Self-contained panel that lets a teacher onboard, list, reset, and
 * deactivate student accounts against the new Render-backed auth.
 * Visual language is locked to the existing Teacher Studio palette
 * (parchment ink on near-black, soft gold accent) so the new tab is
 * indistinguishable from the older Points/Restriction tabs.
 *
 * Three views are managed by a single `view` state:
 *
 *   list        — table of all students + filter + search
 *   create      — new-student form
 *   credential  — one-time credential card (also shown after reset)
 *
 * The plain password lives ONLY in component state. Clicking "Done" on
 * the credential card clears it; it is never written to localStorage,
 * never logged, never re-fetchable from the server.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Users,
  UserPlus,
  RotateCcw,
  XCircle,
  ArrowLeft,
  Copy,
  Check,
  Loader2,
  Search,
  AlertTriangle,
  ShieldCheck,
  RefreshCw,
} from "lucide-react";
import {
  listStudents,
  createStudent,
  deactivateStudent,
  resetStudentPassword,
} from "../../eduhub/auth/studentAuthService";
import PasswordResetRequestsPanel from "./PasswordResetRequestsPanel";

/* -------------------- design tokens (match TeacherStudio) ---------------- */
const css = {
  bg: "#0a0a0f",
  card: "rgba(255,255,255,0.04)",
  border: "rgba(255,255,255,0.08)",
  borderStrong: "rgba(255,255,255,0.16)",
  text: "#F4E5C1",
  textMuted: "rgba(244,229,193,0.55)",
  aurora: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
  danger: "rgba(239, 68, 68, 0.9)",
  good: "rgba(74, 222, 128, 0.9)",
  warn: "rgba(251, 191, 36, 0.9)",
};

const inputStyle = {
  background: "rgba(255,255,255,0.03)",
  border: `1px solid ${css.border}`,
  color: css.text,
  outline: "none",
};

/* ─────────────────────────  root component  ─────────────────────────── */
export default function StudentManager() {
  const [view, setView] = useState("list"); // list | create | credential
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reloadFlag, setReloadFlag] = useState(0);
  const [error, setError] = useState(null);
  const [credential, setCredential] = useState(null); // { clean_id, display_name, password, login_url }

  const refresh = useCallback(() => setReloadFlag((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listStudents()
      .then((s) => { if (!cancelled) setStudents(s); })
      .catch((e) => { if (!cancelled) setError(e.message || "Failed to load students"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadFlag]);

  if (view === "credential" && credential) {
    return (
      <CredentialCard
        credential={credential}
        onDone={() => {
          setCredential(null);
          setView("list");
          refresh();
        }}
      />
    );
  }

  if (view === "create") {
    return (
      <CreateForm
        onCancel={() => setView("list")}
        onCreated={(cred) => {
          setCredential(cred);
          setView("credential");
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <PasswordResetRequestsPanel
        onCredential={(cred) => {
          setCredential(cred);
          setView("credential");
        }}
      />
      <StudentList
        students={students}
        loading={loading}
        error={error}
        onRefresh={refresh}
        onNew={() => setView("create")}
        onReset={async (s) => {
          const r = await resetStudentPassword(s.student_id);
          setCredential(r);
          setView("credential");
        }}
        onDeactivate={async (s) => {
          await deactivateStudent(s.student_id);
          refresh();
        }}
        onReuse={(s) => {
          // Pre-fill the create form with the inactive student's clean_id so
          // the admin can re-onboard under the same printed slip ID.
          sessionStorage.setItem("v10_reuse_clean_id", s.clean_id);
          setView("create");
        }}
      />
    </div>
  );
}

/* ─────────────────────────  list view  ──────────────────────────────── */
function StudentList({ students, loading, error, onRefresh, onNew, onReset, onDeactivate, onReuse }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all"); // all | active | inactive
  const [busyId, setBusyId] = useState(null);
  const [confirmDeact, setConfirmDeact] = useState(null);
  const [confirmReset, setConfirmReset] = useState(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return students.filter((s) => {
      if (filter === "active" && !s.is_active) return false;
      if (filter === "inactive" && s.is_active) return false;
      if (!needle) return true;
      return (
        s.clean_id.toLowerCase().includes(needle) ||
        (s.display_name || "").toLowerCase().includes(needle) ||
        (s.group || "").toLowerCase().includes(needle)
      );
    });
  }, [students, q, filter]);

  return (
    <div data-testid="student-manager" className="space-y-4">
      {/* header row */}
      <div className="flex items-center gap-3 flex-wrap">
        <Users className="h-4 w-4" style={{ color: "#D4A843" }} />
        <h3 className="text-[13px] font-semibold" style={{ color: css.text }}>
          Student Management
        </h3>
        <span className="text-[11px]" style={{ color: css.textMuted }}>
          {students.filter((s) => s.is_active).length} active ·{" "}
          {students.filter((s) => !s.is_active).length} inactive
        </span>
        <div className="flex-1" />
        <button
          onClick={onRefresh}
          data-testid="student-refresh-btn"
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition"
          style={{ background: "rgba(45,31,62,0.65)", color: css.text,
                   border: "1px solid rgba(212,168,67,0.25)" }}
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
        <button
          onClick={onNew}
          data-testid="student-new-btn"
          className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider transition"
          style={{ background: css.aurora, color: "#1a1420",
                   border: "1px solid rgba(255,225,154,0.6)",
                   boxShadow: "0 6px 14px rgba(212,168,67,0.35)" }}
        >
          <UserPlus className="h-3 w-3" /> New Student
        </button>
      </div>

      {/* filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5"
                  style={{ color: css.textMuted }} />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by ID, name or group…"
            data-testid="student-search-input"
            className="w-full pl-9 pr-3 py-2 rounded-lg text-[12px]"
            style={inputStyle}
          />
        </div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid="student-filter-select"
          className="rounded-lg px-3 py-2 text-[12px]"
          style={inputStyle}
        >
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {error && (
        <div className="rounded-xl px-3 py-2.5 text-[12px] border"
             style={{ background: "rgba(239,68,68,0.08)",
                      borderColor: "rgba(239,68,68,0.35)", color: css.danger }}
             data-testid="student-list-error">
          <AlertTriangle className="inline h-3.5 w-3.5 mr-1" />
          {error}
        </div>
      )}

      {/* table */}
      <div className="rounded-xl overflow-hidden"
           style={{ border: `1px solid ${css.border}`, background: css.card }}>
        <table className="w-full text-[12px]" data-testid="student-table">
          <thead>
            <tr style={{ background: "rgba(255,255,255,0.03)",
                         borderBottom: `1px solid ${css.border}` }}>
              <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider"
                  style={{ color: css.textMuted }}>ID</th>
              <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider"
                  style={{ color: css.textMuted }}>Name</th>
              <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider"
                  style={{ color: css.textMuted }}>Group</th>
              <th className="px-3 py-2 text-right font-semibold uppercase tracking-wider"
                  style={{ color: css.textMuted }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center" style={{ color: css.textMuted }}>
                  <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
                  Loading students…
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center" style={{ color: css.textMuted }}>
                  No students match the current filter.
                </td>
              </tr>
            )}
            {!loading && filtered.map((s) => {
              const inactive = !s.is_active;
              return (
                <tr key={s.student_id}
                    data-testid={`student-row-${s.clean_id}`}
                    style={{ borderTop: `1px solid ${css.border}`,
                             opacity: inactive ? 0.55 : 1 }}>
                  <td className="px-3 py-2 font-mono" style={{ color: css.text }}>
                    {s.clean_id}{inactive ? " ✗" : ""}
                  </td>
                  <td className="px-3 py-2" style={{ color: css.text }}>
                    {inactive ? <em>(inactive)</em> : s.display_name}
                  </td>
                  <td className="px-3 py-2" style={{ color: css.text }}>
                    {s.group || "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {inactive ? (
                      <button
                        onClick={() => onReuse(s)}
                        data-testid={`student-reuse-${s.clean_id}`}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold uppercase tracking-wider"
                        style={{ background: "rgba(212,168,67,0.18)", color: "#D4A843",
                                 border: "1px solid rgba(212,168,67,0.4)" }}
                      >
                        Reuse ID
                      </button>
                    ) : (
                      <div className="inline-flex gap-1.5">
                        <button
                          onClick={() => setConfirmReset(s)}
                          disabled={busyId === s.student_id}
                          data-testid={`student-reset-${s.clean_id}`}
                          title="Reset password"
                          className="rounded-md p-1.5 transition"
                          style={{ background: "rgba(212,168,67,0.12)", color: "#D4A843",
                                   border: "1px solid rgba(212,168,67,0.3)" }}
                        >
                          <RotateCcw className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => setConfirmDeact(s)}
                          disabled={busyId === s.student_id}
                          data-testid={`student-deact-${s.clean_id}`}
                          title="Deactivate"
                          className="rounded-md p-1.5 transition"
                          style={{ background: "rgba(239,68,68,0.12)", color: css.danger,
                                   border: "1px solid rgba(239,68,68,0.3)" }}
                        >
                          <XCircle className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* confirm dialogs */}
      {confirmDeact && (
        <ConfirmDialog
          testId="confirm-deactivate"
          title="Deactivate student?"
          body={`Deactivate ${confirmDeact.clean_id} (${confirmDeact.display_name})? Their ID can be reused for a new student.`}
          danger
          onCancel={() => setConfirmDeact(null)}
          onConfirm={async () => {
            setBusyId(confirmDeact.student_id);
            try { await onDeactivate(confirmDeact); }
            finally { setBusyId(null); setConfirmDeact(null); }
          }}
        />
      )}
      {confirmReset && (
        <ConfirmDialog
          testId="confirm-reset"
          title="Reset password?"
          body={`Reset password for ${confirmReset.clean_id}? All active sessions will be logged out.`}
          onCancel={() => setConfirmReset(null)}
          onConfirm={async () => {
            setBusyId(confirmReset.student_id);
            try { await onReset(confirmReset); }
            finally { setBusyId(null); setConfirmReset(null); }
          }}
        />
      )}
    </div>
  );
}

/* ─────────────────────────  create view  ────────────────────────────── */
function CreateForm({ onCancel, onCreated }) {
  const [cleanId, setCleanId] = useState(() => {
    try { return sessionStorage.getItem("v10_reuse_clean_id") || ""; }
    catch { return ""; }
  });
  const [displayName, setDisplayName] = useState("");
  const [group, setGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    return () => { try { sessionStorage.removeItem("v10_reuse_clean_id"); } catch { /* ignore */ } };
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const id = cleanId.trim().toLowerCase();
    const name = displayName.trim();
    if (!id || !name) { setError("Student ID and Full Name are required."); return; }
    setBusy(true);
    try {
      const r = await createStudent({ cleanId: id, displayName: name, group: group.trim() });
      onCreated(r);
    } catch (err) {
      if (err.status === 409) setError("This ID is already active. Deactivate it first to reuse.");
      else setError(err.message || "Failed to create student.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} data-testid="student-create-form" className="space-y-4 max-w-md">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onCancel} data-testid="student-create-cancel"
                className="rounded-md p-1.5"
                style={{ background: "rgba(255,255,255,0.04)",
                         border: `1px solid ${css.border}`, color: css.text }}>
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <h3 className="text-[14px] font-semibold" style={{ color: css.text }}>
          New Student
        </h3>
      </div>

      <Field label="Student ID" hint="Lowercase. Example: stu042">
        <input
          type="text"
          value={cleanId}
          onChange={(e) => setCleanId(e.target.value)}
          placeholder="stu042"
          autoComplete="off"
          data-testid="student-create-id"
          className="w-full rounded-lg px-3 py-2 text-[13px] font-mono"
          style={inputStyle}
        />
      </Field>

      <Field label="Full Name">
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Daravuth Sok"
          data-testid="student-create-name"
          className="w-full rounded-lg px-3 py-2 text-[13px]"
          style={inputStyle}
        />
      </Field>

      <Field label="Group" hint="Optional">
        <input
          type="text"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          placeholder="A"
          data-testid="student-create-group"
          className="w-full rounded-lg px-3 py-2 text-[13px]"
          style={inputStyle}
        />
      </Field>

      {error && (
        <div className="rounded-xl px-3 py-2.5 text-[12px] border"
             style={{ background: "rgba(239,68,68,0.08)",
                      borderColor: "rgba(239,68,68,0.35)", color: css.danger }}
             data-testid="student-create-error">
          <AlertTriangle className="inline h-3.5 w-3.5 mr-1" />
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={busy}
        data-testid="student-create-submit"
        className="inline-flex items-center gap-2 rounded-full px-5 py-2 text-[12px] font-bold uppercase tracking-wider transition disabled:opacity-60"
        style={{ background: css.aurora, color: "#1a1420",
                 border: "1px solid rgba(255,225,154,0.6)",
                 boxShadow: "0 6px 14px rgba(212,168,67,0.35)" }}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
        Create Student
      </button>
    </form>
  );
}

/* ─────────────────────────  credential card view  ───────────────────── */
function CredentialCard({ credential, onDone }) {
  const [copied, setCopied] = useState(false);

  const text = useMemo(() => {
    const url = credential.login_url || "https://eduhub-studio-test.vercel.app";
    return [
      "EduHub Login",
      `Login ID : ${credential.clean_id}`,
      `Name     : ${credential.display_name}`,
      `Password : ${credential.password}`,
      `URL      : ${url}`,
    ].join("\n");
  }, [credential]);

  const copyAll = async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* ignore */ }
  };

  return (
    <div data-testid="student-credential-card" className="max-w-md">
      <div className="rounded-2xl overflow-hidden"
           style={{ border: `1px solid ${css.border}`, background: css.card }}>
        <div className="px-5 py-3 flex items-center gap-2"
             style={{ borderBottom: `1px solid ${css.border}`,
                      background: "rgba(74,222,128,0.06)" }}>
          <ShieldCheck className="h-4 w-4" style={{ color: css.good }} />
          <span className="text-[13px] font-semibold" style={{ color: css.text }}>
            Student {credential.action === "reactivated" ? "Reactivated" : credential.password ? "Created" : "Updated"}
          </span>
        </div>

        <div className="px-5 py-4 space-y-2 text-[12.5px] font-mono"
             data-testid="credential-body" style={{ color: css.text }}>
          <Row label="Login ID" value={credential.clean_id} />
          <Row label="Name"     value={credential.display_name} />
          <Row label="Password" value={credential.password} emphasis />
          <Row label="URL"      value={credential.login_url || "https://eduhub-studio-test.vercel.app"} />
        </div>

        <div className="px-5 pb-4 flex items-center gap-2">
          <button
            onClick={copyAll}
            data-testid="credential-copy-all"
            className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider"
            style={{ background: "rgba(212,168,67,0.18)", color: "#D4A843",
                     border: "1px solid rgba(212,168,67,0.4)" }}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy All"}
          </button>
          <button
            onClick={onDone}
            data-testid="credential-done"
            className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider"
            style={{ background: css.aurora, color: "#1a1420",
                     border: "1px solid rgba(255,225,154,0.6)" }}
          >
            Done
          </button>
        </div>

        <div className="px-5 py-3 flex items-start gap-2 text-[11.5px]"
             style={{ background: "rgba(251,191,36,0.08)",
                      borderTop: `1px solid ${css.border}`,
                      color: css.warn }}
             data-testid="credential-warning">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            Save this now. The password is shown <strong>once</strong> and
            will never be retrievable again. It is not stored on the server
            in plaintext.
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────  small primitives  ───────────────────────── */
function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-bold uppercase tracking-wider mb-1.5"
            style={{ color: css.textMuted }}>
        {label}{hint && <span className="ml-2 font-normal opacity-70">— {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Row({ label, value, emphasis }) {
  return (
    <div className="flex">
      <span className="w-20 shrink-0" style={{ color: css.textMuted }}>
        {label}
      </span>
      <span style={{ color: emphasis ? "#FFE19A" : css.text,
                     fontWeight: emphasis ? 700 : 400 }}>
        : {value}
      </span>
    </div>
  );
}

function ConfirmDialog({ title, body, danger, onCancel, onConfirm, testId }) {
  const [busy, setBusy] = useState(false);
  return (
    <div data-testid={testId} className="fixed inset-0 z-50 flex items-center justify-center p-4"
         style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)" }}
         onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()}
           className="rounded-2xl max-w-sm w-full p-5"
           style={{ background: css.bg, border: `1px solid ${css.borderStrong}` }}>
        <h4 className="text-[13.5px] font-semibold mb-2" style={{ color: css.text }}>
          {title}
        </h4>
        <p className="text-[12px] leading-relaxed mb-4" style={{ color: css.textMuted }}>
          {body}
        </p>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} disabled={busy}
                  data-testid={`${testId}-cancel`}
                  className="rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider"
                  style={{ background: "rgba(255,255,255,0.04)",
                           border: `1px solid ${css.border}`, color: css.text }}>
            Cancel
          </button>
          <button
            onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}
            disabled={busy}
            data-testid={`${testId}-confirm`}
            className="rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider inline-flex items-center gap-1.5"
            style={{
              background: danger ? "rgba(239,68,68,0.18)" : css.aurora,
              color: danger ? css.danger : "#1a1420",
              border: danger ? "1px solid rgba(239,68,68,0.4)" : "1px solid rgba(255,225,154,0.6)",
            }}
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
