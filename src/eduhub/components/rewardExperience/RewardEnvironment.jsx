/**
 * RewardEnvironment.jsx — immersive scene rendered BEHIND the popup.
 * Pure presentation: gradients, light glows, silhouettes, lighting overlay.
 * GPU-friendly (transform/opacity animations only), pointer-events: none.
 */
import { resolveExperience } from "./experienceThemes";

const SILHOUETTES = {
  angkor: (
    <path d="M0 300V240l60-8 20-30 18 30 42 6 20-52 16-34 12 34 18 52 60 6 26-70 22-58 10-26 10 26 22 58 26 70 60-6 18-52 12-34 16 34 20 52 42-6 18-30 20 30 60 8v60z" />
  ),
  lotus: (
    <path d="M0 300v-40c40 6 80-4 100-22 8 18 30 28 50 24 4-30 22-52 30-56 8 4 26 26 30 56 20 4 42-6 50-24 20 18 60 28 100 22 30 4 60 10 90 8 40-2 100 6 150 12 60 6 130 4 200 8 60 2 130-2 200 12v0z" />
  ),
  heritage: (
    <path d="M0 300v-52h60l14-40 12-22 8-40 10-18 10 18 8 40 12 22 14 40h130l16-48 14-26 10-46 12-22 12 22 10 46 14 26 16 48h130l14-40 12-22 8-40 10-18 10 18 8 40 12 22 14 40h60v52z" />
  ),
  columns: (
    <path d="M0 300v-30h30V90h34v180h60V90h34v180h60V60h36v210h60V90h34v180h60V90h34v180h60V60h36v210h60V90h34v180h60V90h34v180h60v30z M0 60l600-40 600 40v14L600 36 0 74z" />
  ),
};

function Bokeh({ variant, intensity }) {
  const dots = variant === "festival"
    ? [
        { x: "12%", y: "22%", s: 90, c: "rgba(255,200,87,0.35)" },
        { x: "84%", y: "16%", s: 60, c: "rgba(94,224,255,0.28)" },
        { x: "70%", y: "72%", s: 110, c: "rgba(255,120,180,0.22)" },
        { x: "24%", y: "70%", s: 70, c: "rgba(255,200,87,0.25)" },
        { x: "50%", y: "12%", s: 46, c: "rgba(190,140,255,0.26)" },
        { x: "90%", y: "50%", s: 80, c: "rgba(255,200,87,0.18)" },
      ]
    : [
        { x: "16%", y: "20%", s: 80, c: "rgba(212,168,67,0.30)" },
        { x: "82%", y: "28%", s: 56, c: "rgba(212,168,67,0.24)" },
        { x: "68%", y: "76%", s: 100, c: "rgba(212,168,67,0.16)" },
        { x: "30%", y: "66%", s: 64, c: "rgba(255,225,154,0.20)" },
        { x: "48%", y: "14%", s: 40, c: "rgba(255,225,154,0.24)" },
      ];
  return dots.map((d, i) => (
    <span
      key={i}
      className="rxp-bokeh"
      style={{
        left: d.x, top: d.y, width: d.s, height: d.s,
        background: `radial-gradient(circle, ${d.c} 0%, transparent 70%)`,
        opacity: intensity,
        animationDelay: `${i * 0.9}s`,
      }}
    />
  ));
}

const LIGHT_STYLE_COLORS = {
  soft: "#ffffff", golden: "#ffc460", morning: "#ffd9a0",
  sunset: "#ff9e58", studio: "#f4f0ff", cool: "#a8c8ff",
};
const LIGHT_POS = {
  top: "50% 8%", left: "10% 45%", right: "90% 45%", bottom: "50% 92%", center: "50% 45%",
};

function alphaHex(a) {
  return Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0");
}

export default function RewardEnvironment({ exp, contained, reducedMotion }) {
  const res = resolveExperience(exp);
  const env = res.env;
  if (env.id === "classic") return null;
  const lighting = res.lightingResolved;
  const op = exp.env_intensity;
  const lc = exp.lighting_config || {};
  const customColor = lc.color || LIGHT_STYLE_COLORS[lighting] || "";

  return (
    <div
      className={`rxp-env ${contained ? "rxp-abs" : ""}`}
      data-testid="rxp-environment"
      data-env={env.id}
      aria-hidden="true"
    >
      <div className="rxp-env-bg" style={{ background: env.bg, opacity: op }} />
      {env.glowA && (
        <span
          className={`rxp-glow ${reducedMotion ? "" : "rxp-glow-drift"}`}
          style={{
            left: env.glowA.x, top: env.glowA.y, width: env.glowA.size, height: env.glowA.size,
            background: `radial-gradient(circle, ${env.glowA.color} 0%, transparent 70%)`,
            opacity: op,
          }}
        />
      )}
      {env.glowB && (
        <span
          className={`rxp-glow ${reducedMotion ? "" : "rxp-glow-drift rxp-glow-slow"}`}
          style={{
            left: env.glowB.x, top: env.glowB.y, width: env.glowB.size, height: env.glowB.size,
            background: `radial-gradient(circle, ${env.glowB.color} 0%, transparent 70%)`,
            opacity: op,
          }}
        />
      )}
      {env.bokeh && <Bokeh variant={env.bokeh} intensity={op} />}
      {env.beams && (
        <div className="rxp-beams" style={{ opacity: 0.5 * op }} />
      )}
      {env.grid && (
        <div
          className="rxp-grid"
          style={{
            position: "absolute", inset: 0, opacity: 0.14 * op,
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.25) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.25) 1px, transparent 1px)",
            backgroundSize: "56px 56px",
            maskImage: "radial-gradient(ellipse at 50% 40%, black 0%, transparent 75%)",
            WebkitMaskImage: "radial-gradient(ellipse at 50% 40%, black 0%, transparent 75%)",
          }}
        />
      )}
      {env.silhouette && SILHOUETTES[env.silhouette] && (
        <svg
          className="rxp-silhouette"
          viewBox="0 0 1200 300"
          preserveAspectRatio="xMidYMax slice"
          style={{ fill: env.silhouetteColor, opacity: (env.silhouetteOpacity || 0.85) * op }}
        >
          {SILHOUETTES[env.silhouette]}
        </svg>
      )}
      {exp.ambient_color && (
        <div
          className="rxp-ambient"
          style={{
            background: `radial-gradient(circle at 50% 45%, ${exp.ambient_color}44 0%, transparent 65%)`,
          }}
        />
      )}
      {lighting !== "none" && (lighting === "aurora" || lighting === "spotlight") && (
        <div className={`rxp-light rxp-light-${lighting}`} style={{ opacity: (lc.opacity ?? 0.7) * op }} />
      )}
      {lighting !== "none" && customColor && (
        <div
          className="rxp-light rxp-light-custom"
          data-testid="rxp-lighting"
          style={{
            background: `radial-gradient(ellipse at ${LIGHT_POS[lc.direction] || LIGHT_POS.top}, ${customColor}${alphaHex((lc.intensity ?? 0.6) * 0.35)} 0%, transparent 62%)`,
            filter: lc.blur ? `blur(${lc.blur}px)` : undefined,
            opacity: (lc.opacity ?? 0.7) * op,
          }}
        />
      )}
    </div>
  );
}
