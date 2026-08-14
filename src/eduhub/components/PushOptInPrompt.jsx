/**
 * PushOptInPrompt.jsx
 *
 * A one-time, friendly slide-in banner that asks the student to enable
 * push notifications shortly after they log in. Designed for high opt-in
 * without being spammy:
 *
 *   • Shows ONLY when:
 *       - browser supports push
 *       - user is logged in (studentId provided)
 *       - user has NOT yet subscribed
 *       - user has NOT permanently denied notifications
 *       - user has NOT dismissed in the last 7 days
 *   • Slides in 4 seconds after mount (after the page has settled)
 *   • Two clear actions: "Yes, enable" (cyan, prominent) or "Maybe later"
 *   • Closing or "Later" → 7-day cool-down before re-asking
 *   • "Never" (long-press / advanced) → permanent dismiss
 *   • Reinforces the value: 3 concrete benefits the student gets
 *
 * Uses the existing usePushNotifications hook — same enable() that the
 * header bell calls. Zero duplication of subscription logic.
 *
 * Usage (in Dashboard.jsx — already imports the hook):
 *   <PushOptInPrompt studentId={student?.studentId} group={student?.group} />
 */
import { useEffect, useState } from "react";
import { Bell, X, Sparkles, Calendar, Trophy } from "lucide-react";
import usePushNotifications from "../hooks/usePushNotifications";

const STORAGE_KEY = "eduhub:push-opt-in-snooze-v1";
const SNOOZE_DAYS = 7;
const SHOW_DELAY_MS = 4000; // wait 4s after mount so it doesn't feel spammy

function isSnoozed() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (!v) return false;
    if (v === "never") return true;
    const ts = parseInt(v, 10);
    if (Number.isNaN(ts)) return false;
    return Date.now() - ts < SNOOZE_DAYS * 24 * 60 * 60 * 1000;
  } catch { return false; }
}

function snooze(value) {
  try { localStorage.setItem(STORAGE_KEY, value); } catch { /* ignore */ }
}

export default function PushOptInPrompt({ studentId, group }) {
  const { enabled, supported, permission, enable } =
    usePushNotifications(studentId, group || "default");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null); // "ok" | "denied"

  useEffect(() => {
    if (!supported || !studentId) return;
    if (enabled) return;
    if (permission === "denied") return; // already permanently denied at OS level
    if (isSnoozed()) return;

    const t = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => clearTimeout(t);
  }, [supported, studentId, enabled, permission]);

  if (!visible) return null;

  const onEnable = async () => {
    setBusy(true);
    try {
      const ok = await enable();
      if (ok) {
        setFeedback("ok");
        setTimeout(() => setVisible(false), 1600);
      } else {
        setFeedback("denied");
        snooze(String(Date.now()));
        setTimeout(() => setVisible(false), 2200);
      }
    } finally {
      setBusy(false);
    }
  };

  const onLater = () => {
    snooze(String(Date.now()));
    setVisible(false);
  };

  const onNever = () => {
    snooze("never");
    setVisible(false);
  };

  return (
    <>
      <style>{`
        @keyframes eduhub-push-slide {
          from { transform: translateY(140%); opacity: 0; }
          to   { transform: translateY(0);      opacity: 1; }
        }
        @keyframes eduhub-push-ring {
          0%,40%,100% { transform: rotate(0); }
          10%,30%     { transform: rotate(-14deg); }
          20%         { transform: rotate(14deg); }
        }
        .eh-push-card { animation: eduhub-push-slide 380ms cubic-bezier(.2,.9,.3,1.2); }
        .eh-push-bell { animation: eduhub-push-ring 1.6s ease-in-out infinite; transform-origin: top center; }
      `}</style>
      <div
        data-testid="push-opt-in-prompt"
        className="eh-push-card fixed z-[80] left-1/2 -translate-x-1/2 bottom-[max(20px,env(safe-area-inset-bottom))] sm:left-auto sm:translate-x-0 sm:right-5 w-[min(94vw,380px)] rounded-2xl overflow-hidden"
        style={{
          background: "linear-gradient(135deg, rgba(10,10,15,0.96) 0%, rgba(45,31,62,0.95) 100%)",
          border: "1px solid rgba(0,224,255,0.35)",
          boxShadow: "0 22px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,224,255,0.10) inset, 0 0 50px rgba(0,224,255,0.18)",
          fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
          color: "#F4E5C1",
          backdropFilter: "blur(22px)",
        }}
      >
        <button
          onClick={onLater}
          aria-label="Close"
          data-testid="push-opt-in-close"
          className="absolute top-2 right-2 w-7 h-7 rounded-full grid place-items-center"
          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.10)", color: "rgba(244,229,193,0.6)" }}
        >
          <X className="w-3.5 h-3.5" />
        </button>

        <div className="px-5 pt-5 pb-4">
          <div className="flex items-start gap-3 mb-3">
            <div
              className="shrink-0 w-11 h-11 rounded-xl grid place-items-center"
              style={{
                background: "linear-gradient(135deg, #00e0ff 0%, #9b5cff 60%, #ff3da6 100%)",
                boxShadow: "0 0 22px rgba(0,224,255,0.45)",
              }}
            >
              <Bell className="eh-push-bell w-5 h-5" style={{ color: "#0a0a0f" }} strokeWidth={2.4} />
            </div>
            <div className="min-w-0">
              <div className="text-[15px] font-bold leading-tight" style={{ color: "#fff" }}>
                Stay in the loop, <span style={{ color: "#00e0ff" }}>{shortName(studentId)}</span>
              </div>
              <div className="text-[12px] mt-0.5" style={{ color: "rgba(244,229,193,0.66)" }}>
                Turn on notifications so you never miss what matters.
              </div>
            </div>
          </div>

          <ul className="grid gap-2 mb-4">
            <Bullet icon={Calendar} text="Pre-class reminders 30 min before lessons" />
            <Bullet icon={Sparkles} text="Be first to know when teachers post new chapters" />
            <Bullet icon={Trophy}  text="Streak protection — never lose a daily-spin streak" />
          </ul>

          {feedback === "ok" && (
            <div className="text-[12px] font-semibold mb-2" data-testid="push-opt-in-success"
                 style={{ color: "#34d399" }}>
              ✓ You're all set — first reminder coming soon.
            </div>
          )}
          {feedback === "denied" && (
            <div className="text-[12px] mb-2" data-testid="push-opt-in-denied"
                 style={{ color: "#fca5a5" }}>
              Notifications blocked at the system level. You can re-enable in Settings.
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={onEnable}
              disabled={busy}
              data-testid="push-opt-in-enable"
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-full py-2.5 text-[12px] font-bold uppercase tracking-wider transition"
              style={{
                background: "linear-gradient(135deg, #00e0ff 0%, #9b5cff 60%, #ff3da6 100%)",
                color: "#0a0a0f",
                border: "1px solid rgba(255,255,255,0.18)",
                boxShadow: "0 6px 20px rgba(0,224,255,0.35)",
                opacity: busy ? 0.7 : 1,
              }}
            >
              <Bell className="w-3.5 h-3.5" />
              {busy ? "Enabling…" : "Enable notifications"}
            </button>
            <button
              onClick={onLater}
              data-testid="push-opt-in-later"
              className="px-3 py-2.5 rounded-full text-[11px] font-bold uppercase tracking-wider"
              style={{
                background: "rgba(255,255,255,0.04)",
                color: "rgba(244,229,193,0.72)",
                border: "1px solid rgba(255,255,255,0.10)",
              }}
            >
              Later
            </button>
          </div>

          <button
            onClick={onNever}
            data-testid="push-opt-in-never"
            className="block mx-auto mt-3 text-[10.5px] font-medium tracking-wide"
            style={{ color: "rgba(244,229,193,0.40)" }}
          >
            Don't ask again
          </button>
        </div>
      </div>
    </>
  );
}

function Bullet({ icon: Icon, text }) {
  return (
    <li className="flex items-start gap-2.5 text-[12.5px] leading-snug"
        style={{ color: "rgba(244,229,193,0.86)" }}>
      <Icon className="shrink-0 w-3.5 h-3.5 mt-0.5" style={{ color: "#00e0ff" }} />
      <span>{text}</span>
    </li>
  );
}

function shortName(studentId) {
  if (!studentId) return "friend";
  const s = String(studentId);
  return s.length <= 8 ? s : s.slice(0, 6) + "…";
}
