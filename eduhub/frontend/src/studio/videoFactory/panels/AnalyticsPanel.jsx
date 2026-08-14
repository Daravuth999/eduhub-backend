/**
 * AnalyticsPanel.jsx — Analytics stage: real production numbers for one
 * lesson from the backend stats route (owners, revenue, learners,
 * completions, average progress, bookmarks). Purchase-state breakdown
 * surfaces reconcile-parked attempts so authors see financial health too.
 */
import { useEffect, useState } from "react";
import { BarChart3, Loader2, Users, Coins, CheckCircle2, Bookmark } from "lucide-react";
import { getLessonStats } from "../videoLibraryApi";

const GOLD = "#D4A843";

function Stat({ Icon, label, value, accent }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
      <div className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider text-faded mb-1.5">
        <Icon size={11} style={{ color: accent || GOLD }} /> {label}
      </div>
      <div className="text-xl font-bold text-parchment tabular-nums">{value}</div>
    </div>
  );
}

export default function AnalyticsPanel({ lesson }) {
  const [stats, setStats] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    getLessonStats(lesson.lessonId)
      .then((s) => { if (alive) setStats(s); })
      .catch((e) => { if (alive) setErr(e.message || "Could not load stats."); });
    return () => { alive = false; };
  }, [lesson.lessonId]);

  if (err) return <div className="text-xs text-red-400" data-testid="analytics-error">{err}</div>;
  if (!stats) {
    return <div className="flex items-center gap-2 text-xs text-faded p-4"><Loader2 size={13} className="animate-spin" /> Loading analytics…</div>;
  }

  const states = stats.purchases || {};
  return (
    <div className="space-y-4" data-testid="production-analytics-panel">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat Icon={Users} label="Owners" value={stats.owners} />
        <Stat Icon={Coins} label="Revenue (points)" value={stats.revenuePoints} />
        <Stat Icon={Users} label="Learners started" value={stats.learners} accent="#93c5fd" />
        <Stat Icon={CheckCircle2} label="Completions" value={stats.completions} accent="#6ee7b7" />
        <Stat Icon={BarChart3} label="Avg progress" value={`${Math.round((stats.avgProgress || 0) * 100)}%`} />
        <Stat Icon={Bookmark} label="Bookmarks" value={stats.bookmarks} />
      </div>

      {Object.keys(states).length > 0 && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5" data-testid="analytics-purchase-states">
          <div className="text-[10.5px] font-bold uppercase tracking-wider text-faded mb-2">Purchase attempts by state</div>
          <div className="flex items-center gap-2 flex-wrap">
            {Object.entries(states).map(([state, count]) => (
              <span key={state} className="text-[11px] px-2 py-0.5 rounded-full border tabular-nums"
                    style={state === "succeeded" ? { color: "#6ee7b7", borderColor: "rgba(52,211,153,0.35)" }
                      : state === "reconcile" ? { color: "#fbbf24", borderColor: "rgba(245,158,11,0.4)" }
                        : { color: "rgba(255,255,255,0.5)", borderColor: "rgba(255,255,255,0.12)" }}>
                {state}: {count}
              </span>
            ))}
          </div>
          {states.reconcile > 0 && (
            <div className="text-[10.5px] text-amber-300/80 mt-2">
              {states.reconcile} purchase(s) awaiting reconciliation — resolve them from the Video Factory home.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
