/**
 * RewardExperienceShell.jsx — the experience layer that wraps the EXISTING
 * LoginRewardPopup (and any future reward popup: attendance, lucky spin,
 * referral, birthday…). It never touches reward logic: it composes an
 * environment, particles, decorations, glass re-skin and choreography
 * AROUND its children.
 *
 * Contract:
 *   • experience == null / environment "classic" with no decorations
 *     → renders children as-is (zero DOM added, legacy pixel-identical).
 *   • all added layers are pointer-events: none.
 *   • prefers-reduced-motion → static environment, no particles,
 *     no choreography.
 */
import { useMemo } from "react";
import { normalizeExperience, themeVars } from "./experienceThemes";
import RewardEnvironment from "./RewardEnvironment";
import RewardParticleLayer from "./RewardParticleLayer";
import RewardDecorationLayer from "./RewardDecorationLayer";
import { SHELL_CSS } from "./shellStyles";

const CEL_MOTES = Array.from({ length: 16 }, (_, i) => ({
  key: i,
  left: 20 + Math.random() * 60,
  top: 45 + Math.random() * 30,
  size: 4 + Math.random() * 6,
  delay: Math.random() * 0.5,
  drift: (Math.random() - 0.5) * 120,
}));

function SuccessCelebration({ accent, contained }) {
  return (
    <div className="rxp-celebrate" data-testid="rxp-celebration" aria-hidden="true">
      <span
        className="rxp-cel-bloom"
        style={{ background: `radial-gradient(circle, ${accent}55 0%, transparent 70%)` }}
      />
      {CEL_MOTES.map((m) => (
        <span
          key={m.key}
          className="rxp-cel-mote"
          style={{
            left: `${m.left}%`, top: `${m.top}%`,
            width: m.size, height: m.size,
            background: accent, color: accent,
            animationDelay: `${m.delay}s`,
            "--rxp-drift": `${m.drift}px`,
          }}
        />
      ))}
    </div>
  );
}

export default function RewardExperienceShell({
  experience,
  accent = "#D4A843",
  phase = "idle",
  reducedMotion = false,
  contained = false,
  children,
}) {
  const exp = useMemo(() => normalizeExperience(experience), [experience]);
  const vars = useMemo(() => themeVars(exp, accent), [exp, accent]);

  // Legacy passthrough — no experience configured: render EXACTLY as before.
  if (exp.environment === "classic" && !exp.decorations.length) return children;

  return (
    <div
      className={`rxp-scope ${contained ? "rxp-contained" : ""}`}
      data-testid="reward-experience-shell"
      data-env={exp.environment}
      data-reveal={reducedMotion ? "classic" : exp.reveal}
      data-phase={phase}
      data-cta={exp.cta?.style || "solid"}
      data-cta-anim={reducedMotion ? "none" : (exp.cta?.animation || "shimmer")}
      style={vars}
    >
      <RewardEnvironment exp={exp} contained={contained} reducedMotion={reducedMotion} />
      {!reducedMotion && <RewardParticleLayer exp={exp} contained={contained} />}
      <RewardDecorationLayer decorations={exp.decorations} layer="back" contained={contained} reducedMotion={reducedMotion} />
      {children}
      <RewardDecorationLayer decorations={exp.decorations} layer="front" contained={contained} reducedMotion={reducedMotion} />
      {phase === "success" && !reducedMotion && (
        <SuccessCelebration accent={accent} contained={contained} />
      )}
      <style>{SHELL_CSS}</style>
    </div>
  );
}
