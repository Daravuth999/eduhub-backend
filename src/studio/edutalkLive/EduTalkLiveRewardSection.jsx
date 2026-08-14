/**
 * EduTalkLiveRewardSection.jsx — Author Studio configuration for
 * "Live Coach Surprise Rewards" (Phase 1).
 *
 * Self-contained section mounted INSIDE the existing EduTalkLivePanel.
 * It reads + writes ONLY /api/admin/edutalk-live/rewards/config and never
 * mutates the surrounding Live Coach config, billing, wallet, or
 * payment internals.
 *
 * Studio safety rules locked in this section:
 *   - Vouchers are visibly unavailable and cannot be enabled.
 *   - Point values are constrained to the backend's safe allowlist
 *     surfaced via /schema.safe_point_values.
 *   - Saving runs through the backend validator; success is shown ONLY
 *     after the backend persists.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Gift,
  RefreshCcw,
  Save,
  ShieldCheck,
} from "lucide-react";
import { getToken } from "../api";
import {
  SAFE_POINT_VALUES,
  UNAVAILABLE_REWARD_TYPES,
  ALLOWED_PERSONALIZATION_PLACEHOLDERS,
  validateRewardTypeActivation,
  validatePointValues,
  sanitiseTemplate,
  renderPreview,
  decideSaveState,
} from "./edutalkLiveRewardSchema";

/* eslint-disable no-undef */
const BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
/* eslint-enable no-undef */

function headers() {
  const h = { Accept: "application/json", "Content-Type": "application/json" };
  const tok = getToken();
  if (tok) h.Authorization = `Bearer ${tok}`;
  return h;
}

// Hotfix v1 (Finding D) — distinct, truthful inactive-reason labels. The
// backend ``_public_status`` now returns a precedence-ordered list so the
// Studio never shows a single generic "master or reward type is off" message.
const REWARD_REASON_LABELS = {
  indexes_unavailable: "Reward database indexes are not ready yet.",
  server_master_gate_off:
    "Server master kill switch is OFF (env EDUTALK_COACH_REWARDS_ENABLED).",
  config_disabled: "Studio master toggle is OFF.",
  points_gate_off:
    "Server points kill switch is OFF (env EDUTALK_COACH_POINTS_REWARDS_ENABLED).",
  points_disabled: "Studio EduHub Points toggle is OFF.",
  real_grant_gate_off:
    "Server real-grant kill switch is OFF (env EDUTALK_COACH_REAL_GRANT_ENABLED).",
  provider_unavailable: "Wallet grant provider is unavailable.",
};

function rewardReasonLabel(code) {
  if (!code) return "Inactive";
  return REWARD_REASON_LABELS[code] || `Inactive: ${code}`;
}

function rewardInactiveReasons(status) {
  if (!status) return [];
  const list = (status.inactive_reasons && status.inactive_reasons.length)
    ? status.inactive_reasons
    : [status.inactive_reason];
  return list.filter(Boolean);
}

async function apiGet() {
  const r = await fetch(`${BASE}/api/admin/edutalk-live/rewards/config`, {
    credentials: "include",
    headers: headers(),
  });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      const j = await r.json();
      detail = j?.detail || detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return r.json();
}

async function apiPut(config) {
  const r = await fetch(`${BASE}/api/admin/edutalk-live/rewards/config`, {
    method: "PUT",
    credentials: "include",
    headers: headers(),
    body: JSON.stringify({ config }),
  });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      const j = await r.json();
      detail = j?.detail || detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return r.json();
}

function Toggle({ label, checked, onChange, testId, hint, disabled }) {
  return (
    <label
      className={`flex items-center justify-between gap-3 rounded-xl border border-gold/15 px-3 py-2 ${
        disabled ? "opacity-50" : ""
      }`}
    >
      <span className="text-[12px] text-parchment">
        {label}
        {hint && (
          <span className="block text-[10px] text-parchment/50">{hint}</span>
        )}
      </span>
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => !disabled && onChange(e.target.checked)}
        disabled={!!disabled}
        data-testid={testId}
        className="h-4 w-4 accent-gold"
      />
    </label>
  );
}

function Num({ label, value, onChange, min = 0, max = 9999, step = 1, testId }) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wider text-parchment/70 mb-1">
        {label}
      </span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value ?? 0}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        data-testid={testId}
        className="w-full bg-black/30 border border-gold/20 rounded-lg px-3 py-2 text-parchment text-[13px] focus:outline-none focus:border-gold"
      />
    </label>
  );
}

function Text({ label, value, onChange, testId, maxLength = 320 }) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wider text-parchment/70 mb-1">
        {label}
      </span>
      <textarea
        rows={2}
        maxLength={maxLength}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        className="w-full bg-black/30 border border-gold/20 rounded-lg px-3 py-2 text-parchment text-[12.5px] focus:outline-none focus:border-gold resize-none"
      />
    </label>
  );
}

export default function EduTalkLiveRewardSection() {
  const [config, setConfig] = useState(null);
  const [schema, setSchema] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const res = await apiGet();
      setConfig(res.config);
      setSchema(res.schema || null);
      setStatus(res.status || null);
    } catch (e) {
      setErr(e?.message || "Failed to load reward config");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Dirty tracking + field updaters are declared BEFORE any consumer
  // (``update``, ``togglePoint``, ``save``) so there is no temporal-dead-zone
  // ReferenceError when the component first renders.
  const [dirty, setDirty] = useState(false);
  const markDirty = useCallback(() => setDirty(true), []);
  const updateField = useCallback((key, val) => {
    setConfig((c) => ({ ...c, [key]: val }));
    markDirty();
  }, [markDirty]);
  const saveState = useMemo(
    () => decideSaveState({ saving, dirty }),
    [saving, dirty],
  );
  const update = updateField;

  const togglePoint = (v) =>
    setConfig((c) => {
      const cur = new Set(c.approved_point_values || []);
      if (cur.has(v)) cur.delete(v);
      else cur.add(v);
      markDirty();
      return { ...c, approved_point_values: Array.from(cur).sort((a, b) => a - b) };
    });

  const save = useCallback(async () => {
    if (!saveState.ok) return;
    setSaving(true);
    setErr("");
    setToast("");
    // Mirror the backend rejections client-side so an unsafe save is
    // refused BEFORE the network call. This is the same set of rules
    // the backend would surface; doing it here keeps the Studio honest.
    const typeCheck = validateRewardTypeActivation(config);
    if (!typeCheck.ok) {
      setErr(typeCheck.reason);
      setSaving(false);
      return;
    }
    const pointsCheck = validatePointValues(
      config.approved_point_values || []);
    if (!pointsCheck.ok) {
      setErr(pointsCheck.reason);
      setSaving(false);
      return;
    }
    const templateKeys = [
      "button_label",
      "pre_claim_message",
      "confirmed_message_template",
      "gemini_pre_claim_template",
      "gemini_confirmed_template",
    ];
    for (const k of templateKeys) {
      const v = config[k];
      if (typeof v === "string" && v.length > 0) {
        const s = sanitiseTemplate(v, v, 520);
        if (!s.ok) {
          setErr(`Unsafe template in ${k}`);
          setSaving(false);
          return;
        }
      }
    }
    try {
      const res = await apiPut(config);
      setConfig(res.config);
      setStatus(res.status || null);
      setToast("Saved");
      setDirty(false);
      setTimeout(() => setToast(""), 2500);
    } catch (e) {
      setErr(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }, [config, saveState]);

  const safePoints = useMemo(
    () => schema?.safe_point_values || [...SAFE_POINT_VALUES],
    [schema],
  );

  if (loading) {
    return (
      <div
        className="rounded-xl border border-gold/15 p-3 text-parchment/80 text-[13px]"
        data-testid="live-reward-loading"
      >
        Loading surprise rewards configuration…
      </div>
    );
  }
  if (!config) {
    return (
      <div
        className="rounded-xl border border-red-400/30 p-3 text-red-300 text-[13px]"
        data-testid="live-reward-error"
      >
        {err || "Reward configuration unavailable"}
      </div>
    );
  }

  return (
    <div
      className="rounded-2xl border border-gold/20 p-3 space-y-3"
      data-testid="live-reward-section"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-parchment/90 text-[13px] font-semibold">
          <Gift className="h-4 w-4 text-gold" />
          Live Coach Surprise Rewards
        </div>
        <div className="flex items-center gap-1 text-[10.5px] text-parchment/55">
          <ShieldCheck className="h-3 w-3" /> Phase 1
        </div>
      </div>

      <div
        className="rounded-lg border border-gold/10 bg-black/20 p-2 text-[11px] text-parchment/70"
        data-testid="live-reward-policy-notice"
      >
        Gemini provides performance evidence only. EduHub decides eligibility,
        reward type, amount and final grant. Vouchers remain unavailable in
        Phase 1.
      </div>

      {/* Feature status */}
      <div className="space-y-2">
        <Toggle
          label="Enable surprise rewards (master)"
          hint="Default OFF — no offers can be created until this is on AND at least one safe reward type is on."
          checked={config.enabled}
          onChange={(v) => update("enabled", v)}
          testId="live-reward-master-enabled"
        />
        <div className="grid grid-cols-2 gap-2">
          <Toggle
            label="EduHub Points"
            checked={config.points_enabled}
            onChange={(v) => update("points_enabled", v)}
            testId="live-reward-points-enabled"
          />
          <Toggle
            label="EduTalk Passes"
            hint="Coming later — unavailable in Phase 1"
            checked={false}
            onChange={() => {}}
            testId="live-reward-pass-enabled"
            disabled
          />
          <Toggle
            label="Achievements"
            hint="Coming later — unavailable in Phase 1"
            checked={false}
            onChange={() => {}}
            testId="live-reward-achievement-enabled"
            disabled
          />
          <Toggle
            label="Vouchers"
            hint="Coming later — unavailable in Phase 1"
            checked={false}
            onChange={() => {}}
            testId="live-reward-voucher-enabled"
            disabled
          />
        </div>
      </div>

      {/* Hotfix v1 (Finding D) — truthful runtime status with DISTINCT
          inactive reasons, plus the visibility-vs-activation clarification. */}
      {status && (
        <div
          className="rounded-xl border border-gold/15 p-3 space-y-1.5"
          data-testid="live-reward-runtime-status"
        >
          <div className="flex items-center gap-2 text-[12px] font-semibold">
            <span
              className={
                status.rewards_active ? "text-emerald-300" : "text-amber-300"
              }
              data-testid="live-reward-runtime-state"
            >
              {status.rewards_active
                ? "Coach Rewards ACTIVE"
                : "Coach Rewards INACTIVE"}
            </span>
          </div>
          {!status.rewards_active &&
            rewardInactiveReasons(status).map((code) => (
              <div
                key={code}
                className="text-[11.5px] text-amber-200/90"
                data-testid={`live-reward-reason-${code}`}
              >
                • {rewardReasonLabel(code)}
              </div>
            ))}
          <div className="mt-1 grid grid-cols-3 gap-1 text-[10.5px] text-parchment/55">
            <span>master env: {status.env_master_enabled ? "on" : "off"}</span>
            <span>points env: {status.env_points_enabled ? "on" : "off"}</span>
            <span>
              real-grant env: {status.env_real_grant_enabled ? "on" : "off"}
            </span>
          </div>
          <div className="mt-1 text-[10.5px] leading-relaxed text-parchment/45">
            Note: the Live Voice Coach <em>visibility</em> control is separate
            from Coach Rewards activation. Rewards require the server env kill
            switches AND these Studio toggles AND a ready grant provider —
            making the coach visible does not enable rewards, and disabling
            rewards never hides the coach.
          </div>
        </div>
      )}

      {/* Eligibility */}
      <div className="rounded-xl border border-gold/15 p-3 space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-parchment/55">
          Performance eligibility
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Num
            label="Min exercises"
            value={config.min_successful_exercises}
            onChange={(v) => update("min_successful_exercises", v)}
            min={1}
            max={50}
            testId="live-reward-min-exercises"
          />
          <Num
            label="Min session sec"
            value={config.min_session_seconds}
            onChange={(v) => update("min_session_seconds", v)}
            min={0}
            max={3600}
            testId="live-reward-min-seconds"
          />
          <Num
            label="Min confidence"
            value={config.min_confidence}
            onChange={(v) => update("min_confidence", v)}
            min={0}
            max={1}
            step={0.05}
            testId="live-reward-min-confidence"
          />
          <Num
            label="Max offers/session"
            value={config.max_offers_per_session}
            onChange={() => {}}
            min={1}
            max={1}
            testId="live-reward-max-offers"
          />
        </div>
        <Toggle
          label="Require a resolved correction"
          checked={config.require_resolved_correction}
          onChange={(v) => update("require_resolved_correction", v)}
          testId="live-reward-require-correction"
          hint="When enabled, a student must make and then fix at least one mistake — flawless practice alone will not qualify."
        />
      </div>

      {/* Reward pool */}
      <div className="rounded-xl border border-gold/15 p-3 space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-parchment/55">
          Approved point values (server-validated allowlist)
        </div>
        <div className="flex flex-wrap gap-2">
          {safePoints.map((v) => {
            const on = (config.approved_point_values || []).includes(v);
            return (
              <button
                key={v}
                type="button"
                onClick={() => togglePoint(v)}
                data-testid={`live-reward-point-${v}`}
                className={`text-[12px] rounded-full px-3 py-1 border transition ${
                  on
                    ? "bg-gold/25 border-gold/60 text-parchment"
                    : "border-gold/20 text-parchment/60 hover:border-gold/40"
                }`}
              >
                {v} pts
              </button>
            );
          })}
        </div>
        <div className="text-[10.5px] text-parchment/50">
          Arbitrary point values cannot be saved. Pick from the backend
          allowlist above.
        </div>
      </div>

      {/* Limits */}
      <div className="rounded-xl border border-gold/15 p-3 space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-parchment/55">
          Limits &amp; cooldowns
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Num
            label="Cooldown sec"
            value={config.cooldown_seconds}
            onChange={(v) => update("cooldown_seconds", v)}
            min={0}
            max={2592000}
            testId="live-reward-cooldown"
          />
          <Num
            label="Daily cap"
            value={config.daily_cap_per_student}
            onChange={(v) => update("daily_cap_per_student", v)}
            min={0}
            max={50}
            testId="live-reward-daily-cap"
          />
          <Num
            label="Monthly cap"
            value={config.monthly_cap_per_student}
            onChange={(v) => update("monthly_cap_per_student", v)}
            min={0}
            max={500}
            testId="live-reward-monthly-cap"
          />
          <Num
            label="Offer TTL sec"
            value={config.offer_ttl_seconds}
            onChange={(v) => update("offer_ttl_seconds", v)}
            min={30}
            max={86400}
            testId="live-reward-offer-ttl"
          />
        </div>
      </div>

      {/* Wording */}
      <div className="rounded-xl border border-gold/15 p-3 space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-parchment/55">
          Student &amp; Gemini wording
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Text
            label="Reward button label"
            value={config.button_label}
            onChange={(v) => update("button_label", v)}
            testId="live-reward-button-label"
            maxLength={40}
          />
          <Text
            label="Pre-claim student message"
            value={config.pre_claim_message}
            onChange={(v) => update("pre_claim_message", v)}
            testId="live-reward-pre-claim-msg"
            maxLength={200}
          />
          <Text
            label="Confirmed reveal message"
            value={config.confirmed_message_template}
            onChange={(v) => update("confirmed_message_template", v)}
            testId="live-reward-confirmed-msg"
            maxLength={200}
          />
          <Text
            label="Gemini pre-claim instruction"
            value={config.gemini_pre_claim_template}
            onChange={(v) => update("gemini_pre_claim_template", v)}
            testId="live-reward-gemini-pre"
            maxLength={500}
          />
          <Text
            label="Gemini confirmed-reward instruction"
            value={config.gemini_confirmed_template}
            onChange={(v) => update("gemini_confirmed_template", v)}
            testId="live-reward-gemini-confirmed"
            maxLength={500}
          />
        </div>
        <div className="text-[10.5px] text-parchment/50">
          Templates support only {"{offer_id}"}, {"{reward_summary}"},{" "}
          {"{amount}"} and {"{student_name}"} placeholders. Unsafe instructions
          are rejected server-side.
        </div>
        <div
          className="mt-2 rounded-lg border border-gold/10 bg-black/20 p-2 text-[11px] text-parchment/70"
          data-testid="live-reward-preview"
        >
          <div className="font-semibold text-parchment/85 mb-1">
            Confirmed reveal preview
          </div>
          <div data-testid="live-reward-preview-text">
            {renderPreview(config.confirmed_message_template || "")}
          </div>
          <div className="mt-1 text-[10px] text-parchment/45">
            Allowed placeholders:{" "}
            {ALLOWED_PERSONALIZATION_PLACEHOLDERS.join(", ")}
          </div>
        </div>
      </div>

      {/* Safety summary */}
      <div
        className="rounded-xl border border-gold/15 p-3 text-[11px] text-parchment/75 space-y-1"
        data-testid="live-reward-safety-summary"
      >
        <div>· Master + at least one safe type must be ON to issue offers.</div>
        <div>
          · Unavailable reward types in Phase 1:{" "}
          {UNAVAILABLE_REWARD_TYPES.join(", ")}.
        </div>
        <div>
          · Configuration changes do not modify existing active offers — every
          offer freezes its own config snapshot.
        </div>
        <div>· Maximum 1 offer per session.</div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="button"
          onClick={save}
          disabled={!saveState.ok}
          data-testid="live-reward-save-btn"
          className="inline-flex items-center gap-2 rounded-xl bg-gold/15 hover:bg-gold/25 border border-gold/40 px-4 py-2 text-[13px] font-semibold text-parchment transition disabled:opacity-50"
        >
          <Save className="h-4 w-4" />{" "}
          {saveState.inFlight ? "Saving…" : "Save reward settings"}
        </button>
        <button
          type="button"
          onClick={load}
          disabled={saving}
          data-testid="live-reward-reload-btn"
          className="inline-flex items-center gap-2 rounded-xl border border-gold/20 px-3 py-2 text-[12.5px] text-parchment/85 hover:border-gold/50 transition disabled:opacity-50"
        >
          <RefreshCcw className="h-3.5 w-3.5" /> Reload
        </button>
        {toast && (
          <span
            className="inline-flex items-center gap-1 text-[12px] text-emerald-300"
            data-testid="live-reward-save-toast"
          >
            <CheckCircle2 className="h-3.5 w-3.5" /> {toast}
          </span>
        )}
        {err && (
          <span
            className="inline-flex items-center gap-1 text-[12px] text-red-300"
            data-testid="live-reward-save-err"
          >
            <AlertCircle className="h-3.5 w-3.5" /> {err}
          </span>
        )}
        {status?.rewards_active === false && (
          <span
            className="text-[11px] text-parchment/55"
            data-testid="live-reward-inactive-hint"
          >
            (No offers will issue — {rewardReasonLabel(status.inactive_reason)})
          </span>
        )}
      </div>
    </div>
  );
}
