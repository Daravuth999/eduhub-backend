/**
 * PromotionTypography.jsx — renders a Promotion config's `textLayers` array
 * as a vertical content stack (eyebrow -> headline -> subhead -> body).
 *
 * Deliberately a STACK, not free-floating per-layer x/y positioning: real
 * banner-authoring tools (this codebase's own Studio modules included) use
 * a content stack for text, reserving free positioning for artwork/CTA —
 * a stack is also what "avoid overwhelming authors" (approved directive)
 * actually asks for. Documented as a scope decision in the implementation
 * report, not silently assumed.
 *
 * Every layer runs through adaptiveTypography.js for sizing/line-height/
 * wrap safety, and gets `lang`/`font-khmer` set from its OWN detected
 * script — this is what "mixed Khmer and English must remain visually
 * balanced" means structurally: each layer picks its own correct
 * typeface/line-height independently rather than the whole block sharing
 * one script's rules.
 */
import { motion } from "framer-motion";
import { getSafeWrapStyle, detectScript } from "../../lib/promotion/adaptiveTypography";

const ROLE_WEIGHT = {
  eyebrow: 700,
  headline: 800,
  subhead: 600,
  body: 500,
};

const ROLE_DEFAULT_COLOR_KEY = {
  eyebrow: "accent",
  headline: "onSurface",
  subhead: "onSurfaceSoft",
  body: "onSurfaceSoft",
};

function layerTextStyle(layer, theme) {
  const { style } = getSafeWrapStyle(layer.role, layer.content, layer.maxLines);
  const colorKey = ROLE_DEFAULT_COLOR_KEY[layer.role] || "onSurface";
  const baseColor = layer.color || theme[colorKey] || theme.onSurface;

  const out = {
    ...style,
    margin: 0,
    fontWeight: ROLE_WEIGHT[layer.role] || 600,
    textAlign: layer.align || (layer.role === "eyebrow" ? "left" : "left"),
    letterSpacing: layer.role === "eyebrow" ? "0.14em" : undefined,
    textTransform: layer.role === "eyebrow" ? "uppercase" : undefined,
    color: baseColor,
  };

  if (layer.gradient) {
    out.backgroundImage = layer.gradient;
    out.WebkitBackgroundClip = "text";
    out.backgroundClip = "text";
    out.color = "transparent";
    out.WebkitTextFillColor = "transparent";
  }
  if (layer.shadow) out.textShadow = layer.shadow;
  if (layer.stroke) {
    out.WebkitTextStroke = layer.stroke;
  }
  return out;
}

function TextLayerItem({ layer, theme, animateEnabled, index }) {
  if (!layer?.content) return null;
  const script = layer.lang && layer.lang !== "auto" ? layer.lang : detectScript(layer.content);
  const textStyle = layerTextStyle(layer, theme);
  const isGlass = Boolean(layer.glass);

  const Tag = layer.role === "headline" ? "h2" : layer.role === "eyebrow" ? "span" : "p";

  const content = (
    <Tag
      lang={script === "km" || script === "mixed" ? "km" : undefined}
      className={script === "km" || script === "mixed" ? "font-khmer" : undefined}
      style={textStyle}
      data-testid={`promotion-text-${layer.role}`}
    >
      {layer.content}
    </Tag>
  );

  const wrapped = isGlass ? (
    <div
      style={{
        display: "inline-block",
        padding: "6px 12px",
        borderRadius: 12,
        background: "rgba(255,255,255,0.10)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: "1px solid rgba(255,255,255,0.16)",
      }}
    >
      {content}
    </div>
  ) : content;

  if (!animateEnabled) return wrapped;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: index * 0.08, ease: [0.22, 1, 0.36, 1] }}
    >
      {wrapped}
    </motion.div>
  );
}

export default function PromotionTypography({ textLayers, theme, animateEnabled = true, align = "left" }) {
  const layers = Array.isArray(textLayers) ? textLayers.filter((l) => l?.content) : [];
  if (!layers.length) return null;

  return (
    <div
      className="relative flex flex-col gap-1.5"
      style={{ textAlign: align, alignItems: align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start" }}
      data-testid="promotion-typography"
    >
      {layers.map((layer, i) => (
        <TextLayerItem key={layer.id ?? i} layer={layer} theme={theme} animateEnabled={animateEnabled} index={i} />
      ))}
    </div>
  );
}
