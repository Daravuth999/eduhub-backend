/**
 * CathyInsight.jsx — Cathy's dedicated section inside the Activity Drawer.
 * Summarises the most recent IMPORTANT real activity (critical / important /
 * achievement priorities from the last 48 h). Renders nothing when no real
 * qualifying events exist — never invents messages.
 */
import { Sparkles } from "lucide-react";
import { priorityStyle, relativeTime } from "./activityTheme";

const WINDOW_MS = 48 * 3600 * 1000;

export default function CathyInsight({ items }) {
  const now = Date.now();
  const highlights = (items || [])
    .filter(
      (n) =>
        n.priority !== "normal" &&
        now - new Date(n.createdAt).getTime() < WINDOW_MS,
    )
    .slice(0, 3);

  if (!highlights.length) return null;

  return (
    <div
      data-testid="cathy-insight"
      className="rounded-2xl border border-aurora-violet/35 p-3 mb-3"
      style={{ background: "linear-gradient(135deg, rgba(155,92,255,0.12) 0%, rgba(0,224,255,0.06) 100%)" }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="w-6 h-6 rounded-full flex items-center justify-center bg-aurora-violet/25 border border-aurora-violet/50">
          <Sparkles className="w-3.5 h-3.5 text-aurora-violet" />
        </span>
        <span className="text-[11px] font-bold tracking-wide text-white">Cathy’s highlights</span>
      </div>
      <ul className="space-y-1.5">
        {highlights.map((n) => {
          const pri = priorityStyle(n.priority);
          return (
            <li key={n.id} className="flex items-start gap-2">
              <span className="mt-[6px] w-1.5 h-1.5 rounded-full shrink-0" style={{ background: pri.accent }} />
              <span className="text-[11.5px] text-white/75 leading-snug flex-1 min-w-0">
                <span className="font-semibold text-white/90">{n.title}</span>
                {" — "}
                {n.body}
              </span>
              <span className="text-[9.5px] text-white/30 shrink-0 mt-[2px]">{relativeTime(n.createdAt)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
