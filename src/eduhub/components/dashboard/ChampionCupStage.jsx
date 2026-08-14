// ChampionCupStage.jsx — RC2.9 Premium Motion System, §6-10.
//
// The Champion Cup presentation stage, shared verbatim between the
// Learning Progress card (compact) and its modal (large) — one
// implementation, not two. Uses the supplied "Champion Cup" artwork
// exactly as provided (src/assets/dashboard/champion-cup.png) — never
// redrawn, replaced, or regenerated.
//
// Motion discipline per spec: the trophy image itself never animates
// continuously — only the surrounding atmosphere does (drifting ambient
// clouds, an occasional slow reflective sweep, a handful of tiny
// particles). Everything continuous is gated by useAmbientActive()
// (off-screen / hidden-tab / reduced-motion all pause it).
import { motion } from "framer-motion";
import { ambient } from "../../styles/tokens/motionTokens";
import useAmbientActive from "../../hooks/useAmbientActive";
import championCupSrc from "../../../assets/dashboard/champion-cup.png";

const PARTICLE_PALETTE = ["#F3D9A4", "#B79CE8", "#D4AF37"];

// RC3.2 §2 — module-level constants (not recreated per render): 8 orbital
// + 6 upward-drifting particles, 14 total (within the 12-18 target).
// Radius/size/duration/phase all vary so nothing reads as synchronized.
const ORBIT_PARTICLES = Array.from({ length: 8 }, (_, i) => ({
  radius: 22 + ((i * 7) % 20),
  size: 2 + (i % 3) * 0.5,
  color: PARTICLE_PALETTE[i % PARTICLE_PALETTE.length],
  duration: 22 + i * 2,
  phase: (360 / 8) * i,
}));
const DRIFT_PARTICLES = Array.from({ length: 6 }, (_, i) => ({
  x: 12 + i * 14,
  size: 2 + (i % 2),
  color: PARTICLE_PALETTE[(i + 1) % PARTICLE_PALETTE.length],
  rise: 26 + (i % 3) * 6,
  duration: 5 + (i % 3),
  delay: i * 1.1,
}));

export default function ChampionCupStage({ size = "card" }) {
  const { ref: ambientRef, active: ambientActive } = useAmbientActive();
  const isModal = size === "modal";
  // RC3 §3/§4 — both heights reduced (card: h-36->h-28, modal: h-56->h-40):
  // the taller stage read as excess empty space above/around the trophy
  // on mobile, per direct feedback ("trophy feels disconnected," "large
  // empty areas waste valuable screen space").
  const stageHeight = isModal ? "h-40" : "h-28";
  // RC3.2 §5 — card trophy slightly enlarged (w-20 -> w-24) so it reads as
  // the section's centerpiece rather than a small icon on a mostly-empty
  // stage.
  const cupWidth = isModal ? "w-32" : "w-24";

  return (
    <div
      ref={ambientRef}
      className={`relative ${stageHeight} overflow-hidden`}
      style={{
        borderRadius: 20,
        background: "radial-gradient(120% 100% at 50% 100%, #FFFFFF 0%, #FBF9FF 55%, #F6F2FB 100%)",
      }}
      data-testid="champion-cup-stage"
    >
      {/* RC3.2 §2 — the atmosphere was reported as "almost invisible." Two
          concrete strengthenings, both still purely environmental (the
          trophy image itself never animates):
            1. the champagne glow is now sized and centered on the
               trophy itself (~2-3x its width) instead of being a small
               generic upper-left wash;
            2. a slow 11s background "breathe" (brighten/dim) layers on
               top of the existing independent cloud drift, so the whole
               stage visibly pulses with light even when the clouds
               themselves are mid-drift. */}
      {ambientActive && (
        <motion.div
          aria-hidden
          className="absolute inset-0"
          style={{ background: `radial-gradient(65% 65% at 50% 55%, rgba(244,208,138,0.55) 0%, transparent 72%)` }}
          animate={{ opacity: [0.7, 1, 0.7] }}
          transition={{ duration: 11, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      {/* Secondary lavender bloom — layered, spans across the card. */}
      {ambientActive && (
        <motion.div
          aria-hidden
          className="absolute inset-0"
          style={{ background: "radial-gradient(90% 70% at 60% 30%, rgba(167,139,250,0.32) 0%, transparent 78%)" }}
          animate={{ opacity: [0.6, 1, 0.6] }}
          transition={{ duration: 12, repeat: Infinity, ease: "easeInOut", delay: 1.5 }}
        />
      )}

      {/* Atmosphere — two independently-drifting, heavily-blurred clouds
          (their own slow position drift, on TOP of the breathing above).
          18-30s loops, never in sync with each other. */}
      {ambientActive && (
        <>
          <motion.div
            aria-hidden
            className="absolute w-28 h-28 rounded-full"
            style={{ left: "10%", top: "20%", background: "#B79CE8", filter: "blur(28px)" }}
            animate={{ x: [0, 14, -6, 0], y: [0, -8, 6, 0], opacity: [0.1, 0.15, 0.1] }}
            transition={{ duration: 24, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.div
            aria-hidden
            className="absolute w-32 h-32 rounded-full"
            style={{ right: "8%", top: "10%", background: "#F3D9A4", filter: "blur(32px)" }}
            animate={{ x: [0, -10, 8, 0], y: [0, 10, -6, 0], opacity: [0.1, 0.14, 0.1] }}
            transition={{ duration: 29, repeat: Infinity, ease: "easeInOut" }}
          />
        </>
      )}

      {/* Soft elliptical light beneath the base + an extremely subtle base
          shadow — the trophy reads as resting on the stage, not floating. */}
      <div
        aria-hidden
        className="absolute left-1/2 bottom-[14%] -translate-x-1/2 w-24 h-4 rounded-full"
        style={{ background: "radial-gradient(closest-side, rgba(244,208,138,0.45) 0%, transparent 80%)" }}
      />
      <div
        aria-hidden
        className="absolute left-1/2 bottom-[15%] -translate-x-1/2 w-16 h-2 rounded-full bg-black/[0.06] dark:bg-black/20"
        style={{ filter: "blur(3px)" }}
      />

      {/* The trophy itself — static; one entrance fade, never a loop.
          RC3 §3 — pb-3 -> pb-1.5, tighter now that the stage itself is
          shorter, so the trophy sits integrated rather than adrift in
          extra vertical space. */}
      <div className="relative w-full h-full flex items-center justify-center pb-1.5">
        <div className={`relative ${cupWidth}`}>
          {/* RC3 §5 — soft glow breathing directly behind the trophy,
              distinct from the two stage-wide atmosphere clouds above
              (this one is trophy-anchored, warm, and tighter). */}
          {ambientActive && (
            <motion.div
              aria-hidden
              className="absolute inset-0 pointer-events-none"
              style={{
                background: "radial-gradient(60% 60% at 50% 55%, rgba(244,208,138,0.5) 0%, transparent 75%)",
                filter: "blur(10px)",
              }}
              animate={{ opacity: [0.4, 0.85, 0.4], scale: [0.92, 1.05, 0.92] }}
              transition={{ duration: ambient.breathe, repeat: Infinity, ease: "easeInOut" }}
            />
          )}

          {/* RC3.2 §2 — expanded from 3 to 14 particles (12-18 target),
              two distinct behaviors mixed together per spec ("orbit" +
              "drift upward, slowly fade, reappear naturally"), varied
              size/speed/color/phase so nothing reads as synchronized.
              Still elegant/slow — no game-style spin, no glitter burst. */}
          {ambientActive && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none" aria-hidden>
              {ORBIT_PARTICLES.map((o, i) => (
                <motion.div
                  key={`orbit-${i}`}
                  className="absolute w-0 h-0"
                  animate={{ rotate: [o.phase, o.phase + 360] }}
                  transition={{ duration: o.duration, repeat: Infinity, ease: "linear" }}
                >
                  <motion.span
                    className="absolute rounded-full"
                    style={{ left: o.radius, top: -o.size / 2, width: o.size, height: o.size, background: o.color }}
                    animate={{ opacity: [0.12, 0.55, 0.12] }}
                    transition={{ duration: 4 + (i % 4), repeat: Infinity, ease: "easeInOut" }}
                  />
                </motion.div>
              ))}
              {DRIFT_PARTICLES.map((p, i) => (
                <motion.span
                  key={`drift-${i}`}
                  className="absolute rounded-full"
                  style={{ left: `${p.x}%`, bottom: "12%", width: p.size, height: p.size, background: p.color }}
                  initial={{ opacity: 0, y: 0 }}
                  animate={{ opacity: [0, 0.5, 0], y: -p.rise }}
                  transition={{ duration: p.duration, delay: p.delay, repeat: Infinity, ease: "easeOut" }}
                />
              ))}
            </div>
          )}

          <motion.img
            src={championCupSrc}
            alt="Champion Cup"
            className="relative w-full h-auto select-none"
            draggable={false}
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          />
          {/* Premium reflection sweep — a soft metallic highlight passing
              over the trophy every ~20s, masked to the image's own bounds
              via the wrapping `overflow-hidden` + `mix-blend-mode`. */}
          {ambientActive && (
            <motion.div
              aria-hidden
              className="absolute inset-0 pointer-events-none"
              style={{
                background: "linear-gradient(105deg, transparent 35%, rgba(255,247,220,0.65) 50%, transparent 65%)",
                mixBlendMode: "overlay",
              }}
              initial={{ x: "-140%" }}
              animate={{ x: ["-140%", "140%"] }}
              transition={{ duration: 2.2, ease: "easeInOut", repeat: Infinity, repeatDelay: ambient.sweep + 6 }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
