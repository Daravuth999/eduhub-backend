/**
 * RuntimeDashboardStudio.jsx — Author Studio's "Runtime Dashboard"
 * (architecture.md continuation: "active/upcoming/finished events,
 * participants, prize pools, event health, realtime status"). A
 * read-only operational view over event_engine.py's Event Engine — no
 * lifecycle actions live here; use the Event Templates screen to create/
 * transition events. This screen is for scanning what's happening RIGHT
 * NOW across every event, not managing any single one.
 *
 * Backend: event_engine.py's get_runtime_dashboard, mounted at
 * GET /api/v1/events/dashboard.
 */
import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw, Users, Coins, Radio } from "lucide-react";
import { getEventsRuntimeDashboard } from "./api";

function Badge({ children, color = "muted" }) {
  const colors = {
    gold:  { bg: "rgba(212,168,67,0.15)",  border: "rgba(212,168,67,0.4)",  text: "#FFE19A" },
    green: { bg: "rgba(52,211,153,0.12)",  border: "rgba(52,211,153,0.35)", text: "#6ee7b7" },
    red:   { bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.35)", text: "#fca5a5" },
    blue:  { bg: "rgba(96,165,250,0.12)",  border: "rgba(96,165,250,0.3)",  text: "#93c5fd" },
    muted: { bg: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.12)", text: "#9ca3af" },
  };
  const c = colors[color] || colors.muted;
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.text }}>
      {children}
    </span>
  );
}

const HEALTH_COLOR = {
  healthy: "green", no_registrations: "red", not_started: "muted",
  completed: "blue", cancelled: "muted",
};
const HEALTH_LABEL = {
  healthy: "Healthy", no_registrations: "No registrations yet", not_started: "Not started",
  completed: "Completed", cancelled: "Cancelled",
};

/** The REAL available reward amount for an event — the live pool balance
 * when the backend reports one, the entry-fee estimate otherwise. */
function poolAmount(event) {
  return typeof event.prize_pool_balance === "number"
    ? event.prize_pool_balance
    : (event.estimated_prize_pool ?? 0);
}

function EventCard({ event }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4" data-testid={`runtime-dashboard-event-${event._id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-parchment">{event.template_name}</span>
          <Badge color="gold">{event.state}</Badge>
          <Badge color={HEALTH_COLOR[event.health] || "muted"}>{HEALTH_LABEL[event.health] || event.health}</Badge>
          {event.realtime_active && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-red-400">
              <Radio className="h-3 w-3 animate-pulse" /> Live
            </span>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-faded">
        <span className="inline-flex items-center gap-1">
          <Users className="h-3.5 w-3.5" /> {event.participant_count} participant{event.participant_count === 1 ? "" : "s"}
        </span>
        <span className="inline-flex items-center gap-1">
          <Coins className="h-3.5 w-3.5" />
          {typeof event.prize_pool_balance === "number"
            ? `${event.prize_pool_balance} pts reward pool`
            : `~${event.estimated_prize_pool} pts reward pool`}
        </span>
        <span>{event.lucky_code_count ?? 0} lucky codes</span>
        <span>{event.winner_count ?? 0} winners</span>
        {event.schedule && <span>Schedule {event.schedule}</span>}
      </div>
    </div>
  );
}

function Section({ title, events, testid, emptyText }) {
  return (
    <div>
      <div className="text-sm font-semibold text-parchment mb-2">{title} ({events.length})</div>
      {events.length === 0 ? (
        <div className="text-sm text-faded">{emptyText}</div>
      ) : (
        <div className="space-y-3" data-testid={testid}>
          {events.map((e) => <EventCard key={e._id} event={e} />)}
        </div>
      )}
    </div>
  );
}

/* ── Main panel ───────────────────────────────────────────────────────── */
export default function RuntimeDashboardStudio() {
  const [dashboard, setDashboard] = useState({ active: [], upcoming: [], finished: [] });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await getEventsRuntimeDashboard();
      setDashboard({ active: data.active || [], upcoming: data.upcoming || [], finished: data.finished || [] });
    } catch (e) {
      setErr(e.message || "Failed to load runtime dashboard.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const totalParticipants = [...dashboard.active, ...dashboard.upcoming]
    .reduce((sum, e) => sum + (e.participant_count || 0), 0);
  const totalPrizePool = [...dashboard.active, ...dashboard.upcoming]
    .reduce((sum, e) => sum + poolAmount(e), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-parchment flex items-center gap-2">
            <Activity className="h-5 w-5" /> Runtime Dashboard
          </h2>
          <p className="text-xs text-faded">
            Everything happening right now across every event. Read-only — use Event Templates to create or transition events.
          </p>
        </div>
        <button onClick={reload} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-faded hover:text-parchment hover:bg-white/10">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {err && <div className="text-xs text-red-400">{err}</div>}

      {loading ? (
        <div className="text-sm text-faded">Loading…</div>
      ) : (
        <>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 flex flex-wrap gap-6" data-testid="runtime-dashboard-summary">
            <div>
              <div className="text-xs text-faded">Active events</div>
              <div className="text-xl font-bold text-parchment">{dashboard.active.length}</div>
            </div>
            <div>
              <div className="text-xs text-faded">Total participants</div>
              <div className="text-xl font-bold text-parchment">{totalParticipants}</div>
            </div>
            <div>
              <div className="text-xs text-faded">Total reward pool</div>
              <div className="text-xl font-bold text-parchment">{totalPrizePool} pts</div>
            </div>
          </div>

          <Section title="Active" events={dashboard.active} testid="runtime-dashboard-active"
                    emptyText="No events are currently active." />
          <Section title="Upcoming" events={dashboard.upcoming} testid="runtime-dashboard-upcoming"
                    emptyText="No events are scheduled yet." />
          <Section title="Finished" events={dashboard.finished} testid="runtime-dashboard-finished"
                    emptyText="No events have finished yet." />
        </>
      )}
    </div>
  );
}
