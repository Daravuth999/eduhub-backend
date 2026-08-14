/**
 * ExperienceDesignerSection.jsx — Author Studio "Experience Designer".
 * A visual, canvas-first section added INSIDE the existing Login Reward
 * campaign form. It only edits `form.experience` (a purely presentational
 * field) — every existing campaign control, save flow and API stays
 * untouched.
 */
import { useMemo, useState } from "react";
import {
  Wand2, Monitor, Tablet, Smartphone, RotateCcw, Play, PartyPopper,
  Trash2, Copy, Lock, Unlock, ArrowUp, ArrowDown, FlipHorizontal2,
  Layers, UploadCloud, Link2, Loader2, Eye, EyeOff, Group as GroupIcon,
  Ungroup, LayoutTemplate, Type, MousePointerClick, Sun, GlassWater,
} from "lucide-react";
import {
  ENVIRONMENTS, ENVIRONMENT_IDS, GLASS_STYLES, LIGHTING_STYLES,
  REVEAL_STYLES, PARTICLE_STYLES, PARTICLE_INTENSITIES, POPUP_SIZES,
  DECOR_ANIMS, LIGHT_DIRECTIONS, CTA_STYLES, CTA_ANIMS, FONT_FAMILIES,
  normalizeExperience, normalizeDecoration,
} from "../../eduhub/components/rewardExperience/experienceThemes";
import { EXPERIENCE_TEMPLATES } from "../../eduhub/components/rewardExperience/experienceTemplates";
import {
  DECOR_CATEGORIES, ASSET_LABELS, decorAssetUri,
} from "../../eduhub/components/rewardExperience/decorationAssets";
import { uploadHeroArtwork } from "../api";
import RewardExperiencePreview, { PREVIEW_DEVICES, DEVICE_ORDER } from "./RewardExperiencePreview";

const selCls = "mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-2.5 py-1.5 text-[12px] text-parchment focus:outline-none focus:border-gold";
const lblCls = "text-[11px] text-faded";
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

function Slider({ label, value, min, max, step = 1, onChange, testid, fmt }) {
  return (
    <label className="block">
      <span className={lblCls}>{label} <span className="text-parchment/70">{fmt ? fmt(value) : value}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} data-testid={testid}
             onChange={(e) => onChange(Number(e.target.value))}
             className="mt-1 w-full accent-amber-400" />
    </label>
  );
}

export default function ExperienceDesignerSection({ form, set }) {
  const exp = useMemo(() => normalizeExperience(form.experience), [form.experience]);
  const upd = (patch) => set("experience", { ...exp, ...patch });

  const [selectedIds, setSelectedIds] = useState([]);
  const [device, setDevice] = useState("iphone");
  const [cat, setCat] = useState("khmer");
  const [customUrl, setCustomUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState(null);
  const [replayKey, setReplayKey] = useState(0);
  const [phase, setPhase] = useState("idle");
  const [renamingId, setRenamingId] = useState(null);
  const [panel, setPanel] = useState("scene"); // scene | lighting | glass | text | cta

  const decorations = exp.decorations;
  const selected = decorations.find((d) => d.id === selectedIds[0]) || null;
  const multiCount = selectedIds.length;

  const setDecorations = (list) => upd({ decorations: list });
  const updateDec = (id, patch) =>
    setDecorations(decorations.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const updateMany = (patchMap) =>
    setDecorations(decorations.map((d) => (patchMap[d.id] ? { ...d, ...patchMap[d.id] } : d)));

  const groupSelected = () => {
    if (multiCount < 2) return;
    const gid = `grp_${Date.now().toString(36)}`;
    setDecorations(decorations.map((d) => (selectedIds.includes(d.id) ? { ...d, group: gid } : d)));
  };
  const ungroupSelected = () =>
    setDecorations(decorations.map((d) => (selectedIds.includes(d.id) ? { ...d, group: "" } : d)));

  const applyTemplate = (tpl) => {
    upd(normalizeExperience({ ...exp, ...tpl.experience }));
    setSelectedIds([]);
    setReplayKey((k) => k + 1);
  };

  const addDecoration = (partial) => {
    const d = normalizeDecoration({
      id: `dec_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      x: 50, y: 30, size: 64, opacity: 1, layer: "front", ...partial,
    });
    if (!d) return;
    setDecorations([...decorations, d]);
    setSelectedIds([d.id]);
  };
  const duplicateDec = (d) =>
    addDecoration({ ...d, id: undefined, x: Math.min(96, d.x + 6), y: Math.min(96, d.y + 6), locked: false, group: "" });
  const removeDec = (id) => {
    setDecorations(decorations.filter((d) => d.id !== id));
    setSelectedIds((ids) => ids.filter((i) => i !== id));
  };
  const moveZ = (id, dir) => {
    const i = decorations.findIndex((d) => d.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= decorations.length) return;
    const list = decorations.slice();
    [list[i], list[j]] = [list[j], list[i]];
    setDecorations(list);
  };

  const addCustomUrl = () => {
    const url = customUrl.trim();
    if (!url.startsWith("https://") && !url.startsWith("/")) { setUploadErr("URL must start with https:// or /"); return; }
    setUploadErr(null);
    addDecoration({ kind: "custom", url });
    setCustomUrl("");
  };

  const onUpload = async (file) => {
    if (!file) return;
    setUploading(true); setUploadErr(null);
    try {
      const res = await uploadHeroArtwork(file);
      const url = res?.asset?.url;
      if (url) addDecoration({ kind: "custom", url });
      else setUploadErr("Upload succeeded but no URL returned.");
    } catch (e) {
      setUploadErr(e?.message || "Upload failed.");
    } finally { setUploading(false); }
  };

  const activeCat = DECOR_CATEGORIES.find((c) => c.id === cat) || DECOR_CATEGORIES[0];

  return (
    <fieldset className="space-y-3 min-w-0" data-testid="lrc-experience-designer">
      <legend className="text-[10.5px] uppercase tracking-wider text-gold font-bold mb-1 flex items-center gap-1.5">
        <Wand2 className="h-3.5 w-3.5" /> Experience designer
        <span className="text-faded text-[10px] normal-case ml-1">visual only — never affects the reward engine</span>
      </legend>

      {/* Experience templates */}
      <div className="min-w-0">
        <span className={lblCls + " flex items-center gap-1"}><LayoutTemplate className="h-3 w-3" /> Templates (editable starting points)</span>
        {/* min-w-0 is required here: a flex row with overflow-x-auto and
            shrink-0 children otherwise reports its MIN-CONTENT (the full
            unscrolled width of every card) as its size instead of shrinking
            to the available width, which drags every ancestor — including
            the <fieldset> itself, whose UA-default min-width is min-content
            — wider than the viewport on mobile instead of clipping+scrolling. */}
        <div className="mt-1 flex gap-1.5 overflow-x-auto pb-1 min-w-0">
          {EXPERIENCE_TEMPLATES.map((t) => (
            <button key={t.id} type="button" data-testid={`rxp-template-${t.id}`} onClick={() => applyTemplate(t)}
                    title={t.tagline}
                    className="shrink-0 rounded-xl overflow-hidden border border-white/10 hover:border-gold text-left w-[104px]">
              <div className="h-8" style={{ background: (ENVIRONMENTS[t.experience.environment] || ENVIRONMENTS.classic).swatch }} />
              <div className="px-1.5 py-1 bg-black/40 text-[9px] font-bold text-parchment leading-tight">{t.label}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Environment picker */}
      <div>
        <span className={lblCls}>Environment</span>
        <div className="mt-1 grid grid-cols-3 sm:grid-cols-4 gap-2">
          {ENVIRONMENT_IDS.map((id) => {
            const env = ENVIRONMENTS[id];
            const active = exp.environment === id;
            return (
              <button key={id} type="button" data-testid={`rxp-env-${id}`}
                      onClick={() => upd({ environment: id })}
                      className={`rounded-xl overflow-hidden border text-left transition-transform hover:scale-[1.02] ${active ? "border-gold ring-1 ring-gold/60" : "border-white/10"}`}>
                <div className="h-10" style={{ background: env.swatch }} />
                <div className="px-2 py-1 bg-black/40">
                  <div className="text-[10px] font-bold text-parchment leading-tight">{env.label}</div>
                  <div className="text-[8.5px] text-faded leading-tight truncate">{env.tagline}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Sub-panel tabs */}
      <div className="flex flex-wrap gap-1">
        {[
          { id: "scene", label: "Scene", Icon: Wand2 },
          { id: "lighting", label: "Lighting", Icon: Sun },
          { id: "glass", label: "Glass", Icon: GlassWater },
          { id: "text", label: "Typography", Icon: Type },
          { id: "cta", label: "Button", Icon: MousePointerClick },
        ].map(({ id, label, Icon }) => (
          <button key={id} type="button" data-testid={`rxp-panel-${id}`} onClick={() => setPanel(id)}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider border ${panel === id ? "border-gold text-gold" : "border-white/15 text-faded"}`}>
            <Icon className="h-3 w-3" /> {label}
          </button>
        ))}
      </div>

      {panel === "scene" && (<>
      {/* Style controls */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <label className="block">
          <span className={lblCls}>Glass style</span>
          <select value={exp.glass} onChange={(e) => upd({ glass: e.target.value })} data-testid="rxp-input-glass" className={selCls}>
            {GLASS_STYLES.map((g) => <option key={g} value={g}>{g === "auto" ? "Auto (theme default)" : cap(g)}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={lblCls}>Lighting</span>
          <select value={exp.lighting} onChange={(e) => upd({ lighting: e.target.value })} data-testid="rxp-input-lighting" className={selCls}>
            {LIGHTING_STYLES.map((g) => <option key={g} value={g}>{g === "auto" ? "Auto (theme default)" : cap(g)}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={lblCls}>Reveal animation</span>
          <select value={exp.reveal} onChange={(e) => upd({ reveal: e.target.value })} data-testid="rxp-input-reveal" className={selCls}>
            {REVEAL_STYLES.map((g) => <option key={g} value={g}>{cap(g)}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={lblCls}>Particles</span>
          <select value={exp.particles} onChange={(e) => upd({ particles: e.target.value })} data-testid="rxp-input-particles" className={selCls}>
            {PARTICLE_STYLES.map((g) => <option key={g} value={g}>{g === "auto" ? "Auto (theme default)" : cap(g)}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={lblCls}>Particle intensity</span>
          <select value={exp.particle_intensity} onChange={(e) => upd({ particle_intensity: e.target.value })} data-testid="rxp-input-particle-intensity" className={selCls}>
            {PARTICLE_INTENSITIES.map((g) => <option key={g} value={g}>{cap(g)}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={lblCls}>Popup size</span>
          <select value={exp.popup_size} onChange={(e) => upd({ popup_size: e.target.value })} data-testid="rxp-input-size" className={selCls}>
            {Object.keys(POPUP_SIZES).map((g) => <option key={g} value={g}>{cap(g)}</option>)}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 items-end">
        <Slider label="Background blur" value={exp.backdrop_blur} min={0} max={24} testid="rxp-input-blur"
                onChange={(v) => upd({ backdrop_blur: v })} fmt={(v) => `${v}px`} />
        <Slider label="Environment intensity" value={Math.round(exp.env_intensity * 100)} min={20} max={100} testid="rxp-input-intensity"
                onChange={(v) => upd({ env_intensity: v / 100 })} fmt={(v) => `${v}%`} />
        <label className="block">
          <span className={lblCls}>Ambient color</span>
          <div className="mt-1 flex items-center gap-2">
            <input type="color" value={exp.ambient_color || "#d4a843"} data-testid="rxp-input-ambient"
                   onChange={(e) => upd({ ambient_color: e.target.value })}
                   className="h-8 w-10 rounded bg-transparent border border-white/15 cursor-pointer" />
            <button type="button" onClick={() => upd({ ambient_color: "" })}
                    className="text-[10px] text-faded underline">clear</button>
          </div>
        </label>
      </div>
      </>)}

      {panel === "lighting" && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 items-end" data-testid="rxp-lighting-panel">
          <label className="block">
            <span className={lblCls}>Lighting style</span>
            <select value={exp.lighting} onChange={(e) => upd({ lighting: e.target.value })} data-testid="rxp-input-lighting2" className={selCls}>
              {LIGHTING_STYLES.map((g) => <option key={g} value={g}>{g === "auto" ? "Auto (theme default)" : cap(g)}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={lblCls}>Direction</span>
            <select value={exp.lighting_config.direction} onChange={(e) => upd({ lighting_config: { ...exp.lighting_config, direction: e.target.value } })} data-testid="rxp-light-direction" className={selCls}>
              {LIGHT_DIRECTIONS.map((g) => <option key={g} value={g}>{cap(g)}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={lblCls}>Light color</span>
            <div className="mt-1 flex items-center gap-2">
              <input type="color" value={exp.lighting_config.color || "#ffd9a0"} data-testid="rxp-light-color"
                     onChange={(e) => upd({ lighting_config: { ...exp.lighting_config, color: e.target.value } })}
                     className="h-8 w-10 rounded bg-transparent border border-white/15 cursor-pointer" />
              <button type="button" onClick={() => upd({ lighting_config: { ...exp.lighting_config, color: "" } })}
                      className="text-[10px] text-faded underline">auto</button>
            </div>
          </label>
          <Slider label="Intensity" value={Math.round(exp.lighting_config.intensity * 100)} min={0} max={100} testid="rxp-light-intensity"
                  onChange={(v) => upd({ lighting_config: { ...exp.lighting_config, intensity: v / 100 } })} fmt={(v) => `${v}%`} />
          <Slider label="Opacity" value={Math.round(exp.lighting_config.opacity * 100)} min={0} max={100} testid="rxp-light-opacity"
                  onChange={(v) => upd({ lighting_config: { ...exp.lighting_config, opacity: v / 100 } })} fmt={(v) => `${v}%`} />
          <Slider label="Softness (blur)" value={exp.lighting_config.blur} min={0} max={40} testid="rxp-light-blur"
                  onChange={(v) => upd({ lighting_config: { ...exp.lighting_config, blur: v } })} fmt={(v) => `${v}px`} />
        </div>
      )}

      {panel === "glass" && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 items-end" data-testid="rxp-glass-panel">
          <label className="block">
            <span className={lblCls}>Glass preset</span>
            <select value={exp.glass} onChange={(e) => upd({ glass: e.target.value })} data-testid="rxp-input-glass2" className={selCls}>
              {GLASS_STYLES.map((g) => <option key={g} value={g}>{g === "auto" ? "Auto (theme default)" : cap(g)}</option>)}
            </select>
          </label>
          <Slider label="Frost level" value={exp.glass_config.frost < 0 ? 18 : exp.glass_config.frost} min={0} max={40} testid="rxp-glass-frost"
                  onChange={(v) => upd({ glass_config: { ...exp.glass_config, frost: v } })} fmt={(v) => `${v}px`} />
          <Slider label="Card opacity" value={Math.round((exp.glass_config.opacity < 0 ? 1 : exp.glass_config.opacity) * 100)} min={20} max={100} testid="rxp-glass-opacity"
                  onChange={(v) => upd({ glass_config: { ...exp.glass_config, opacity: v / 100 } })} fmt={(v) => `${v}%`} />
          <Slider label="Corner radius" value={exp.glass_config.radius < 0 ? 28 : exp.glass_config.radius} min={0} max={48} testid="rxp-glass-radius"
                  onChange={(v) => upd({ glass_config: { ...exp.glass_config, radius: v } })} fmt={(v) => `${v}px`} />
          <Slider label="Shadow depth" value={Math.round(exp.glass_config.depth * 100)} min={0} max={100} testid="rxp-glass-depth"
                  onChange={(v) => upd({ glass_config: { ...exp.glass_config, depth: v / 100 } })} fmt={(v) => `${v}%`} />
          <label className="block">
            <span className={lblCls}>Border style</span>
            <select value={exp.glass_config.border} onChange={(e) => upd({ glass_config: { ...exp.glass_config, border: e.target.value } })} data-testid="rxp-glass-border" className={selCls}>
              {["auto", "none", "soft", "gold", "glow"].map((g) => <option key={g} value={g}>{cap(g)}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 pt-4">
            <input type="checkbox" checked={exp.glass_config.reflection} data-testid="rxp-glass-reflection"
                   onChange={(e) => upd({ glass_config: { ...exp.glass_config, reflection: e.target.checked } })}
                   className="h-4 w-4 accent-amber-400" />
            <span className="text-[12px] text-parchment">Top reflection highlight</span>
          </label>
        </div>
      )}

      {panel === "text" && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 items-end" data-testid="rxp-text-panel">
          <label className="block">
            <span className={lblCls}>Title font</span>
            <select value={exp.typography.title_font} onChange={(e) => upd({ typography: { ...exp.typography, title_font: e.target.value } })} data-testid="rxp-text-font" className={selCls}>
              {Object.keys(FONT_FAMILIES).map((g) => <option key={g} value={g}>{cap(g)}</option>)}
            </select>
          </label>
          <Slider label="Weight" value={exp.typography.title_weight} min={400} max={900} step={100} testid="rxp-text-weight"
                  onChange={(v) => upd({ typography: { ...exp.typography, title_weight: v } })} />
          <Slider label="Letter spacing" value={exp.typography.title_spacing} min={-2} max={8} testid="rxp-text-spacing"
                  onChange={(v) => upd({ typography: { ...exp.typography, title_spacing: v } })} />
          <Slider label="Text shadow" value={Math.round(exp.typography.title_shadow * 100)} min={0} max={100} testid="rxp-text-shadow"
                  onChange={(v) => upd({ typography: { ...exp.typography, title_shadow: v / 100 } })} fmt={(v) => `${v}%`} />
          <label className="block">
            <span className={lblCls}>Title color</span>
            <div className="mt-1 flex items-center gap-2">
              <input type="color" value={exp.typography.title_color || "#241505"} data-testid="rxp-text-color"
                     onChange={(e) => upd({ typography: { ...exp.typography, title_color: e.target.value } })}
                     className="h-8 w-10 rounded bg-transparent border border-white/15 cursor-pointer" />
              <button type="button" onClick={() => upd({ typography: { ...exp.typography, title_color: "" } })}
                      className="text-[10px] text-faded underline">auto</button>
            </div>
          </label>
          <label className="block">
            <span className={lblCls}>Alignment</span>
            <select value={exp.typography.align} onChange={(e) => upd({ typography: { ...exp.typography, align: e.target.value } })} data-testid="rxp-text-align" className={selCls}>
              <option value="center">Center</option>
              <option value="left">Left</option>
            </select>
          </label>
        </div>
      )}

      {panel === "cta" && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 items-end" data-testid="rxp-cta-panel">
          <label className="block">
            <span className={lblCls}>Button style</span>
            <select value={exp.cta.style} onChange={(e) => upd({ cta: { ...exp.cta, style: e.target.value } })} data-testid="rxp-cta-style" className={selCls}>
              {CTA_STYLES.map((g) => <option key={g} value={g}>{cap(g)}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={lblCls}>Animation</span>
            <select value={exp.cta.animation} onChange={(e) => upd({ cta: { ...exp.cta, animation: e.target.value } })} data-testid="rxp-cta-anim" className={selCls}>
              {CTA_ANIMS.map((g) => <option key={g} value={g}>{cap(g)}</option>)}
            </select>
          </label>
          <Slider label="Corner radius" value={exp.cta.radius} min={0} max={40} testid="rxp-cta-radius"
                  onChange={(v) => upd({ cta: { ...exp.cta, radius: v } })} fmt={(v) => `${v}px`} />
          <Slider label="Glow" value={Math.round(exp.cta.glow * 100)} min={0} max={100} testid="rxp-cta-glow"
                  onChange={(v) => upd({ cta: { ...exp.cta, glow: v / 100 } })} fmt={(v) => `${v}%`} />
          <Slider label="Shadow" value={Math.round(exp.cta.shadow * 100)} min={0} max={100} testid="rxp-cta-shadow"
                  onChange={(v) => upd({ cta: { ...exp.cta, shadow: v / 100 } })} fmt={(v) => `${v}%`} />
          <p className="text-[10px] text-faded">Button text stays managed by the campaign's CTA field above — the design system only styles it.</p>
        </div>
      )}

      {/* Canvas + live preview */}
      <div className="rounded-xl border border-white/10 bg-black/25 p-2.5 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {DEVICE_ORDER.map((id) => {
            const d = PREVIEW_DEVICES[id];
            const Icon = id === "tablet" ? Tablet : id === "desktop" ? Monitor : Smartphone;
            return (
              <button key={id} type="button" data-testid={`rxp-device-${id}`} onClick={() => setDevice(id)}
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider border ${device === id ? "border-gold text-gold" : "border-white/15 text-faded"}`}>
                <Icon className="h-3 w-3" /> {d.label}
              </button>
            );
          })}
          <div className="flex-1" />
          {multiCount >= 2 && (
            <button type="button" data-testid="rxp-group-btn" onClick={groupSelected}
                    className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider border border-white/15 text-parchment hover:border-gold">
              <GroupIcon className="h-3 w-3" /> Group ({multiCount})
            </button>
          )}
          {selectedIds.some((id) => (decorations.find((d) => d.id === id) || {}).group) && (
            <button type="button" data-testid="rxp-ungroup-btn" onClick={ungroupSelected}
                    className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider border border-white/15 text-parchment hover:border-gold">
              <Ungroup className="h-3 w-3" /> Ungroup
            </button>
          )}
          <button type="button" data-testid="rxp-replay-btn"
                  onClick={() => { setPhase("idle"); setReplayKey((k) => k + 1); }}
                  className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider border border-white/15 text-parchment hover:border-gold hover:text-gold">
            {phase === "idle" ? <RotateCcw className="h-3 w-3" /> : <Play className="h-3 w-3" />} Replay reveal
          </button>
          <button type="button" data-testid="rxp-success-btn"
                  onClick={() => { setPhase((p) => (p === "success" ? "idle" : "success")); setReplayKey((k) => k + 1); }}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider border ${phase === "success" ? "border-gold text-gold" : "border-white/15 text-parchment"}`}>
            <PartyPopper className="h-3 w-3" /> Success state
          </button>
        </div>

        <RewardExperiencePreview
          form={{ ...form, experience: exp }}
          device={device}
          phase={phase}
          replayKey={replayKey}
          editable
          selectedIds={selectedIds}
          onSelect={setSelectedIds}
          onUpdateDecoration={updateDec}
          onUpdateMany={updateMany}
        />
        <p className="text-[9.5px] text-faded text-center">Drag to move · shift-click to multi-select · corner square resizes · top knob rotates · cyan lines = smart snapping · dashed box = safe zone</p>
      </div>

      {/* Asset library */}
      <div className="rounded-xl border border-white/10 bg-black/25 p-2.5 space-y-2">
        <div className="flex flex-wrap gap-1">
          {DECOR_CATEGORIES.map((c) => (
            <button key={c.id} type="button" onClick={() => setCat(c.id)} data-testid={`rxp-cat-${c.id}`}
                    className={`rounded-full px-2.5 py-1 text-[10px] font-bold border ${cat === c.id ? "border-gold text-gold" : "border-white/12 text-faded"}`}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-6 sm:grid-cols-8 gap-1.5">
          {activeCat.assets.map((a) => (
            <button key={a} type="button" title={ASSET_LABELS[a] || a} data-testid={`rxp-asset-${a}`}
                    onClick={() => addDecoration({ kind: "builtin", asset: a })}
                    className="aspect-square rounded-lg border border-white/10 bg-white/5 hover:border-gold p-1.5 transition-colors">
              <img src={decorAssetUri(a)} alt={ASSET_LABELS[a] || a} className="w-full h-full object-contain" draggable={false} />
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-white/8">
          <div className="flex items-center gap-1 flex-1 min-w-[180px]">
            <Link2 className="h-3.5 w-3.5 text-faded shrink-0" />
            <input type="text" value={customUrl} onChange={(e) => setCustomUrl(e.target.value)}
                   placeholder="https://… custom image URL" data-testid="rxp-custom-url"
                   className="flex-1 rounded-lg bg-black/30 border border-parchment/15 px-2 py-1.5 text-[11px] text-parchment focus:outline-none focus:border-gold" />
            <button type="button" onClick={addCustomUrl} data-testid="rxp-custom-url-add"
                    className="rounded-full border border-white/15 px-2.5 py-1 text-[10px] font-bold text-parchment hover:border-gold">Add</button>
          </div>
          <label className="inline-flex items-center gap-1.5 rounded-full border border-white/15 px-2.5 py-1 text-[10px] font-bold text-parchment hover:border-gold cursor-pointer">
            {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <UploadCloud className="h-3 w-3" />}
            {uploading ? "Uploading…" : "Upload image"}
            <input type="file" accept="image/*" className="hidden" data-testid="rxp-upload-input"
                   onChange={(e) => { onUpload(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
        </div>
        {uploadErr && <div className="text-[10px] text-red-400">{uploadErr}</div>}
      </div>

      {/* Inspector + layers */}
      {decorations.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-black/25 p-2.5 space-y-2" data-testid="rxp-layers-panel">
          <div className="text-[10px] uppercase tracking-wider text-faded font-bold flex items-center gap-1">
            <Layers className="h-3 w-3" /> Decoration layers ({decorations.length}/40)
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
            {decorations.slice().reverse().map((d) => (
              <div key={d.id}
                   className={`flex items-center gap-1.5 rounded-lg px-2 py-1 border cursor-pointer ${selectedIds.includes(d.id) ? "border-gold/70 bg-gold/5" : "border-white/8"} ${d.visible === false ? "opacity-50" : ""}`}
                   onClick={(e) => {
                     if (e.shiftKey) setSelectedIds((ids) => ids.includes(d.id) ? ids.filter((i) => i !== d.id) : [...ids, d.id]);
                     else setSelectedIds([d.id]);
                   }}
                   data-testid={`rxp-layer-row-${d.id}`}>
                <img src={d.kind === "builtin" ? decorAssetUri(d.asset) : d.url} alt="" className="h-5 w-5 object-contain" draggable={false} />
                {renamingId === d.id ? (
                  <input
                    autoFocus
                    defaultValue={d.name || (d.kind === "builtin" ? (ASSET_LABELS[d.asset] || d.asset) : "Custom image")}
                    data-testid={`rxp-rename-input-${d.id}`}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => { updateDec(d.id, { name: e.target.value.slice(0, 60) }); setRenamingId(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    className="flex-1 min-w-0 rounded bg-black/40 border border-gold/40 px-1.5 py-0.5 text-[10.5px] text-parchment focus:outline-none"
                  />
                ) : (
                  <span
                    className="flex-1 text-[10.5px] text-parchment truncate"
                    onDoubleClick={(e) => { e.stopPropagation(); setRenamingId(d.id); }}
                    title="Double-click to rename"
                  >
                    {d.name || (d.kind === "builtin" ? (ASSET_LABELS[d.asset] || d.asset) : "Custom image")}
                  </span>
                )}
                {d.group && <span className="text-[8px] rounded bg-white/10 px-1 text-faded" title={`Group ${d.group}`}>grp</span>}
                <span className="text-[8.5px] uppercase text-faded">{d.layer}</span>
                <button type="button" title={d.visible === false ? "Show" : "Hide"} data-testid={`rxp-visibility-${d.id}`}
                        onClick={(e) => { e.stopPropagation(); updateDec(d.id, { visible: d.visible === false }); }} className="text-faded hover:text-gold">
                  {d.visible === false ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                </button>
                <button type="button" title="Bring forward" onClick={(e) => { e.stopPropagation(); moveZ(d.id, +1); }} className="text-faded hover:text-gold"><ArrowUp className="h-3 w-3" /></button>
                <button type="button" title="Send backward" onClick={(e) => { e.stopPropagation(); moveZ(d.id, -1); }} className="text-faded hover:text-gold"><ArrowDown className="h-3 w-3" /></button>
                <button type="button" title={d.locked ? "Unlock" : "Lock"} onClick={(e) => { e.stopPropagation(); updateDec(d.id, { locked: !d.locked }); }} className="text-faded hover:text-gold">
                  {d.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                </button>
                <button type="button" title="Duplicate" onClick={(e) => { e.stopPropagation(); duplicateDec(d); }} className="text-faded hover:text-gold"><Copy className="h-3 w-3" /></button>
                <button type="button" title="Delete" onClick={(e) => { e.stopPropagation(); removeDec(d.id); }} className="text-faded hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
              </div>
            ))}
          </div>

          {selected && (
            <div className="border-t border-white/8 pt-2 space-y-2" data-testid="rxp-inspector">
              {multiCount > 1 && (
                <div className="text-[10px] text-faded">{multiCount} selected — editing “{selected.name || ASSET_LABELS[selected.asset] || "item"}”. Drag on canvas moves all selected.</div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1">
                <Slider label="Size" value={selected.size} min={16} max={400} testid="rxp-dec-size"
                        onChange={(v) => updateDec(selected.id, { size: v })} fmt={(v) => `${v}px`} />
                <Slider label="Rotation" value={selected.rotation} min={-180} max={180} testid="rxp-dec-rotation"
                        onChange={(v) => updateDec(selected.id, { rotation: v })} fmt={(v) => `${v}°`} />
                <Slider label="Opacity" value={Math.round(selected.opacity * 100)} min={5} max={100} testid="rxp-dec-opacity"
                        onChange={(v) => updateDec(selected.id, { opacity: v / 100 })} fmt={(v) => `${v}%`} />
                <Slider label="Glow" value={Math.round(selected.glow * 100)} min={0} max={100} testid="rxp-dec-glow"
                        onChange={(v) => updateDec(selected.id, { glow: v / 100 })} fmt={(v) => `${v}%`} />
                <Slider label="Shadow" value={Math.round((selected.shadow || 0) * 100)} min={0} max={100} testid="rxp-dec-shadow"
                        onChange={(v) => updateDec(selected.id, { shadow: v / 100 })} fmt={(v) => `${v}%`} />
                <Slider label="Blur" value={selected.blur} min={0} max={12} testid="rxp-dec-blur"
                        onChange={(v) => updateDec(selected.id, { blur: v })} fmt={(v) => `${v}px`} />
                <label className="block">
                  <span className={lblCls}>Layer</span>
                  <select value={selected.layer} data-testid="rxp-dec-layer"
                          onChange={(e) => updateDec(selected.id, { layer: e.target.value })} className={selCls}>
                    <option value="back">Behind popup</option>
                    <option value="front">In front of popup</option>
                  </select>
                </label>
                <label className="block">
                  <span className={lblCls}>Animation</span>
                  <select value={selected.anim || "none"} data-testid="rxp-dec-anim"
                          onChange={(e) => updateDec(selected.id, { anim: e.target.value })} className={selCls}>
                    {DECOR_ANIMS.map((a) => <option key={a} value={a}>{cap(a)}</option>)}
                  </select>
                </label>
                <Slider label="Anim speed" value={Math.round((selected.anim_speed || 1) * 100)} min={25} max={400} testid="rxp-dec-anim-speed"
                        onChange={(v) => updateDec(selected.id, { anim_speed: v / 100 })} fmt={(v) => `${(v / 100).toFixed(2)}×`} />
              </div>
              <button type="button" data-testid="rxp-dec-flip"
                      onClick={() => updateDec(selected.id, { flip: !selected.flip })}
                      className="inline-flex items-center gap-1 rounded-full border border-white/15 px-2.5 py-1 text-[10px] font-bold text-parchment hover:border-gold">
                <FlipHorizontal2 className="h-3 w-3" /> Flip {selected.flip ? "(on)" : ""}
              </button>
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
}
