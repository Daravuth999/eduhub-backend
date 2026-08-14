/**
 * EventTemplatesStudio.jsx — Author Studio panel for the Event Engine
 * (architecture.md §4.3, Migration Phase 3 continuation). Speaking Lab is
 * the first event_type; this panel manages Event Templates (draft ->
 * published -> archived, publish-immutable, duplicate-to-edit) and lets
 * an operator create + run Events from a published template — without
 * editing any code, per the approved architecture's acceptance criteria.
 *
 * Backend: event_engine.py, mounted at /api/v1/event-templates* and
 * /api/v1/events*. Communicates via the same api.js request() helper and
 * lifecycle verbs (publish/unpublish/duplicate/archive) already
 * established by the Experience Configuration Platform panels
 * (WelcomeExperienceStudio.jsx, AchievementExperienceStudio.jsx).
 */
import { useCallback, useEffect, useState } from "react";
import {
  CalendarClock, Plus, RefreshCw, Copy, Archive, Send, Undo2,
  ChevronRight, ChevronDown, Play, Pause, Flag, XCircle, CheckCircle2,
} from "lucide-react";
import {
  listEventTemplates, createEventTemplate, updateEventTemplate,
  publishEventTemplate, unpublishEventTemplate, archiveEventTemplate,
  duplicateEventTemplate,
  listEvents, createEvent, transitionEvent,
  getPrizePoolForSession, getPrizePoolBalance, setTemplateRewardPool,
} from "./api";

function fmt(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}

function Badge({ children, color = "muted" }) {
  const colors = {
    gold:  { bg: "rgba(212,168,67,0.15)",  border: "rgba(212,168,67,0.4)",  text: "#FFE19A" },
    green: { bg: "rgba(52,211,153,0.12)",  border: "rgba(52,211,153,0.35)", text: "#6ee7b7" },
    red:   { bg: "rgba(255,100,100,0.12)", border: "rgba(255,100,100,0.3)", text: "#fca5a5" },
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

const TEMPLATE_STATUS_COLOR = { draft: "muted", published: "green", archived: "red" };
const EVENT_STATE_COLOR = {
  draft: "muted", scheduled: "blue", registration_open: "gold", live: "green",
  drawing: "gold", settling: "gold", settled: "blue", archived: "muted", cancelled: "red",
};
// Mirrors event_engine.py's _ALLOWED_TRANSITIONS — kept in sync manually;
// the backend is the actual source of truth and will reject anything not
// listed here, this is only used to decide which buttons to show.
const NEXT_STATES = {
  draft: ["scheduled", "cancelled"],
  scheduled: ["registration_open", "cancelled"],
  registration_open: ["live", "cancelled"],
  live: ["drawing", "cancelled"],
  drawing: ["settling", "cancelled"],
  settling: ["settled"],
  settled: ["archived"],
  cancelled: ["archived"],
};
const STATE_LABEL = {
  scheduled: "Schedule", registration_open: "Open Registration", live: "Go Live",
  drawing: "Start Draw", settling: "Settle", settled: "Mark Settled",
  archived: "Archive", cancelled: "Cancel",
};

/* ── Template create/edit form ───────────────────────────────────────── */
const BLANK_TEMPLATE_FORM = { name: "", entry_fee: "0", per_question_s: "", reward_points: "", num_winners: "", split: "" };

function parseSplit(raw) {
  return (raw || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/* Shared validation for the Reward Pool fields. Returns {error} or the
 * payload for setTemplateRewardPool (null when all fields are blank). */
function buildRewardPayload({ reward_points, num_winners, split }) {
  const points = reward_points === "" ? null : Number(reward_points);
  if (points !== null && (!Number.isInteger(points) || points < 0 || points > 100000)) {
    return { error: "Reward Pool must be an integer between 0 and 100000." };
  }
  const winners = num_winners ? Number(num_winners) : undefined;
  if (winners !== undefined && (!Number.isInteger(winners) || winners < 1 || winners > 3)) {
    return { error: "Number of winners must be 1, 2, or 3." };
  }
  const splitList = parseSplit(split);
  if (split.trim() && splitList.length === 0) {
    return { error: "Prize distribution must be comma-separated numbers, e.g. 50,30,20." };
  }
  if (points === null && winners === undefined && !splitList.length) return { payload: null };
  const payload = { points: points ?? 0 };
  if (winners !== undefined) payload.num_winners = winners;
  if (splitList.length) payload.split = splitList;
  return { payload };
}

/* The Reward Pool fields — the complete admin configuration. One Save and
 * the platform creates + funds the pool and links it to every future
 * session from this template automatically. No ids, no linking, no
 * separate funding screen. */
function RewardPoolFields({ form, set, testPrefix }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/10 p-3 space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-faded">
        Reward Pool
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1 text-xs text-faded">
          Reward Pool (PTS)
          <input type="number" min={0} value={form.reward_points}
                 placeholder="e.g. 500"
                 onChange={(e) => set("reward_points", e.target.value)}
                 data-testid={`${testPrefix}-reward-points-input`}
                 className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
          <span className="text-[10px] text-faded/70">
            Total points winners share. Funded automatically when you save.
          </span>
        </label>
        <label className="flex flex-col gap-1 text-xs text-faded">
          Number of Winners
          <input type="number" min={1} max={3} value={form.num_winners}
                 placeholder="Default: 3"
                 onChange={(e) => set("num_winners", e.target.value)}
                 data-testid={`${testPrefix}-num-winners-input`}
                 className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-faded">
          Prize Distribution (%)
          <input value={form.split} placeholder="e.g. 50,30,20"
                 onChange={(e) => set("split", e.target.value)}
                 data-testid={`${testPrefix}-split-input`}
                 className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
        </label>
      </div>
    </div>
  );
}

function TemplateForm({ initial, onSaved, onCancel }) {
  const [form, setForm] = useState(initial || BLANK_TEMPLATE_FORM);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const isEdit = !!initial?._id;

  const handleSubmit = async () => {
    setErr(null);
    if (!form.name.trim()) { setErr("Name is required."); return; }
    const entryFee = Number(form.entry_fee);
    if (!Number.isInteger(entryFee) || entryFee < 0 || entryFee > 500) {
      setErr("Entry fee must be an integer between 0 and 500.");
      return;
    }
    const reward = buildRewardPayload(form);
    if (reward.error) { setErr(reward.error); return; }
    const timers = form.per_question_s
      ? { per_question_s: Number(form.per_question_s) }
      : {};
    setSaving(true);
    try {
      let templateId = form._id;
      if (isEdit) {
        await updateEventTemplate(form._id, {
          name: form.name.trim(),
          runtime_defaults: { entry_fee: entryFee },
          timers,
        });
      } else {
        const resp = await createEventTemplate({
          name: form.name.trim(),
          event_type: "speaking_lab_session",
          runtime_defaults: { entry_fee: entryFee },
          timers,
        });
        templateId = resp?.template?._id;
      }
      // One Save does everything else automatically on the backend:
      // create the reward pool, fund it, and link it to every future
      // session from this template.
      if (templateId && reward.payload) {
        await setTemplateRewardPool(templateId, reward.payload);
      }
      onSaved();
    } catch (e) {
      setErr(e.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1 text-xs text-faded sm:col-span-2">
          Template name
          <input value={form.name} onChange={(e) => set("name", e.target.value)}
                 placeholder="Weekly Speaking Lab"
                 data-testid="event-template-name-input"
                 className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-faded">
          Entry fee (points, optional)
          <input type="number" min={0} max={500} value={form.entry_fee}
                 onChange={(e) => set("entry_fee", e.target.value)}
                 data-testid="event-template-entry-fee-input"
                 className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
          <span className="text-[10px] text-faded/70">
            Leave at 0 when using a Reward Pool — students join free.
          </span>
        </label>
      </div>

      <RewardPoolFields form={form} set={set} testPrefix="event-template" />

      <label className="flex flex-col gap-1 text-xs text-faded">
        Per-question timer (seconds, optional)
        <input type="number" min={0} value={form.per_question_s}
               onChange={(e) => set("per_question_s", e.target.value)}
               className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment sm:max-w-[220px]" />
      </label>

      {err && <div className="text-xs text-red-400">{err}</div>}
      <div className="flex items-center gap-2">
        <button disabled={saving} onClick={handleSubmit}
                data-testid="event-template-save-button"
                className="rounded-lg px-4 py-2 text-xs font-bold text-ink"
                style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}>
          {saving ? "Saving…" : isEdit ? "Save changes" : "Create template"}
        </button>
        {onCancel && (
          <button onClick={onCancel} className="rounded-lg px-3 py-2 text-xs text-faded hover:text-parchment">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Per-row Reward Pool editor — works on drafts AND published templates
 * (funding is an operational action, not versioned template content). */
function RewardPoolForm({ template, onSaved, onCancel }) {
  const policy = template.prize_policy || {};
  const [form, setForm] = useState({
    reward_points: policy.reward_pool_points != null ? String(policy.reward_pool_points) : "",
    num_winners: policy.num_winners ? String(policy.num_winners) : "",
    split: Array.isArray(policy.split) ? policy.split.join(",") : "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    setErr(null);
    const reward = buildRewardPayload(form);
    if (reward.error) { setErr(reward.error); return; }
    setSaving(true);
    try {
      await setTemplateRewardPool(template._id, reward.payload || { points: 0 });
      onSaved();
    } catch (e) {
      setErr(e.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <RewardPoolFields form={form} set={set} testPrefix={`reward-pool-${template._id}`} />
      {err && <div className="text-xs text-red-400">{err}</div>}
      <div className="flex items-center gap-2">
        <button disabled={saving} onClick={handleSave}
                data-testid={`reward-pool-save-${template._id}`}
                className="rounded-lg px-4 py-2 text-xs font-bold text-ink"
                style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={onCancel} className="rounded-lg px-3 py-2 text-xs text-faded hover:text-parchment">
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── Per-event pool readout — plain admin language only. The pool itself
 * is configured in ONE place (the template's Reward Pool section); this
 * just shows what the runtime will display. */
function EventPool({ event }) {
  const [pool, setPool] = useState(null);
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!event.linked_session_id) { setLoading(false); return undefined; }
    setLoading(true);
    getPrizePoolForSession(event.linked_session_id)
      .then((data) => {
        if (cancelled) return null;
        setPool(data.pool || null);
        return data.pool ? getPrizePoolBalance(data.pool._id) : null;
      })
      .then((b) => { if (!cancelled && b) setBalance(b.balance); })
      .catch(() => { if (!cancelled) setPool(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [event.linked_session_id]);

  if (!event.linked_session_id) {
    return <span className="text-xs text-faded">Pool opens with registration.</span>;
  }
  if (loading) {
    return <span className="text-xs text-faded">Loading pool…</span>;
  }
  if (pool) {
    return (
      <span className="text-xs text-faded" data-testid={`event-pool-${event._id}`}>
        Reward pool: <span className="text-parchment font-semibold">
          {typeof balance === "number" ? balance : "…"} PTS
        </span>
      </span>
    );
  }
  if ((event.entry_fee || 0) > 0) {
    return (
      <span className="text-xs text-faded" data-testid={`event-pool-${event._id}`}>
        Pool: entry fees ({event.entry_fee} pts per player)
      </span>
    );
  }
  return (
    <span className="text-xs text-faded" data-testid={`event-pool-${event._id}`}>
      Reward pool: 0 PTS — set a Reward Pool on this template.
    </span>
  );
}

/* ── Events sub-panel for one template ───────────────────────────────── */
function EventsForTemplate({ template, onClose }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [creating, setCreating] = useState(false);
  const [schedule, setSchedule] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listEvents();
      setEvents((data.events || []).filter((e) => e.template_id === template._id));
    } catch (e) {
      setErr(e.message || "Failed to load events.");
    } finally {
      setLoading(false);
    }
  }, [template._id]);

  useEffect(() => { reload(); }, [reload]);

  const handleCreate = async () => {
    setErr(null);
    setCreating(true);
    try {
      await createEvent({ template_id: template._id, schedule });
      await reload();
    } catch (e) {
      setErr(e.message || "Failed to create event.");
    } finally {
      setCreating(false);
    }
  };

  const handleTransition = async (eventId, to) => {
    setErr(null);
    try {
      await transitionEvent(eventId, to);
      await reload();
    } catch (e) {
      setErr(e.message || "Transition failed.");
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-parchment">Events from "{template.name}"</div>
        <button onClick={onClose} className="text-xs text-faded hover:text-parchment">Close</button>
      </div>

      {template.status === "published" ? (
        <div className="flex flex-wrap items-center gap-2">
          <select value={schedule} onChange={(e) => setSchedule(e.target.value)}
                  className="rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-parchment">
            <option value="">Schedule: none / all</option>
            <option value="A">Schedule A</option>
            <option value="B">Schedule B</option>
            <option value="AB">Combined A+B</option>
          </select>
          <button disabled={creating} onClick={handleCreate}
                  data-testid={`event-create-from-${template._id}`}
                  className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-ink"
                  style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}>
            <Plus className="h-3.5 w-3.5" /> {creating ? "Creating…" : "Create event"}
          </button>
        </div>
      ) : (
        <div className="text-xs text-faded">Publish this template to create events from it.</div>
      )}

      {err && <div className="text-xs text-red-400">{err}</div>}

      {loading ? (
        <div className="text-xs text-faded">Loading events…</div>
      ) : events.length === 0 ? (
        <div className="text-xs text-faded">No events created from this template yet.</div>
      ) : (
        <div className="space-y-2">
          {events.map((ev) => (
            <div key={ev._id} className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge color={EVENT_STATE_COLOR[ev.state] || "muted"}>{ev.state}</Badge>
                  <span className="text-xs text-faded">
                    {ev.schedule ? `Schedule ${ev.schedule}` : "All schedules"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {(NEXT_STATES[ev.state] || []).map((to) => (
                    <button key={to} onClick={() => handleTransition(ev._id, to)}
                            data-testid={`event-transition-${ev._id}-${to}`}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10 transition">
                      {to === "cancelled" ? <XCircle className="h-3 w-3" /> :
                       to === "live" ? <Play className="h-3 w-3" /> :
                       to === "archived" ? <Archive className="h-3 w-3" /> :
                       <ChevronRight className="h-3 w-3" />}
                      {STATE_LABEL[to] || to}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-1.5">
                <EventPool event={ev} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Template row ─────────────────────────────────────────────────────── */
function TemplateRow({ template, onChanged }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [showRewardPool, setShowRewardPool] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const act = async (fn) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e.message || "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4" data-testid={`event-template-row-${template._id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button onClick={() => setExpanded((v) => !v)} className="flex items-center gap-2 text-left">
          {expanded ? <ChevronDown className="h-4 w-4 text-faded" /> : <ChevronRight className="h-4 w-4 text-faded" />}
          <span className="text-sm font-semibold text-parchment">{template.name}</span>
          <Badge color={TEMPLATE_STATUS_COLOR[template.status] || "muted"}>{template.status}</Badge>
          <span className="text-[10px] text-faded">v{template.version}</span>
        </button>
        <div className="flex flex-wrap items-center gap-1.5">
          {template.status === "draft" && (
            <>
              <button disabled={busy} onClick={() => setEditing((v) => !v)}
                      data-testid={`event-template-edit-${template._id}`}
                      className="rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
                Edit
              </button>
              <button disabled={busy} onClick={() => act(() => publishEventTemplate(template._id))}
                      data-testid={`event-template-publish-${template._id}`}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
                <Send className="h-3 w-3" /> Publish
              </button>
            </>
          )}
          {template.status === "published" && (
            <button disabled={busy} onClick={() => act(() => unpublishEventTemplate(template._id))}
                    data-testid={`event-template-unpublish-${template._id}`}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
              <Undo2 className="h-3 w-3" /> Unpublish
            </button>
          )}
          {template.status !== "archived" && (
            <button disabled={busy} onClick={() => act(() => archiveEventTemplate(template._id))}
                    data-testid={`event-template-archive-${template._id}`}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
              <Archive className="h-3 w-3" /> Archive
            </button>
          )}
          <button disabled={busy} onClick={() => act(() => duplicateEventTemplate(template._id))}
                  data-testid={`event-template-duplicate-${template._id}`}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
            <Copy className="h-3 w-3" /> Duplicate
          </button>
          {template.status !== "archived" && (
            <button disabled={busy} onClick={() => setShowRewardPool((v) => !v)}
                    data-testid={`event-template-rewardpool-${template._id}`}
                    className="rounded-md px-2 py-1 text-[11px] font-semibold text-[#FFE19A] hover:text-parchment hover:bg-white/10">
              Reward Pool
            </button>
          )}
          <button disabled={busy} onClick={() => setShowEvents((v) => !v)}
                  data-testid={`event-template-events-${template._id}`}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-ink"
                  style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}>
            <CalendarClock className="h-3 w-3" /> Events
          </button>
        </div>
      </div>

      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}

      {expanded && (
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-faded">
          <div>Event type: <span className="text-parchment">{template.event_type}</span></div>
          <div>Entry fee: <span className="text-parchment">{template.runtime_defaults?.entry_fee ?? 0}</span></div>
          <div>Timer: <span className="text-parchment">{template.timers?.per_question_s ?? "—"}s</span></div>
          <div>Updated: <span className="text-parchment">{fmt(template.updated_at)}</span></div>
          <div>Reward pool: <span className="text-parchment">{template.prize_policy?.reward_pool_points != null ? `${template.prize_policy.reward_pool_points} pts` : "—"}</span></div>
          <div>Winners: <span className="text-parchment">{template.prize_policy?.num_winners ?? "default (3)"}</span></div>
          <div>Distribution: <span className="text-parchment">{template.prize_policy?.split?.join(" / ") || "default (equal)"}</span></div>
        </div>
      )}

      {editing && template.status === "draft" && (
        <div className="mt-3">
          <TemplateForm
            initial={{
              _id: template._id,
              name: template.name,
              entry_fee: String(template.runtime_defaults?.entry_fee ?? 0),
              per_question_s: template.timers?.per_question_s ? String(template.timers.per_question_s) : "",
              reward_points: template.prize_policy?.reward_pool_points != null ? String(template.prize_policy.reward_pool_points) : "",
              num_winners: template.prize_policy?.num_winners ? String(template.prize_policy.num_winners) : "",
              split: template.prize_policy?.split ? template.prize_policy.split.join(",") : "",
            }}
            onSaved={() => { setEditing(false); onChanged(); }}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}

      {showRewardPool && (
        <div className="mt-3">
          <RewardPoolForm template={template}
                          onSaved={() => { setShowRewardPool(false); onChanged(); }}
                          onCancel={() => setShowRewardPool(false)} />
        </div>
      )}

      {showEvents && <EventsForTemplate template={template} onClose={() => setShowEvents(false)} />}
    </div>
  );
}

/* ── Main panel ───────────────────────────────────────────────────────── */
export default function EventTemplatesStudio() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await listEventTemplates(statusFilter || undefined);
      setTemplates(data.templates || []);
    } catch (e) {
      setErr(e.message || "Failed to load event templates.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-parchment">Event Templates</h2>
          <p className="text-xs text-faded">
            Speaking Lab is the first event type. Create, publish, and run events entirely from here — no code changes required.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
                  className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-parchment">
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
          <button onClick={reload} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-faded hover:text-parchment hover:bg-white/10">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
          <button onClick={() => setShowCreate((v) => !v)}
                  data-testid="event-template-new-button"
                  className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-ink"
                  style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}>
            <Plus className="h-3.5 w-3.5" /> New template
          </button>
        </div>
      </div>

      {showCreate && (
        <TemplateForm onSaved={() => { setShowCreate(false); reload(); }} onCancel={() => setShowCreate(false)} />
      )}

      {err && <div className="text-xs text-red-400">{err}</div>}

      {loading ? (
        <div className="text-sm text-faded">Loading templates…</div>
      ) : templates.length === 0 ? (
        <div className="text-sm text-faded">No event templates yet. Create one to get started.</div>
      ) : (
        <div className="space-y-3">
          {templates.map((t) => (
            <TemplateRow key={t._id} template={t} onChanged={reload} />
          ))}
        </div>
      )}
    </div>
  );
}
