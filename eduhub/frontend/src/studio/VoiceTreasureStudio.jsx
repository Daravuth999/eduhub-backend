/**
 * VoiceTreasureStudio.jsx — Author Studio panel for Voice Treasure (Phase 2).
 *
 * Loads and saves the backend config through authenticated admin endpoints
 * (getVoiceTreasureConfig / saveVoiceTreasureConfig in ./api). The backend
 * is authoritative: it re-validates and clamps to master env switches, so
 * this panel surfaces the effective master state and shows voucher / EduTalk
 * Pass reward types as disabled until their grant paths are wired.
 *
 * No new dependencies. Uses the existing Author Studio dark theme + the
 * shared request() helper convention.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, BookOpen, CheckCircle2, Coins, Compass, Globe2,
  Image as ImageIcon, Languages, Layers, ShieldCheck, Sparkles, XCircle,
} from "lucide-react";
import {
  getVoiceTreasureConfig, saveVoiceTreasureConfig,
  getVoiceTreasureAnalytics, getVoiceTreasureAttempts, getVoiceTreasureEntries,
  getVoiceTreasureRewards, getVoiceTreasureReconciliationQueue,
  reconcileVoiceTreasureReward,
  getVoiceTreasureScenes, updateVoiceTreasureScene, reconcileVoiceTreasureEntry,
  reopenVoiceTreasureEntry, replaceVoiceTreasureMission,
} from "./api";
import {
  VT_SECTIONS,
  REWARD_UNAVAILABLE,
  TECH_FAIL_POLICIES,
  DIFFICULTY_MODES,
  FEEDBACK_TONES,
  EVAL_CATEGORIES,
  defaultStudioConfig,
  validateStudioConfig,
  interpretSaveResult,
} from "./voiceTreasureSchema";
import "./VoiceTreasureStudio.css";

const card = {
  background: "rgba(45,31,62,0.55)",
  border: "1px solid rgba(212,168,67,0.22)",
  borderRadius: 14,
  padding: "16px 18px",
  marginBottom: 16,
};
const labelStyle = { fontSize: 12, color: "#C9B68A", display: "block", marginBottom: 4 };
const inputStyle = {
  width: "100%",
  background: "rgba(15,10,22,0.7)",
  border: "1px solid rgba(212,168,67,0.3)",
  borderRadius: 8,
  color: "#F4E5C1",
  padding: "8px 10px",
  fontSize: 13,
};

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

function Toggle({ label, checked, onChange, disabled, note, testId }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, opacity: disabled ? 0.55 : 1 }}>
      <input
        type="checkbox"
        data-testid={testId}
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => !disabled && onChange(e.target.checked)}
      />
      <span style={{ fontSize: 13, color: "#F4E5C1" }}>{label}</span>
      {note ? <span style={{ fontSize: 11, color: "#B07A7A" }}>· {note}</span> : null}
    </div>
  );
}

export default function VoiceTreasureStudio() {
  const [cfg, setCfg] = useState(null);
  const [effective, setEffective] = useState(null);
  const [rewardAvail, setRewardAvail] = useState({ voucher: false, edutalk_pass: false });
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [errors, setErrors] = useState([]); // validation / server errors

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await getVoiceTreasureConfig();
        if (!alive) return;
        setCfg(data.config || defaultStudioConfig());
        setEffective(data.effective || null);
        setRewardAvail({
          ...(data.reward_availability || { voucher: false, edutalk_pass: false }),
          __integration_status: data.integration_status || null,
        });
      } catch (e) {
        if (!alive) return;
        setLoadError(e?.message || "Failed to load Voice Treasure config");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const setGroup = (group, key, value) =>
    setCfg((prev) => ({ ...prev, [group]: { ...prev[group], [key]: value } }));

  const setList = (group, key, raw) =>
    setGroup(group, key, raw.split(",").map((s) => s.trim()).filter(Boolean));

  const onSave = async () => {
    const validation = validateStudioConfig(cfg);
    if (validation.length) {
      setErrors(validation);
      setSavedAt(0);
      return;
    }
    setSaving(true);
    setErrors([]);
    let resp = null, err = null;
    try {
      resp = await saveVoiceTreasureConfig(cfg);
    } catch (e) {
      err = e;
    }
    const result = interpretSaveResult({ resp, err });
    setSaving(false);
    if (result.ok) {
      if (result.config) setCfg(result.config);
      if (result.effective) setEffective(result.effective);
      setSavedAt(Date.now());
      setErrors([]);
    } else {
      // Server error / validation: NEVER show a false success.
      setSavedAt(0);
      setErrors([result.message]);
    }
  };

  if (loading) return <div data-testid="vt-loading" style={{ color: "#C9B68A", padding: 20 }}>Loading Voice Treasure…</div>;
  if (loadError) return <div data-testid="vt-load-error" style={{ color: "#E2A0A0", padding: 20 }}>{loadError}</div>;
  if (!cfg) return null;

  const voucherIntegration = rewardAvail.voucher;
  const passIntegration = rewardAvail.edutalk_pass;
  const integrationStatus = rewardAvail.__integration_status || null;
  // Pass A.1 — drive inline Voucher / EduTalk messaging from the truthful
  // four-dimensional integration_status payload rather than the combined
  // `voucherIntegration` boolean. The Toggle remains saveable while the
  // master switch is OFF; only the inline note text changes.
  const voucherStatus = (integrationStatus && integrationStatus.voucher) || {};
  const passStatus = (integrationStatus && integrationStatus.edutalk_pass) || {};
  const voucherInlineNote =
    !voucherStatus.integration_available ? "Unavailable integration — config is saveable, students will not see this reward until the grant adapter is wired"
    : !voucherStatus.master_switch_enabled ? "Blocked by backend master switch — config is saveable; students will not see this reward until master is enabled"
    : "";
  const passInlineNote =
    !passStatus.integration_available ? "Unavailable integration — config is saveable, students will not see this reward until the grant adapter is wired"
    : !passStatus.master_switch_enabled ? "Blocked by backend master switch — config is saveable; students will not see this reward until master is enabled"
    : "";

  return (
    <div data-testid="voice-treasure-studio" style={{ color: "#F4E5C1" }}>
      <h2 style={{ fontSize: 18, marginBottom: 4 }}>Voice Treasure</h2>
      <p style={{ fontSize: 12, color: "#C9B68A", marginBottom: 14 }}>
        Premium AI speaking game · configuration foundation (Phase 2)
      </p>

      {/* ── Pass B.2.1 Overview ──────────────────────────────────────────
          Premium overview built from authoritative config + effective +
          integration_status only. No fabricated metrics. */}
      <VoiceTreasureStudioOverview
        cfg={cfg}
        effective={effective}
        integrationStatus={integrationStatus}
      />

      {/* Master-switch / effective state banner */}
      {effective && (
        <div
          data-testid="vt-master-banner"
          style={{
            ...card,
            borderColor: effective.feature_available ? "rgba(120,200,150,0.4)" : "rgba(212,168,67,0.3)",
            background: "rgba(20,14,28,0.7)",
          }}
        >
          <div style={{ fontSize: 12, color: "#C9B68A", marginBottom: 6 }}>
            Effective state (backend master switches are authoritative):
          </div>
          <div style={{ fontSize: 12, display: "flex", flexWrap: "wrap", gap: 14 }}>
            <span>Feature available: <b>{String(effective.feature_available)}</b></span>
            <span>VOICE_TREASURE_ENABLED: <b>{String(effective.master_enabled)}</b></span>
            <span>Points reward master: <b>{String(effective.master_points_reward_enabled)}</b></span>
            <span>Image gen master: <b>{String(effective.master_image_generation_enabled)}</b></span>
          </div>
          {!effective.master_enabled && (
            <div style={{ fontSize: 11, color: "#E2C18A", marginTop: 6 }}>
              The master switch is OFF, so the game stays unavailable to students even if enabled below.
            </div>
          )}
        </div>
      )}

      {/* Section nav (visual confirmation all sections render) */}
      <div data-testid="vt-section-list" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {VT_SECTIONS.map((s) => (
          <span key={s.key} data-testid={`vt-section-chip-${s.key}`}
                style={{ fontSize: 11, color: "#C9B68A", border: "1px solid rgba(212,168,67,0.25)", borderRadius: 999, padding: "3px 10px" }}>
            {s.label}
          </span>
        ))}
      </div>

      {/* ── Access ─────────────────────────────────────────────────────── */}
      <section data-testid="vt-section-access" style={card}>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Access</h3>
        <Toggle testId="vt-access-enabled" label="Enabled" checked={cfg.access.enabled}
                onChange={(v) => setGroup("access", "enabled", v)} />
        <Toggle testId="vt-access-tile" label="Show Home tile" checked={cfg.access.show_home_tile}
                onChange={(v) => setGroup("access", "show_home_tile", v)} />
        <Toggle testId="vt-access-open" label="Open to all students" checked={cfg.access.open_to_all}
                onChange={(v) => setGroup("access", "open_to_all", v)} />
        <Toggle testId="vt-access-free-first" label="Free first play" checked={cfg.access.free_first_play}
                onChange={(v) => setGroup("access", "free_first_play", v)} />
        <Field label="Eligible student IDs (comma-separated)">
          <input style={inputStyle} value={(cfg.access.eligible_student_ids || []).join(", ")}
                 onChange={(e) => setList("access", "eligible_student_ids", e.target.value)} />
        </Field>
        <Field label="Eligible groups (comma-separated)">
          <input style={inputStyle} value={(cfg.access.eligible_groups || []).join(", ")}
                 onChange={(e) => setList("access", "eligible_groups", e.target.value)} />
        </Field>
        <Field label="Suspended student IDs (comma-separated)">
          <input style={inputStyle} value={(cfg.access.suspended_student_ids || []).join(", ")}
                 onChange={(e) => setList("access", "suspended_student_ids", e.target.value)} />
        </Field>
        <Field label="Daily mission limit">
          <div data-testid="vt-daily-limit-locked" style={{ fontSize: 13, color: "#E8DEC9" }}>
            1
            <span style={{ display: "block", fontSize: 11, color: "#9a8c70", marginTop: 2 }}>
              One paid mission per student per day. Multi-play support is planned for a future release.
            </span>
          </div>
        </Field>
      </section>

      {/* ── Entry Cost ─────────────────────────────────────────────────── */}
      <section data-testid="vt-section-entry" style={card}>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Entry Cost</h3>
        <Field label="Entry cost (Points)">
          <input type="number" data-testid="vt-entry-cost" style={inputStyle} value={cfg.entry.entry_cost_points}
                 onChange={(e) => setGroup("entry", "entry_cost_points", parseInt(e.target.value || "0", 10))} />
        </Field>
        <Field label="Minimum balance (Points)">
          <input type="number" style={inputStyle} value={cfg.entry.minimum_balance_points}
                 onChange={(e) => setGroup("entry", "minimum_balance_points", parseInt(e.target.value || "0", 10))} />
        </Field>
        <Toggle testId="vt-entry-reopen" label="Reopen paid entry without recharge"
                checked={cfg.entry.reopen_paid_entry_without_recharge}
                onChange={(v) => setGroup("entry", "reopen_paid_entry_without_recharge", v)} />
        <Field label="Technical-failure policy">
          <select style={inputStyle} value={cfg.entry.technical_failure_policy}
                  onChange={(e) => setGroup("entry", "technical_failure_policy", e.target.value)}>
            {TECH_FAIL_POLICIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
      </section>

      {/* ── Image Challenges ───────────────────────────────────────────── */}
      <section data-testid="vt-section-images" style={card}>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Image Challenges</h3>
        <Toggle testId="vt-img-enabled" label="Image generation enabled"
                checked={cfg.images.image_generation_enabled}
                onChange={(v) => setGroup("images", "image_generation_enabled", v)}
                note={effective && !effective.master_image_generation_enabled ? "master OFF — will be clamped" : ""} />
        <Field label="Image model (backend config)">
          <input style={inputStyle} value={cfg.images.image_model || ""}
                 placeholder="set via VOICE_TREASURE_IMAGE_MODEL or here"
                 onChange={(e) => setGroup("images", "image_model", e.target.value)} />
        </Field>
        <Field label="Allowed themes (comma-separated)">
          <input style={inputStyle} value={(cfg.images.allowed_themes || []).join(", ")}
                 onChange={(e) => setList("images", "allowed_themes", e.target.value)} />
        </Field>
        <Field label="Blocked themes (comma-separated)">
          <input style={inputStyle} value={(cfg.images.blocked_themes || []).join(", ")}
                 onChange={(e) => setList("images", "blocked_themes", e.target.value)} />
        </Field>
        <Field label="Difficulty mode">
          <select style={inputStyle} value={cfg.images.difficulty_mode}
                  onChange={(e) => setGroup("images", "difficulty_mode", e.target.value)}>
            {DIFFICULTY_MODES.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </Field>
        <Toggle testId="vt-img-personalize" label="Personalization enabled" checked={cfg.images.personalization_enabled}
                onChange={(v) => setGroup("images", "personalization_enabled", v)} />
        <Toggle testId="vt-img-fallback" label="Fallback mission enabled" checked={cfg.images.fallback_mission_enabled}
                onChange={(v) => setGroup("images", "fallback_mission_enabled", v)} />
      </section>

      {/* ── Speaking Rules ─────────────────────────────────────────────── */}
      <section data-testid="vt-section-speaking" style={card}>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Speaking Rules</h3>
        <Field label="Minimum recording seconds">
          <input type="number" data-testid="vt-rec-min" style={inputStyle} value={cfg.speaking.minimum_recording_seconds}
                 onChange={(e) => setGroup("speaking", "minimum_recording_seconds", parseInt(e.target.value || "0", 10))} />
        </Field>
        <Field label="Maximum recording seconds">
          <input type="number" data-testid="vt-rec-max" style={inputStyle} value={cfg.speaking.maximum_recording_seconds}
                 onChange={(e) => setGroup("speaking", "maximum_recording_seconds", parseInt(e.target.value || "0", 10))} />
        </Field>
        <Field label="Maximum recording retries">
          <input type="number" style={inputStyle} value={cfg.speaking.maximum_recording_retries}
                 onChange={(e) => setGroup("speaking", "maximum_recording_retries", parseInt(e.target.value || "0", 10))} />
        </Field>
        <Toggle testId="vt-preview" label="Audio preview required" checked={cfg.speaking.audio_preview_enabled}
                onChange={(v) => setGroup("speaking", "audio_preview_enabled", v)} />
        <Field label="Evaluation categories">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {EVAL_CATEGORIES.map((c) => {
              const on = (cfg.speaking.evaluation_categories || []).includes(c);
              return (
                <label key={c} style={{ fontSize: 12, display: "flex", gap: 5, alignItems: "center" }}>
                  <input type="checkbox" checked={on}
                         onChange={(e) => {
                           const set = new Set(cfg.speaking.evaluation_categories || []);
                           if (e.target.checked) set.add(c); else set.delete(c);
                           setGroup("speaking", "evaluation_categories", [...set]);
                         }} />
                  {c}
                </label>
              );
            })}
          </div>
        </Field>
        <Field label="Minimum eligible score (0–100)">
          <input type="number" style={inputStyle} value={cfg.speaking.minimum_eligible_score}
                 onChange={(e) => setGroup("speaking", "minimum_eligible_score", parseInt(e.target.value || "0", 10))} />
        </Field>
        <Field label="Feedback tone">
          <select style={inputStyle} value={cfg.speaking.feedback_tone}
                  onChange={(e) => setGroup("speaking", "feedback_tone", e.target.value)}>
            {FEEDBACK_TONES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
      </section>

      {/* ── Rewards ────────────────────────────────────────────────────── */}
      <section data-testid="vt-section-rewards" style={card}>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Rewards</h3>
        <Toggle testId="vt-reward-points" label="Points reward enabled" checked={cfg.rewards.points_reward_enabled}
                onChange={(v) => setGroup("rewards", "points_reward_enabled", v)}
                note={effective && !effective.master_points_reward_enabled ? "master OFF — will be clamped" : ""} />
        <Field label="Base points reward">
          <input type="number" data-testid="vt-reward-base" style={inputStyle} value={cfg.rewards.base_points_reward}
                 onChange={(e) => setGroup("rewards", "base_points_reward", parseInt(e.target.value || "0", 10))} />
        </Field>
        <Field label="Maximum points reward">
          <input type="number" data-testid="vt-reward-max" style={inputStyle} value={cfg.rewards.maximum_points_reward}
                 onChange={(e) => setGroup("rewards", "maximum_points_reward", parseInt(e.target.value || "0", 10))} />
        </Field>
        <Field label="Daily points payout cap">
          <input type="number" style={inputStyle} value={cfg.rewards.daily_points_payout_cap}
                 onChange={(e) => setGroup("rewards", "daily_points_payout_cap", parseInt(e.target.value || "0", 10))} />
        </Field>
        <Field label="Weekly points payout cap">
          <input type="number" style={inputStyle} value={cfg.rewards.weekly_points_payout_cap}
                 onChange={(e) => setGroup("rewards", "weekly_points_payout_cap", parseInt(e.target.value || "0", 10))} />
        </Field>
        <Toggle testId="vt-reward-streak" label="Streak reward enabled" checked={cfg.rewards.streak_reward_enabled}
                onChange={(v) => setGroup("rewards", "streak_reward_enabled", v)} />
        {cfg.rewards.streak_reward_enabled && (
          <>
            <Field label="Streak bonus points (per extra consecutive day)">
              <input type="number" data-testid="vt-reward-streak-points" style={inputStyle}
                     value={cfg.rewards.streak_bonus_points ?? 0}
                     onChange={(e) => setGroup("rewards", "streak_bonus_points", parseInt(e.target.value || "0", 10))} />
            </Field>
            <Field label="Streak bonus maximum (cap)">
              <input type="number" data-testid="vt-reward-streak-max" style={inputStyle}
                     value={cfg.rewards.streak_bonus_max ?? 0}
                     onChange={(e) => setGroup("rewards", "streak_bonus_max", parseInt(e.target.value || "0", 10))} />
            </Field>
          </>
        )}
        <Field label="High score bonus threshold (0–100)">
          <input type="number" data-testid="vt-reward-hs-threshold" style={inputStyle}
                 value={cfg.rewards.high_score_bonus_threshold ?? 90}
                 onChange={(e) => setGroup("rewards", "high_score_bonus_threshold", parseInt(e.target.value || "0", 10))} />
        </Field>
        <Field label="High score bonus points">
          <input type="number" data-testid="vt-reward-hs-points" style={inputStyle}
                 value={cfg.rewards.high_score_bonus_points ?? 0}
                 onChange={(e) => setGroup("rewards", "high_score_bonus_points", parseInt(e.target.value || "0", 10))} />
        </Field>
        <Toggle testId="vt-reward-firstcard" label="First Voice Card (VT collectible)"
                checked={cfg.rewards.first_voice_card_enabled}
                onChange={(v) => setGroup("rewards", "first_voice_card_enabled", v)} />

        {/* Pass A — voucher reward: real controlled inputs. The Author Studio
            can save voucher configuration WHILE the backend master env switch
            is OFF or the grant adapter is unavailable; the backend re-clamps
            on PUT. The integration-status panel below reports the truth. */}
        <Toggle testId="vt-reward-voucher" label="Voucher reward enabled"
                checked={!!cfg.rewards.voucher_reward_enabled}
                onChange={(v) => setGroup("rewards", "voucher_reward_enabled", v)}
                note={voucherInlineNote} />
        {cfg.rewards.voucher_reward_enabled && (
          <div data-testid="vt-reward-voucher-fields" style={{ paddingLeft: 12, borderLeft: "2px solid rgba(212,168,67,0.18)" }}>
            <Field label="Minimum overall score to earn (0–100)">
              <input type="number" data-testid="vt-voucher-min-score" style={inputStyle}
                     value={cfg.rewards.voucher_minimum_score ?? 70}
                     onChange={(e) => setGroup("rewards", "voucher_minimum_score", parseInt(e.target.value || "0", 10))} />
            </Field>
            <Field label="Source">
              <select data-testid="vt-voucher-source" style={inputStyle}
                      value={cfg.rewards.voucher_source || "existing"}
                      onChange={(e) => setGroup("rewards", "voucher_source", e.target.value)}>
                <option value="existing">Existing coupon code</option>
                <option value="auto">Auto-generated</option>
              </select>
            </Field>
            {cfg.rewards.voucher_source === "existing" && (
              <Field label="Existing coupon code">
                <input type="text" data-testid="vt-voucher-existing" style={inputStyle}
                       value={cfg.rewards.voucher_existing_code || ""}
                       onChange={(e) => setGroup("rewards", "voucher_existing_code", e.target.value)} />
              </Field>
            )}
            {cfg.rewards.voucher_source === "auto" && (
              <>
                <Field label="Discount type">
                  <select data-testid="vt-voucher-discount-type" style={inputStyle}
                          value={cfg.rewards.voucher_discount_type || "percent"}
                          onChange={(e) => setGroup("rewards", "voucher_discount_type", e.target.value)}>
                    <option value="percent">Percent</option>
                    <option value="amount">Amount</option>
                  </select>
                </Field>
                <Field label="Discount value">
                  <input type="number" data-testid="vt-voucher-discount-value" style={inputStyle}
                         value={cfg.rewards.voucher_discount_value ?? 0}
                         onChange={(e) => setGroup("rewards", "voucher_discount_value", parseFloat(e.target.value || "0"))} />
                </Field>
              </>
            )}
            <Field label="Title (student-visible)">
              <input type="text" data-testid="vt-voucher-title" style={inputStyle}
                     value={cfg.rewards.voucher_title || ""}
                     onChange={(e) => setGroup("rewards", "voucher_title", e.target.value)} />
            </Field>
            <Field label="Subtitle (optional)">
              <input type="text" data-testid="vt-voucher-subtitle" style={inputStyle}
                     value={cfg.rewards.voucher_subtitle || ""}
                     onChange={(e) => setGroup("rewards", "voucher_subtitle", e.target.value)} />
            </Field>
            <Field label="Daily cap per student">
              <input type="number" data-testid="vt-voucher-daily-cap" style={inputStyle}
                     value={cfg.rewards.voucher_daily_cap ?? 1}
                     onChange={(e) => setGroup("rewards", "voucher_daily_cap", parseInt(e.target.value || "0", 10))} />
            </Field>
          </div>
        )}

        <Toggle testId="vt-reward-pass" label="EduTalk Pass reward enabled"
                checked={!!cfg.rewards.edutalk_pass_reward_enabled}
                onChange={(v) => setGroup("rewards", "edutalk_pass_reward_enabled", v)}
                note={passInlineNote} />
        {cfg.rewards.edutalk_pass_reward_enabled && (
          <div data-testid="vt-reward-pass-fields" style={{ paddingLeft: 12, borderLeft: "2px solid rgba(212,168,67,0.18)" }}>
            <Field label="Minimum overall score to earn (0–100)">
              <input type="number" data-testid="vt-pass-min-score" style={inputStyle}
                     value={cfg.rewards.edutalk_pass_minimum_score ?? 70}
                     onChange={(e) => setGroup("rewards", "edutalk_pass_minimum_score", parseInt(e.target.value || "0", 10))} />
            </Field>
            <Field label="Pass feature">
              <select data-testid="vt-pass-feature" style={inputStyle}
                      value={cfg.rewards.edutalk_pass_feature || "edutalk_session"}
                      onChange={(e) => setGroup("rewards", "edutalk_pass_feature", e.target.value)}>
                <option value="edutalk_session">EduTalk session</option>
                <option value="edutalk_voice">EduTalk voice reply</option>
              </select>
            </Field>
            <Field label="Quantity per grant">
              <input type="number" data-testid="vt-pass-quantity" style={inputStyle} min={1}
                     value={cfg.rewards.edutalk_pass_quantity ?? 1}
                     onChange={(e) => setGroup("rewards", "edutalk_pass_quantity", parseInt(e.target.value || "1", 10))} />
            </Field>
            <Field label="Expires in days">
              <input type="number" data-testid="vt-pass-expires" style={inputStyle} min={1}
                     value={cfg.rewards.edutalk_pass_expires_in_days ?? 30}
                     onChange={(e) => setGroup("rewards", "edutalk_pass_expires_in_days", parseInt(e.target.value || "1", 10))} />
            </Field>
            <Field label="Eligible book slugs (comma-separated; empty = all)">
              <input type="text" data-testid="vt-pass-books" style={inputStyle}
                     value={(cfg.rewards.edutalk_pass_eligible_books || []).join(", ")}
                     onChange={(e) => setGroup("rewards", "edutalk_pass_eligible_books",
                       e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
            </Field>
            <Field label="Daily cap per student">
              <input type="number" data-testid="vt-pass-daily-cap" style={inputStyle}
                     value={cfg.rewards.edutalk_pass_daily_cap ?? 1}
                     onChange={(e) => setGroup("rewards", "edutalk_pass_daily_cap", parseInt(e.target.value || "0", 10))} />
            </Field>
          </div>
        )}
      </section>

      {/* ── Bilingual Evaluation (English / Khmer) ──────────────────────── */}
      <section data-testid="vt-section-bilingual" style={card}>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Bilingual Evaluation</h3>
        <p style={{ fontSize: 11, color: "#9F9376", marginBottom: 12 }}>
          Server-authoritative. The student cannot override these. The
          frozen score schema (relevance, visual_grounding, detail,
          organization, understandable_language) is unaffected.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={{ fontSize: 12 }}>Response language
            <select
              data-testid="vt-lang-response"
              style={inputStyle}
              value={(cfg.language || {}).response_language || "english"}
              onChange={(e) => setGroup("language", "response_language", e.target.value)}
            >
              <option value="english">English</option>
              <option value="khmer">Khmer</option>
              <option value="english_or_khmer">English or Khmer</option>
              <option value="mixed">Mixed (Khmer/English)</option>
            </select>
          </label>
          <label style={{ fontSize: 12 }}>Feedback language
            <select
              data-testid="vt-lang-feedback"
              style={inputStyle}
              value={(cfg.language || {}).feedback_language || "english"}
              onChange={(e) => setGroup("language", "feedback_language", e.target.value)}
            >
              <option value="english">English</option>
              <option value="khmer">Khmer</option>
              <option value="match">Match student response</option>
              <option value="bilingual">Bilingual</option>
            </select>
          </label>
          <label style={{ fontSize: 12, gridColumn: "1 / span 2" }}>Mission instruction language
            <select
              data-testid="vt-lang-instruction"
              style={inputStyle}
              value={(cfg.language || {}).mission_instruction_language || "english"}
              onChange={(e) => setGroup("language", "mission_instruction_language", e.target.value)}
            >
              <option value="english">English</option>
              <option value="khmer">Khmer</option>
              <option value="bilingual">Bilingual</option>
            </select>
          </label>
        </div>
        <details style={{ marginTop: 12 }} data-testid="vt-lang-templates">
          <summary style={{ fontSize: 12, cursor: "pointer", color: "#C9B68A" }}>
            Optional text overrides (English / Khmer)
          </summary>
          {[
            ["mission_instruction_text", "Mission instruction"],
            ["recording_guidance_text", "Recording guidance"],
            ["evaluation_unavailable_text", "Evaluation unavailable message"],
            ["retry_message_text", "Retry message"],
          ].map(([base, label]) => (
            <div key={base} style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, color: "#9F9376", marginBottom: 4 }}>{label}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <textarea
                  data-testid={`vt-lang-${base}-en`}
                  placeholder="English (optional override)"
                  maxLength={600}
                  style={{ ...inputStyle, minHeight: 48 }}
                  value={(cfg.language || {})[`${base}_en`] || ""}
                  onChange={(e) => setGroup("language", `${base}_en`, e.target.value)}
                />
                <textarea
                  data-testid={`vt-lang-${base}-km`}
                  placeholder="Khmer ភាសាខ្មែរ (optional override)"
                  maxLength={600}
                  lang="km"
                  style={{ ...inputStyle, minHeight: 48 }}
                  value={(cfg.language || {})[`${base}_km`] || ""}
                  onChange={(e) => setGroup("language", `${base}_km`, e.target.value)}
                />
              </div>
            </div>
          ))}
        </details>

        {/* ── Pass B.2.1 Bilingual preview card ─────────────────────────
            Shows the student-facing message in English / Khmer / both,
            driven by the existing cfg.language fields. Pure preview —
            does not change save behavior. */}
        <VoiceTreasureBilingualPreview language={cfg.language || {}} />
      </section>

      {/* ── Reward Integration Status ────────────────────────────────────── */}
      <section data-testid="vt-section-integration-status" style={card}>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Reward Integration Status</h3>
        <p style={{ fontSize: 11, color: "#9F9376", marginBottom: 12 }}>
          Each reward type shows its real, runtime-detected availability. The
          four orthogonal truths are reported per row: <b>configured</b>,
          <b> integration_available</b>, <b>master_switch_enabled</b>, and
          <b> effectively_active</b>. A reward is shown to students ONLY when
          <b> effectively_active</b> is true.
        </p>
        {["points", "first_voice_card", "voucher", "edutalk_pass"].map((key) => {
          const labels = {
            points: "Points reward",
            first_voice_card: "First Voice Card (collectible)",
            voucher: "Book Voucher",
            edutalk_pass: "EduTalk Pass",
          };
          const status = (integrationStatus && integrationStatus[key]) || null;
          const configured = status ? status.configured : false;
          const integrationOk = status ? status.integration_available : false;
          const masterOn = status ? status.master_switch_enabled : false;
          const active = status ? status.effectively_active : false;
          const summary =
            !integrationOk ? "Unavailable integration"
            : !masterOn ? "Blocked by backend master switch"
            : !configured ? "Available but disabled"
            : active ? "Available and active"
            : "Available but disabled";
          const color =
            !integrationOk ? "#E2A0A0"
            : !masterOn ? "#E5C46B"
            : active ? "#A6E29A"
            : "#9F9376";
          return (
            <div
              key={key}
              className="vts-integration-row"
              data-testid={`vt-integration-${key}`}
              data-integration-status={summary}
              data-configured={String(configured)}
              data-integration-available={String(integrationOk)}
              data-master-switch-enabled={String(masterOn)}
              data-effectively-active={String(active)}
            >
              <span style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 8 }}>
                {key === "points" ? <Coins size={14} aria-hidden="true" />
                  : key === "first_voice_card" ? <Sparkles size={14} aria-hidden="true" />
                  : key === "voucher" ? <ShieldCheck size={14} aria-hidden="true" />
                  : <Activity size={14} aria-hidden="true" />}
                {labels[key]}
              </span>
              <span className="vts-integration-pill" style={{ color }}>{summary}</span>
            </div>
          );
        })}
      </section>

      {/* ── Safety ─────────────────────────────────────────────────────── */}
      <section data-testid="vt-section-safety" style={card}>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Safety</h3>
        <Toggle testId="vt-safety-preserve" label="Preserve paid entry on provider failure"
                checked={cfg.safety.preserve_paid_entry_on_provider_failure}
                onChange={(v) => setGroup("safety", "preserve_paid_entry_on_provider_failure", v)} />
        <Toggle testId="vt-safety-retry" label="Allow evaluation retry" checked={cfg.safety.allow_evaluation_retry}
                onChange={(v) => setGroup("safety", "allow_evaluation_retry", v)} />
        <Toggle testId="vt-safety-recon" label="Manual reconciliation enabled"
                checked={cfg.safety.manual_reconciliation_enabled}
                onChange={(v) => setGroup("safety", "manual_reconciliation_enabled", v)} />
      </section>

      {/* Errors */}
      {errors.length > 0 && (
        <div data-testid="vt-errors" style={{ ...card, borderColor: "rgba(226,160,160,0.5)", background: "rgba(60,20,20,0.4)" }}>
          {errors.map((e, i) => (
            <div key={i} style={{ fontSize: 12, color: "#E2A0A0" }}>• {e}</div>
          ))}
        </div>
      )}

      {/* Save */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <button
          data-testid="vt-save-btn"
          onClick={onSave}
          disabled={saving}
          style={{
            background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
            color: "#1a1420", border: "none", borderRadius: 999, padding: "10px 22px",
            fontWeight: 700, fontSize: 13, cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? "Saving…" : "Save configuration"}
        </button>
        {savedAt > 0 && (
          <span data-testid="vt-saved" style={{ fontSize: 12, color: "#9FE2B0" }}>Saved ✓</span>
        )}
      </div>

      {/* ── Operations dashboard (read-only + explicit reconcile) ──────── */}
      <VoiceTreasureOps />

      {/* ── Bundled mission scene library management ──────────────────── */}
      <VoiceTreasureSceneLibrary />
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * VoiceTreasureOps — operational dashboard: analytics, attempts, entry
 * transactions, reward claims, and the reconciliation queue with an explicit,
 * auditable reconcile action. All reads use existing admin auth; the only
 * mutating action is reconcile, which requires an explicit outcome + evidence.
 * Never displays student passwords or raw audio (backend never returns them).
 * ------------------------------------------------------------------------- */
const opsCard = {
  background: "rgba(45,31,62,0.55)",
  border: "1px solid rgba(212,168,67,0.22)",
  borderRadius: 14,
  padding: 16,
  marginTop: 14,
};
const opsTh = { textAlign: "left", fontSize: 11, color: "#C9B89A", padding: "6px 8px", borderBottom: "1px solid rgba(212,168,67,0.18)" };
const opsTd = { fontSize: 12, color: "#E8DEC9", padding: "6px 8px", borderBottom: "1px solid rgba(212,168,67,0.08)" };

function Stat({ label, value, testId }) {
  return (
    <div style={{ minWidth: 130 }}>
      <div style={{ fontSize: 11, color: "#C9B89A" }}>{label}</div>
      <div data-testid={testId} style={{ fontSize: 18, fontWeight: 800, color: "#FFE19A" }}>{value}</div>
    </div>
  );
}

export function VoiceTreasureOps() {
  const [tab, setTab] = useState("analytics");
  const [analytics, setAnalytics] = useState(null);
  const [rows, setRows] = useState([]);
  const [queue, setQueue] = useState(null);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState("");

  const loadAnalytics = async () => {
    try { setAnalytics(await getVoiceTreasureAnalytics()); } catch (e) { setErr(e?.message || "load failed"); }
  };
  const loadRows = async (which) => {
    setErr(""); setRows([]);
    try {
      if (which === "attempts") setRows((await getVoiceTreasureAttempts()).attempts || []);
      else if (which === "entries") setRows((await getVoiceTreasureEntries()).entries || []);
      else if (which === "rewards") setRows((await getVoiceTreasureRewards()).rewards || []);
    } catch (e) { setErr(e?.message || "load failed"); }
  };
  const loadQueue = async () => {
    setErr("");
    try { setQueue(await getVoiceTreasureReconciliationQueue()); } catch (e) { setErr(e?.message || "load failed"); }
  };

  useEffect(() => { loadAnalytics(); }, []);
  useEffect(() => {
    if (tab === "analytics") loadAnalytics();
    else if (tab === "reconciliation") loadQueue();
    else loadRows(tab);
    // eslint-disable-next-line
  }, [tab]);

  const onReconcile = async (rewardId, outcome) => {
    const evidence = window.prompt(
      `Provide reconciliation evidence for ${outcome} (required, auditable):`);
    if (!evidence || !evidence.trim()) return;
    setBusyId(rewardId);
    try {
      await reconcileVoiceTreasureReward(rewardId, outcome, evidence.trim());
      await loadQueue();
    } catch (e) {
      setErr(e?.message || "reconcile failed");
    } finally {
      setBusyId("");
    }
  };

  const onReconcileEntry = async (entryId, outcome) => {
    const evidence = window.prompt(
      `Provide entry reconciliation evidence for ${outcome} (required, auditable):`);
    if (!evidence || !evidence.trim()) return;
    setBusyId(entryId);
    try {
      await reconcileVoiceTreasureEntry(entryId, outcome, evidence.trim());
      await loadQueue();
    } catch (e) {
      setErr(e?.message || "reconcile failed");
    } finally {
      setBusyId("");
    }
  };

  const onEntryRecovery = async (entryId, kind) => {
    const verb = kind === "reopen" ? "reopen this paid entry" : "replace this entry's mission";
    const reason = window.prompt(`Reason to ${verb} (required, auditable). No second charge occurs:`);
    if (!reason || !reason.trim()) return;
    setBusyId(entryId);
    try {
      if (kind === "reopen") await reopenVoiceTreasureEntry(entryId, reason.trim());
      else await replaceVoiceTreasureMission(entryId, reason.trim());
      await loadRows("entries");
    } catch (e) {
      setErr(e?.message || "recovery failed");
    } finally {
      setBusyId("");
    }
  };

  const tabs = [
    ["analytics", "Analytics"],
    ["attempts", "Attempts"],
    ["entries", "Entry transactions"],
    ["rewards", "Reward claims"],
    ["reconciliation", "Reconciliation"],
  ];

  return (
    <div data-testid="vt-ops" style={opsCard}>
      <h3 style={{ fontSize: 14, marginBottom: 10, color: "#FFE19A" }}>Operations</h3>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {tabs.map(([k, label]) => (
          <button
            key={k}
            data-testid={`vt-ops-tab-${k}`}
            onClick={() => setTab(k)}
            style={{
              background: tab === k ? "linear-gradient(135deg,#FFE19A,#D4A843)" : "transparent",
              color: tab === k ? "#1a1420" : "#C9B89A",
              border: "1px solid rgba(212,168,67,0.3)", borderRadius: 999,
              padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer",
            }}
          >{label}</button>
        ))}
      </div>

      {err && <div data-testid="vt-ops-error" style={{ fontSize: 12, color: "#E2A0A0", marginBottom: 8 }}>{err}</div>}

      {tab === "analytics" && analytics && (
        <div data-testid="vt-ops-analytics" style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          <Stat label="Missions offered" value={analytics.missions_offered} testId="vt-an-missions" />
          <Stat label="Entries paid" value={analytics.entries_paid} testId="vt-an-entries" />
          <Stat label="Attempts submitted" value={analytics.attempts_submitted} testId="vt-an-submitted" />
          <Stat label="Attempts evaluated" value={analytics.attempts_evaluated} testId="vt-an-evaluated" />
          <Stat label="Points spent" value={analytics.points_spent} testId="vt-an-spent" />
          <Stat label="Points rewarded" value={analytics.points_rewarded} testId="vt-an-rewarded" />
          <Stat label="Net points flow" value={analytics.net_points_flow} testId="vt-an-net" />
          <Stat label="Provider failures" value={analytics.provider_failures} testId="vt-an-failures" />
          <Stat label="Recon — entries" value={analytics.reconciliation_required_entries} testId="vt-an-recon-entries" />
          <Stat label="Recon — rewards" value={analytics.reconciliation_required_rewards} testId="vt-an-recon-rewards" />
          <Stat label="Reopens" value={analytics.reopen_count ?? 0} testId="vt-an-reopens" />
          <Stat label="Replacements" value={analytics.replacement_count ?? 0} testId="vt-an-replacements" />
        </div>
      )}

      {(tab === "attempts" || tab === "entries" || tab === "rewards") && (
        <div data-testid="vt-ops-table" style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={opsTh}>ID</th>
                <th style={opsTh}>Student</th>
                <th style={opsTh}>State</th>
                <th style={opsTh}>Detail</th>
                {tab === "entries" && <th style={opsTh}>Recovery</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td style={opsTd} colSpan={tab === "entries" ? 5 : 4}>No records.</td></tr>
              )}
              {rows.map((r, i) => (
                <tr key={r.attempt_id || r.entry_id || r.reward_id || i}>
                  <td style={opsTd}>{r.attempt_id || r.entry_id || r.reward_id}</td>
                  <td style={opsTd}>{r.student_id}</td>
                  <td style={opsTd}>{r.state}</td>
                  <td style={opsTd}>
                    {tab === "rewards"
                      ? `pts:${(r.fulfillment && r.fulfillment.credited_points) || 0}`
                      : tab === "entries"
                        ? `cost:${r.cost_points ?? "-"}`
                        : `score:${(r.result && r.result.overall) ?? "-"}`}
                  </td>
                  {tab === "entries" && (
                    <td style={opsTd}>
                      {r.state === "succeeded" ? (
                        <>
                          <button
                            data-testid={`vt-entry-reopen-${r.entry_id}`}
                            disabled={busyId === r.entry_id}
                            onClick={() => onEntryRecovery(r.entry_id, "reopen")}
                            style={{ marginRight: 6, fontSize: 11, padding: "3px 8px", borderRadius: 6, border: "1px solid #8db4ff", background: "transparent", color: "#9fc0ff", cursor: "pointer" }}
                          >Reopen</button>
                          <button
                            data-testid={`vt-entry-replace-${r.entry_id}`}
                            disabled={busyId === r.entry_id}
                            onClick={() => onEntryRecovery(r.entry_id, "replace")}
                            style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, border: "1px solid #ffce6b", background: "transparent", color: "#ffce6b", cursor: "pointer" }}
                          >Replace mission</button>
                        </>
                      ) : <span style={{ color: "#9a8c70" }}>—</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "reconciliation" && queue && (
        <div data-testid="vt-ops-reconciliation">
          <div style={{ fontSize: 12, color: "#C9B89A", marginBottom: 6 }}>
            Reward reconciliation queue ({queue.reward_count})
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={opsTh}>Reward ID</th>
                <th style={opsTh}>Student</th>
                <th style={opsTh}>Reason</th>
                <th style={opsTh}>Resolve</th>
              </tr>
            </thead>
            <tbody>
              {(queue.reward_reconciliation || []).length === 0 && (
                <tr><td style={opsTd} colSpan={4}>Queue empty.</td></tr>
              )}
              {(queue.reward_reconciliation || []).map((r) => (
                <tr key={r.reward_id}>
                  <td style={opsTd}>{r.reward_id}</td>
                  <td style={opsTd}>{r.student_id}</td>
                  <td style={opsTd}>{r.last_failure_reason || "-"}</td>
                  <td style={opsTd}>
                    <button
                      data-testid={`vt-recon-success-${r.reward_id}`}
                      disabled={busyId === r.reward_id}
                      onClick={() => onReconcile(r.reward_id, "resolved_success")}
                      style={{ marginRight: 6, fontSize: 11, padding: "3px 8px", borderRadius: 6, border: "1px solid #6FCF97", background: "transparent", color: "#9FE2B0", cursor: "pointer" }}
                    >Confirmed sent</button>
                    <button
                      data-testid={`vt-recon-failed-${r.reward_id}`}
                      disabled={busyId === r.reward_id}
                      onClick={() => onReconcile(r.reward_id, "resolved_failed")}
                      style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, border: "1px solid #E2A0A0", background: "transparent", color: "#E2A0A0", cursor: "pointer" }}
                    >Not sent</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 11, color: "#C9B89A", marginTop: 8 }}>
            Entry reconciliation queue ({queue.entry_count})
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 4 }}>
            <thead>
              <tr>
                <th style={opsTh}>Entry ID</th>
                <th style={opsTh}>Student</th>
                <th style={opsTh}>Reason</th>
                <th style={opsTh}>Resolve</th>
              </tr>
            </thead>
            <tbody>
              {(queue.entry_reconciliation || []).length === 0 && (
                <tr><td style={opsTd} colSpan={4}>Queue empty.</td></tr>
              )}
              {(queue.entry_reconciliation || []).map((r) => (
                <tr key={r.entry_id}>
                  <td style={opsTd}>{r.entry_id}</td>
                  <td style={opsTd}>{r.student_id}</td>
                  <td style={opsTd}>{r.last_failure_reason || "-"}</td>
                  <td style={opsTd}>
                    <button
                      data-testid={`vt-entry-recon-paid-${r.entry_id}`}
                      disabled={busyId === r.entry_id}
                      onClick={() => onReconcileEntry(r.entry_id, "resolved_paid")}
                      style={{ marginRight: 6, fontSize: 11, padding: "3px 8px", borderRadius: 6, border: "1px solid #6FCF97", background: "transparent", color: "#9FE2B0", cursor: "pointer" }}
                    >Debit applied</button>
                    <button
                      data-testid={`vt-entry-recon-failed-${r.entry_id}`}
                      disabled={busyId === r.entry_id}
                      onClick={() => onReconcileEntry(r.entry_id, "resolved_failed")}
                      style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, border: "1px solid #E2A0A0", background: "transparent", color: "#E2A0A0", cursor: "pointer" }}
                    >No debit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * VoiceTreasureSceneLibrary — manage the 8 bundled mission scenes: list,
 * enable/disable, edit prompt text, difficulty, and theme. Reads the admin
 * scene endpoint (includes rubric/keyword hints for admin visibility only) and
 * persists per-scene overrides through the admin update endpoint. Never sends
 * grounding data to students.
 * ------------------------------------------------------------------------- */
function VoiceTreasureSceneLibrary() {
  const [scenes, setScenes] = useState(null);
  const [err, setErr] = useState("");
  const [savingId, setSavingId] = useState("");
  const [drafts, setDrafts] = useState({});

  const load = async () => {
    setErr("");
    try {
      const res = await getVoiceTreasureScenes();
      setScenes(res.scenes || []);
    } catch (e) { setErr(e?.message || "Could not load scenes."); }
  };
  useEffect(() => { load(); }, []);

  const draftFor = (sc) => drafts[sc.scene_id] || {};
  const setDraft = (id, patch) =>
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] || {}), ...patch } }));

  const saveScene = async (sc) => {
    setSavingId(sc.scene_id);
    setErr("");
    const d = draftFor(sc);
    const override = {
      enabled: d.enabled != null ? d.enabled : sc.enabled,
      prompt: d.prompt != null ? d.prompt : sc.prompt,
      difficulty: d.difficulty || sc.difficulty,
      theme: d.theme || sc.theme,
    };
    try {
      await updateVoiceTreasureScene(sc.scene_id, override);
      await load();
      setDrafts((dd) => { const n = { ...dd }; delete n[sc.scene_id]; return n; });
    } catch (e) {
      setErr(e?.message || "Save failed.");
    } finally {
      setSavingId("");
    }
  };

  return (
    <div data-testid="vt-scene-library" style={opsCard}>
      <h3 style={{ fontSize: 14, marginBottom: 4, color: "#FFE19A" }}>Mission scene library</h3>
      <div style={{ fontSize: 11, color: "#C9B89A", marginBottom: 12 }}>
        8 bundled scenes. Disable a scene to remove it from rotation. Prompt edits
        apply to future missions only.
      </div>
      {err && <div data-testid="vt-scene-error" style={{ fontSize: 12, color: "#E2A0A0", marginBottom: 8 }}>{err}</div>}
      {scenes === null ? (
        <div data-testid="vt-scene-loading" style={{ fontSize: 12, color: "#C9B89A" }}>Loading scenes…</div>
      ) : scenes.length === 0 ? (
        <div data-testid="vt-scene-empty" style={{ fontSize: 12, color: "#C9B89A", padding: "8px 0" }}>
          No scenes configured.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {scenes.map((sc) => {
            const d = draftFor(sc);
            const enabled = d.enabled != null ? d.enabled : sc.enabled;
            return (
              <div key={sc.scene_id} data-testid={`vt-scene-${sc.scene_id}`}
                   style={{ border: "1px solid rgba(212,168,67,0.18)", borderRadius: 10, padding: 12,
                            opacity: enabled ? 1 : 0.55 }}>
                <div className="vts-scene-row-head">
                  <div className="vts-scene-meta">
                    <div className="vts-scene-thumb" aria-hidden="true" data-testid={`vt-scene-thumb-${sc.scene_id}`}>
                      <ImageIcon size={20} />
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, color: "#E8DEC9" }}>{sc.title}</div>
                      <div style={{ fontSize: 11, color: "#9a8c70", marginTop: 2 }}>
                        {sc.scene_id} · theme: {sc.theme}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span
                      className="vts-scene-status"
                      data-state={enabled ? "enabled" : "disabled"}
                      data-testid={`vt-scene-status-${sc.scene_id}`}
                    >
                      {enabled ? "ACTIVE" : "INACTIVE"}
                    </span>
                    <label style={{ fontSize: 12, color: "#C9B89A", display: "flex", gap: 6, alignItems: "center" }}>
                      <input type="checkbox" data-testid={`vt-scene-enabled-${sc.scene_id}`}
                             checked={!!enabled}
                             onChange={(e) => setDraft(sc.scene_id, { enabled: e.target.checked })} />
                      Enabled
                    </label>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "#9a8c70", margin: "8px 0 4px" }}>
                  ref: {sc.image_ref} · asset: {sc.asset_file}
                </div>
                <textarea
                  data-testid={`vt-scene-prompt-${sc.scene_id}`}
                  value={d.prompt != null ? d.prompt : sc.prompt}
                  onChange={(e) => setDraft(sc.scene_id, { prompt: e.target.value })}
                  rows={2}
                  style={{ width: "100%", fontSize: 12, background: "rgba(0,0,0,0.25)",
                           color: "#E8DEC9", border: "1px solid rgba(212,168,67,0.2)",
                           borderRadius: 8, padding: 8, boxSizing: "border-box" }}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <select value={d.difficulty || sc.difficulty}
                          data-testid={`vt-scene-difficulty-${sc.scene_id}`}
                          onChange={(e) => setDraft(sc.scene_id, { difficulty: e.target.value })}
                          style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6,
                                   background: "#241a30", color: "#E8DEC9", border: "1px solid rgba(212,168,67,0.25)" }}>
                    {["beginner", "intermediate", "advanced"].map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                  <span style={{ fontSize: 11, color: "#9a8c70" }}>
                    hints: {(sc.keyword_hints || []).slice(0, 5).join(", ")}…
                  </span>
                  <button
                    data-testid={`vt-scene-save-${sc.scene_id}`}
                    disabled={savingId === sc.scene_id}
                    onClick={() => saveScene(sc)}
                    style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, padding: "5px 14px",
                             borderRadius: 999, border: "none", cursor: "pointer",
                             background: "linear-gradient(135deg,#FFE19A,#D4A843)", color: "#1a1420" }}
                  >{savingId === sc.scene_id ? "Saving…" : "Save"}</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


/* ───────────────────────────────────────────────────────────────────────────
 * VoiceTreasureStudioOverview — Pass B.2.1 polish.
 *
 * Premium-styled overview surface built from authoritative data only:
 *   • cfg.access.enabled         — feature flag at config level
 *   • effective.master_enabled   — backend master switch (authoritative)
 *   • cfg.entry.entry_cost_points
 *   • daily limit (constant 1 — explicit in the existing schema)
 *   • cfg.language summary
 *   • integration_status — number of effectively-active reward types
 *
 * Surfaces honest warnings (master OFF / no active rewards / image gen OFF)
 * rather than fabricating any uptime/metrics that don't exist.
 * ------------------------------------------------------------------------- */
function VoiceTreasureStudioOverview({ cfg, effective, integrationStatus }) {
  const lang = cfg.language || {};
  const rewards = useMemo(() => ["points", "first_voice_card", "voucher", "edutalk_pass"], []);
  const active = useMemo(
    () => rewards.filter((k) => integrationStatus && integrationStatus[k] && integrationStatus[k].effectively_active),
    [integrationStatus, rewards],
  );
  const warnings = [];
  if (effective && effective.master_enabled === false) {
    warnings.push({ tone: "error", text: "Master switch OFF — students cannot enter." });
  }
  if (effective && effective.master_image_generation_enabled === false) {
    warnings.push({ tone: "warn", text: "Image generation master OFF — bundled scenes only." });
  }
  if (effective && active.length === 0) {
    warnings.push({ tone: "warn", text: "No reward is effectively active." });
  }
  if (!warnings.length && effective && effective.feature_available) {
    warnings.push({ tone: "ok", text: "Feature available to students." });
  }
  return (
    <section className="vts-overview" data-testid="vts-overview">
      <div className="vts-overview-head">
        <Compass size={16} aria-hidden="true" />
        <span className="vts-overview-title">Overview</span>
      </div>
      <div className="vts-overview-grid">
        <Stat2 icon={ShieldCheck} label="Feature available"
          value={effective ? String(!!effective.feature_available) : "—"}
          testId="vts-ov-available" />
        <Stat2 icon={Activity} label="Master switch"
          value={effective ? (effective.master_enabled ? "ON" : "OFF") : "—"}
          testId="vts-ov-master" />
        <Stat2 icon={Coins} label="Entry cost"
          value={`${cfg.entry?.entry_cost_points ?? 0} pts`}
          testId="vts-ov-entry-cost" />
        <Stat2 icon={Layers} label="Daily mission limit"
          value={1}
          testId="vts-ov-daily-limit" />
        <Stat2 icon={Sparkles} label="Active rewards"
          value={`${active.length} / ${rewards.length}`}
          testId="vts-ov-active-rewards" />
        <Stat2 icon={Languages} label="Response"
          value={lang.response_language || "english"}
          testId="vts-ov-lang-response" />
        <Stat2 icon={Globe2} label="Feedback"
          value={lang.feedback_language || "english"}
          testId="vts-ov-lang-feedback" />
        <Stat2 icon={BookOpen} label="Instruction"
          value={lang.mission_instruction_language || "english"}
          testId="vts-ov-lang-instruction" />
      </div>
      <div className="vts-overview-warns" data-testid="vts-overview-warnings">
        {warnings.map((w, i) => (
          <span
            key={i}
            className="vts-overview-warn"
            data-tone={w.tone}
            data-testid={`vts-ov-warn-${w.tone}-${i}`}
          >
            {w.tone === "ok" ? <CheckCircle2 size={11} aria-hidden="true" />
              : w.tone === "error" ? <XCircle size={11} aria-hidden="true" />
              : <AlertTriangle size={11} aria-hidden="true" />}
            <span style={{ marginLeft: 4 }}>{w.text}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

function Stat2({ icon: Icon, label, value, testId }) {
  return (
    <div className="vts-overview-stat" data-testid={testId}>
      <div className="vts-overview-stat-label">
        {Icon ? <Icon size={12} aria-hidden="true" /> : null}
        <span>{label}</span>
      </div>
      <div className="vts-overview-stat-value">{value}</div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * VoiceTreasureBilingualPreview — Pass B.2.1 polish.
 *
 * Live preview card showing the student-facing instruction in English,
 * Khmer, and Bilingual, using the existing cfg.language fields. Pure
 * preview surface — no API calls, no save behavior side-effects.
 * ------------------------------------------------------------------------- */
const DEFAULT_INSTRUCTION_EN = "Describe what you see in the picture. Use full sentences.";
const DEFAULT_INSTRUCTION_KM = "សូមពិពណ៌នាអំពីអ្វីដែលអ្នកឃើញនៅក្នុងរូបភាព។ សូមប្រើប្រយោគពេញលេញ។";

function VoiceTreasureBilingualPreview({ language }) {
  const en = (language.mission_instruction_text_en || "").trim();
  const km = (language.mission_instruction_text_km || "").trim();
  const enText = en || DEFAULT_INSTRUCTION_EN;
  const kmText = km || DEFAULT_INSTRUCTION_KM;
  const enFallback = !en;
  const kmFallback = !km;
  return (
    <div className="vts-bilingual-preview" data-testid="vts-bilingual-preview">
      <div className="vts-bilingual-preview-head">
        <Sparkles size={12} aria-hidden="true" />
        Student-visible instruction preview
      </div>
      <div className="vts-bilingual-preview-row">
        <div className="vts-bilingual-preview-card" data-testid="vts-bilingual-preview-en">
          <div className="vts-bilingual-preview-tag">
            English
            {enFallback ? (
              <span className="vts-fallback-tag" data-testid="vts-bilingual-fallback-en">
                <AlertTriangle size={9} aria-hidden="true" /> fallback
              </span>
            ) : null}
          </div>
          <div className="vts-bilingual-preview-body" data-testid="vts-bilingual-preview-en-body">
            {enText}
          </div>
          <div className="vts-bilingual-preview-count" data-testid="vts-bilingual-preview-en-count">
            {enText.length} chars
          </div>
        </div>
        <div className="vts-bilingual-preview-card" data-testid="vts-bilingual-preview-km">
          <div className="vts-bilingual-preview-tag">
            Khmer
            {kmFallback ? (
              <span className="vts-fallback-tag" data-testid="vts-bilingual-fallback-km">
                <AlertTriangle size={9} aria-hidden="true" /> fallback
              </span>
            ) : null}
          </div>
          <div className="vts-bilingual-preview-body" lang="km" data-testid="vts-bilingual-preview-km-body">
            {kmText}
          </div>
          <div className="vts-bilingual-preview-count" data-testid="vts-bilingual-preview-km-count">
            {kmText.length} chars
          </div>
        </div>
        <div className="vts-bilingual-preview-card" style={{ gridColumn: "1 / -1" }}
             data-testid="vts-bilingual-preview-both">
          <div className="vts-bilingual-preview-tag">Bilingual (paired)</div>
          <div className="vts-bilingual-preview-body" data-testid="vts-bilingual-preview-both-en">
            {enText}
          </div>
          <div className="vts-bilingual-preview-body" lang="km" style={{ marginTop: 6 }}
               data-testid="vts-bilingual-preview-both-km">
            {kmText}
          </div>
        </div>
      </div>
    </div>
  );
}
