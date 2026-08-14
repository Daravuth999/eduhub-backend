/**
 * RewardDecorationLayer.jsx — renders campaign-authored decorations.
 * Built-in library assets and custom uploads share one code path (<img>).
 * layer="back" sits behind the popup veil (depth), layer="front" floats
 * above the card. Always pointer-events: none in student mode.
 */
import { decorationSrc } from "./decorationAssets";

export function decorationStyle(d) {
  return {
    left: `${d.x}%`,
    top: `${d.y}%`,
    width: d.size,
    opacity: d.opacity,
  };
}

function imgStyle(d) {
  const shadow = d.shadow > 0 ? `drop-shadow(0 ${Math.round(2 + d.shadow * 10)}px ${Math.round(4 + d.shadow * 14)}px rgba(0,0,0,${(0.2 + d.shadow * 0.4).toFixed(2)}))` : "";
  const glow = d.glow > 0 ? `drop-shadow(0 0 ${Math.round(4 + d.glow * 18)}px rgba(255,214,120,${(0.35 + d.glow * 0.5).toFixed(2)}))` : "";
  const blur = d.blur > 0 ? `blur(${d.blur}px)` : "";
  return {
    width: "100%",
    transform: `rotate(${d.rotation}deg) scaleX(${d.flip ? -1 : 1})`,
    filter: [glow, shadow, blur].filter(Boolean).join(" ") || undefined,
  };
}

export default function RewardDecorationLayer({ decorations, layer, contained, reducedMotion }) {
  const items = (decorations || []).filter((d) => d.layer === layer && d.visible !== false);
  if (!items.length) return null;
  return (
    <div
      className={`rxp-decor rxp-decor-${layer} ${contained ? "rxp-abs" : ""}`}
      data-testid={`rxp-decorations-${layer}`}
      aria-hidden="true"
    >
      {items.map((d) => (
        <span
          key={d.id}
          className={`rxp-decor-wrap ${!reducedMotion && d.anim && d.anim !== "none" ? `rxp-danim-${d.anim}` : ""}`}
          style={{
            ...decorationStyle(d),
            animationDuration: d.anim && d.anim !== "none" ? `${(d.anim === "spin" ? 14 : 5) / (d.anim_speed || 1)}s` : undefined,
          }}
        >
          <img
            src={decorationSrc(d)}
            alt=""
            draggable={false}
            className="rxp-decor-item-img"
            style={imgStyle(d)}
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
        </span>
      ))}
    </div>
  );
}
