/**
 * InspectorPanel.jsx — context-sensitive property inspector for the selected
 * layer (Campaign Design Studio 2.0). Sections adapt to the layer type:
 * Background (surface/fill/image/overlay), Image (mode/transform/effects),
 * Text (content/style/effects), Component (props), Effect (type/intensity).
 */
import {
  CANVAS_SURFACES, POSTER_FITS, BACKGROUND_IMAGE_FITS, EFFECT_TYPES,
  SHADOW_PRESETS,
} from "../../../eduhub/lib/campaignCanvas/canvasSchema";
import { TYPOGRAPHY_STYLES } from "../../../eduhub/lib/campaignCanvas/typographyStyles";
import { MOTION_PRESETS } from "../../../eduhub/lib/campaignCanvas/motionPresets";
import { MARKETING_COMPONENTS } from "../../../eduhub/components/campaign/MarketingComponents";
import { CLICK_ACTIONS } from "../../../eduhub/components/artwork/artworkConfig";

/* ────────── shared controls ────────── */
const fieldStyle = {
  width: "100%",
  background: "rgba(20,14,32,0.7)",
  border: "1px solid rgba(212,168,67,0.25)",
  borderRadius: 10,
  color: "#F4E5C1",
  padding: "7px 10px",
  fontSize: 12,
  outline: "none",
};

function Section({ title, children }) {
  return (
    <div className="mb-4">
      <p className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-faded mb-1.5">{title}</p>
      {children}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-center gap-2 mb-1.5">
      <span className="w-[74px] shrink-0 text-[10.5px] text-faded">{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function SliderRow({ label, value, min, max, step = 1, onChange, testid }) {
  return (
    <Row label={label}>
      <div className="flex items-center gap-2">
        <input type="range" min={min} max={max} step={step} value={value}
               onChange={(e) => onChange(Number(e.target.value))}
               className="flex-1 accent-[#D4A843]" data-testid={testid} />
        <span className="w-10 text-right text-[10.5px] text-parchment tabular-nums">{Math.round(value * 10) / 10}</span>
      </div>
    </Row>
  );
}

function ColorRow({ label, value, onChange, allowEmpty, testid }) {
  return (
    <Row label={label}>
      <div className="flex items-center gap-1.5">
        <input type="color" value={value || "#D4A843"} onChange={(e) => onChange(e.target.value)}
               className="h-7 w-9 rounded cursor-pointer bg-transparent border border-white/10" data-testid={testid} />
        {allowEmpty && value && (
          <button type="button" onClick={() => onChange("")}
                  className="text-[9.5px] uppercase tracking-wider text-faded hover:text-gold">Clear</button>
        )}
      </div>
    </Row>
  );
}

function SelectRow({ label, value, options, onChange, testid }) {
  return (
    <Row label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={fieldStyle} data-testid={testid}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Row>
  );
}

function ToggleRow({ label, value, onChange, testid }) {
  return (
    <Row label={label}>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        data-testid={testid}
        className="relative h-5 w-9 rounded-full transition-colors"
        style={{ background: value ? "linear-gradient(135deg,#FFE19A,#D4A843)" : "rgba(45,31,62,0.9)", border: "1px solid rgba(212,168,67,0.35)" }}
      >
        <span className="absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all"
              style={{ left: value ? 18 : 3 }} />
      </button>
    </Row>
  );
}

/* ────────── effects (shared by image/text/component) ────────── */
function EffectsSection({ layer, patchEffects }) {
  const fx = layer.effects || {};
  return (
    <Section title="Effects">
      <ToggleRow label="Shadow" value={Boolean(fx.shadow?.enabled)} testid="inspector-shadow-toggle"
                 onChange={(v) => patchEffects({ shadow: { ...fx.shadow, enabled: v } })} />
      {fx.shadow?.enabled && (
        <>
          <SelectRow label="Preset" value={fx.shadow.preset || "soft"} testid="inspector-shadow-preset"
                     options={Object.keys(SHADOW_PRESETS).filter((k) => k !== "none").map((k) => ({ value: k, label: k }))}
                     onChange={(v) => patchEffects({ shadow: { ...fx.shadow, ...SHADOW_PRESETS[v], preset: v, enabled: true } })} />
          <SliderRow label="Opacity" value={fx.shadow.opacity ?? 30} min={0} max={100}
                     onChange={(v) => patchEffects({ shadow: { ...fx.shadow, opacity: v } })} />
        </>
      )}
      <ToggleRow label="Glow" value={Boolean(fx.glow?.enabled)} testid="inspector-glow-toggle"
                 onChange={(v) => patchEffects({ glow: { ...fx.glow, enabled: v } })} />
      {fx.glow?.enabled && (
        <>
          <ColorRow label="Glow color" value={fx.glow.color || "#D9B872"}
                    onChange={(v) => patchEffects({ glow: { ...fx.glow, color: v } })} />
          <SliderRow label="Glow blur" value={fx.glow.blur ?? 24} min={4} max={80}
                     onChange={(v) => patchEffects({ glow: { ...fx.glow, blur: v } })} />
        </>
      )}
      <SliderRow label="Blur" value={fx.blur ?? 0} min={0} max={20} step={0.5} testid="inspector-blur-slider"
                 onChange={(v) => patchEffects({ blur: v })} />
      <SliderRow label="Radius" value={fx.radius ?? 0} min={0} max={48} testid="inspector-radius-slider"
                 onChange={(v) => patchEffects({ radius: v })} />
    </Section>
  );
}

function TransformSection({ layer, patch }) {
  const f = layer.frame || { x: 50, y: 50, w: 30 };
  return (
    <Section title="Transform">
      <SliderRow label="X" value={f.x} min={-10} max={110} step={0.5} testid="inspector-x-slider"
                 onChange={(v) => patch({ frame: { ...f, x: v } })} />
      <SliderRow label="Y" value={f.y} min={-10} max={110} step={0.5} testid="inspector-y-slider"
                 onChange={(v) => patch({ frame: { ...f, y: v } })} />
      <SliderRow label="Width" value={f.w} min={2} max={140} step={0.5} testid="inspector-w-slider"
                 onChange={(v) => {
                   const scale = v / f.w;
                   const next = { frame: { ...f, w: v } };
                   if (Number.isFinite(f.h)) next.frame.h = Math.min(160, f.h * scale);
                   if (layer.type === "text" || layer.type === "component") next.size = Math.max(0.6, (layer.size || 4) * scale);
                   patch(next);
                 }} />
      <SliderRow label="Rotation" value={layer.rotation || 0} min={-180} max={180} testid="inspector-rotation-slider"
                 onChange={(v) => patch({ rotation: v })} />
      <SliderRow label="Opacity" value={layer.opacity ?? 100} min={0} max={100} testid="inspector-opacity-slider"
                 onChange={(v) => patch({ opacity: v })} />
    </Section>
  );
}

/* ────────── per-type inspectors ────────── */
function BackgroundInspector({ layer, patch }) {
  const fill = layer.fill || {};
  const img = layer.image || {};
  const ov = layer.overlay || {};
  return (
    <>
      <Section title="Surface">
        <div className="grid grid-cols-3 gap-1.5 mb-2">
          {CANVAS_SURFACES.map((s) => (
            <button key={s.id} type="button" title={s.label}
                    onClick={() => patch({ fill: { ...fill, kind: "surface", surfaceId: s.id } })}
                    data-testid={`inspector-surface-${s.id}`}
                    className="h-10 rounded-lg transition-transform hover:scale-[1.04]"
                    style={{
                      background: s.night,
                      border: fill.surfaceId === s.id && fill.kind === "surface"
                        ? "2px solid #FFE19A" : "1px solid rgba(255,255,255,0.14)",
                    }} />
          ))}
        </div>
        <SelectRow label="Fill type" value={fill.kind || "surface"} testid="inspector-fill-kind"
                   options={[{ value: "surface", label: "Preset surface" }, { value: "solid", label: "Solid color" }, { value: "gradient", label: "Custom gradient" }]}
                   onChange={(v) => patch({ fill: { ...fill, kind: v } })} />
        {fill.kind === "solid" && (
          <ColorRow label="Color" value={fill.color || "#0E1F18"} onChange={(v) => patch({ fill: { ...fill, color: v } })} />
        )}
        {fill.kind === "gradient" && (
          <textarea rows={3} value={fill.css || ""} placeholder="linear-gradient(135deg, #0B1712, #123F2C)"
                    onChange={(e) => patch({ fill: { ...fill, css: e.target.value } })}
                    style={{ ...fieldStyle, fontFamily: "monospace", fontSize: 10.5 }}
                    data-testid="inspector-gradient-css" />
        )}
      </Section>

      <Section title="Background image">
        {img.src ? (
          <>
            <div className="mb-2 rounded-lg overflow-hidden border border-white/10">
              <img src={img.src} alt="" className="w-full h-16 object-cover" />
            </div>
            <SelectRow label="Fit" value={img.fit || "cover"} testid="inspector-bg-fit"
                       options={BACKGROUND_IMAGE_FITS.map((f) => ({ value: f.id, label: f.label }))}
                       onChange={(v) => patch({ image: { ...img, fit: v } })} />
            <SliderRow label="Blur" value={img.blur ?? 0} min={0} max={24} onChange={(v) => patch({ image: { ...img, blur: v } })} />
            <SliderRow label="Opacity" value={img.opacity ?? 100} min={0} max={100} onChange={(v) => patch({ image: { ...img, opacity: v } })} />
            <button type="button" onClick={() => patch({ image: { ...img, src: "" } })}
                    className="text-[10px] uppercase tracking-wider text-red-300 hover:text-red-200"
                    data-testid="inspector-bg-image-clear">
              Remove image
            </button>
          </>
        ) : (
          <p className="text-[10.5px] text-faded">Pick any asset in the Library and choose “BG”.</p>
        )}
      </Section>

      <Section title="Overlay">
        <ToggleRow label="Enabled" value={Boolean(ov.enabled)} testid="inspector-overlay-toggle"
                   onChange={(v) => patch({ overlay: { ...ov, enabled: v } })} />
        {ov.enabled && (
          <>
            <ColorRow label="Color" value={ov.color || "#0B1712"} onChange={(v) => patch({ overlay: { ...ov, color: v } })} />
            <SliderRow label="Opacity" value={ov.opacity ?? 24} min={0} max={90} onChange={(v) => patch({ overlay: { ...ov, opacity: v } })} />
          </>
        )}
      </Section>
    </>
  );
}

function ImageInspector({ layer, patch, patchEffects }) {
  return (
    <>
      <Section title="Artwork mode">
        <SelectRow label="Mode" value={layer.role || "hero"} testid="inspector-image-role"
                   options={[{ value: "hero", label: "Hero — free transform" }, { value: "decor", label: "Decor — composition" }, { value: "poster", label: "Poster — exact render" }]}
                   onChange={(v) => patch({ role: v, ...(v === "poster" ? { frame: { x: 50, y: 50, w: 100, h: 100 }, rotation: 0 } : null) })} />
        {layer.role === "poster" && (
          <>
            <SelectRow label="Poster fit" value={layer.posterFit || "contain"} testid="inspector-poster-fit"
                       options={POSTER_FITS.map((f) => ({ value: f.id, label: f.label }))}
                       onChange={(v) => patch({ posterFit: v })} />
            <p className="text-[10px] text-faded leading-relaxed mt-1">
              Poster mode renders your artwork exactly — no cropping, no forced scaling, no repositioning.
            </p>
          </>
        )}
        {layer.role !== "poster" && (
          <ToggleRow label="Flip" value={Boolean(layer.flipH)} testid="inspector-flip-toggle"
                     onChange={(v) => patch({ flipH: v })} />
        )}
      </Section>
      {layer.role !== "poster" && <TransformSection layer={layer} patch={patch} />}
      {layer.role === "poster" && (
        <Section title="Poster">
          <SliderRow label="Opacity" value={layer.opacity ?? 100} min={0} max={100}
                     onChange={(v) => patch({ opacity: v })} />
        </Section>
      )}
      <EffectsSection layer={layer} patchEffects={patchEffects} />
    </>
  );
}

function TextInspector({ layer, patch, patchEffects }) {
  return (
    <>
      <Section title="Content">
        <textarea rows={3} value={layer.text || ""} onChange={(e) => patch({ text: e.target.value })}
                  style={fieldStyle} data-testid="inspector-text-content" />
      </Section>
      <Section title="Text style">
        <div className="grid grid-cols-2 gap-1.5 mb-2">
          {Object.values(TYPOGRAPHY_STYLES).map((s) => (
            <button key={s.id} type="button" onClick={() => patch({ styleId: s.id })}
                    data-testid={`inspector-textstyle-${s.id}`}
                    className="rounded-lg px-2 py-1.5 text-left transition-colors"
                    style={{
                      background: layer.styleId === s.id ? "rgba(212,168,67,0.16)" : "rgba(45,31,62,0.5)",
                      border: layer.styleId === s.id ? "1px solid rgba(212,168,67,0.55)" : "1px solid rgba(212,168,67,0.16)",
                    }}>
              <p className="text-[10.5px] font-bold text-parchment truncate">{s.label}</p>
              <p className="text-[8.5px] text-faded truncate">{s.hint}</p>
            </button>
          ))}
        </div>
        <SliderRow label="Size" value={layer.size || 6} min={1} max={16} step={0.2} testid="inspector-text-size"
                   onChange={(v) => patch({ size: v })} />
        <SelectRow label="Align" value={layer.align || "left"} testid="inspector-text-align"
                   options={[{ value: "left", label: "Left" }, { value: "center", label: "Center" }, { value: "right", label: "Right" }]}
                   onChange={(v) => patch({ align: v })} />
        <ColorRow label="Color" value={layer.colorOverride} allowEmpty testid="inspector-text-color"
                  onChange={(v) => patch({ colorOverride: v })} />
      </Section>
      <TransformSection layer={layer} patch={patch} />
      <EffectsSection layer={layer} patchEffects={patchEffects} />
    </>
  );
}

function ComponentInspector({ layer, patch, patchEffects }) {
  const entry = MARKETING_COMPONENTS[layer.componentId];
  const props = { ...(entry?.defaults || {}), ...(layer.props || {}) };
  const setProp = (k, v) => patch({ props: { ...layer.props, [k]: v } });

  const textFields = {
    offerBadge: [["text", "Text"]],
    discountCard: [["value", "Value"], ["label", "Label"], ["caption", "Caption"]],
    limitedRibbon: [["text", "Text"]],
    glassLabel: [["text", "Text"]],
    vipBadge: [["text", "Text"]],
    priceCard: [["price", "Price"], ["unit", "Unit"], ["strike", "Strike"], ["caption", "Caption"]],
    socialProof: [["count", "Count"], ["label", "Label"]],
    highlightNumber: [["value", "Value"], ["label", "Label"]],
    ctaButton: [["label", "Label"]],
  }[layer.componentId] || [];

  return (
    <>
      <Section title={entry?.label || "Component"}>
        {textFields.map(([key, label]) => (
          <Row key={key} label={label}>
            <input value={props[key] ?? ""} onChange={(e) => setProp(key, e.target.value)}
                   style={fieldStyle} data-testid={`inspector-prop-${key}`} />
          </Row>
        ))}
        {layer.componentId === "countdown" && (
          <>
            <Row label="Ends at">
              <input type="datetime-local"
                     value={props.endsAt ? new Date(props.endsAt).toISOString().slice(0, 16) : ""}
                     onChange={(e) => setProp("endsAt", e.target.value ? new Date(e.target.value).toISOString() : "")}
                     style={fieldStyle} data-testid="inspector-countdown-endsat" />
            </Row>
            <ToggleRow label="Show days" value={props.showDays !== false}
                       onChange={(v) => setProp("showDays", v)} />
          </>
        )}
        {layer.componentId === "ctaButton" && (
          <>
            <SelectRow label="Style" value={props.style || "gold"} testid="inspector-cta-style"
                       options={[{ value: "gold", label: "Gold" }, { value: "emerald", label: "Emerald" }, { value: "ruby", label: "Ruby" }, { value: "glass", label: "Glass" }, { value: "outline", label: "Outline" }]}
                       onChange={(v) => setProp("style", v)} />
            <SelectRow label="Action" value={props.action?.type || "topup"} testid="inspector-cta-action"
                       options={CLICK_ACTIONS.map((a) => ({ value: a.key, label: a.label }))}
                       onChange={(v) => setProp("action", { ...(props.action || {}), type: v })} />
            {["book", "collection", "internal_route", "external_url"].includes(props.action?.type) && (
              <Row label="Value">
                <input value={props.action?.value || ""} placeholder={props.action?.type === "external_url" ? "https://…" : "/library"}
                       onChange={(e) => setProp("action", { ...(props.action || {}), value: e.target.value })}
                       style={fieldStyle} data-testid="inspector-cta-action-value" />
              </Row>
            )}
          </>
        )}
        <SliderRow label="Scale" value={layer.size || 3.4} min={1} max={10} step={0.2} testid="inspector-component-scale"
                   onChange={(v) => patch({ size: v })} />
      </Section>
      <TransformSection layer={layer} patch={patch} />
      <EffectsSection layer={layer} patchEffects={patchEffects} />
    </>
  );
}

function EffectInspector({ layer, patch }) {
  return (
    <Section title="Effect">
      <SelectRow label="Type" value={layer.effectId} testid="inspector-effect-type"
                 options={EFFECT_TYPES.map((e) => ({ value: e.id, label: e.label }))}
                 onChange={(v) => patch({ effectId: v, name: EFFECT_TYPES.find((x) => x.id === v)?.label || v })} />
      <SelectRow label="Intensity" value={layer.intensity || "medium"} testid="inspector-effect-intensity"
                 options={[{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }]}
                 onChange={(v) => patch({ intensity: v })} />
      <ColorRow label="Tint" value={layer.colorOverride} allowEmpty testid="inspector-effect-color"
                onChange={(v) => patch({ colorOverride: v })} />
      <SliderRow label="Opacity" value={layer.opacity ?? 100} min={0} max={100}
                 onChange={(v) => patch({ opacity: v })} />
    </Section>
  );
}

/* ────────── canvas-level inspector (no selection) ────────── */
function CanvasInspector({ state, dispatch }) {
  const { canvas } = state;
  return (
    <>
      <Section title="Motion">
        <SelectRow label="Preset" value={canvas.motion?.preset || "layeredElegant"} testid="inspector-motion-preset"
                   options={Object.values(MOTION_PRESETS).map((m) => ({ value: m.id, label: m.label }))}
                   onChange={(v) => dispatch({ type: "UPDATE_CANVAS", patch: { motion: { ...canvas.motion, preset: v } } })} />
        <ToggleRow label="Entrance" value={canvas.motion?.enabled !== false} testid="inspector-motion-enabled"
                   onChange={(v) => dispatch({ type: "UPDATE_CANVAS", patch: { motion: { ...canvas.motion, enabled: v } } })} />
        <ToggleRow label="Idle float" value={canvas.motion?.idle !== false} testid="inspector-motion-idle"
                   onChange={(v) => dispatch({ type: "UPDATE_CANVAS", patch: { motion: { ...canvas.motion, idle: v } } })} />
      </Section>
      <p className="text-[10.5px] text-faded leading-relaxed">
        Select any object directly on the canvas to edit it, or pick a layer from the Layers panel.
      </p>
    </>
  );
}

/* ────────── main ────────── */
export default function InspectorPanel({ state, dispatch }) {
  const { canvas, selectedId } = state;
  const layer = canvas.layers.find((l) => l.id === selectedId) || null;

  const patch = (p) => dispatch({ type: "UPDATE_LAYER", id: layer.id, patch: p });
  const patchEffects = (p) => dispatch({
    type: "UPDATE_LAYER", id: layer.id,
    patch: { effects: { ...layer.effects, ...p } },
  });

  return (
    <div data-testid="inspector-panel">
      {!layer && <CanvasInspector state={state} dispatch={dispatch} />}
      {layer && (
        <>
          <div className="flex items-center gap-2 mb-3">
            <input
              value={layer.name || ""}
              onChange={(e) => patch({ name: e.target.value })}
              aria-label="Layer name"
              style={{ ...fieldStyle, fontWeight: 700 }}
              data-testid="inspector-layer-name"
            />
          </div>
          {layer.type === "background" && <BackgroundInspector layer={layer} patch={patch} />}
          {layer.type === "image" && <ImageInspector layer={layer} patch={patch} patchEffects={patchEffects} />}
          {layer.type === "text" && <TextInspector layer={layer} patch={patch} patchEffects={patchEffects} />}
          {layer.type === "component" && <ComponentInspector layer={layer} patch={patch} patchEffects={patchEffects} />}
          {layer.type === "effect" && <EffectInspector layer={layer} patch={patch} />}
        </>
      )}
    </div>
  );
}
