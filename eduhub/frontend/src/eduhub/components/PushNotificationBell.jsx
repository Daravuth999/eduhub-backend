/**
 * PushNotificationBell.jsx
 *
 * Drop-in bell button that lets students opt in / out of push notifications.
 * Uses the already-committed usePushNotifications hook from
 * src/eduhub/hooks/usePushNotifications.js — no other changes needed.
 *
 * Usage:
 *   import PushNotificationBell from "./PushNotificationBell";
 *   {isAuthenticated && <PushNotificationBell studentId={student?.studentId} group={student?.group} />}
 */
import { Bell, BellOff, BellRing, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import usePushNotifications from "../hooks/usePushNotifications";

export default function PushNotificationBell({ studentId, group }) {
  const { enabled, supported, permission, enable, disable } =
    usePushNotifications(studentId, group || "default");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null); // "enabled" | "denied" | "disabled"

  const handleClick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (enabled) {
        await disable();
        setFeedback("disabled");
      } else {
        const ok = await enable();
        if (ok) setFeedback("enabled");
        else if (Notification.permission === "denied") setFeedback("denied");
        else setFeedback("denied");
      }
      setTimeout(() => setFeedback(null), 2400);
    } finally {
      setBusy(false);
    }
  }, [busy, enabled, enable, disable]);

  // Hide silently if browser can't do push or user permanently blocked
  if (!supported) return null;
  if (permission === "denied" && !enabled) return null;

  const label = enabled ? "Disable notifications" : "Enable notifications";
  const Icon = busy ? Loader2 : enabled ? BellRing : Bell;
  const showAttention = !enabled && !busy && permission !== "denied";

  return (
    <div className="relative inline-flex items-center" data-testid="push-bell-wrap">
      <style>{`
        @keyframes eduhub-bell-attn {
          0%,100% { box-shadow: 0 0 0 0 rgba(0,224,255,0.55); }
          50%     { box-shadow: 0 0 0 7px rgba(0,224,255,0); }
        }
      `}</style>
      <button
        onClick={handleClick}
        disabled={busy}
        title={label}
        aria-label={label}
        data-testid="push-bell-btn"
        style={showAttention ? { animation: "eduhub-bell-attn 2.2s ease-in-out infinite" } : undefined}
        className={[
          "relative w-[34px] h-[34px] rounded-[9px] border flex items-center justify-center transition",
          enabled
            ? "bg-aurora-cyan/15 border-aurora-cyan/50 text-aurora-cyan hover:shadow-[0_0_14px_rgba(0,224,255,0.5)]"
            : "bg-white/[0.05] border-white/[0.10] text-white/80 hover:bg-aurora-violet/15 hover:border-aurora-violet/60",
          busy ? "cursor-wait opacity-60" : "",
        ].join(" ")}
      >
        <Icon className={"w-3.5 h-3.5 " + (busy ? "animate-spin" : "")} />
        {enabled && !busy && (
          <span
            aria-hidden
            className="absolute top-[3px] right-[3px] w-[7px] h-[7px] rounded-full bg-emerald-400 ring-2 ring-[#0a0a0f]"
          />
        )}
      </button>

      {feedback && (
        <span
          data-testid="push-bell-feedback"
          className={[
            "pointer-events-none absolute top-full mt-2 right-0 whitespace-nowrap",
            "text-[10.5px] font-semibold tracking-wide px-2 py-1 rounded-md shadow-lg",
            feedback === "enabled"
              ? "bg-emerald-500/90 text-emerald-50"
              : feedback === "denied"
              ? "bg-rose-500/90 text-rose-50"
              : "bg-slate-700/90 text-slate-50",
          ].join(" ")}
        >
          {feedback === "enabled"
            ? "✓ Notifications on"
            : feedback === "denied"
            ? "Permission denied"
            : "Notifications off"}
        </span>
      )}
    </div>
  );
}
