// Hero.jsx — presentation for the "welcome_dashboard" experience type.
//
// Pure presentation. Receives ONE fully-resolved `config` prop (the
// ExperienceConfig shape: content/appearance/motion/playback) and renders
// it — it contains NO configuration-resolution logic (that lives in
// useExperienceConfig) and reads every color/easing/preset value from the
// platform token modules, never inline hex codes or magic numbers.
//
// Animation is driven IMPERATIVELY via Framer Motion's useAnimation()
// controls rather than declarative initial/animate diffing: the sequence
// is explicitly .start()'d in a useEffect keyed on [tier, preset,
// lighting.origin], so replaying is a decision this component makes on
// purpose (a genuine tier/preset change), never an accidental side effect
// of an unrelated prop updating — there is no ambiguous "did the target
// object change enough to replay" diffing for React/Framer Motion to get
// wrong across StrictMode's dev-only double effect invoke.
import React, { useEffect, useMemo } from "react";
import { motion, useAnimation } from "framer-motion";
import { Sparkles } from "lucide-react";
import { getPalette, radius } from "../styles/tokens/designTokens";
import { getAnimationPreset, getEasingCurve } from "../styles/tokens/animationPresets";
import { getLightingPreset } from "../styles/tokens/lightingTokens";
import { getParticlePreset } from "../styles/tokens/particlePresets";
import usePlaybackMode from "../hooks/usePlaybackMode";
import HeroArtworkLayer from "./HeroArtworkLayer";

const CONTENT_GROUPS = ["badge", "title", "khmerSubtitle", "description", "instructorLine"];

function resolveColor(token, palette) {
  if (!token) return undefined;
  if (typeof token === "string" && token.startsWith("#")) return token;
  return palette[token] || token;
}

export default function Hero({ config }) {
  const content = config?.content || {};
  const appearance = config?.appearance || {};
  const motionCfg = config?.motion || {};
  const playback = config?.playback || {};
  const heroArtwork = appearance.heroArtwork || null;
  const artworkLayerOrder = heroArtwork?.layerOrder || "behindText";

  // usePlaybackMode already folds prefers-reduced-motion into the
  // returned tier (always "static" when the OS setting is on) — Hero
  // doesn't need to query it a second time.
  const tier = usePlaybackMode("welcome_dashboard", playback);
  const animateEnabled = tier !== "static";

  const preset = useMemo(() => {
    const presetId = tier === "full" ? motionCfg.presetId : tier === "short" ? "quickFade" : "instant";
    return getAnimationPreset(presetId);
  }, [tier, motionCfg.presetId]);

  const palette = getPalette(appearance.paletteId);
  const lighting = getLightingPreset(animateEnabled ? motionCfg.lightingId : "none");
  const particles = getParticlePreset(animateEnabled ? motionCfg.particlesId : "none");
  const easingCurve = getEasingCurve(preset.easingId);

  // One imperative controller per content group + one for the light
  // layer — explicitly started/stopped, never left to declarative diffing.
  const groupControls = {
    badge: useAnimation(),
    title: useAnimation(),
    khmerSubtitle: useAnimation(),
    description: useAnimation(),
    instructorLine: useAnimation(),
  };
  const lightControls = useAnimation();

  useEffect(() => {
    let cancelled = false;

    if (!animateEnabled) {
      // Static tier: jump every layer straight to its settled state, no
      // transition at all.
      Object.values(groupControls).forEach((c) => c.set({ opacity: 1, y: 0, filter: "blur(0px)" }));
      lightControls.set({ opacity: lighting.origin ? 1 : 0, scale: 1, y: "0%" });
      return () => { cancelled = true; };
    }

    CONTENT_GROUPS.forEach((key, i) => {
      if (cancelled) return;
      groupControls[key].start(
        { opacity: 1, y: 0, filter: "blur(0px)" },
        { delay: preset.typography.delayFor(i), duration: preset.typography.itemDuration, ease: easingCurve },
      );
    });

    if (lighting.origin) {
      lightControls.start(
        {
          opacity: [0, 0, 0.85, 1],
          scale: lighting.bloomScaleRange,
          y: ["18%", "18%", "0%", "0%"],
        },
        {
          delay: preset.lighting.start,
          duration: preset.lighting.riseDuration + preset.lighting.bloomDuration,
          times: [0, 0.28, 0.72, 1],
          ease: easingCurve,
        },
      );
    }

    // Deliberately NOT calling controls.stop() here. Framer Motion's
    // motion.* components already cancel their own in-flight animations
    // on a genuine DOM unmount — a manual .stop() in cleanup is redundant
    // for that case, and across React 18 StrictMode's dev-only double
    // effect invoke (mount -> cleanup -> mount, same component instance,
    // same controls object) it risks tearing down a controls object the
    // immediately-following .start() call still needs. `cancelled` is
    // kept as a cheap guard for any future async work added before a
    // .start() call; it costs nothing today since every .start() call
    // here is synchronous within the effect body.
    return () => { cancelled = true; };
    // Re-run only when the ACTUAL sequence to play changes (tier/preset) —
    // not on every content string update within the same resolved config.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier, preset, lighting.origin]);

  if (content.visible === false) return null;

  const sectionShadow = "0 18px 44px rgba(9,28,20,0.35), 0 0 0 1px rgba(255,255,255,0.05)";

  return (
    <motion.section
      initial={animateEnabled ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4, ease: easingCurve }}
      className="relative overflow-hidden p-4 sm:p-6 mb-3 sm:mb-4"
      style={{
        borderRadius: radius[appearance.radiusId] || radius.lg,
        boxShadow: sectionShadow,
        background: `linear-gradient(${palette.baseAngle}deg, ${palette.base[0]} 0%, ${palette.base[1]} 58%, ${palette.base[2]} 100%)`,
      }}
      data-testid="hero"
    >
      {/* Atmosphere — static, always present, gives depth without motion */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            `radial-gradient(ellipse 70% 60% at 15% 0%, ${resolveColor("softGlow", palette)}1A 0%, transparent 60%), radial-gradient(ellipse 60% 50% at 100% 100%, ${resolveColor("bloom", palette)}1A 0%, transparent 65%)`,
        }}
      />

      {/* Hero Artwork — behindParticles slot */}
      {artworkLayerOrder === "behindParticles" && (
        <HeroArtworkLayer heroArtwork={heroArtwork} animateEnabled={animateEnabled} />
      )}

      {/* Particles */}
      {particles.kind === "twinkle" && particles.items.map((s, i) => (
        <motion.span
          key={i}
          aria-hidden
          className="absolute rounded-full bg-white pointer-events-none"
          style={{ left: s.x, top: s.y, width: s.size, height: s.size }}
          initial={animateEnabled ? { opacity: 0 } : false}
          animate={animateEnabled ? { opacity: [0, particles.maxOpacity, particles.maxOpacity * 0.55, particles.maxOpacity] } : { opacity: particles.maxOpacity * 0.7 }}
          transition={animateEnabled ? { duration: particles.twinkleDuration, delay: s.delay, repeat: Infinity, repeatType: "mirror", ease: "easeInOut" } : undefined}
        />
      ))}
      {particles.kind === "drift-up" && particles.items.map((p, i) => (
        <motion.span
          key={i}
          aria-hidden
          className="absolute rounded-full pointer-events-none"
          style={{ left: p.x, bottom: "6%", width: p.size, height: p.size, background: resolveColor("softGlow", palette), opacity: animateEnabled ? undefined : particles.maxOpacity * 0.7 }}
          initial={animateEnabled ? { opacity: 0, y: 0 } : false}
          animate={animateEnabled ? { opacity: [0, particles.maxOpacity, particles.maxOpacity, 0], y: -particles.driftDistance } : undefined}
          transition={animateEnabled ? { duration: p.duration, delay: p.delay, repeat: Infinity, ease: "linear" } : undefined}
        />
      ))}

      {/* Soft mist — two static-position, slow-drifting blurred blobs */}
      <motion.div
        aria-hidden
        className="absolute -left-10 bottom-[-20%] w-[65%] h-[70%] rounded-full pointer-events-none"
        style={{ background: `radial-gradient(circle, ${resolveColor("softGlow", palette)}24 0%, transparent 70%)`, filter: "blur(40px)" }}
        animate={animateEnabled ? { x: [0, 14, 0], opacity: [0.7, 1, 0.7] } : { opacity: 0.85 }}
        transition={animateEnabled ? { duration: 22, repeat: Infinity, ease: "easeInOut" } : undefined}
      />
      <motion.div
        aria-hidden
        className="absolute -right-16 -top-16 w-[55%] h-[60%] rounded-full pointer-events-none"
        style={{ background: `radial-gradient(circle, ${palette.base[2]}59 0%, transparent 70%)`, filter: "blur(48px)" }}
        animate={animateEnabled ? { x: [0, -10, 0], opacity: [0.6, 0.85, 0.6] } : { opacity: 0.7 }}
        transition={animateEnabled ? { duration: 26, repeat: Infinity, ease: "easeInOut" } : undefined}
      />

      {/* Hero Artwork — aboveParticles slot */}
      {artworkLayerOrder === "aboveParticles" && (
        <HeroArtworkLayer heroArtwork={heroArtwork} animateEnabled={animateEnabled} />
      )}

      {/* Lighting layer — behind typography always (lower in DOM order) */}
      {lighting.origin && (
        <motion.div
          aria-hidden
          className="absolute left-1/2 bottom-[-35%] -translate-x-1/2 w-[130%] aspect-square rounded-full pointer-events-none"
          style={{
            background: `radial-gradient(circle, ${resolveColor("onBase", palette)}8C 0%, ${resolveColor("softGlow", palette)}4D 30%, ${resolveColor("bloom", palette)}24 55%, transparent 72%)`,
            filter: "blur(2px)",
          }}
          initial={animateEnabled ? { opacity: 0, scale: 0.85, y: "18%" } : false}
          animate={lightControls}
        />
      )}

      {/* Hero Artwork — behindText slot (default) */}
      {artworkLayerOrder === "behindText" && (
        <HeroArtworkLayer heroArtwork={heroArtwork} animateEnabled={animateEnabled} />
      )}

      {/* Typography — always topmost */}
      <div className="relative">
        {content.badge && (
          <motion.div
            initial={animateEnabled ? { opacity: 0, y: 28, filter: "blur(4px)" } : false}
            animate={groupControls.badge}
            className="inline-flex items-center gap-1.5 text-[0.68rem] font-bold tracking-[0.14em] uppercase mb-2 px-2.5 py-1 rounded-full bg-white/[0.08] border border-white/[0.14] backdrop-blur-sm"
          >
            <Sparkles className="w-3 h-3" style={{ color: palette.accent }} />
            <span style={{ color: palette.onBase }}>{content.badge}</span>
          </motion.div>
        )}

        {content.title && (
          <motion.h1
            initial={animateEnabled ? { opacity: 0, y: 30, filter: "blur(5px)" } : false}
            animate={groupControls.title}
            className="font-display font-extrabold leading-[1.05] tracking-tight mb-1.5 text-[clamp(1.45rem,5.5vw,2.5rem)]"
            style={{ color: palette.onBase }}
            data-testid="hero-title"
          >
            {content.title}
          </motion.h1>
        )}

        {content.khmerSubtitle && (
          <motion.div
            initial={animateEnabled ? { opacity: 0, y: 26, filter: "blur(4px)" } : false}
            animate={groupControls.khmerSubtitle}
            className="font-khmer text-[clamp(1rem,3vw,1.45rem)] mb-3"
            style={{ color: palette.softGlow }}
            data-testid="hero-khmer"
          >
            {content.khmerSubtitle}
          </motion.div>
        )}

        {content.description && (
          <motion.div
            initial={animateEnabled ? { opacity: 0, y: 20 } : false}
            animate={groupControls.description}
            className="text-[0.85rem] flex flex-wrap items-center gap-x-1.5 gap-y-1"
            style={{ color: palette.onBaseSoft }}
          >
            <span className="inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: palette.bloom }} />
              {content.description}
            </span>
          </motion.div>
        )}

        {content.instructorLine && (
          <motion.div
            initial={animateEnabled ? { opacity: 0, y: 16 } : false}
            animate={groupControls.instructorLine}
            className="text-[0.85rem] mt-0.5"
            style={{ color: palette.onBaseSoft }}
          >
            Instructor: <strong className="font-semibold" style={{ color: palette.accent }}>{content.instructorLine}</strong>
          </motion.div>
        )}

        {content.cta && (
          <motion.a
            href={content.cta.href}
            initial={animateEnabled ? { opacity: 0, y: 14 } : false}
            animate={groupControls.instructorLine}
            className="inline-flex mt-3 items-center gap-1.5 px-3.5 py-[7px] rounded-full text-[0.8rem] font-semibold"
            style={{ background: palette.accent, color: palette.base[0] }}
          >
            {content.cta.label}
          </motion.a>
        )}
      </div>

      {/* Hero Artwork — aboveDecorative slot (topmost; pointer-events:none so
          it never intercepts clicks, and admins are expected to choose a
          placement/padding that doesn't sit over the typography block) */}
      {artworkLayerOrder === "aboveDecorative" && (
        <HeroArtworkLayer heroArtwork={heroArtwork} animateEnabled={animateEnabled} />
      )}
    </motion.section>
  );
}
