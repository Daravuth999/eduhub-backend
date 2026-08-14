/**
 * CampaignCanvasRenderer.jsx — THE shared rendering engine for Campaign
 * Design Studio 2.0 canvas documents (content.canvas, schemaVersion 2).
 *
 * Used by BOTH:
 *   • the Studio's CanvasStage (editing surface — interaction handled by a
 *     separate overlay, this component stays pure presentation), and
 *   • PromotionPanel on the student Dashboard (published render).
 * One renderer -> "what you see is what ships", structurally.
 *
 * All layout is percentage/canvas-unit based (see canvasSchema.js), so the
 * same document renders identically at any container width.
 *
 * Reuse-first: effect layers render through the EXISTING DecorationLayer
 * (sparkles/dust/rays/confetti/ribbons) rather than a duplicate particle
 * system; only spotlight/luxurySmoke are new CSS-gradient effects.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  normalizeCanvas, getCanvasSurface, getAspectRatioCss, frameToStyle,
  getLayerEffectStyles,
} from "../../lib/campaignCanvas/canvasSchema";
import { getTypographyStyle } from "../../lib/campaignCanvas/typographyStyles";
import { getMotionPreset, getLayerEntrance, getIdleAnimation, getMotionRank } from "../../lib/campaignCanvas/motionPresets";
import { detectScript } from "../../lib/promotion/adaptiveTypography";
import DecorationLayer from "../decorations/DecorationLayer";
import MarketingComponentLayer from "./MarketingComponents";

/* ────────────────── background layer ────────────────── */
function BackgroundLayer({ layer, mode }) {
  const fill = layer.fill || {};
  const surface = getCanvasSurface(fill.surfaceId);
  const background =
    fill.kind === "solid" ? fill.color
      : fill.kind === "gradient" && fill.css ? fill.css
        : mode === "night" ? surface.night : surface.day;

  const img = layer.image || {};
  const hasImage = Boolean(img.src);
  const imgStyle = hasImage ? {
    position: "absolute", inset: 0, width: "100%", height: "100%",
    ...(img.fit === "tile"
      ? { backgroundImage: `url(${img.src})`, backgroundRepeat: "repeat", backgroundSize: "22% auto" }
      : null),
    ...(img.fit !== "tile" ? { objectFit: img.fit === "stretch" ? "fill" : img.fit || "cover" } : null),
    opacity: (Number.isFinite(img.opacity) ? img.opacity : 100) / 100,
    filter: img.blur > 0 ? `blur(${img.blur}px)` : undefined,
    transform: img.blur > 0 ? "scale(1.04)" : undefined,
  } : null;

  const ov = layer.overlay || {};
  return (
    <div aria-hidden className="absolute inset-0" style={{ background }} data-testid="campaign-bg-layer">
      {hasImage && img.fit === "tile" && <div style={imgStyle} />}
      {hasImage && img.fit !== "tile" && <img src={img.src} alt="" draggable={false} style={imgStyle} />}
      {ov.enabled && (ov.gradientCss || ov.color) && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={ov.gradientCss
            ? { background: ov.gradientCss }
            : { background: ov.color, opacity: (Number.isFinite(ov.opacity) ? ov.opacity : 24) / 100 }}
        />
      )}
    </div>
  );
}

/* ────────────────── image layer (hero / poster / decor) ──────────── */
function ImageLayerContent({ layer }) {
  if (layer.role === "poster") return null; // poster handled separately
  const fxStyle = getLayerEffectStyles(layer, { isImage: true });
  return (
    <img
      src={layer.src}
      alt={layer.name || ""}
      draggable={false}
      style={{
        width: "100%", height: "100%",
        objectFit: "contain",             // hero artwork is NEVER cropped
        transform: layer.flipH ? "scaleX(-1)" : undefined,
        borderRadius: layer.effects?.radius > 0 ? layer.effects.radius : undefined,
        ...fxStyle,
        pointerEvents: "none", userSelect: "none",
      }}
    />
  );
}

/** Poster mode — render professional artwork EXACTLY. No auto crop, no
 * forced scaling, no repositioning. Fit rules only. */
function PosterLayer({ layer }) {
  const fit = layer.posterFit || "contain";
  const fxStyle = getLayerEffectStyles(layer, { isImage: true });
  const common = {
    display: "block", pointerEvents: "none", userSelect: "none",
    opacity: (Number.isFinite(layer.opacity) ? layer.opacity : 100) / 100,
    ...fxStyle,
  };
  let style;
  if (fit === "original") {
    style = { ...common, position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", maxWidth: "none", maxHeight: "none" };
  } else if (fit === "fitWidth") {
    style = { ...common, position: "absolute", left: 0, top: "50%", transform: "translateY(-50%)", width: "100%", height: "auto" };
  } else if (fit === "fitHeight") {
    style = { ...common, position: "absolute", left: "50%", top: 0, transform: "translateX(-50%)", width: "auto", height: "100%" };
  } else if (fit === "center") {
    style = { ...common, position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", maxWidth: "100%", maxHeight: "100%" };
  } else { // contain
    style = { ...common, position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" };
  }
  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden" data-testid="campaign-poster-layer">
      <img src={layer.src} alt={layer.name || ""} draggable={false} style={style} />
    </div>
  );
}

/* ────────────────── text layer ────────────────── */
function TextLayerContent({ layer, cu, mode }) {
  const styleDef = getTypographyStyle(layer.styleId);
  const css = styleDef.build({ cu, size: layer.size || 6, mode, align: layer.align });
  const script = layer.lang && layer.lang !== "auto" ? layer.lang : detectScript(layer.text || "");
  const fxStyle = getLayerEffectStyles(layer, { isImage: false });
  return (
    <div style={{ width: "100%", textAlign: layer.align || "left" }}>
      <span
        lang={script === "km" || script === "mixed" ? "km" : undefined}
        style={{
          ...css,
          ...(layer.colorOverride ? { color: layer.colorOverride, WebkitTextFillColor: layer.colorOverride, backgroundImage: "none" } : null),
          ...fxStyle,
          display: css.display || "inline-block",
          maxWidth: "100%",
          overflowWrap: "break-word",
          whiteSpace: "pre-wrap",
        }}
        data-testid="campaign-text-layer"
      >
        {layer.text}
      </span>
    </div>
  );
}

/* ────────────────── effect layer ────────────────── */
const DECORATION_EFFECTS = new Set(["sparkles", "premiumDust", "lightRays", "confetti", "academicParticles", "ribbons"]);

function EffectLayerContent({ layer, animateEnabled }) {
  if (DECORATION_EFFECTS.has(layer.effectId)) {
    const decorations = {
      [layer.effectId]: {
        enabled: true,
        intensity: layer.intensity || "medium",
        colorOverride: layer.colorOverride || null,
      },
    };
    return <DecorationLayer decorations={decorations} animateEnabled={animateEnabled} testidPrefix="campaign-effect" />;
  }
  if (layer.effectId === "spotlight") {
    return (
      <div aria-hidden className="absolute inset-0 pointer-events-none" style={{
        background: `radial-gradient(58% 82% at 50% 8%, ${layer.colorOverride || "rgba(255,236,190,0.34)"} 0%, transparent 68%)`,
        mixBlendMode: "screen",
      }} />
    );
  }
  if (layer.effectId === "luxurySmoke") {
    return (
      <div aria-hidden className="absolute inset-0 pointer-events-none" style={{ overflow: "hidden" }}>
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            style={{
              position: "absolute",
              left: `${12 + i * 30}%`, bottom: "-30%",
              width: "52%", height: "85%",
              background: `radial-gradient(50% 50% at 50% 50%, ${layer.colorOverride || "rgba(212,168,67,0.10)"} 0%, transparent 70%)`,
              filter: "blur(18px)",
            }}
            animate={animateEnabled ? { y: [0, -26, 0], x: [0, i % 2 ? 14 : -14, 0] } : undefined}
            transition={{ duration: 9 + i * 2.4, repeat: Infinity, ease: "easeInOut" }}
          />
        ))}
      </div>
    );
  }
  return null;
}

/* ────────────────── main renderer ────────────────── */
/**
 * @param {object}  canvas          canvas document (content.canvas)
 * @param {string}  appTheme        "light" | "dark" — student app theme
 * @param {boolean} animateEnabled  entrance+idle motion (false = final frame)
 * @param {boolean} interactive     enable CTA clicks (Dashboard true, Studio false)
 * @param {object}  handlers        { navigate, openTopUp } for ctaButton
 * @param {boolean} editMode        Studio stage — disables entrance/idle so
 *                                  editing is stable while dragging
 * @param {function} onCanvasUnit   optional (cu)=>void — Studio overlay sync
 */
export default function CampaignCanvasRenderer({
  canvas: rawCanvas,
  appTheme = "light",
  animateEnabled = true,
  interactive = false,
  handlers,
  editMode = false,
  onCanvasUnit,
  className = "",
  style,
}) {
  const canvas = useMemo(() => normalizeCanvas(rawCanvas), [rawCanvas]);
  const ref = useRef(null);
  const [cu, setCu] = useState(3.4); // canvas unit px — corrected on mount

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) {
        const unit = w / 100;
        setCu(unit);
        onCanvasUnit?.(unit);
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      // very old browsers / jsdom: fall back to a single measurement +
      // window resize (no continuous observation needed there)
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onCanvasUnit]);

  const bgLayer = canvas.layers.find((l) => l.type === "background" && l.visible !== false);
  const surface = getCanvasSurface(bgLayer?.fill?.surfaceId);
  const mode = useMemo(() => {
    const id = bgLayer?.fill?.surfaceId || "emeraldAuto";
    if (id === "emeraldAuto") return appTheme === "dark" ? "night" : "day";
    // Fixed surfaces declare their own ink mode via inkDay lightness
    return ["champagne"].includes(id) && appTheme !== "dark" ? "day"
      : ["emeraldNight", "midnightRoyal", "celebrationGold", "rubyFestival"].includes(id) ? "night"
        : appTheme === "dark" ? "night" : "day";
  }, [bgLayer, appTheme]);

  const preset = getMotionPreset(canvas.motion?.preset);
  const motionOn = animateEnabled && !editMode && canvas.motion?.enabled !== false;
  const idleOn = motionOn && canvas.motion?.idle !== false;

  // per-rank index for stagger
  const rankCounters = {};

  return (
    <div
      ref={ref}
      className={`relative w-full overflow-hidden ${className}`}
      style={{ aspectRatio: getAspectRatioCss(canvas.aspect), ...style }}
      data-testid="campaign-canvas"
      data-canvas-mode={mode}
    >
      {canvas.layers.map((layer) => {
        if (!layer || layer.visible === false) return null;
        const rank = getMotionRank(layer);
        rankCounters[rank] = (rankCounters[rank] || 0) + 1;
        const entrance = motionOn ? getLayerEntrance(layer, rankCounters[rank] - 1, preset) : null;

        if (layer.type === "background") {
          const node = <BackgroundLayer layer={layer} mode={mode} />;
          return motionOn ? (
            <motion.div key={layer.id} className="absolute inset-0" {...entrance}>{node}</motion.div>
          ) : <div key={layer.id} className="absolute inset-0">{node}</div>;
        }

        if (layer.type === "effect") {
          const node = <EffectLayerContent layer={layer} animateEnabled={motionOn || (!editMode && animateEnabled)} />;
          const wrapStyle = { opacity: (Number.isFinite(layer.opacity) ? layer.opacity : 100) / 100 };
          return motionOn ? (
            <motion.div key={layer.id} className="absolute inset-0 pointer-events-none" style={wrapStyle} {...entrance}>{node}</motion.div>
          ) : <div key={layer.id} className="absolute inset-0 pointer-events-none" style={wrapStyle}>{node}</div>;
        }

        if (layer.type === "image" && layer.role === "poster") {
          if (!layer.src) return null;
          const node = <PosterLayer layer={layer} />;
          return motionOn ? (
            <motion.div key={layer.id} className="absolute inset-0" {...entrance}>{node}</motion.div>
          ) : <div key={layer.id} className="absolute inset-0">{node}</div>;
        }

        // framed layers: image (hero/decor), text, component
        const frameStyle = frameToStyle(layer.frame, layer.rotation);
        const opacity = (Number.isFinite(layer.opacity) ? layer.opacity : 100) / 100;
        let inner = null;
        if (layer.type === "image") {
          if (!layer.src) return null;
          inner = <ImageLayerContent layer={layer} />;
        } else if (layer.type === "text") {
          inner = <TextLayerContent layer={layer} cu={cu} mode={mode} />;
        } else if (layer.type === "component") {
          inner = (
            <MarketingComponentLayer
              layer={layer} cu={cu} mode={mode}
              interactive={interactive} handlers={handlers}
            />
          );
        } else {
          return null;
        }

        const idle = idleOn ? getIdleAnimation(layer, rankCounters[rank] - 1) : null;
        const body = idle ? (
          <motion.div style={{ width: "100%", height: "100%" }} animate={idle.animate} transition={idle.transition}>
            {inner}
          </motion.div>
        ) : inner;

        const pe = layer.type === "component" && interactive ? "auto" : "none";
        return motionOn ? (
          <motion.div key={layer.id} style={{ ...frameStyle, opacity, pointerEvents: pe }} {...entrance} data-layer-id={layer.id}>
            {body}
          </motion.div>
        ) : (
          <div key={layer.id} style={{ ...frameStyle, opacity, pointerEvents: pe }} data-layer-id={layer.id}>
            {body}
          </div>
        );
      })}
      {/* subtle inner ring for premium finish — matches legacy panel framing */}
      <div aria-hidden className="absolute inset-0 pointer-events-none" style={{ boxShadow: `inset 0 0 0 1px ${mode === "night" ? "rgba(255,255,255,0.08)" : "rgba(14,31,24,0.08)"}` }} />
      <span className="sr-only">{surface.label}</span>
    </div>
  );
}
