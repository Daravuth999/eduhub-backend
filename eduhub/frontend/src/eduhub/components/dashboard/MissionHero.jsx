// MissionHero.jsx — "Today's Journey" card (Home Dashboard V4).
//
// A NEW sibling to Hero.jsx, not a rewrite of it. Hero.jsx is left
// byte-for-byte untouched because Author Studio's WelcomeExperienceStudio
// live-preview panel imports it directly — restyling Hero.jsx in place
// would silently change what admins see in Author Studio, which is
// out of scope for this reconstruction. Both components read the exact
// same resolved `welcome_dashboard` ExperienceConfig (same
// useExperienceConfig/resolveExperienceConfig pipeline); only the
// presentation differs, matching the flat/light mockup instead of the
// ambient dark hero.
//
// Artwork rule: no illustration is embedded here. HeroArtworkLayer only
// renders when an admin has actually published heroArtwork through Author
// Studio's existing media pipeline — absent that, the card is text + CTA
// only, never a fixed/hardcoded graphic.
import { motion } from "framer-motion";
import { ArrowRight, Sparkles } from "lucide-react";
import { getPalette, elevation, radius } from "../../styles/tokens/designTokens";
import { easing, duration, ambient } from "../../styles/tokens/motionTokens";
import usePlaybackMode from "../../hooks/usePlaybackMode";
import useAmbientActive from "../../hooks/useAmbientActive";
import HeroArtworkLayer from "../HeroArtworkLayer";

export default function MissionHero({ config, compact = false }) {
  const content = config?.content || {};
  const appearance = config?.appearance || {};
  const playback = config?.playback || {};
  const heroArtwork = appearance.heroArtwork || null;

  // Same tier hook Hero.jsx uses — Studio playback settings (first-launch
  // replay, reduced-motion) apply identically here.
  const tier = usePlaybackMode("welcome_dashboard", playback);
  const animateEnabled = tier !== "static";
  const palette = getPalette(appearance.paletteId);
  // RC2.5 Motion System — gates every CONTINUOUS ambient loop below (glow,
  // sweep, float, particles). One-shot entrance/CTA-brighten animations are
  // unaffected — they run once regardless.
  const { ref: ambientRef, active: ambientActive } = useAmbientActive();
  const ambientOn = animateEnabled && ambientActive;

  if (content.visible === false) return null;
  if (!content.title) return null;

  return (
    <motion.section
      ref={ambientRef}
      initial={animateEnabled ? { opacity: 0, y: 16 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: duration.slow, ease: easing.premiumEaseOut }}
      className="relative overflow-hidden mx-4 bg-gradient-to-br from-[#EEFBF3] via-[#F7FCF4] to-white dark:from-[#13201A] dark:via-[#101A14] dark:to-[#0D160F] border border-[rgba(40,199,79,0.18)] dark:border-[rgba(40,199,79,0.14)]"
      style={{
        borderRadius: radius.lg,
        // RC2 — dark mode previously had NO variant here at all: this card
        // rendered as a hardcoded light mint gradient (with dark-ink text)
        // regardless of theme, i.e. a bright white-ish card stranded on a
        // dark page. Now a layered dark-green charcoal (not pure black),
        // matching the "avoid pure black / avoid pure-white-on-black"
        // dark mode principle. elevation.raised (0.35 opacity) was
        // calibrated for the V3 dark ambient card system — on this flat
        // layout it reads as too heavy/dark for a calm, premium card.
        // elevation.soft is the correct token for every card on this page,
        // hero included; no card here escalates above it.
        boxShadow: elevation.soft,
      }}
      data-testid="mission-hero"
    >
      {/* RC2 / RC2.5 — one subtle ambient glow, not a particle system.
          MissionHero deliberately has no illustration/particle layer of its
          own (see header comment); this is a single soft, slow-breathing
          light blob, purely abstract (no imagery). */}
      {ambientOn && (
        <motion.div
          aria-hidden
          className="absolute -right-10 -top-14 w-40 h-40 rounded-full pointer-events-none"
          style={{ background: palette.bloom, filter: "blur(36px)" }}
          initial={{ opacity: 0.12, scale: 0.9 }}
          animate={{ opacity: [0.1, 0.22, 0.1], scale: [0.9, 1.05, 0.9] }}
          transition={{ duration: ambient.breathe, repeat: Infinity, ease: "easeInOut" }}
        />
      )}

      {/* RC2.5 — soft light sweep, once every ~13s: a faint diagonal band
          crosses the card and then pauses, rather than looping constantly
          (per the spec: "almost invisible unless someone watches
          carefully"). Skewed via a wide diagonal gradient, not a rotated
          element, so it reads as light grazing the surface. */}
      {ambientOn && (
        <motion.div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background: "linear-gradient(100deg, transparent 40%, rgba(255,255,255,0.35) 50%, transparent 60%)",
          }}
          initial={{ x: "-60%" }}
          animate={{ x: ["-60%", "160%"] }}
          transition={{ duration: 1.8, ease: easing.premiumEaseOut, repeat: Infinity, repeatDelay: ambient.sweep - 1.8 }}
        />
      )}

      {/* RC2.5 — very slow ambient gradient drift behind the content, a
          large soft radial wash whose position eases back and forth. */}
      {ambientOn && (
        <motion.div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background: `radial-gradient(60% 60% at 30% 20%, ${palette.bloom}14 0%, transparent 70%)`,
          }}
          animate={{ opacity: [0.5, 1, 0.5] }}
          transition={{ duration: ambient.breathe * 1.6, repeat: Infinity, ease: "easeInOut" }}
        />
      )}

      {/* RC2.5 — two or three tiny floating particles near the artwork
          corner, echoing Hero.jsx's own particle language at a much
          smaller, quieter scale appropriate to this flat card. */}
      {ambientOn && heroArtwork?.url && (
        <>
          {[{ x: "72%", y: "18%", size: 4, delay: 0 }, { x: "84%", y: "32%", size: 3, delay: 1.1 }, { x: "66%", y: "40%", size: 3, delay: 2.2 }].map((p, i) => (
            <motion.span
              key={i}
              aria-hidden
              className="absolute rounded-full pointer-events-none"
              style={{ left: p.x, top: p.y, width: p.size, height: p.size, background: palette.bloom }}
              initial={{ opacity: 0, y: 0 }}
              animate={{ opacity: [0, 0.7, 0], y: -14 }}
              transition={{ duration: 3.6, delay: p.delay, repeat: Infinity, ease: "easeInOut" }}
            />
          ))}
        </>
      )}

      {heroArtwork?.url && (
        // A CSS `transform` (which framer-motion's `animate` applies here)
        // makes this div a new containing block for absolutely-positioned
        // descendants — HeroArtworkLayer's own inner layer is positioned
        // absolute — so this wrapper is explicitly sized to the full card
        // (absolute inset-0) rather than left as an implicit 0×0 static
        // box, which would otherwise silently break the artwork's
        // placement math the moment the float animation starts.
        <motion.div
          className="absolute inset-0"
          animate={ambientOn ? { y: [0, -3, 0] } : undefined}
          transition={{ duration: ambient.float, repeat: Infinity, ease: "easeInOut" }}
        >
          <HeroArtworkLayer heroArtwork={heroArtwork} animateEnabled={animateEnabled} />
        </motion.div>
      )}

      <div className={compact ? "relative p-3 sm:p-4" : "relative p-4 sm:p-5"}>
        <span
          className={`inline-flex items-center gap-1.5 text-[0.65rem] font-bold tracking-[0.12em] uppercase px-2.5 py-1 rounded-full text-[#1E7A3E] dark:text-[#7FE3A3] ${compact ? "mb-1.5" : "mb-2.5"}`}
          style={{ background: `${palette.bloom}1A` }}
        >
          <Sparkles className="w-3 h-3" />
          {content.badge || "Today's Journey"}
        </span>

        <h2
          className={`font-display font-extrabold leading-[1.12] tracking-tight text-ink dark:text-white max-w-[85%] ${compact ? "text-[1.05rem]" : "text-[1.35rem] sm:text-[1.55rem]"}`}
          data-testid="mission-hero-title"
        >
          {content.title}
        </h2>

        {/* Compact mode (guest identity strip) — badge + title only. The
            description/instructor-line/CTA are dropped here rather than
            shown clipped: this card's height is fully content-driven (no
            fixed height anywhere in this component), so a CSS height clamp
            around variable admin-authored content risks awkwardly cutting
            off whichever field happens to run long. Omitting them outright
            keeps the compact card visually honest at any content length. */}
        {!compact && content.khmerSubtitle && (
          <p className="font-khmer text-[0.95rem] text-zinc-500 dark:text-white/50 mt-1">{content.khmerSubtitle}</p>
        )}

        {!compact && content.description && (
          <p className="text-[0.85rem] text-zinc-600 dark:text-white/60 mt-2 max-w-[92%]">{content.description}</p>
        )}

        {!compact && content.instructorLine && (
          <p className="text-[0.8rem] text-zinc-600 dark:text-white/60 mt-1">
            Instructor: <strong className="font-semibold text-ink dark:text-white">{content.instructorLine}</strong>
          </p>
        )}

        {!compact && content.cta?.label && (
          <motion.a
            href={content.cta.href || "#"}
            initial={animateEnabled ? { filter: "brightness(0.85)" } : false}
            animate={{ filter: "brightness(1)" }}
            transition={{ duration: 0.7, delay: duration.slow + 0.15, ease: easing.premiumEaseOut }}
            whileTap={{ scale: 0.97 }}
            className="inline-flex items-center gap-1.5 mt-4 px-4 py-2.5 rounded-full text-[0.82rem] font-bold text-white"
            style={{ background: palette.bloom, boxShadow: `0 10px 24px ${palette.bloom}40` }}
            data-testid="mission-hero-cta"
          >
            {content.cta.label}
            <ArrowRight className="w-4 h-4" />
          </motion.a>
        )}
      </div>
    </motion.section>
  );
}
