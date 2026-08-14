// DiscoveryCard.jsx — "Today's Discovery" section (Home Dashboard V4).
//
// A new `daily_discovery` experienceType on the EXISTING Experience
// Configuration Platform — not a parallel config system. This required
// ZERO changes to resolveExperienceConfig.js / useExperienceConfig.js /
// experienceDefaults.js: an experienceType with no entry in
// experienceDefaults.js already falls back to the generic empty default
// (`{content: {title: "", visible: true}, ...}`) exactly the way
// `promotional_banner` does today — the platform was already generic-safe
// for a brand-new type. Same "no legacy source, gate on source==='published'"
// contract PromotionPanel uses, for the same reason: the generic default's
// content is empty, so treating it as "there's a real config" would render
// a blank card instead of nothing.
//
// Content shape (content.items[]): { id, title, body, cta?: {label, href},
// artwork?: <heroArtwork-shaped, see heroArtworkSchema.js> } — artwork
// reuses the exact same asset field convention (assetId + url) as
// Welcome/Achievement/Promotion, rendered through the SAME HeroArtworkLayer
// (including its offline cache) — no new upload pipeline, no embedded/
// hardcoded artwork.
//
// content.emptyState (Final Polish Phase, additive): { title, subtitle,
// cta?: {label, href}, artwork? } — shown, using the shared
// EmptyStateCard, whenever no real item exists yet (either nothing
// published at all, or a published config with zero items). Every field
// is optional and admin-authored via DailyDiscoveryFields.jsx exactly
// like the real items are; when unauthored, a generic, honest "coming
// soon" fallback renders instead — never fabricated word-of-the-day
// content, just honest system copy about the section's own state (same
// class of message as "No dashboard environment published" elsewhere in
// Author Studio).
//
// Author Studio's Dashboard Studio (DashboardStudio.jsx) previews this
// EXACT component with draft content, via the optional `previewConfig`
// prop below — "real rendering with draft configuration," never a mock
// preview. Dashboard.jsx itself never passes that prop; it always
// self-fetches through useExperienceConfig, so production behavior here
// is completely unchanged by the prop's existence.
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion, useScroll, useTransform } from "framer-motion";
import { Sparkles, Compass } from "lucide-react";
import useExperienceConfig from "../../hooks/useExperienceConfig";
import usePlaybackMode from "../../hooks/usePlaybackMode";
import { easing, duration, ambient } from "../../styles/tokens/motionTokens";
import { getPalette, elevation, radius } from "../../styles/tokens/designTokens";
import useAmbientActive from "../../hooks/useAmbientActive";
import HeroArtworkLayer from "../HeroArtworkLayer";
import EmptyStateCard from "./EmptyStateCard";

const ROTATE_MS = 6000;

export default function DiscoveryCard({ previewConfig } = {}) {
  // The hook is always called (rules-of-hooks) — a Studio-supplied
  // previewConfig simply overrides what it resolved to, and is treated as
  // "published" for gating purposes: Studio previews what WOULD render if
  // this draft were live, regardless of its actual publish status.
  const hookResult = useExperienceConfig("daily_discovery");
  const config = previewConfig || hookResult.config;
  const source = previewConfig ? "published" : hookResult.source;
  const content = config?.content || {};
  const appearance = config?.appearance || {};
  const playback = config?.playback || {};
  const items = Array.isArray(content.items) ? content.items.filter((it) => it && (it.title || it.body)) : [];

  const tier = usePlaybackMode("daily_discovery", playback);
  const animateEnabled = tier !== "static";
  const palette = getPalette(appearance.paletteId);
  // RC2.5 — gates the continuous artwork-zone ambient loops (float, extra
  // sparkles, glow). The sparkle on the "Word of the Day" eyebrow already
  // existed from RC2 and is intentionally left as-is (gated by
  // animateEnabled only, matching its original scope).
  const { ref: ambientRef, active: ambientActive } = useAmbientActive();
  const ambientOn = animateEnabled && ambientActive;
  // Scroll-linked parallax between artwork and text — not covered by
  // useAmbientActive (that hook is for time-based loops); gated directly
  // on OS reduced-motion here instead.
  const prefersReducedMotion = useReducedMotion();
  const frameRef = useRef(null);
  const { scrollYProgress } = useScroll({ target: frameRef, offset: ["start end", "end start"] });
  const artworkParallaxY = useTransform(scrollYProgress, [0, 1], prefersReducedMotion ? [0, 0] : [-10, 10]);
  const textParallaxY = useTransform(scrollYProgress, [0, 1], prefersReducedMotion ? [0, 0] : [6, -6]);

  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (items.length < 2) return undefined;
    const id = setInterval(() => setIndex((i) => (i + 1) % items.length), ROTATE_MS);
    return () => clearInterval(id);
  }, [items.length]);

  const current = items[Math.min(index, Math.max(0, items.length - 1))];

  // The only real hide condition is an explicit admin toggle. Everything
  // else (never published, or published with zero items) falls through
  // to the empty state below instead of vanishing — see header comment.
  if (content.visible === false) return null;

  if (!current) {
    const emptyState = content.emptyState || {};
    return (
      <section data-testid="discovery-card">
        <div className="px-4 mb-2.5">
          <h2 className="font-display text-[1rem] font-bold text-ink dark:text-white">
            {content.title || "Today's Discovery"}
          </h2>
        </div>
        <div className="px-4">
          <EmptyStateCard
            Icon={Compass}
            accent={palette.accent}
            title={emptyState.title || "New discoveries coming soon"}
            subtitle={emptyState.subtitle || "Check back soon for today's word, fact, or challenge."}
            ctaLabel={emptyState.cta?.label}
            ctaHref={emptyState.cta?.href}
            artwork={emptyState.artwork}
            animateEnabled={animateEnabled}
            data-testid="discovery-card-empty"
          />
        </div>
      </section>
    );
  }

  return (
    <section data-testid="discovery-card">
      <div className="px-4 mb-2.5 flex items-baseline justify-between">
        <h2 className="font-display text-[1rem] font-bold text-ink dark:text-white">
          {content.title || "Today's Discovery"}
        </h2>
      </div>

      <div
        className="mx-4 relative overflow-hidden"
        style={{ borderRadius: radius.lg, boxShadow: elevation.soft }}
        data-testid="discovery-card-frame"
        ref={(el) => { ambientRef.current = el; frameRef.current = el; }}
      >
        {/* RC2 — dedicated artwork zone, not a full-bleed background behind
            an opaque text panel. Previously the text panel below used a
            fully OPAQUE gradient background and the card had no defined
            height of its own — since HeroArtworkLayer is absolutely
            positioned (contributes zero to layout) and the text panel was
            the only element in normal flow, the frame's rendered height was
            always exactly the text panel's height, so the artwork had zero
            visible room and never actually appeared, regardless of what an
            author uploaded in Dashboard Studio. A fixed-height zone above
            the text guarantees the artwork always has real, consistent
            space — no manual positioning required from Dashboard Studio
            authors, and text can never overlap it since they're separate
            boxes. Zone is only rendered when real artwork exists, so
            nothing fabricated fills the gap when it doesn't. */}
        {current.artwork?.url && (
          <div
            className="relative h-[120px] overflow-hidden"
            style={{ background: `linear-gradient(135deg, ${palette.accent}1F 0%, ${palette.accent}08 100%)` }}
            data-testid="discovery-card-artwork-zone"
          >
            {/* RC2.5 — ambient glow behind the artwork. */}
            {ambientOn && (
              <motion.div
                aria-hidden
                className="absolute inset-0 pointer-events-none"
                style={{ background: `radial-gradient(50% 70% at 70% 50%, ${palette.accent}26 0%, transparent 75%)` }}
                animate={{ opacity: [0.4, 1, 0.4] }}
                transition={{ duration: ambient.breathe, repeat: Infinity, ease: "easeInOut" }}
              />
            )}
            {/* RC2.5 — tiny sparkles, quiet and few. */}
            {ambientOn && (
              <>
                {[{ x: "20%", y: "22%", size: 3, delay: 0.4 }, { x: "34%", y: "62%", size: 2.5, delay: 1.6 }].map((p, i) => (
                  <motion.span
                    key={i}
                    aria-hidden
                    className="absolute rounded-full pointer-events-none"
                    style={{ left: p.x, top: p.y, width: p.size, height: p.size, background: "#fff" }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: [0, 0.9, 0] }}
                    transition={{ duration: ambient.sparkle, delay: p.delay, repeat: Infinity, ease: "easeInOut" }}
                  />
                ))}
              </>
            )}
            {/* RC2.5 — scroll parallax and the 2-3px float loop are kept
                on TWO SEPARATE nested wrappers rather than one element:
                framer-motion doesn't reliably support a `style.y` motion
                value and an `animate.y` keyframe loop targeting the same
                transform property on the same node at once. Each wrapper
                is explicitly `absolute inset-0` for the same
                containing-block reason as MissionHero's float wrapper —
                a CSS transform makes it a new containing block for
                HeroArtworkLayer's own absolutely-positioned inner layer. */}
            <motion.div className="absolute inset-0" style={{ y: artworkParallaxY }}>
              <motion.div
                className="absolute inset-0"
                animate={ambientOn ? { y: [0, -3, 0] } : undefined}
                transition={{ duration: ambient.float, repeat: Infinity, ease: "easeInOut" }}
              >
                <HeroArtworkLayer heroArtwork={current.artwork} animateEnabled={animateEnabled} />
              </motion.div>
            </motion.div>
          </div>
        )}

        {/* RC2.5 — text panel scroll parallax on its own outer wrapper
            (see note above); the inner AnimatePresence motion.div keeps
            owning entrance/exit only, so the two never fight over `y`. */}
        <motion.div style={{ y: textParallaxY }}>
        <AnimatePresence mode="wait">
          <motion.div
            key={current.id || index}
            initial={animateEnabled ? { opacity: 0, y: 10 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={animateEnabled ? { opacity: 0 } : undefined}
            transition={{ duration: duration.base, ease: easing.premiumEaseOut }}
            className="relative p-4 bg-gradient-to-b from-[#F5F1FF] via-[#FBFAFF] to-white dark:from-white/[0.06] dark:via-white/[0.04] dark:to-white/[0.02]"
          >
            <span
              className="inline-flex items-center gap-1.5 text-[0.65rem] font-bold tracking-[0.1em] uppercase mb-1.5"
              style={{ color: palette.accent }}
            >
              <motion.span
                className="inline-flex"
                animate={ambientOn ? { opacity: [0.5, 1, 0.5], scale: [0.9, 1, 0.9] } : undefined}
                transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
              >
                <Sparkles className="w-3 h-3" />
              </motion.span>
              Word of the Day
            </span>
            {current.title && (
              <h3 className="font-display font-extrabold text-[1.25rem] text-ink dark:text-white" data-testid="discovery-card-title">
                {current.title}
              </h3>
            )}
            {current.body && <p className="text-[0.85rem] text-zinc-600 dark:text-white/60 mt-1">{current.body}</p>}
            {current.cta?.label && (
              <a
                href={current.cta.href || "#"}
                className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 rounded-full text-[0.78rem] font-bold text-white active:scale-[0.97] transition-transform"
                style={{ background: palette.accent }}
                data-testid="discovery-card-cta"
              >
                {current.cta.label}
              </a>
            )}
          </motion.div>
        </AnimatePresence>
        </motion.div>

        {items.length > 1 && (
          <div className="relative flex items-center justify-center gap-1.5 pb-3" data-testid="discovery-card-dots">
            {items.map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Show discovery item ${i + 1}`}
                onClick={() => setIndex(i)}
                className={`h-1.5 rounded-full transition-[width,background-color] ${
                  i === index ? "w-4" : "w-1.5 bg-zinc-300 dark:bg-white/25"
                }`}
                style={i === index ? { background: palette.accent } : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
