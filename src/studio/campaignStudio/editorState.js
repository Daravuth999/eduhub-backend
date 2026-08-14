/**
 * editorState.js — Campaign Design Studio 2.0 editor state engine.
 * Plain reducer + undo/redo history (max 60 checkpoints), zero new deps.
 *
 * History discipline: discrete actions checkpoint automatically; continuous
 * gestures (drag/resize/rotate) dispatch CHECKPOINT once on pointer-down and
 * then TRANSIENT updates, so undo restores the pre-gesture frame in one step
 * (professional editor behavior).
 */
import {
  normalizeCanvas, newLayerId, makeImageLayer, makeTextLayer,
  makeComponentLayer, makeEffectLayer,
} from "../../eduhub/lib/campaignCanvas/canvasSchema";

const HISTORY_LIMIT = 60;

export function initialEditorState(canvas) {
  return {
    canvas: normalizeCanvas(canvas),
    selectedId: null,
    history: [],
    future: [],
    dirty: false,
  };
}

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

function checkpoint(state) {
  return {
    history: [...state.history.slice(-HISTORY_LIMIT + 1), clone(state.canvas)],
    future: [],
  };
}

function patchLayer(canvas, id, patch) {
  return {
    ...canvas,
    layers: canvas.layers.map((l) => (l.id === id ? { ...l, ...(typeof patch === "function" ? patch(l) : patch) } : l)),
  };
}

export function editorReducer(state, action) {
  switch (action.type) {
    case "RESET":
      return initialEditorState(action.canvas);

    case "SELECT":
      return { ...state, selectedId: action.id };

    case "CHECKPOINT":
      return { ...state, ...checkpoint(state) };

    case "TRANSIENT_LAYER": // no history — gesture frames
      return { ...state, canvas: patchLayer(state.canvas, action.id, action.patch), dirty: true };

    case "UPDATE_LAYER":
      return { ...state, ...checkpoint(state), canvas: patchLayer(state.canvas, action.id, action.patch), dirty: true };

    case "UPDATE_CANVAS": // canvas-level meta (aspect, motion, artworkMode, safeArea)
      return { ...state, ...checkpoint(state), canvas: { ...state.canvas, ...action.patch }, dirty: true };

    case "ADD_LAYER": {
      const layer = action.layer;
      const layers = [...state.canvas.layers];
      // poster layers sit right above background; everything else on top
      if (layer.type === "image" && layer.role === "poster") {
        const bgIndex = layers.findIndex((l) => l.type === "background");
        layers.splice(bgIndex + 1, 0, layer);
      } else {
        layers.push(layer);
      }
      return {
        ...state, ...checkpoint(state),
        canvas: { ...state.canvas, layers },
        selectedId: layer.id, dirty: true,
      };
    }

    case "REMOVE_LAYER": {
      const layers = state.canvas.layers.filter((l) => l.id !== action.id);
      return {
        ...state, ...checkpoint(state),
        canvas: { ...state.canvas, layers },
        selectedId: state.selectedId === action.id ? null : state.selectedId,
        dirty: true,
      };
    }

    case "DUPLICATE_LAYER": {
      const src = state.canvas.layers.find((l) => l.id === action.id);
      if (!src || src.type === "background") return state;
      const copy = clone(src);
      copy.id = newLayerId(src.type.slice(0, 3));
      copy.name = `${src.name || src.type} copy`;
      if (copy.frame) { copy.frame.x = Math.min(96, copy.frame.x + 4); copy.frame.y = Math.min(96, copy.frame.y + 6); }
      const idx = state.canvas.layers.findIndex((l) => l.id === action.id);
      const layers = [...state.canvas.layers];
      layers.splice(idx + 1, 0, copy);
      return { ...state, ...checkpoint(state), canvas: { ...state.canvas, layers }, selectedId: copy.id, dirty: true };
    }

    case "REORDER_LAYER": {
      const { id, direction } = action; // "up" = later in array = visually above
      const layers = [...state.canvas.layers];
      const idx = layers.findIndex((l) => l.id === id);
      if (idx < 0 || layers[idx].type === "background") return state;
      const target = direction === "up" ? idx + 1 : idx - 1;
      if (target < 1 || target >= layers.length) return state; // index 0 = background floor
      const [moved] = layers.splice(idx, 1);
      layers.splice(target, 0, moved);
      return { ...state, ...checkpoint(state), canvas: { ...state.canvas, layers }, dirty: true };
    }

    case "UNDO": {
      if (!state.history.length) return state;
      const prev = state.history[state.history.length - 1];
      return {
        ...state,
        canvas: prev,
        history: state.history.slice(0, -1),
        future: [clone(state.canvas), ...state.future].slice(0, HISTORY_LIMIT),
        dirty: true,
      };
    }

    case "REDO": {
      if (!state.future.length) return state;
      const next = state.future[0];
      return {
        ...state,
        canvas: next,
        history: [...state.history.slice(-HISTORY_LIMIT + 1), clone(state.canvas)],
        future: state.future.slice(1),
        dirty: true,
      };
    }

    case "MARK_SAVED":
      return { ...state, dirty: false };

    default:
      return state;
  }
}

/* ────── layer insertion helpers (shared by panels) ────── */

export function insertAsset(dispatch, asset, { role = "hero" } = {}) {
  if (role === "background") {
    // handled by caller via UPDATE_LAYER on the background layer
    return null;
  }
  const isWide = (asset.aspect || 1) > 1.4;
  const w = role === "poster" ? 100 : isWide ? 34 : 24;
  const aspectH = role === "poster" ? 100 : Math.min(86, (w * (21 / 9)) / (asset.aspect || 1));
  const layer = makeImageLayer({
    name: asset.label,
    src: asset.src,
    role,
    assetId: asset.id || null,
    frame: role === "poster" ? { x: 50, y: 50, w: 100, h: 100 } : { x: 70, y: 50, w, h: aspectH },
    effects: {
      shadow: { enabled: role !== "poster", preset: "soft", x: 0, y: 10, blur: 26, color: "#000000", opacity: 30 },
      glow: { enabled: false, color: "#D9B872", blur: 26, opacity: 50 },
      blur: 0, radius: 0,
    },
  });
  dispatch({ type: "ADD_LAYER", layer });
  return layer;
}

export function insertText(dispatch, { styleId = "premiumLuxury", text = "Your headline", size = 7 } = {}) {
  const layer = makeTextLayer({ text, styleId, size, frame: { x: 30, y: 42, w: 52 } });
  dispatch({ type: "ADD_LAYER", layer });
  return layer;
}

export function insertComponent(dispatch, componentId, props = {}, overrides = {}) {
  const layer = makeComponentLayer(componentId, { props, ...overrides });
  dispatch({ type: "ADD_LAYER", layer });
  return layer;
}

export function insertEffect(dispatch, effectId) {
  const layer = makeEffectLayer(effectId);
  dispatch({ type: "ADD_LAYER", layer });
  return layer;
}

/* ────── legacy → canvas migration (non-destructive) ────── */

const ROLE_TO_STYLE = {
  eyebrow: { styleId: "minimal", size: 2.6 },
  headline: { styleId: "premiumLuxury", size: 7.4 },
  subhead: { styleId: "appleInspired", size: 3.6 },
  body: { styleId: "academic", size: 2.8 },
};

const LEGACY_THEME_TO_SURFACE = {
  emeraldDay: "emeraldAuto",
  emeraldNight: "emeraldNight",
  celebrationGold: "celebrationGold",
};

/** Converts a legacy (form-era) promotional_banner config into a canvas v2
 * document. Purely additive — the caller keeps every legacy content field
 * alongside the new `canvas` key so unpublishing/rolling back stays safe. */
export function migrateLegacyToCanvas(config) {
  const content = config?.content || {};
  const appearance = config?.appearance || {};
  const layers = [];

  layers.push({
    ...makeImageLayerSafeBackground(appearance),
  });

  // artwork -> hero layer (position approximated from legacy placement)
  const art = appearance.artwork;
  if (art?.url) {
    const placementX = { left: 18, center: 50, right: 78, topLeft: 18, topRight: 78, bottomLeft: 18, bottomRight: 78, custom: art.customX ?? 70 };
    const placementY = { left: 50, center: 50, right: 50, topLeft: 26, topRight: 26, bottomLeft: 74, bottomRight: 74, custom: art.customY ?? 50 };
    layers.push(makeImageLayer({
      name: "Legacy artwork",
      src: art.url,
      assetId: art.assetId || null,
      role: "hero",
      frame: {
        x: placementX[art.placement] ?? 72,
        y: placementY[art.placement] ?? 50,
        w: Math.min(60, 30 * ((art.scale ?? 100) / 100)),
        h: Math.min(90, 66 * ((art.scale ?? 100) / 100)),
      },
      opacity: Number.isFinite(art.opacity) ? art.opacity : 100,
    }));
  }

  // text layers -> typography layers, stacked on the left
  const texts = Array.isArray(content.textLayers) ? content.textLayers.filter((t) => t?.content) : [];
  let y = 30;
  texts.forEach((t) => {
    const map = ROLE_TO_STYLE[t.role] || ROLE_TO_STYLE.body;
    layers.push(makeTextLayer({
      name: t.role || "Text",
      text: t.content,
      styleId: map.styleId,
      size: map.size,
      align: t.align || "left",
      colorOverride: t.color || "",
      frame: { x: 30, y, w: 52 },
    }));
    y += t.role === "headline" ? 20 : 12;
  });

  // CTA buttons -> component layers
  const ctas = Array.isArray(content.ctaButtons) ? content.ctaButtons.filter((b) => b?.label) : [];
  ctas.forEach((b, i) => {
    layers.push(makeComponentLayer("ctaButton", {
      name: b.label,
      props: { label: b.label, style: b.style === "glass" ? "glass" : b.style === "outline" ? "outline" : "gold", action: b.action || { type: "internal_route", value: "/library" } },
      frame: { x: 24 + i * 20, y: Math.min(84, y + 6), w: 20 },
      size: 3.2,
    }));
  });

  // decorations -> effect layers
  const decos = appearance.overrides?.decorations || {};
  Object.entries(decos).forEach(([type, cfg]) => {
    if (cfg?.enabled) layers.push(makeEffectLayer(type, { intensity: cfg.intensity || "medium", colorOverride: cfg.colorOverride || "" }));
  });

  return normalizeCanvas({
    schemaVersion: 2,
    aspect: "21/9",
    artworkMode: art?.url ? "hero" : "composition",
    motion: { preset: "layeredElegant", enabled: true, idle: true },
    layers,
  });
}

function makeImageLayerSafeBackground(appearance) {
  const surfaceId = LEGACY_THEME_TO_SURFACE[appearance.themeId] || "emeraldAuto";
  return {
    id: newLayerId("bg"),
    type: "background",
    name: "Background",
    visible: true,
    locked: false,
    fill: { kind: "surface", surfaceId, color: "#0E1F18", css: "" },
    image: { src: "", fit: "cover", blur: 0, opacity: 100 },
    overlay: { enabled: false, color: "#0B1712", opacity: 24, gradientCss: "" },
  };
}
