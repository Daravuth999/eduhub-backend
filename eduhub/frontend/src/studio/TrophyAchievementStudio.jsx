// TrophyAchievementStudio.jsx — Author Studio management for the
// Achievement Center Trophy Tiers (Phase 1).
//
// Full control over every trophy: enabled/order/name/artwork, all six
// unlock requirements, and the point reward. Nothing is hardcoded — the
// student-facing Achievement Center consumes exactly what is saved here.
import { useCallback, useEffect, useState } from "react";
import { Loader2, Save, Trophy as TrophyIcon } from "lucide-react";
import {
  listAchievementTrophies,
  updateAchievementTrophy,
  listAchievementClaims,
} from "./api";
import { EFFECT_OPTIONS, DEFAULT_EFFECT } from "../eduhub/pages/achievements/ambiencePresets";

const REQ_FIELDS = [
  { key: "min_lifetime_points", label: "Min Lifetime Points" },
  { key: "min_attendance_sessions", label: "Min Attendance (sessions)" },
  { key: "min_lessons_completed", label: "Min Lessons Completed" },
  { key: "min_reading_completed", label: "Min Reading Completed" },
  { key: "min_speaking_activities", label: "Min Speaking Activities" },
  { key: "min_streak_days", label: "Min Learning Streak (days)" },
];

const REWARD_FLAGS = [
  { key: "claim_enabled", label: "Claim Enabled" },
  { key: "one_time", label: "One-time Claim" },
  { key: "celebration_enabled", label: "Celebration Enabled" },
];

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-zinc-500 mb-1">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-violet-400";

function TrophyEditor({ trophy, onSaved }) {
  const [draft, setDraft] = useState(trophy);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => { setDraft(trophy); }, [trophy]);

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setReq = (key, value) =>
    setDraft((d) => ({ ...d, requirements: { ...d.requirements, [key]: value } }));
  const setReward = (key, value) =>
    setDraft((d) => ({ ...d, reward: { ...d.reward, [key]: value } }));

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const payload = {
        enabled: !!draft.enabled,
        display_order: Number(draft.display_order) || 0,
        name: draft.name,
        artwork: draft.artwork,
        requirements: Object.fromEntries(
          REQ_FIELDS.map(({ key }) => [key, Number(draft.requirements?.[key]) || 0]),
        ),
        reward: {
          type: "points",
          points: Number(draft.reward?.points) || 0,
          claim_enabled: !!draft.reward?.claim_enabled,
          one_time: !!draft.reward?.one_time,
          celebration_enabled: !!draft.reward?.celebration_enabled,
          celebration_effect: draft.reward?.celebration_effect || DEFAULT_EFFECT,
        },
      };
      const res = await updateAchievementTrophy(trophy.trophy_id, payload);
      setMsg({ ok: true, text: "Saved" });
      onSaved(res.trophy);
    } catch (e) {
      setMsg({ ok: false, text: e?.message || "Save failed" });
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(null), 3000);
    }
  };

  const configured = REQ_FIELDS.some(({ key }) => Number(draft.requirements?.[key]) > 0);

  return (
    <div
      className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm"
      data-testid={`trophy-editor-${trophy.trophy_id}`}
    >
      <div className="flex items-start gap-3">
        <img
          src={draft.artwork}
          alt={draft.name}
          loading="lazy"
          className="w-16 h-16 object-contain rounded-xl bg-zinc-50 border border-zinc-100"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-bold text-zinc-900 truncate">{draft.name}</h3>
            <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-600 shrink-0">
              <input
                type="checkbox"
                checked={!!draft.enabled}
                onChange={(e) => set({ enabled: e.target.checked })}
                data-testid={`trophy-enabled-${trophy.trophy_id}`}
              />
              Enabled
            </label>
          </div>
          <p className="text-[11px] text-zinc-400 mt-0.5">
            id: {trophy.trophy_id} · v{trophy.version}
            {!configured && (
              <span className="ml-2 text-amber-600 font-semibold">
                needs configuration — no requirements set
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-4">
        <Field label="Name">
          <input
            className={inputCls}
            value={draft.name || ""}
            onChange={(e) => set({ name: e.target.value })}
            data-testid={`trophy-name-${trophy.trophy_id}`}
          />
        </Field>
        <Field label="Display Order">
          <input
            className={inputCls}
            type="number"
            min="0"
            value={draft.display_order ?? 0}
            onChange={(e) => set({ display_order: e.target.value })}
          />
        </Field>
        <div className="col-span-2">
          <Field label="Artwork Path">
            <input
              className={inputCls}
              value={draft.artwork || ""}
              onChange={(e) => set({ artwork: e.target.value })}
            />
          </Field>
        </div>
      </div>

      <p className="text-[11px] font-bold uppercase tracking-wide text-zinc-500 mt-4 mb-2">
        Unlock Requirements <span className="font-normal normal-case text-zinc-400">(0 = not required)</span>
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {REQ_FIELDS.map(({ key, label }) => (
          <Field key={key} label={label}>
            <input
              className={inputCls}
              type="number"
              min="0"
              value={draft.requirements?.[key] ?? 0}
              onChange={(e) => setReq(key, e.target.value)}
              data-testid={`trophy-${trophy.trophy_id}-${key}`}
            />
          </Field>
        ))}
      </div>

      <p className="text-[11px] font-bold uppercase tracking-wide text-zinc-500 mt-4 mb-2">Reward</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
        <Field label="Reward Type">
          <input className={inputCls} value="points" disabled readOnly />
        </Field>
        <Field label="Reward Points">
          <input
            className={inputCls}
            type="number"
            min="0"
            value={draft.reward?.points ?? 0}
            onChange={(e) => setReward("points", e.target.value)}
            data-testid={`trophy-${trophy.trophy_id}-reward-points`}
          />
        </Field>
        <div className="col-span-2 flex flex-wrap gap-x-4 gap-y-1.5 pb-1">
          {REWARD_FLAGS.map(({ key, label }) => (
            <label key={key} className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-600">
              <input
                type="checkbox"
                checked={!!draft.reward?.[key]}
                onChange={(e) => setReward(key, e.target.checked)}
                data-testid={`trophy-${trophy.trophy_id}-${key}`}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-3">
        <Field label="Celebration Effect (live ambience)">
          <select
            className={inputCls}
            value={draft.reward?.celebration_effect || DEFAULT_EFFECT}
            onChange={(e) => setReward("celebration_effect", e.target.value)}
            disabled={!draft.reward?.celebration_enabled}
            data-testid={`trophy-${trophy.trophy_id}-celebration_effect`}
          >
            {EFFECT_OPTIONS.map(({ id, label }) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </Field>
        <p className="text-[11px] text-zinc-400 self-end pb-2">
          Plays around the trophy once a student has earned it. Requires
          "Celebration Enabled". Auto-pauses under reduced-motion.
        </p>
      </div>

      <div className="flex items-center gap-3 mt-4">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-full bg-violet-600 hover:bg-violet-700 disabled:opacity-60 text-white text-sm font-bold px-4 py-2"
          data-testid={`trophy-save-${trophy.trophy_id}`}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save
        </button>
        {msg && (
          <span className={`text-xs font-semibold ${msg.ok ? "text-emerald-600" : "text-red-600"}`}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}

function ClaimsAudit() {
  const [claims, setClaims] = useState(null);
  useEffect(() => {
    let alive = true;
    listAchievementClaims(30)
      .then((r) => { if (alive) setClaims(r.claims || []); })
      .catch(() => { if (alive) setClaims([]); });
    return () => { alive = false; };
  }, []);
  if (!claims) return null;
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <h3 className="font-bold text-zinc-900 mb-2">Recent Reward Claims</h3>
      {claims.length === 0 ? (
        <p className="text-sm text-zinc-400">No claims yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-400">
                <th className="py-1 pr-3">Student</th>
                <th className="py-1 pr-3">Trophy</th>
                <th className="py-1 pr-3">Points</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1">Claimed At</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((c) => (
                <tr key={c.claim_id} className="border-t border-zinc-100">
                  <td className="py-1.5 pr-3 font-semibold text-zinc-700">{c.clean_id || c.student_id}</td>
                  <td className="py-1.5 pr-3">{c.trophy_name || c.trophy_id}</td>
                  <td className="py-1.5 pr-3 font-bold text-violet-600">+{c.points}</td>
                  <td className="py-1.5 pr-3">{c.status}</td>
                  <td className="py-1.5 text-zinc-500">{(c.claimed_at || "").slice(0, 19).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function TrophyAchievementStudio() {
  const [trophies, setTrophies] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    listAchievementTrophies()
      .then((r) => setTrophies(r.trophies || []))
      .catch((e) => setError(e?.message || "Failed to load trophies"));
  }, []);

  useEffect(() => { load(); }, [load]);

  const onSaved = (updated) =>
    setTrophies((list) =>
      (list || []).map((t) => (t.trophy_id === updated.trophy_id ? updated : t)),
    );

  return (
    <div className="max-w-3xl mx-auto space-y-4 pb-10" data-testid="achievement-center-studio">
      <div className="flex items-center gap-2">
        <TrophyIcon className="w-5 h-5 text-violet-600" />
        <div>
          <h2 className="font-bold text-zinc-900 text-lg leading-tight">Achievement Center</h2>
          <p className="text-xs text-zinc-500">
            Trophy Tier unlock requirements & claimable point rewards. Trophies stay
            locked for students until enabled AND at least one requirement is set.
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!trophies && !error && (
        <p className="text-sm text-zinc-400 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading trophies…
        </p>
      )}
      {trophies?.map((t) => (
        <TrophyEditor key={t.trophy_id} trophy={t} onSaved={onSaved} />
      ))}
      {trophies && <ClaimsAudit />}
    </div>
  );
}
