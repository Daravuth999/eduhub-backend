/**
 * EduTalkLivePanel.jsx — Author Studio → AI Tools → EduTalk →
 * "Live Voice Coach Beta" admin panel.
 *
 * Self-contained: reads/writes ONLY /api/admin/edutalk-live/config (plus the
 * read-only usage/reports endpoints). It does NOT touch the existing EduTalk
 * config state machine, ai_tools_config, or any payment/wallet logic. Mirrors
 * the inline fetch pattern used by EduTalkStudio's Phase 3 panels so delivery
 * stays limited to the new feature files.
 */
import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Coins,
  RefreshCcw,
  Radio,
  Save,
  ShieldCheck,
} from "lucide-react";
import { getToken } from "../api";
import EduTalkLiveRewardSection from "./EduTalkLiveRewardSection";
import {
  validateTopupNudgeConfig,
  reasonMessage,
} from "./edutalkTopupNudgeSchema";
import {
  validateTeacherPersonaConfig,
  validateTeacherDisplayName,
  teacherPersonaReasonMessage,
} from "./edutalkTeacherPersonaSchema";

/* eslint-disable no-undef */
const BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
/* eslint-enable no-undef */

function headers() {
  const h = { Accept: "application/json", "Content-Type": "application/json" };
  const tok = getToken();
  if (tok) h.Authorization = `Bearer ${tok}`;
  return h;
}

async function apiGet() {
  const r = await fetch(`${BASE}/api/admin/edutalk-live/config`, {
    credentials: "include",
    headers: headers(),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function apiPut(config) {
  const r = await fetch(`${BASE}/api/admin/edutalk-live/config`, {
    method: "PUT",
    credentials: "include",
    headers: headers(),
    body: JSON.stringify({ config }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const TEACHER_METHODS = [
  ["friendly_beginner", "Friendly beginner coach"],
  ["pronunciation_first", "Pronunciation-first coach"],
  ["confidence_first", "Confidence-first coach"],
  ["professional_english", "Professional English coach"],
  ["khmer_support", "Khmer support coach"],
  ["friday_trainer", "Friday challenge trainer"],
];
const CORRECTION_STYLES = [
  ["every_sentence", "Correct after every sentence"],
  ["finish_then_correct", "Let student finish, then correct"],
  ["gentle", "Gentle correction"],
  ["intensive", "Intensive correction"],
];
const LANGUAGE_MODES = [
  ["english_only", "English only"],
  ["english_with_khmer_support", "English with Khmer support"],
  ["bilingual_after_correction", "Bilingual explanation after correction"],
];
const FOCUS_OPTIONS = [
  "pronunciation", "mouth_movement", "final_sounds", "intonation",
  "natural_flow", "professional_wording", "grammar_clarity", "confidence",
];
const TIERS = ["free", "standard", "premium", "limited"];
const BOOK_CTX = [
  ["use_book_title", "Use book title"],
  ["use_chapter_title", "Use chapter title"],
  ["use_current_paragraph", "Use current paragraph"],
  ["use_saved_words", "Use saved words"],
  ["use_reading_progress", "Use reading progress"],
  ["use_previous_reports", "Use previous speaking reports"],
];

function Toggle({ label, checked, onChange, testId, hint }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-xl border border-gold/15 px-3 py-2">
      <span className="text-[12px] text-parchment">
        {label}
        {hint && <span className="block text-[10px] text-parchment/50">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
        className="h-4 w-4 accent-gold"
      />
    </label>
  );
}

function Num({ label, value, onChange, min = 0, max = 1800, testId }) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wider text-parchment/70 mb-1">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value ?? 0}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        data-testid={testId}
        className="w-full bg-black/30 border border-gold/20 rounded-lg px-3 py-2 text-parchment text-[13px] focus:outline-none focus:border-gold"
      />
    </label>
  );
}

function Select({ label, value, onChange, options, testId }) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wider text-parchment/70 mb-1">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        className="w-full bg-black/30 border border-gold/20 rounded-lg px-3 py-2 text-parchment text-[13px] focus:outline-none focus:border-gold"
      >
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function Text({ label, value, onChange, testId, placeholder, disabled = false, maxLength = 80 }) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wider text-parchment/70 mb-1">{label}</span>
      <input
        type="text"
        value={value ?? ""}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        className={`w-full bg-black/30 border border-gold/20 rounded-lg px-3 py-2 text-parchment text-[13px] focus:outline-none focus:border-gold ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
      />
    </label>
  );
}

export default function EduTalkLivePanel() {
  const [config, setConfig] = useState(null);
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
      setStatus(res.status);
    } catch (e) {
      setErr(e?.message || "Failed to load Live Coach config");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const update = (key, val) => setConfig((c) => ({ ...c, [key]: val }));
  const updateMode = (mk, field, val) =>
    setConfig((c) => ({
      ...c,
      modes: { ...c.modes, [mk]: { ...c.modes[mk], [field]: val } },
    }));
  const updateTier = (tk, field, val) =>
    setConfig((c) => ({
      ...c,
      tier_rules: { ...c.tier_rules, [tk]: { ...c.tier_rules[tk], [field]: val } },
    }));
  const updateBookCtx = (ck, val) =>
    setConfig((c) => ({ ...c, book_context: { ...c.book_context, [ck]: val } }));
  const toggleFocus = (f) =>
    setConfig((c) => {
      const cur = new Set(c.focus_areas || []);
      cur.has(f) ? cur.delete(f) : cur.add(f);
      return { ...c, focus_areas: Array.from(cur) };
    });

  const save = useCallback(async () => {
    setSaving(true);
    setErr("");
    setToast("");
    // Phase 1 Smart Top-Up Nudge — REJECT invalid input client-side (no silent
    // clamping), mirroring the backend validation + reason codes.
    const nudgeCheck = validateTopupNudgeConfig(config);
    if (!nudgeCheck.ok) {
      setErr(reasonMessage(nudgeCheck.reason) || nudgeCheck.reason);
      setSaving(false);
      return;
    }
    // Phase 1 Teacher Daravuth persona — REJECT invalid input client-side (no
    // silent clamping), mirroring the backend validation + reason codes.
    const teacherCheck = validateTeacherPersonaConfig(config);
    if (!teacherCheck.ok) {
      setErr(teacherPersonaReasonMessage(teacherCheck.reason) || teacherCheck.reason);
      setSaving(false);
      return;
    }
    try {
      const res = await apiPut(config);
      setConfig(res.config);
      setStatus(res.status);
      setToast("Saved");
      setTimeout(() => setToast(""), 2500);
    } catch (e) {
      setErr(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }, [config]);

  const reconcile = useCallback(async () => {
    setErr("");
    setToast("");
    try {
      const r = await fetch(`${BASE}/api/admin/edutalk-live/reconcile`, {
        method: "POST",
        credentials: "include",
        headers: headers(),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (data.status) setStatus(data.status);
      setToast(`Reconciled — ${data.expired} expired, ${data.refunds_retried} refunds retried, ${data.refunds_outstanding} outstanding`);
      setTimeout(() => setToast(""), 5000);
    } catch (e) {
      setErr(e?.message || "Reconcile failed");
    }
  }, []);

  if (loading) {
    return <div className="text-parchment/80 text-[13px]" data-testid="live-admin-loading">Loading Live Voice Coach…</div>;
  }
  if (!config) {
    return <div className="text-red-300 text-[13px]" data-testid="live-admin-error">{err || "Config unavailable"}</div>;
  }

  return (
    <div className="space-y-4" data-testid="live-admin-panel">
      {/* Status */}
      <div className="rounded-xl border border-gold/15 p-3 grid grid-cols-2 gap-2 text-[11.5px]" data-testid="live-admin-status">
        <div className="flex items-center gap-1.5">
          {status?.gemini_configured ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <AlertCircle className="h-3.5 w-3.5 text-amber-400" />}
          <span className="text-parchment/80">{status?.gemini_configured ? "Gemini configured" : "Gemini not configured"}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {status?.websockets_lib_ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <AlertCircle className="h-3.5 w-3.5 text-amber-400" />}
          <span className="text-parchment/80">Backend WS {status?.websockets_lib_ok ? "ready" : "missing"}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {status?.points_helpers_ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <AlertCircle className="h-3.5 w-3.5 text-amber-400" />}
          <span className="text-parchment/80">Points engine {status?.points_helpers_ok ? "ready" : "missing"}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {status?.refund_path_ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <AlertCircle className="h-3.5 w-3.5 text-amber-400" />}
          <span className="text-parchment/80">Refund path {status?.refund_path_ok ? "ready" : "needs SL_TREASURY_PASSWORD"}</span>
        </div>
        <div className="flex items-center gap-1.5 text-parchment/60">
          <Radio className="h-3.5 w-3.5" /> {status?.live_model}
        </div>
      </div>

      {/* Master control */}
      <div className="space-y-2">
        <Toggle label="Enable Live Coach" checked={config.enabled} onChange={(v) => update("enabled", v)} testId="live-enabled" hint="Default OFF until you are ready" />
        <Toggle label="Beta mode" checked={config.beta_enabled} onChange={(v) => update("beta_enabled", v)} testId="live-beta" />
      </div>

      {/* Access rules */}
      <div className="rounded-xl border border-gold/15 p-3 space-y-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-parchment/55 flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Access rules</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Num label="Free trial sec" value={config.free_trial_seconds} onChange={(v) => update("free_trial_seconds", v)} max={600} testId="live-trial-seconds" />
          <Num label="Trial sessions" value={config.free_trial_sessions} onChange={(v) => update("free_trial_sessions", v)} max={20} testId="live-trial-sessions" />
          <Num label="Daily limit" value={config.daily_session_limit} onChange={(v) => update("daily_session_limit", v)} max={50} testId="live-daily-limit" />
          <Num label="Max session sec" value={config.max_session_seconds} onChange={(v) => update("max_session_seconds", v)} min={30} testId="live-max-seconds" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {TIERS.map((t) => (
            <div key={t} className="rounded-lg border border-gold/10 p-2">
              <div className="text-[11px] font-bold text-parchment capitalize mb-1">{t}</div>
              <Toggle label="Enabled" checked={config.tier_rules?.[t]?.enabled} onChange={(v) => updateTier(t, "enabled", v)} testId={`live-tier-${t}-enabled`} />
              {t === "free" && (
                <Toggle label="Trial only" checked={config.tier_rules?.[t]?.trial_only} onChange={(v) => updateTier(t, "trial_only", v)} testId={`live-tier-${t}-trial-only`} />
              )}
              {t === "premium" && (
                <Num label="Discount %" value={config.tier_rules?.[t]?.discount_percent} onChange={(v) => updateTier(t, "discount_percent", v)} max={100} testId={`live-tier-${t}-discount`} />
              )}
              {t === "limited" && (
                <Num label="Free / book" value={config.tier_rules?.[t]?.free_sessions_per_book} onChange={(v) => updateTier(t, "free_sessions_per_book", v)} max={50} testId={`live-tier-${t}-free-book`} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Pricing + modes */}
      <div className="rounded-xl border border-gold/15 p-3 space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-parchment/55 flex items-center gap-1.5"><Coins className="h-3.5 w-3.5" /> Coaching modes · points pricing</div>
        {Object.entries(config.modes || {}).map(([mk, m]) => (
          <div key={mk} className="rounded-lg border border-gold/10 p-2 grid grid-cols-1 sm:grid-cols-4 gap-2 items-end" data-testid={`live-mode-row-${mk}`}>
            <Toggle label={m.label || mk} checked={m.enabled} onChange={(v) => updateMode(mk, "enabled", v)} testId={`live-mode-${mk}-enabled`} />
            <Num label="Cost pts" value={m.cost_points} onChange={(v) => updateMode(mk, "cost_points", v)} max={1000} testId={`live-mode-${mk}-cost`} />
            <Num label="Duration sec" value={m.duration_seconds} onChange={(v) => updateMode(mk, "duration_seconds", v)} min={30} testId={`live-mode-${mk}-duration`} />
            <div className="text-[10.5px] text-parchment/45">{Math.round((m.duration_seconds || 0) / 60)} min</div>
          </div>
        ))}
      </div>

      {/* Teacher method / correction / language */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Select label="Teacher method" value={config.teacher_method} onChange={(v) => update("teacher_method", v)} options={TEACHER_METHODS} testId="live-teacher-method" />
        <Select label="Correction style" value={config.correction_style} onChange={(v) => update("correction_style", v)} options={CORRECTION_STYLES} testId="live-correction-style" />
        <Select label="Language behavior" value={config.default_language_mode} onChange={(v) => update("default_language_mode", v)} options={LANGUAGE_MODES} testId="live-language-mode" />
      </div>

      {/* Focus areas */}
      <div className="rounded-xl border border-gold/15 p-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-parchment/55 mb-2">Focus areas</div>
        <div className="flex flex-wrap gap-2">
          {FOCUS_OPTIONS.map((f) => {
            const on = (config.focus_areas || []).includes(f);
            return (
              <button
                key={f}
                type="button"
                onClick={() => toggleFocus(f)}
                data-testid={`live-focus-${f}`}
                className={`text-[11.5px] rounded-full px-3 py-1 border transition ${on ? "bg-gold/25 border-gold/60 text-parchment" : "border-gold/20 text-parchment/60"}`}
              >
                {f.replace(/_/g, " ")}
              </button>
            );
          })}
        </div>
      </div>

      {/* Book context */}
      <div className="rounded-xl border border-gold/15 p-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-parchment/55 mb-2">Book context usage</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {BOOK_CTX.map(([k, label]) => (
            <Toggle key={k} label={label} checked={config.book_context?.[k]} onChange={(v) => updateBookCtx(k, v)} testId={`live-ctx-${k}`} />
          ))}
        </div>
      </div>

      {/* Report settings */}
      <div className="rounded-xl border border-gold/15 p-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Toggle label="Save transcript" checked={config.save_transcript} onChange={(v) => update("save_transcript", v)} testId="live-save-transcript" />
        <Toggle label="Save report" checked={config.save_report} onChange={(v) => update("save_report", v)} testId="live-save-report" />
        <Toggle label="Save raw audio" checked={config.save_audio} onChange={(v) => update("save_audio", v)} testId="live-save-audio" hint="Off by default" />
        <Toggle label="Student can view report" checked={config.student_can_view_report} onChange={(v) => update("student_can_view_report", v)} testId="live-student-view" />
        <Toggle label="Teacher/admin can view reports" checked={config.teacher_can_view_reports} onChange={(v) => update("teacher_can_view_reports", v)} testId="live-teacher-view" />
      </div>

      {/* Phase 1 SMART TOP-UP NUDGE — additive, default OFF. With the toggle
          off this produces ZERO student-facing change. Validation REJECTS bad
          input (no silent clamping); see edutalkTopupNudgeSchema.js. */}
      <div className="rounded-xl border border-gold/15 p-3 space-y-3" data-testid="live-topup-nudge-section">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-parchment/55 flex items-center gap-1.5"><Coins className="h-3.5 w-3.5" /> Smart Top-Up Nudge</div>
        <Toggle
          label="Enable Smart Top-Up Nudge"
          checked={config.topup_nudge_enabled}
          onChange={(v) => update("topup_nudge_enabled", v)}
          testId="live-topup-nudge-enabled"
          hint="Default OFF. Gently suggests topping up for a FUTURE session — never extends the current one."
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Num
            label="Threshold (pts)"
            value={config.topup_nudge_threshold}
            onChange={(v) => update("topup_nudge_threshold", v)}
            min={0}
            max={100000}
            testId="live-topup-nudge-threshold"
          />
          <Num
            label="Max per week"
            value={config.topup_nudge_max_per_week}
            onChange={(v) => update("topup_nudge_max_per_week", v)}
            min={0}
            max={1000}
            testId="live-topup-nudge-cap"
          />
        </div>
        <div className="text-[10.5px] text-parchment/45">
          Max per week is per student, across all their sessions, rolling 7 days.
        </div>
        {!validateTopupNudgeConfig(config).ok && (
          <div className="text-[11px] text-red-300 flex items-center gap-1.5" data-testid="live-topup-nudge-error">
            <AlertCircle className="h-3.5 w-3.5" />
            {reasonMessage(validateTopupNudgeConfig(config).reason)}
          </div>
        )}
      </div>

      {/* Phase 1 TEACHER DARAVUTH PERSONA — additive, master gate DARK by
          default. With the master toggle off this produces ZERO student-facing
          change; the name/mention values are preserved (never deleted) but the
          controls are visually subordinated. Validation REJECTS bad input (no
          silent clamping); see edutalkTeacherPersonaSchema.js. */}
      <div className="rounded-xl border border-gold/15 p-3 space-y-3" data-testid="live-teacher-persona-section">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-parchment/55 flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Teacher Persona (Daravuth)</div>
        <Toggle
          label="Enable teacher persona (master gate)"
          checked={!!config.teacher_persona_enabled}
          onChange={(v) => update("teacher_persona_enabled", v)}
          testId="live-teacher-persona-enabled"
          hint="Default OFF. When on, the coach acknowledges the configured teacher but never impersonates them or quotes them."
        />
        <div className={config.teacher_persona_enabled ? "space-y-3" : "space-y-3 opacity-50"}>
          <Text
            label="Teacher display name"
            value={config.teacher_display_name}
            onChange={(v) => update("teacher_display_name", v)}
            testId="live-teacher-display-name"
            placeholder="Teacher Daravuth"
            disabled={!config.teacher_persona_enabled}
            maxLength={80}
          />
          <Toggle
            label="Mention teacher in greeting"
            checked={!!config.mention_teacher_in_greeting}
            onChange={(v) => update("mention_teacher_in_greeting", v)}
            testId="live-teacher-mention"
            hint="Mention the teacher once, naturally, at session start only."
          />
        </div>
        <div className="text-[10.5px] text-parchment/45">
          The coach is EduTalk Live Coach (an AI), not the teacher, and never claims the teacher said or requested anything.
        </div>
        {(() => {
          const r = validateTeacherDisplayName(config.teacher_display_name);
          if (config.teacher_persona_enabled && !r.ok) {
            return (
              <div className="text-[11px] text-red-300 flex items-center gap-1.5" data-testid="live-teacher-persona-error">
                <AlertCircle className="h-3.5 w-3.5" />
                {teacherPersonaReasonMessage(r.reason)}
              </div>
            );
          }
          return null;
        })()}
      </div>

      {/* Phase 1 SURPRISE REWARDS — isolated sub-section. Reads + writes its
          own /api/admin/edutalk-live/rewards/config endpoint and never
          mutates the Live Coach config above. */}
      <EduTalkLiveRewardSection />

      {/* Actions */}
      <div className="flex items-center gap-3 pt-1">
        <button type="button" onClick={save} disabled={saving} data-testid="live-save-btn"
          className="inline-flex items-center gap-2 rounded-xl bg-gold/15 hover:bg-gold/25 border border-gold/40 px-4 py-2 text-[13px] font-semibold text-parchment transition disabled:opacity-50">
          <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save Live Coach settings"}
        </button>
        <button type="button" onClick={load} disabled={saving} data-testid="live-reload-btn"
          className="inline-flex items-center gap-2 rounded-xl border border-gold/20 px-3 py-2 text-[12.5px] text-parchment/85 hover:border-gold/50 transition disabled:opacity-50">
          <RefreshCcw className="h-3.5 w-3.5" /> Reload
        </button>
        <button type="button" onClick={reconcile} disabled={saving} data-testid="live-reconcile-btn"
          className="inline-flex items-center gap-2 rounded-xl border border-gold/20 px-3 py-2 text-[12.5px] text-parchment/85 hover:border-gold/50 transition disabled:opacity-50"
          title="Expire stale reservations and retry any failed refunds">
          <ShieldCheck className="h-3.5 w-3.5" /> Reconcile / retry refunds
        </button>
        {toast && <span className="inline-flex items-center gap-1 text-[12px] text-emerald-300" data-testid="live-save-toast"><CheckCircle2 className="h-3.5 w-3.5" /> {toast}</span>}
        {err && <span className="inline-flex items-center gap-1 text-[12px] text-red-300" data-testid="live-save-err"><AlertCircle className="h-3.5 w-3.5" /> {err}</span>}
      </div>
    </div>
  );
}
