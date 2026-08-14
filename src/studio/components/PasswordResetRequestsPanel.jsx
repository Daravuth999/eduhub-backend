/**
 * PasswordResetRequestsPanel.jsx — Milestone 4 (Authentication Completion,
 * Phase 1): teacher-assisted password reset queue.
 *
 * Shows pending "forgot password" requests students have flagged from the
 * login screen. Each row's "Reset & Resolve" button reuses the EXISTING
 * resetStudentPassword() call StudentManager already uses (no duplicated
 * reset logic), then dismisses the queue entry. No email/SMS is sent by
 * this panel — the teacher still hands the shown credential to the
 * student directly, exactly as the existing Reset Password flow works.
 */
import { useCallback, useEffect, useState } from "react";
import { Bell, Loader2, RotateCcw } from "lucide-react";
import {
  listPasswordResetRequests,
  dismissPasswordResetRequest,
  resetStudentPassword,
} from "../../eduhub/auth/studentAuthService";

const css = {
  card: "rgba(255,255,255,0.04)",
  border: "rgba(255,255,255,0.08)",
  text: "#F4E5C1",
  textMuted: "rgba(244,229,193,0.55)",
  aurora: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
};

export default function PasswordResetRequestsPanel({ onCredential }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(() => {
    setLoading(true);
    listPasswordResetRequests()
      .then((rows) => setRequests(rows))
      .catch((e) => setError(e.message || "Failed to load requests"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!loading && requests.length === 0) return null;

  return (
    <div
      data-testid="password-reset-requests-panel"
      className="rounded-xl px-3 py-2.5 space-y-2"
      style={{ border: `1px solid ${css.border}`, background: css.card }}
    >
      <div className="flex items-center gap-2">
        <Bell className="h-3.5 w-3.5" style={{ color: "#D4A843" }} />
        <span className="text-[12px] font-semibold" style={{ color: css.text }}>
          Password Reset Requests
        </span>
        {requests.length > 0 && (
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-bold"
            style={{ background: css.aurora, color: "#1a1420" }}
          >
            {requests.length}
          </span>
        )}
      </div>

      {error && (
        <p className="text-[11px]" style={{ color: "rgba(239,68,68,0.9)" }}>
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-[11px]" style={{ color: css.textMuted }}>Loading…</p>
      ) : (
        <ul className="space-y-1.5">
          {requests.map((r) => (
            <li
              key={r.request_id}
              data-testid="password-reset-request-row"
              className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5"
              style={{ background: "rgba(255,255,255,0.03)" }}
            >
              <span className="text-[11px]" style={{ color: css.text }}>
                <strong>{r.display_name}</strong>{" "}
                <span style={{ color: css.textMuted }}>({r.clean_id})</span>
              </span>
              <button
                type="button"
                disabled={busyId === r.request_id}
                data-testid="password-reset-request-resolve-btn"
                onClick={async () => {
                  setBusyId(r.request_id);
                  setError(null);
                  try {
                    const cred = await resetStudentPassword(r.student_id);
                    await dismissPasswordResetRequest(r.request_id);
                    if (onCredential) onCredential(cred);
                    refresh();
                  } catch (e) {
                    setError(e.message || "Failed to resolve request");
                  } finally {
                    setBusyId(null);
                  }
                }}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider"
                style={{ background: css.aurora, color: "#1a1420" }}
              >
                {busyId === r.request_id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
                Reset &amp; Resolve
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
