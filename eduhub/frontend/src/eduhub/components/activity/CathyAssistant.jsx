/**
 * CathyAssistant.jsx — small premium assistant surface on the dashboard.
 *
 * Shows the single latest UNREAD important real event (critical / important /
 * achievement, last 48 h). Dismissible (per-notification, localStorage).
 * Renders nothing when no qualifying real event exists — never fabricates.
 */
import { Sparkles, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useNotifications } from "../../context/NotificationContext";
import { priorityStyle, relativeTime } from "./activityTheme";

const LS_KEY = "eduhub_cathy_dismissed_v1";
const WINDOW_MS = 48 * 3600 * 1000;

function loadDismissed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(LS_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

export default function CathyAssistant() {
  const ctx = useNotifications();
  const [dismissed, setDismissed] = useState(loadDismissed);

  const highlight = useMemo(() => {
    const now = Date.now();
    return (ctx?.items || []).find(
      (n) =>
        !n.read &&
        !dismissed.has(n.id) &&
        n.priority !== "normal" &&
        now - new Date(n.createdAt).getTime() < WINDOW_MS,
    );
  }, [ctx?.items, dismissed]);

  if (!ctx || !highlight) return null;
  const pri = priorityStyle(highlight.priority);

  const dismiss = () => {
    const next = new Set(dismissed);
    next.add(highlight.id);
    setDismissed(next);
    try {
      localStorage.setItem(LS_KEY, JSON.stringify([...next].slice(-40)));
    } catch { /* ignore */ }
  };

  return (
    <div className="px-4 mt-2" data-testid="cathy-assistant">
      <style>{`
        @keyframes eduhub-cathy-in {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-testid="cathy-assistant"] * { animation: none !important; }
        }
      `}</style>
      <div
        className="eh-cathy-card relative rounded-2xl border p-4 flex items-start gap-3 overflow-hidden"
        style={{
          animation: "eduhub-cathy-in 0.45s ease-out",
          borderColor: pri.ring,
          boxShadow: `0 4px 24px ${pri.bg}`,
        }}
      >
        <span
          className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border"
          style={{ background: "rgba(155,92,255,0.18)", borderColor: "rgba(155,92,255,0.45)" }}
        >
          <Sparkles className="w-4.5 h-4.5 text-aurora-violet" style={{ width: 18, height: 18 }} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-aurora-violet">Cathy</span>
            <span
              className="text-[8.5px] font-bold uppercase tracking-wider px-1.5 py-[1px] rounded-full"
              style={{ color: pri.accent, background: pri.bg, border: `1px solid ${pri.ring}` }}
            >
              {pri.label}
            </span>
            <span className="text-[9.5px] text-white/55">{relativeTime(highlight.createdAt)}</span>
          </div>
          <button
            onClick={() => {
              ctx.markRead(highlight.id);
              ctx.openDrawer();
            }}
            data-testid="cathy-assistant-open-btn"
            className="block text-left mt-1 w-full"
          >
            <p className="text-[13px] font-semibold text-white leading-snug">{highlight.title}</p>
            <p className="text-[11.5px] text-white/70 mt-0.5 line-clamp-2">{highlight.body}</p>
          </button>
        </div>
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          data-testid="cathy-assistant-dismiss-btn"
          className="w-6 h-6 rounded-md flex items-center justify-center text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
