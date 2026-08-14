/**
 * RewardParticleLayer.jsx — ambient drifting particles (dust / fireflies /
 * petals / sparkles / confetti). CSS-only animation, pointer-events none.
 */
import { useMemo } from "react";
import { resolveExperience } from "./experienceThemes";

const COUNTS = { subtle: 8, premium: 14, celebration: 22 };

const PALETTES = {
  dust: ["#FFE19A", "#D4A843", "#FFF3D6"],
  fireflies: ["#D9F99D", "#FDE68A", "#BEF264"],
  petals: ["#F9A8C7", "#F472B6", "#FBCFE8"],
  sparkles: ["#FFE19A", "#FFFFFF", "#D4A843"],
  confetti: ["#FFC857", "#5EE0FF", "#F472B6", "#A78BFA", "#86EFAC"],
  mist: ["#FFFFFF", "#EAE4F2", "#DCE8F2"],
};

function Rays({ contained }) {
  return (
    <div className={`rxp-particles-layer ${contained ? "rxp-abs" : ""}`} data-testid="rxp-particles" aria-hidden="true">
      {[18, 42, 70].map((x, i) => (
        <span
          key={i}
          style={{
            position: "absolute", left: `${x}%`, top: "-12%",
            width: 90 + i * 26, height: "130%",
            background: "linear-gradient(180deg, rgba(255,244,214,0.5) 0%, transparent 80%)",
            transform: `rotate(${(i - 1) * 9 + 8}deg)`,
            transformOrigin: "top center",
            filter: "blur(14px)",
            animation: `rxp-ray-pulse ${7 + i * 2}s ease-in-out ${i * 1.4}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

export default function RewardParticleLayer({ exp, contained }) {
  const res = resolveExperience(exp);
  const style = res.particlesResolved;
  const count = COUNTS[exp.particle_intensity] || 14;

  const items = useMemo(() => {
    if (!style || style === "none" || style === "rays") return [];
    const palette = PALETTES[style] || PALETTES.dust;
    const n = style === "mist" ? Math.max(4, Math.round(count / 2)) : count;
    return Array.from({ length: n }, (_, i) => ({
      key: i,
      left: Math.random() * 100,
      top: 12 + Math.random() * 82,
      size: style === "mist" ? 60 + Math.random() * 90
        : style === "petals" || style === "confetti" ? 6 + Math.random() * 7 : 3 + Math.random() * 5,
      delay: Math.random() * 6,
      dur: (style === "mist" ? 12 : 6) + Math.random() * 8,
      drift: (Math.random() - 0.5) * 60,
      spin: Math.random() * 360,
      color: palette[i % palette.length],
    }));
  }, [style, count]);

  if (style === "rays") return <Rays contained={contained} />;
  if (!items.length) return null;
  return (
    <div
      className={`rxp-particles-layer ${contained ? "rxp-abs" : ""}`}
      data-testid="rxp-particles"
      aria-hidden="true"
    >
      {items.map((p) => (
        <span
          key={p.key}
          className={`rxp-p rxp-p-${style}`}
          style={{
            left: `${p.left}%`,
            top: `${p.top}%`,
            width: p.size,
            height: style === "petals" ? p.size * 1.5 : p.size,
            background: style === "mist"
              ? `radial-gradient(circle, ${p.color}33 0%, transparent 70%)`
              : p.color,
            color: p.color,
            borderRadius: "50%",
            filter: style === "mist" ? "blur(6px)" : undefined,
            animationName: style === "mist" ? "rxp-mist" : undefined,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.dur}s`,
            "--rxp-drift": `${p.drift}px`,
            "--rxp-spin": `${p.spin}deg`,
          }}
        />
      ))}
    </div>
  );
}
