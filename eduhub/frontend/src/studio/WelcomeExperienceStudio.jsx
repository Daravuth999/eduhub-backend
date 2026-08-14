/**
 * WelcomeExperienceStudio.jsx — Author Studio › Welcome Experience (Phase 3)
 *
 * The first management screen on the Experience Configuration Platform:
 * "code defines capabilities, Author Studio controls the experience."
 * Every visual/motion/playback dial the platform's token modules define
 * (palettes, motion presets, lighting, particles) is exposed here as a
 * picker bound to the token's id — never free text, never a new value
 * invented in this file. Content stays free text since that's genuinely
 * per-deployment copy.
 *
 * A draft is never live until explicitly Published. Publishing here is
 * exactly what makes GET /experience-configs/active (Phase 1) start
 * returning it, which is what the Dashboard's real Hero then renders —
 * this file never talks to the Hero directly except for the live preview
 * below, which renders the ACTUAL Hero.jsx component so "what you see
 * here" and "what ships" can never drift apart.
 *
 * Scoped to experienceType="welcome_dashboard" only. Future experience
 * types (digital_books_hero, etc.) get their own Studio tab when they're
 * built — this file intentionally does not generalize itself further
 * ahead of a second real consumer.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Sparkles, Plus, RefreshCw, Trash2, Pencil, X, Eye,
  Save, AlertTriangle, Check, Rocket, Undo2, Copy,
} from "lucide-react";
import {
  listExperienceConfigs, createExperienceConfig, updateExperienceConfig,
  publishExperienceConfig, unpublishExperienceConfig,
  duplicateExperienceConfig, deleteExperienceConfig,
} from "./api";
import { palettes } from "../eduhub/styles/tokens/designTokens";
import { animationPresets } from "../eduhub/styles/tokens/animationPresets";
import { lightingPresets } from "../eduhub/styles/tokens/lightingTokens";
import { particlePresets } from "../eduhub/styles/tokens/particlePresets";
import Hero from "../eduhub/components/Hero";
import HeroArtworkPanel from "./HeroArtworkPanel";

const EXPERIENCE_TYPE = "welcome_dashboard";

const BLANK = {
  key: "default",
  content: {
    badge: "Academic Learning Portal",
    title: "Welcome to Our Classroom",
    khmerSubtitle: "",
    description: "Interactive Learning Portal",
    instructorLine: "",
    cta: null,
    visible: true,
  },
  appearance: { paletteId: "morningEmerald", radiusId: "lg" },
  motion: { presetId: "cinematicRise", lightingId: "sunrise", particlesId: "sparseStars" },
  playback: { firstLaunchOfDay: true, firstLaunchPerSession: true, replayIntervalHours: 6 },
  activeWindow: { startsAt: "", endsAt: "" },
};

const PALETTE_OPTIONS = Object.entries(palettes).map(([id, p]) => ({ id, label: p.label }));
const PRESET_OPTIONS = Object.entries(animationPresets).map(([id, p]) => ({ id, label: p.label }));
const LIGHTING_OPTIONS = Object.entries(lightingPresets).map(([id, p]) => ({ id, label: p.label }));
const PARTICLE_OPTIONS = Object.entries(particlePresets).map(([id, p]) => ({ id, label: p.label }));

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

function ConfigForm({ initial, onSaved, onCancel }) {
  const [form, setForm] = useState(initial || BLANK);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const setContent = (k, v) => setForm((f) => ({ ...f, content: { ...f.content, [k]: v } }));
  const setAppearance = (k, v) => setForm((f) => ({ ...f, appearance: { ...f.appearance, [k]: v } }));
  const setHeroArtwork = (nextHeroArtwork) =>
    setForm((f) => ({ ...f, appearance: { ...f.appearance, heroArtwork: nextHeroArtwork } }));
  const setMotion = (k, v) => setForm((f) => ({ ...f, motion: { ...f.motion, [k]: v } }));
  const setPlayback = (k, v) => setForm((f) => ({ ...f, playback: { ...f.playback, [k]: v } }));
  const setWindow = (k, v) => setForm((f) => ({ ...f, activeWindow: { ...f.activeWindow, [k]: v } }));

  const previewConfig = useMemo(() => ({
    experienceType: EXPERIENCE_TYPE,
    content: form.content,
    appearance: form.appearance,
    motion: form.motion,
    playback: form.playback,
  }), [form]);

  const handleSubmit = async () => {
    setErr(null);
    if (!form.content.title || !form.content.title.trim()) {
      return setErr("Title is required.");
    }
    setSaving(true);
    try {
      const activeWindow = {
        startsAt: form.activeWindow.startsAt ? new Date(form.activeWindow.startsAt).toISOString() : null,
        endsAt: form.activeWindow.endsAt ? new Date(form.activeWindow.endsAt).toISOString() : null,
      };
      const payload = {
        content: { ...form.content, title: form.content.title.trim() },
        appearance: form.appearance,
        motion: form.motion,
        playback: {
          ...form.playback,
          replayIntervalHours: Number(form.playback.replayIntervalHours) || 6,
        },
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
    <div className="rounded-2xl border border-gold/25 p-5 mb-6" style={{ background: "rgba(20,14,32,0.55)" }} data-testid="welcomeexp-form">
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="h-4 w-4 text-gold" />
        <h3 className="font-display text-[15px] text-parchment">
          {initial && initial.id ? `Edit "${initial.key}"` : "New Welcome Experience config"}
        </h3>
        <div className="flex-1" />
        {onCancel && (
          <button onClick={onCancel} data-testid="welcomeexp-form-cancel" className="text-faded hover:text-parchment">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          {!initial?.id && (
            <Section title="Key (identifies this variant, e.g. 'default' or 'lunar-new-year')">
              <input style={fieldStyle} value={form.key} data-testid="welcomeexp-key"
                     onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} placeholder="default" />
            </Section>
          )}

          <p className="text-[11px] font-bold uppercase tracking-wider text-gold mb-2">Content</p>
          <Section title="Badge">
            <input style={fieldStyle} value={form.content.badge || ""} data-testid="welcomeexp-badge"
                   onChange={(e) => setContent("badge", e.target.value)} />
          </Section>
          <Section title="Title">
            <input style={fieldStyle} value={form.content.title || ""} data-testid="welcomeexp-title"
                   onChange={(e) => setContent("title", e.target.value)} />
          </Section>
          <Section title="Khmer subtitle">
            <input style={fieldStyle} value={form.content.khmerSubtitle || ""} data-testid="welcomeexp-khmer"
                   onChange={(e) => setContent("khmerSubtitle", e.target.value)} />
          </Section>
          <Section title="Description">
            <input style={fieldStyle} value={form.content.description || ""} data-testid="welcomeexp-description"
                   onChange={(e) => setContent("description", e.target.value)} />
          </Section>
          <Section title="Instructor line">
            <input style={fieldStyle} value={form.content.instructorLine || ""} data-testid="welcomeexp-instructor"
                   onChange={(e) => setContent("instructorLine", e.target.value)} />
          </Section>
          <button type="button" onClick={() => setContent("visible", !form.content.visible)}
                  data-testid="welcomeexp-visible-toggle"
                  className="inline-flex items-center gap-2 text-[12px] font-bold text-parchment">
            {form.content.visible ? <Check className="h-4 w-4 text-green-400" /> : <X className="h-4 w-4 text-faded" />}
            {form.content.visible ? "Visible" : "Hidden"}
          </button>

          <p className="text-[11px] font-bold uppercase tracking-wider text-gold mt-5 mb-2">Scheduling</p>
          <div className="grid grid-cols-2 gap-3">
            <Section title="Starts at (optional)">
              <input type="datetime-local" style={fieldStyle} value={toInputDatetime(form.activeWindow.startsAt)}
                     data-testid="welcomeexp-starts-at"
                     onChange={(e) => setWindow("startsAt", e.target.value)} />
            </Section>
            <Section title="Ends at (optional)">
              <input type="datetime-local" style={fieldStyle} value={toInputDatetime(form.activeWindow.endsAt)}
                     data-testid="welcomeexp-ends-at"
                     onChange={(e) => setWindow("endsAt", e.target.value)} />
            </Section>
          </div>
        </div>

        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-gold mb-2">Appearance</p>
          <Section title="Palette">
            <select style={fieldStyle} value={form.appearance.paletteId} data-testid="welcomeexp-palette"
                    onChange={(e) => setAppearance("paletteId", e.target.value)}>
              {PALETTE_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </Section>

          <HeroArtworkPanel
            heroArtwork={form.appearance.heroArtwork}
            onChange={setHeroArtwork}
          />

          <p className="text-[11px] font-bold uppercase tracking-wider text-gold mt-5 mb-2">Motion</p>
          <Section title="Entrance preset (full-play tier)">
            <select style={fieldStyle} value={form.motion.presetId} data-testid="welcomeexp-preset"
                    onChange={(e) => setMotion("presetId", e.target.value)}>
              {PRESET_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </Section>
          <Section title="Lighting">
            <select style={fieldStyle} value={form.motion.lightingId} data-testid="welcomeexp-lighting"
                    onChange={(e) => setMotion("lightingId", e.target.value)}>
              {LIGHTING_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </Section>
          <Section title="Particles">
            <select style={fieldStyle} value={form.motion.particlesId} data-testid="welcomeexp-particles"
                    onChange={(e) => setMotion("particlesId", e.target.value)}>
              {PARTICLE_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </Section>

          <p className="text-[11px] font-bold uppercase tracking-wider text-gold mt-5 mb-2">Playback</p>
          <button type="button" onClick={() => setPlayback("firstLaunchOfDay", !form.playback.firstLaunchOfDay)}
                  data-testid="welcomeexp-first-launch-day"
                  className="mb-2 inline-flex items-center gap-2 text-[12px] font-bold text-parchment">
            {form.playback.firstLaunchOfDay ? <Check className="h-4 w-4 text-green-400" /> : <X className="h-4 w-4 text-faded" />}
            Play full sequence on first launch of the day
          </button>
          <br />
          <button type="button" onClick={() => setPlayback("firstLaunchPerSession", !form.playback.firstLaunchPerSession)}
                  data-testid="welcomeexp-first-launch-session"
                  className="mb-3 inline-flex items-center gap-2 text-[12px] font-bold text-parchment">
            {form.playback.firstLaunchPerSession ? <Check className="h-4 w-4 text-green-400" /> : <X className="h-4 w-4 text-faded" />}
            Play a short version on session return
          </button>
          <Section title={`Replay interval · ${form.playback.replayIntervalHours}h`}>
            <input type="range" min="1" max="24" value={form.playback.replayIntervalHours}
                   data-testid="welcomeexp-replay-interval"
                   onChange={(e) => setPlayback("replayIntervalHours", Number(e.target.value))}
                   className="w-full accent-[#D4A843]" />
          </Section>
        </div>
      </div>

      {/* Live preview — the ACTUAL Hero component, so what's shown here is exactly what ships */}
      <div className="mt-5">
        <p className={labelCls}><Eye className="inline h-3 w-3 mr-1" /> Live preview</p>
        <div className="rounded-2xl overflow-hidden" data-testid="welcomeexp-preview">
          <Hero config={previewConfig} />
        </div>
      </div>

      {err && (
        <div className="mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-[12px]"
             style={{ background: "rgba(255,100,100,0.12)", color: "#fca5a5" }} data-testid="welcomeexp-error">
          <AlertTriangle className="h-4 w-4" /> {err}
        </div>
      )}

      <div className="mt-5 flex gap-2">
        <button onClick={handleSubmit} disabled={saving} data-testid="welcomeexp-save"
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
         style={{ background: "rgba(30,22,44,0.5)" }} data-testid={`welcomeexp-row-${c.id}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-display text-[14px] text-parchment">{c.key}</p>
          {c.status === "published"
            ? <span className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase" style={{ background: "rgba(52,211,153,0.15)", color: "#6ee7b7" }}>Live</span>
            : <span className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase" style={{ background: "rgba(255,255,255,0.06)", color: "#9ca3af" }}>Draft</span>}
        </div>
        <p className="truncate text-[11px] text-faded">{c.content?.title || "(untitled)"}</p>
        <p className="text-[10.5px] text-faded">v{c.version} · updated {fmtDate(c.updatedAt)}</p>
      </div>
      <button onClick={() => onEdit(c)} data-testid={`welcomeexp-edit-${c.id}`} title="Edit" className="text-parchment hover:text-gold">
        <Pencil className="h-4 w-4" />
      </button>
      {c.status === "published" ? (
        <button onClick={() => onUnpublish(c)} data-testid={`welcomeexp-unpublish-${c.id}`} title="Unpublish" className="text-parchment hover:text-gold">
          <Undo2 className="h-4 w-4" />
        </button>
      ) : (
        <button onClick={() => onPublish(c)} data-testid={`welcomeexp-publish-${c.id}`} title="Publish" className="text-parchment hover:text-green-400">
          <Rocket className="h-4 w-4" />
        </button>
      )}
      <button onClick={() => onDuplicate(c)} data-testid={`welcomeexp-duplicate-${c.id}`} title="Duplicate" className="text-parchment hover:text-gold">
        <Copy className="h-4 w-4" />
      </button>
      {confirm ? (
        <button onClick={() => onDelete(c)} data-testid={`welcomeexp-delete-confirm-${c.id}`}
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold text-red-300"
                style={{ background: "rgba(255,100,100,0.15)" }}>
          <Check className="h-3 w-3" /> Confirm
        </button>
      ) : (
        <button onClick={() => setConfirm(true)} data-testid={`welcomeexp-delete-${c.id}`} title="Delete" className="text-red-300/70 hover:text-red-300">
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export default function WelcomeExperienceStudio() {
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
    <div data-testid="welcome-experience-studio">
      <div className="flex items-center gap-3 mb-5">
        <div className="grid h-10 w-10 place-items-center rounded-xl"
             style={{ background: "linear-gradient(150deg,#2D1F3E,#1A1420)", border: "1px solid rgba(212,168,67,0.25)" }}>
          <Sparkles className="h-5 w-5 text-gold" />
        </div>
        <div className="flex-1">
          <h2 className="font-display text-xl text-parchment">Welcome Experience</h2>
          <p className="text-[11.5px] text-faded">
            Configure the Welcome Dashboard hero's content, appearance, motion and playback.
            Until a config is Published here, the hero keeps using the legacy Google Sheets content.
          </p>
        </div>
        <button onClick={load} data-testid="welcomeexp-refresh"
                className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-walnut/70 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
        {!showForm && (
          <button onClick={startNew} data-testid="welcomeexp-new"
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
             style={{ background: "rgba(255,100,100,0.12)", color: "#fca5a5" }} data-testid="welcomeexp-list-error">
          <AlertTriangle className="h-4 w-4" /> {err}
        </div>
      )}

      {loading ? (
        <p className="text-[12px] text-faded">Loading configs…</p>
      ) : configs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gold/30 px-6 py-12 text-center"
             style={{ background: "rgba(34,24,48,0.4)" }} data-testid="welcomeexp-empty">
          <Sparkles className="mx-auto h-8 w-8 text-gold/70" />
          <p className="mt-3 font-display text-[16px] text-parchment">No Welcome Experience configs yet</p>
          <p className="mt-1 text-[12px] text-faded">The hero is currently driven by the legacy Google Sheets content. Create one to take over.</p>
        </div>
      ) : (
        <div className="space-y-2.5" data-testid="welcomeexp-list">
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
