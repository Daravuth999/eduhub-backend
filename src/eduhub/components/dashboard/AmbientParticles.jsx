// AmbientParticles.jsx — RC2.9 Premium Motion System, §10.
//
// A small, reusable ambient particle field: tiny, low-opacity, slow-fading
// dots in a champagne/gold/violet palette. Used by LearningProgress's
// Champion Cup stage and the Wallet pill's sparkle system — one
// implementation, not two copies. GPU-friendly (only opacity + transform
// are animated). Purely decorative/atmospheric — never implies data.
//
// `active` is passed in by the caller (already gated through
// useAmbientActive() for on-screen/tab-visible/reduced-motion) rather than
// this component running its own IntersectionObserver — callers already
// have that context, and a shared visual atom shouldn't duplicate it.
import { useMemo } from "react";
import { motion } from "framer-motion";

const PALETTE = ["#F3D9A4", "#D4AF37", "#B79CE8"]; // champagne, gold, soft violet

export default function AmbientParticles({ active = true, count = 4, className = "" }) {
  // Randomized once per mount, not re-rolled every render — "random
  // timing" means each particle's own cadence, not a re-shuffle on
  // every re-render (which would look like a reset, not ambience).
  const particles = useMemo(
    () =>
      Array.from({ length: Math.max(3, Math.min(5, count)) }, (_, i) => ({
        id: i,
        x: 10 + Math.random() * 80,
        y: 15 + Math.random() * 70,
        size: 2 + Math.random() * 2,
        color: PALETTE[i % PALETTE.length],
        delay: Math.random() * 5,
        duration: 4.5 + Math.random() * 3,
        repeatDelay: 2 + Math.random() * 4,
      })),
    [count],
  );

  if (!active) return null;

  return (
    <div className={`absolute inset-0 pointer-events-none overflow-hidden ${className}`} aria-hidden>
      {particles.map((p) => (
        <motion.span
          key={p.id}
          className="absolute rounded-full"
          style={{ left: `${p.x}%`, top: `${p.y}%`, width: p.size, height: p.size, background: p.color }}
          initial={{ opacity: 0, y: 0 }}
          animate={{ opacity: [0, 0.55, 0], y: -18 }}
          transition={{
            duration: p.duration,
            delay: p.delay,
            repeat: Infinity,
            repeatDelay: p.repeatDelay,
            ease: "easeInOut",
          }}
        />
      ))}
    </div>
  );
}
