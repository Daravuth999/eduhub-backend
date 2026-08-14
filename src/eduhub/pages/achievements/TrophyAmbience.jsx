// TrophyAmbience.jsx — the single live-ambience engine for achieved trophies.
//
// Renders one of 15 preset effects (ambiencePresets.js) around an UNLOCKED
// trophy. Locked trophies never receive ambience — the contrast between a
// matte, silent locked trophy and a living, earned one IS the motivator.
//
// Performance contract:
//   • transform/opacity-only CSS keyframes (ambience.css) — GPU-composited
//   • ≤16 particles, zero per-frame JS (no rAF loops, no canvas)
//   • fully gated by useAmbientActive(): pauses off-screen, on hidden tabs,
//     and under prefers-reduced-motion (renders nothing at all)
//   • deterministic layout (seeded PRNG) — no re-randomize on re-render
import { useMemo } from "react";
import useAmbientActive from "../../hooks/useAmbientActive";
import { PRESETS, DEFAULT_EFFECT } from "./ambiencePresets";
import "./ambience.css";

// Tiny seeded PRNG (mulberry32) — stable particle layout per effect id.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

const between = (rnd, [min, max]) => min + rnd() * (max - min);

function buildParticles(effectId, preset) {
  const rnd = mulberry32(seedFrom(effectId));
  const particles = [];
  for (let i = 0; i < preset.count; i += 1) {
    particles.push({
      key: i,
      left: 8 + rnd() * 84,                       // %
      top: 6 + rnd() * 80,                        // % (twinkle only)
      size: between(rnd, preset.size),
      color: preset.colors[Math.floor(rnd() * preset.colors.length)],
      duration: between(rnd, preset.duration),
      delay: rnd() * between(rnd, preset.duration),
      sway: (rnd() * 2 - 1) * (preset.motion === "spiral" ? 26 : 12),
      radius: 46 + rnd() * 34,                    // px (orbit only)
      reverse: rnd() > 0.5,
    });
  }
  const glints = preset.glint
    ? [0, 1, 2].map((i) => ({
        key: `g${i}`,
        left: 26 + rnd() * 48,
        top: 18 + rnd() * 40,
        duration: preset.glint + rnd() * preset.glint,
        delay: rnd() * preset.glint * 1.6,
        color: preset.colors[0],
      }))
    : [];
  return { particles, glints };
}

function Particle({ p, preset }) {
  const base = {
    width: p.size,
    height: p.size,
    background: p.color,
    filter: preset.blur ? `blur(${preset.blur}px)` : undefined,
    "--peak": preset.opacity,
    "--d": `${p.duration}s`,
    "--delay": `${p.delay}s`,
  };
  if (preset.motion === "orbit") {
    return (
      <span
        className={`ta-orbit-arm${p.reverse ? " ta-reverse" : ""}`}
        style={{ "--d": `${p.duration}s`, "--delay": `${-p.delay}s` }}
      >
        <span className="ta-orbit-dot" style={{ ...base, "--radius": `${p.radius}px` }} />
      </span>
    );
  }
  if (preset.motion === "twinkle") {
    return <span className="ta-p ta-twinkle" style={{ ...base, left: `${p.left}%`, top: `${p.top}%` }} />;
  }
  const cls = preset.motion === "fall" ? "ta-fall" : preset.motion === "spiral" ? "ta-spiral" : "ta-rise";
  return (
    <span
      className={`ta-p ${cls}`}
      style={{
        ...base,
        left: `${p.left}%`,
        "--sway": `${p.sway}px`,
        "--travel": "185px",
        borderRadius: preset.motion === "fall" ? "40% 60% 55% 45%" : undefined,
      }}
    />
  );
}

export default function TrophyAmbience({ effectId }) {
  const id = PRESETS[effectId] ? effectId : DEFAULT_EFFECT;
  const preset = PRESETS[id];
  const { ref, active } = useAmbientActive();
  const { particles, glints } = useMemo(() => buildParticles(id, preset), [id, preset]);

  return (
    <div ref={ref} className="trophy-ambience" aria-hidden="true" data-testid="trophy-ambience" data-effect={id}>
      {active && (
        <>
          {preset.halo && (
            <span
              className="ta-halo"
              style={{ background: `radial-gradient(circle, ${preset.halo} 0%, transparent 68%)` }}
            />
          )}
          {preset.sweep && <span className="ta-sweep" />}
          {particles.map((p) => (
            <Particle key={p.key} p={p} preset={preset} />
          ))}
          {glints.map((g) => (
            <span
              key={g.key}
              className="ta-glint"
              style={{
                left: `${g.left}%`,
                top: `${g.top}%`,
                background: g.color,
                "--d": `${g.duration}s`,
                "--delay": `${g.delay}s`,
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}
