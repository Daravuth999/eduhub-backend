// DYOrbitLogo.jsx — DY brand mark surrounded by orbiting "learning"
// particles (books, AI spark, voice wave dots, points stars). Used:
//   • subtly above the credential card (idle "breathing" mode)
//   • centered inside DYSigningOverlay (active orbit during signin)
//
// Implementation notes
// --------------------
// • Pure CSS keyframe rotations on three concentric orbit rings keep
//   the animation cheap (no per-frame React reconciliation), while
//   Framer Motion only animates the soft glow + the center logo.
// • Respects `prefers-reduced-motion`: the orbit rings freeze and
//   only a slow opacity breathe stays on the center logo.
// • No new dependencies. Particles use inline SVG strokes; no icon
//   font, no external image, no Lottie. Lightweight on first paint.
import { motion, useReducedMotion } from "framer-motion";
import DYLogo from "./DYLogo";

/**
 * Props:
 *   size:    number  total square size of the orbit field (default 168)
 *   active:  boolean true while signing-in; speeds particles + brighter
 *   palette: "light" | "dark"   choose particle/glow contrast (default "light")
 *   testID:  string  data-testid root (default "dy-orbit-logo")
 */
export default function DYOrbitLogo({
  size = 168,
  active = false,
  palette = "light",
  testID = "dy-orbit-logo",
}) {
  const reduce = useReducedMotion();

  // Logo sits in the center, ~52% of total field
  const logoSize = Math.round(size * 0.52);

  // Three orbit rings — radii relative to the total field.
  // We render the rings as absolutely-positioned squares that rotate
  // around their own center; particles sit on the ring edge.
  const rings = [
    {
      key: "inner",
      ringSize: Math.round(size * 0.74),
      duration: 14,
      direction: 1,
      particles: ["book", "spark", "dot", "star"],
    },
    {
      key: "middle",
      ringSize: Math.round(size * 0.9),
      duration: 22,
      direction: -1,
      particles: ["wave", "dot", "spark", "dot", "book", "dot"],
    },
    {
      key: "outer",
      ringSize: size,
      duration: 32,
      direction: 1,
      particles: ["dot", "star", "dot", "spark", "dot", "wave", "dot", "star"],
    },
  ];

  const accent = palette === "light" ? "#0B1B36" : "#F8FAFF";
  const gold = "#D4A843";
  const blue = "#1A56DB";

  return (
    <div
      data-testid={testID}
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {/* Soft radial glow behind the logo — animated subtly */}
      <motion.span
        className="absolute inset-0 rounded-full pointer-events-none"
        style={{
          background:
            palette === "light"
              ? "radial-gradient(circle at 50% 50%, rgba(212,168,67,0.18) 0%, rgba(26,86,219,0.08) 38%, transparent 70%)"
              : "radial-gradient(circle at 50% 50%, rgba(212,168,67,0.28) 0%, rgba(26,86,219,0.14) 40%, transparent 70%)",
          filter: "blur(6px)",
        }}
        animate={
          reduce
            ? { opacity: 0.55 }
            : { opacity: active ? [0.55, 0.85, 0.55] : [0.4, 0.6, 0.4] }
        }
        transition={{
          duration: active ? 2.4 : 4.2,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />

      {/* Orbit rings */}
      {rings.map((ring) => (
        <div
          key={ring.key}
          className="dy-orbit-ring"
          data-active={active ? "1" : "0"}
          data-reduce={reduce ? "1" : "0"}
          style={{
            width: ring.ringSize,
            height: ring.ringSize,
            // Slow down a touch when idle, speed up when active.
            animationDuration: `${
              reduce ? 0 : active ? ring.duration * 0.65 : ring.duration
            }s`,
            animationDirection:
              ring.direction === 1 ? "normal" : "reverse",
          }}
        >
          {ring.particles.map((kind, i) => {
            const angle = (i / ring.particles.length) * 360;
            return (
              <span
                key={i}
                className="dy-orbit-particle"
                style={{
                  transform: `rotate(${angle}deg) translateY(-${
                    ring.ringSize / 2
                  }px) rotate(${-angle}deg)`,
                }}
              >
                <Particle kind={kind} accent={accent} gold={gold} blue={blue} />
              </span>
            );
          })}
        </div>
      ))}

      {/* Center logo with subtle breathing */}
      <motion.div
        className="relative z-10"
        animate={
          reduce
            ? { scale: 1, opacity: 1 }
            : { scale: active ? [1, 1.02, 1] : [1, 1.015, 1] }
        }
        transition={{
          duration: active ? 1.8 : 3.6,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      >
        <DYLogo size={logoSize} testID={`${testID}-mark`} />
      </motion.div>
    </div>
  );
}

/**
 * Particle — a tiny inline SVG glyph used as an orbital point.
 * kind: "book" | "spark" | "wave" | "star" | "dot"
 */
function Particle({ kind, accent, gold, blue }) {
  switch (kind) {
    case "book":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path
            d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 1 4 17.5v-12Z"
            fill={blue}
            opacity="0.92"
          />
          <path
            d="M13 4h5.5A1.5 1.5 0 0 1 20 5.5v12a1.5 1.5 0 0 1-1.5 1.5H13V4Z"
            fill={accent}
            opacity="0.88"
          />
        </svg>
      );
    case "spark":
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 2.5l1.7 5.6 5.6 1.7-5.6 1.7-1.7 5.6-1.7-5.6-5.6-1.7 5.6-1.7L12 2.5Z"
            fill={gold}
          />
        </svg>
      );
    case "wave":
      return (
        <svg width="18" height="10" viewBox="0 0 24 10" fill="none">
          <rect x="0"  y="3" width="2" height="4"  rx="1" fill={blue} />
          <rect x="4"  y="1" width="2" height="8"  rx="1" fill={blue} />
          <rect x="8"  y="2" width="2" height="6"  rx="1" fill={accent} />
          <rect x="12" y="0" width="2" height="10" rx="1" fill={accent} />
          <rect x="16" y="2" width="2" height="6"  rx="1" fill={blue} />
          <rect x="20" y="3" width="2" height="4"  rx="1" fill={blue} />
        </svg>
      );
    case "star":
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 2l2.6 6.2 6.7.6-5 4.5 1.5 6.6L12 16.6 6.2 19.9l1.5-6.6-5-4.5 6.7-.6L12 2Z"
            fill={gold}
            stroke={accent}
            strokeWidth="0.6"
            opacity="0.95"
          />
        </svg>
      );
    case "dot":
    default:
      return (
        <span
          style={{
            display: "block",
            width: 6,
            height: 6,
            borderRadius: 9999,
            background: accent,
            opacity: 0.55,
            boxShadow: `0 0 0 2px rgba(212,168,67,0.18)`,
          }}
        />
      );
  }
}
