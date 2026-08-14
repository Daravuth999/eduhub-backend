/**
 * AchievementExperienceStudio.jsx — Author Studio › Achievement Experience
 * › Top Earner (approved "Top Earner Configuration Platform" directive).
 *
 * Mirrors WelcomeExperienceStudio.jsx's CRUD/draft/publish/scheduling
 * contract exactly (same generic experience-configs API, same admin auth,
 * same "draft never live until Published" rule) — scoped to
 * experienceType="achievement_top_earner" instead of "welcome_dashboard".
 * No new backend route, no new caching system: reuses the Experience
 * Configuration Platform end to end.
 *
 * A config is either:
 *   - syncMode "followWelcome": presentation tracks the app's day/night
 *     theme automatically (the base Emerald/Midnight Achievement pair) —
 *     no preset picker needed.
 *   - syncMode "independent": an admin picks ANY of the 11 built-in
 *     presets, then layers optional field-level overrides on top (palette,
 *     trophy, player card, decorations). "Create a custom theme" = publish
 *     a config with overrides, or Duplicate an existing one as a starting
 *     point — reusing the existing generic duplicate endpoint, no second
 *     theme-authoring system.
 *
 * Live preview renders the REAL TopEarnerPanel (same "what you see here
 * is what ships" guarantee as WelcomeExperienceStudio's Hero preview) —
 * it shows the actual live leaderboard data since TopEarnerPanel owns
 * that fetch internally, only the presentation layer is fed by this form.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Trophy, Plus, RefreshCw, Trash2, Pencil, X, Eye,
  Save, AlertTriangle, Check, Rocket, Undo2, Copy, Sparkles as SparklesIcon,
} from "lucide-react";
import {
  listExperienceConfigs, createExperienceConfig, updateExperienceConfig,
  publishExperienceConfig, unpublishExperienceConfig,
  duplicateExperienceConfig, deleteExperienceConfig,
} from "./api";
import HeroArtworkPanel from "./HeroArtworkPanel";
import TopEarnerPanel from "../eduhub/components/TopEarnerPanel";
import {
  achievementThemes, ACHIEVEMENT_PRESET_IDS, DECORATION_TYPES,
  TROPHY_STYLES, MEDAL_DESIGNS, WINNER_ANIMATIONS, CARD_SHAPES,
} from "../eduhub/styles/tokens/achievementThemes";

const EXPERIENCE_TYPE = "achievement_top_earner";

const BLANK = {
  key: "default",
  content: { visible: true },
  appearance: {
    syncMode: "followWelcome",
    themeId: "emeraldAchievement",
    overrides: {},
    artwork: null,
  },
  activeWindow: { startsAt: "", endsAt: "", recurringAnnual: false },
};

const fieldStyle = {
  width: "100%",
  background: "rgba(20,14,32,0.7)",
  border: "1px solid rgba(212,168,67,0.25)",
  borderRadius: 12,
  color: "#F4E5C1",
  padding: "10px 12px",
  fontSize: 13,
  outline: "none",
};

const labelCls = "block text-[11px] font-bold uppercase tracking-wider text-faded mb-1.5";

function Section({ title, children }) {
  return (
    <div className="mb-4">
      <p className={labelCls}>{title}</p>
      {children}
    </div>
  );
}

function toInputDatetime(iso) {
  if (!iso) return "";
  try { return new Date(iso).toISOString().slice(0, 16); } catch { return ""; }
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function fmtMonthDay(md) {
  // md is "MM-DD" (seasonalDefault shape) — render as e.g. "Apr 13".
  const [m, d] = md.split("-").map(Number);
  return new Date(2000, m - 1, d).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function PresetSwatch({ preset, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`achievementexp-preset-${preset.id}`}
      aria-pressed={active}
      className="rounded-xl px-2.5 py-2 text-left transition"
      style={{
        border: active ? `1.5px solid ${preset.goldAccent}` : "1px solid rgba(255,255,255,0.1)",
        background: active ? `${preset.goldAccent}18` : "rgba(255,255,255,0.03)",
      }}
    >
      <div className="h-6 w-full rounded-md mb-1.5" style={{ background: preset.surface }} />
      <p className="text-[10.5px] font-bold text-parchment truncate">{preset.label}</p>
    </button>
  );
}

function DecorationRow({ type, config, onChange }) {
  return (
    <div className="flex items-center gap-2 mb-1.5" data-testid={`achievementexp-decoration-${type}`}>
      <button
        type="button"
        onClick={() => onChange({ ...config, enabled: !config.enabled })}
        data-testid={`achievementexp-decoration-toggle-${type}`}
        className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-parchment min-w-[130px]"
      >
        {config.enabled ? <Check className="h-3.5 w-3.5 text-green-400" /> : <X className="h-3.5 w-3.5 text-faded" />}
        <span className="capitalize">{type.replace(/([A-Z])/g, " $1")}</span>
      </button>
      {config.enabled && (
        <select
          value={config.intensity}
          data-testid={`achievementexp-decoration-intensity-${type}`}
          onChange={(e) => onChange({ ...config, intensity: e.target.value })}
          style={{ ...fieldStyle, width: 100, padding: "4px 8px", fontSize: 11 }}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      )}
    </div>
  );
}

function ConfigForm({ initial, onSaved, onCancel }) {
  const [form, setForm] = useState(initial || BLANK);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const setAppearance = (k, v) => setForm((f) => ({ ...f, appearance: { ...f.appearance, [k]: v } }));
  const setOverride = (k, v) => setForm((f) => ({ ...f, appearance: { ...f.appearance, overrides: { ...f.appearance.overrides, [k]: v } } }));
  const setOverrideSub = (parent, patch) => setForm((f) => ({
    ...f,
    appearance: {
      ...f.appearance,
      overrides: { ...f.appearance.overrides, [parent]: { ...(f.appearance.overrides?.[parent] || {}), ...patch } },
    },
  }));
  const setDecoration = (type, patch) => setForm((f) => ({
    ...f,
    appearance: {
      ...f.appearance,
      overrides: {
        ...f.appearance.overrides,
        decorations: { ...(f.appearance.overrides?.decorations || {}), [type]: patch },
      },
    },
  }));
  const setArtwork = (nextArtwork) => setAppearance("artwork", nextArtwork);
  const setWindow = (k, v) => setForm((f) => ({ ...f, activeWindow: { ...f.activeWindow, [k]: v } }));

  const selectedPreset = achievementThemes[form.appearance.themeId] || achievementThemes.emeraldAchievement;
  const resolvedDecorations = {
    ...selectedPreset.decorations,
    ...(form.appearance.overrides?.decorations || {}),
  };

  const applySuggestedDates = () => {
    if (!selectedPreset.seasonalDefault) return;
    const { startsAt, endsAt, recurringAnnual } = selectedPreset.seasonalDefault;
    const year = new Date().getFullYear();
    // Full UTC ISO ("Z"-suffixed), matching the shape every OTHER
    // activeWindow value in this form already has (loaded-from-backend
    // configs, and what handleSubmit itself writes on save) — so it
    // round-trips through toInputDatetime() identically regardless of
    // the browser's local timezone, instead of a naive "YYYY-MM-DDTHH:mm"
    // string that would get silently shifted when re-parsed as local time.
    setForm((f) => ({
      ...f,
      activeWindow: {
        startsAt: `${year}-${startsAt}T00:00:00Z`,
        endsAt: `${year}-${endsAt}T23:59:00Z`,
        recurringAnnual,
      },
    }));
  };

  const previewConfig = useMemo(() => ({
    experienceType: EXPERIENCE_TYPE,
    content: form.content,
    appearance: form.appearance,
  }), [form]);

  const handleSubmit = async () => {
    setErr(null);
    setSaving(true);
    try {
      const activeWindow = {
        startsAt: form.activeWindow.startsAt ? new Date(form.activeWindow.startsAt).toISOString() : null,
        endsAt: form.activeWindow.endsAt ? new Date(form.activeWindow.endsAt).toISOString() : null,
        recurringAnnual: Boolean(form.activeWindow.recurringAnnual),
      };
      const payload = {
        content: form.content,
        appearance: form.appearance,
        activeWindow,
      };
      if (initial && initial.id) {
        await updateExperienceConfig(initial.id, payload);
      } else {
        await createExperienceConfig({ experienceType: EXPERIENCE_TYPE, key: form.key || "default", ...payload });
      }
      onSaved();
    } catch (e) {
      setErr(e.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-gold/25 p-5 mb-6" style={{ background: "rgba(20,14,32,0.55)" }} data-testid="achievementexp-form">
      <div className="flex items-center gap-2 mb-4">
        <Trophy className="h-4 w-4 text-gold" />
        <h3 className="font-display text-[15px] text-parchment">
          {initial && initial.id ? `Edit "${initial.key}"` : "New Achievement Experience config"}
        </h3>
        <div className="flex-1" />
        {onCancel && (
          <button onClick={onCancel} data-testid="achievementexp-form-cancel" className="text-faded hover:text-parchment">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          {!initial?.id && (
            <Section title="Key (identifies this variant, e.g. 'default' or 'khmer-new-year')">
              <input style={fieldStyle} value={form.key} data-testid="achievementexp-key"
                     onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} placeholder="default" />
            </Section>
          )}

          <p className="text-[11px] font-bold uppercase tracking-wider text-gold mb-2">Theme</p>
          <Section title="Synchronization">
            <div className="flex gap-2">
              {["followWelcome", "independent"].map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setAppearance("syncMode", mode)}
                  aria-pressed={form.appearance.syncMode === mode}
                  data-testid={`achievementexp-syncmode-${mode}`}
                  className="rounded-full px-3.5 py-2 text-[11px] font-bold uppercase tracking-wider"
                  style={
                    form.appearance.syncMode === mode
                      ? { background: "rgba(212,168,67,0.25)", color: "#F4E5C1", border: "1px solid rgba(212,168,67,0.55)" }
                      : { background: "rgba(255,255,255,0.04)", color: "rgba(244,229,193,0.6)", border: "1px solid rgba(255,255,255,0.10)" }
                  }
                >
                  {mode === "followWelcome" ? "Follow Welcome Theme" : "Independent Theme"}
                </button>
              ))}
            </div>
          </Section>

          {form.appearance.syncMode === "independent" && (
            <Section title="Preset">
              <div className="grid grid-cols-3 gap-2" data-testid="achievementexp-preset-grid">
                {ACHIEVEMENT_PRESET_IDS.map((id) => (
                  <PresetSwatch
                    key={id}
                    preset={achievementThemes[id]}
                    active={form.appearance.themeId === id}
                    onClick={() => setAppearance("themeId", id)}
                  />
                ))}
              </div>
            </Section>
          )}

          <p className="text-[11px] font-bold uppercase tracking-wider text-gold mt-5 mb-2">Palette overrides (optional)</p>
          <div className="grid grid-cols-2 gap-3">
            {["primary", "secondary", "accent", "scoreColor"].map((k) => (
              <Section key={k} title={k.replace(/([A-Z])/g, " $1")}>
                <input
                  type="color"
                  data-testid={`achievementexp-override-${k}`}
                  value={form.appearance.overrides?.[k] || selectedPreset[k] || "#000000"}
                  onChange={(e) => setOverride(k, e.target.value)}
                  style={{ ...fieldStyle, padding: 4, height: 34 }}
                />
              </Section>
            ))}
          </div>

          <p className="text-[11px] font-bold uppercase tracking-wider text-gold mt-5 mb-2">Trophy Presentation</p>
          <div className="grid grid-cols-2 gap-3">
            <Section title="Style">
              <select
                style={fieldStyle} data-testid="achievementexp-trophy-style"
                value={form.appearance.overrides?.trophy?.style || selectedPreset.trophy.style}
                onChange={(e) => setOverrideSub("trophy", { style: e.target.value })}
              >
                {TROPHY_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Section>
            <Section title="Medal design">
              <select
                style={fieldStyle} data-testid="achievementexp-trophy-medal"
                value={form.appearance.overrides?.trophy?.medalDesign || selectedPreset.trophy.medalDesign}
                onChange={(e) => setOverrideSub("trophy", { medalDesign: e.target.value })}
              >
                {MEDAL_DESIGNS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Section>
            <Section title="Winner animation">
              <select
                style={fieldStyle} data-testid="achievementexp-trophy-animation"
                value={form.appearance.overrides?.trophy?.winnerAnimation || selectedPreset.trophy.winnerAnimation}
                onChange={(e) => setOverrideSub("trophy", { winnerAnimation: e.target.value })}
              >
                {WINNER_ANIMATIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Section>
            <Section title="Trophy color">
              <input
                type="color" data-testid="achievementexp-trophy-color"
                value={form.appearance.overrides?.trophy?.color || selectedPreset.trophy.color}
                onChange={(e) => setOverrideSub("trophy", { color: e.target.value })}
                style={{ ...fieldStyle, padding: 4, height: 34 }}
              />
            </Section>
          </div>

          <p className="text-[11px] font-bold uppercase tracking-wider text-gold mt-5 mb-2">Player Cards</p>
          <div className="grid grid-cols-2 gap-3">
            <Section title="Shape">
              <select
                style={fieldStyle} data-testid="achievementexp-card-shape"
                value={form.appearance.overrides?.playerCard?.shape || selectedPreset.playerCard.shape}
                onChange={(e) => setOverrideSub("playerCard", { shape: e.target.value })}
              >
                {CARD_SHAPES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Section>
            <Section title="Border style">
              <select
                style={fieldStyle} data-testid="achievementexp-card-border"
                value={form.appearance.overrides?.playerCard?.borderStyle || selectedPreset.playerCard.borderStyle}
                onChange={(e) => setOverrideSub("playerCard", { borderStyle: e.target.value })}
              >
                <option value="solid">Solid</option>
                <option value="glow">Glow</option>
                <option value="none">None</option>
              </select>
            </Section>
          </div>
          <button type="button"
                  onClick={() => setOverrideSub("playerCard", {
                    winnerEmphasis: { enabled: !(form.appearance.overrides?.playerCard?.winnerEmphasis?.enabled ?? selectedPreset.playerCard.winnerEmphasis.enabled) },
                  })}
                  data-testid="achievementexp-card-winner-emphasis"
                  className="inline-flex items-center gap-2 text-[12px] font-bold text-parchment mt-1">
            {(form.appearance.overrides?.playerCard?.winnerEmphasis?.enabled ?? selectedPreset.playerCard.winnerEmphasis.enabled)
              ? <Check className="h-4 w-4 text-green-400" /> : <X className="h-4 w-4 text-faded" />}
            Winner emphasis (champion glow + "On fire")
          </button>

          <button type="button" onClick={() => setForm((f) => ({ ...f, content: { ...f.content, visible: !f.content.visible } }))}
                  data-testid="achievementexp-visible-toggle"
                  className="mt-5 inline-flex items-center gap-2 text-[12px] font-bold text-parchment">
            {form.content.visible ? <Check className="h-4 w-4 text-green-400" /> : <X className="h-4 w-4 text-faded" />}
            {form.content.visible ? "Visible" : "Hidden"}
          </button>
        </div>

        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-gold mb-2">Decorations</p>
          <div className="rounded-xl border border-white/8 p-3" style={{ background: "rgba(0,0,0,0.2)" }}>
            {DECORATION_TYPES.map((type) => (
              <DecorationRow
                key={type}
                type={type}
                config={resolvedDecorations[type]}
                onChange={(patch) => setDecoration(type, patch)}
              />
            ))}
          </div>

          <HeroArtworkPanel
            heroArtwork={form.appearance.artwork}
            onChange={setArtwork}
          />

          <p className="text-[11px] font-bold uppercase tracking-wider text-gold mt-5 mb-2">Seasonal Scheduling</p>
          {selectedPreset.seasonalDefault && (
            <button
              type="button"
              onClick={applySuggestedDates}
              data-testid="achievementexp-use-suggested-dates"
              className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-walnut/70 px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold"
            >
              <SparklesIcon className="h-3 w-3" />
              Use suggested dates ({fmtMonthDay(selectedPreset.seasonalDefault.startsAt)}–{fmtMonthDay(selectedPreset.seasonalDefault.endsAt)})
            </button>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Section title="Starts at (optional)">
              <input type="datetime-local" style={fieldStyle} value={toInputDatetime(form.activeWindow.startsAt)}
                     data-testid="achievementexp-starts-at"
                     onChange={(e) => setWindow("startsAt", e.target.value)} />
            </Section>
            <Section title="Ends at (optional)">
              <input type="datetime-local" style={fieldStyle} value={toInputDatetime(form.activeWindow.endsAt)}
                     data-testid="achievementexp-ends-at"
                     onChange={(e) => setWindow("endsAt", e.target.value)} />
            </Section>
          </div>
          <button type="button" onClick={() => setWindow("recurringAnnual", !form.activeWindow.recurringAnnual)}
                  data-testid="achievementexp-recurring-annual"
                  className="mt-2 inline-flex items-center gap-2 text-[12px] font-bold text-parchment">
            {form.activeWindow.recurringAnnual ? <Check className="h-4 w-4 text-green-400" /> : <X className="h-4 w-4 text-faded" />}
            Repeat every year (same dates, no redeploy needed)
          </button>
        </div>
      </div>

      {/* Live preview — the ACTUAL TopEarnerPanel, so what's shown here is exactly what ships */}
      <div className="mt-5">
        <p className={labelCls}><Eye className="inline h-3 w-3 mr-1" /> Live preview</p>
        <div className="rounded-2xl overflow-hidden" data-testid="achievementexp-preview">
          <TopEarnerPanel achievementConfig={previewConfig} />
        </div>
      </div>

      {err && (
        <div className="mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-[12px]"
             style={{ background: "rgba(255,100,100,0.12)", color: "#fca5a5" }} data-testid="achievementexp-error">
          <AlertTriangle className="h-4 w-4" /> {err}
        </div>
      )}

      <div className="mt-5 flex gap-2">
        <button onClick={handleSubmit} disabled={saving} data-testid="achievementexp-save"
                className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-[12px] font-bold uppercase tracking-wider text-ink disabled:opacity-50"
                style={{ background: "linear-gradient(135deg,#FFE19A 0%,#D4A843 50%,#9C7A2C 100%)" }}>
          <Save className="h-3.5 w-3.5" /> {saving ? "Saving…" : "Save draft"}
        </button>
        {onCancel && (
          <button onClick={onCancel}
                  className="rounded-full border border-parchment/25 px-4 py-2.5 text-[12px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function ConfigRow({ c, onEdit, onPublish, onUnpublish, onDuplicate, onDelete }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="rounded-xl border border-white/8 p-3 flex items-center gap-3"
         style={{ background: "rgba(30,22,44,0.5)" }} data-testid={`achievementexp-row-${c.id}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-display text-[14px] text-parchment">{c.key}</p>
          {c.status === "published"
            ? <span className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase" style={{ background: "rgba(52,211,153,0.15)", color: "#6ee7b7" }}>Live</span>
            : <span className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase" style={{ background: "rgba(255,255,255,0.06)", color: "#9ca3af" }}>Draft</span>}
          {c.activeWindow?.recurringAnnual && (
            <span className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase" style={{ background: "rgba(212,168,67,0.15)", color: "#D4A843" }}>Recurring</span>
          )}
        </div>
        <p className="truncate text-[11px] text-faded">
          {c.appearance?.syncMode === "independent" ? (achievementThemes[c.appearance?.themeId]?.label || c.appearance?.themeId) : "Follows Welcome Theme"}
        </p>
        <p className="text-[10.5px] text-faded">v{c.version} · updated {fmtDate(c.updatedAt)}</p>
      </div>
      <button onClick={() => onEdit(c)} data-testid={`achievementexp-edit-${c.id}`} title="Edit" className="text-parchment hover:text-gold">
        <Pencil className="h-4 w-4" />
      </button>
      {c.status === "published" ? (
        <button onClick={() => onUnpublish(c)} data-testid={`achievementexp-unpublish-${c.id}`} title="Unpublish" className="text-parchment hover:text-gold">
          <Undo2 className="h-4 w-4" />
        </button>
      ) : (
        <button onClick={() => onPublish(c)} data-testid={`achievementexp-publish-${c.id}`} title="Publish" className="text-parchment hover:text-green-400">
          <Rocket className="h-4 w-4" />
        </button>
      )}
      <button onClick={() => onDuplicate(c)} data-testid={`achievementexp-duplicate-${c.id}`} title="Duplicate" className="text-parchment hover:text-gold">
        <Copy className="h-4 w-4" />
      </button>
      {confirm ? (
        <button onClick={() => onDelete(c)} data-testid={`achievementexp-delete-confirm-${c.id}`}
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold text-red-300"
                style={{ background: "rgba(255,100,100,0.15)" }}>
          <Check className="h-3 w-3" /> Confirm
        </button>
      ) : (
        <button onClick={() => setConfirm(true)} data-testid={`achievementexp-delete-${c.id}`} title="Delete" className="text-red-300/70 hover:text-red-300">
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export default function AchievementExperienceStudio() {
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await listExperienceConfigs(EXPERIENCE_TYPE);
      setConfigs(data.configs || []);
    } catch (e) {
      setErr(e.message || "Failed to load configs.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startNew = () => { setEditing(null); setShowForm(true); };
  const startEdit = (c) => {
    setEditing({
      ...c,
      activeWindow: {
        startsAt: c.activeWindow?.startsAt || "",
        endsAt: c.activeWindow?.endsAt || "",
        recurringAnnual: Boolean(c.activeWindow?.recurringAnnual),
      },
    });
    setShowForm(true);
  };
  const handleSaved = () => { setShowForm(false); setEditing(null); load(); };

  const handlePublish = async (c) => {
    try { await publishExperienceConfig(c.id); load(); } catch (e) { setErr(e.message); }
  };
  const handleUnpublish = async (c) => {
    try { await unpublishExperienceConfig(c.id); load(); } catch (e) { setErr(e.message); }
  };
  const handleDuplicate = async (c) => {
    try { await duplicateExperienceConfig(c.id); load(); } catch (e) { setErr(e.message); }
  };
  const handleDelete = async (c) => {
    try {
      await deleteExperienceConfig(c.id, { force: c.status === "published" });
      load();
    } catch (e) { setErr(e.message); }
  };

  return (
    <div data-testid="achievement-experience-studio">
      <div className="flex items-center gap-3 mb-5">
        <div className="grid h-10 w-10 place-items-center rounded-xl"
             style={{ background: "linear-gradient(150deg,#2D1F3E,#1A1420)", border: "1px solid rgba(212,168,67,0.25)" }}>
          <Trophy className="h-5 w-5 text-gold" />
        </div>
        <div className="flex-1">
          <h2 className="font-display text-xl text-parchment">Achievement Experience — Top Earner</h2>
          <p className="text-[11.5px] text-faded">
            Configure the Top Earner panel's theme, decorations, trophy presentation, background artwork and seasonal scheduling.
            Until a config is Published here, the panel automatically follows the app's Day/Night theme (Emerald/Midnight Achievement).
          </p>
        </div>
        <button onClick={load} data-testid="achievementexp-refresh"
                className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-walnut/70 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
        {!showForm && (
          <button onClick={startNew} data-testid="achievementexp-new"
                  className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-ink"
                  style={{ background: "linear-gradient(135deg,#FFE19A 0%,#D4A843 50%,#9C7A2C 100%)" }}>
            <Plus className="h-3.5 w-3.5" /> New config
          </button>
        )}
      </div>

      {showForm && (
        <ConfigForm initial={editing} onSaved={handleSaved} onCancel={() => { setShowForm(false); setEditing(null); }} />
      )}

      {err && (
        <div className="mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-[12px]"
             style={{ background: "rgba(255,100,100,0.12)", color: "#fca5a5" }} data-testid="achievementexp-list-error">
          <AlertTriangle className="h-4 w-4" /> {err}
        </div>
      )}

      {loading ? (
        <p className="text-[12px] text-faded">Loading configs…</p>
      ) : configs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gold/30 px-6 py-12 text-center"
             style={{ background: "rgba(34,24,48,0.4)" }} data-testid="achievementexp-empty">
          <Trophy className="mx-auto h-8 w-8 text-gold/70" />
          <p className="mt-3 font-display text-[16px] text-parchment">No Achievement Experience configs yet</p>
          <p className="mt-1 text-[12px] text-faded">The Top Earner panel is currently following the app's Day/Night theme automatically. Create one to customize it.</p>
        </div>
      ) : (
        <div className="space-y-2.5" data-testid="achievementexp-list">
          {configs.map((c) => (
            <ConfigRow key={c.id} c={c}
                       onEdit={startEdit} onPublish={handlePublish} onUnpublish={handleUnpublish}
                       onDuplicate={handleDuplicate} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}
