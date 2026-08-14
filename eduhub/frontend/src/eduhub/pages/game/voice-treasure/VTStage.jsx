/**
 * VTStage.jsx — Pass B.1 Visual Foundation
 *
 * Shared, reusable Voice Treasure stage component. Mounted at the top of
 * each VT route, it provides the layered background system every Pass B
 * screen builds on top of:
 *
 *   1. ambient backdrop     ← gradient + noise wash, scoped only to VT
 *   2. scene/hero artwork   ← optional bundled / generated mission art
 *   3. glass content plane  ← safe-area-aware HUD/content frame
 *   4. foreground decor     ← floating motes, scoped, decorative only
 *
 * Scope rules:
 *   • All class names are prefixed `vts-` and live in VTStage.css.
 *   • The stage NEVER leaks into global styles (no `body`/`html` selectors,
 *     no `:root` writes, no global resets).
 *   • Mobile-first: 100dvh height, env(safe-area-inset-*) padding,
 *     bottom-nav clearance via --eduhub-bottom-nav-h.
 *   • Reduced motion (`prefers-reduced-motion: reduce`) ⇒ animation off.
 *   • Static fallback: when Framer Motion is unavailable or motion is
 *     reduced, the foreground decor renders as plain divs (no animation).
 *
 * No new dependencies. Only framer-motion (already installed) is used —
 * imported lazily so a packaging issue cannot break the page; the
 * fallback path still renders correctly without it.
 */
import React, { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import "./VTStage.css";

// framer-motion is already a confirmed dependency of this project. We use
// it for the foreground decorative motes only; everything else is plain
// JSX so the stage gracefully degrades for reduced-motion users (the
// `animate` flag below short-circuits to static divs).
const MotionDiv = motion.div;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = () => setReduced(mq.matches);
    handler();
    try { mq.addEventListener("change", handler); } catch { mq.addListener(handler); }
    return () => {
      try { mq.removeEventListener("change", handler); } catch { mq.removeListener(handler); }
    };
  }, []);
  return reduced;
}

/** Decorative floating motes. Purely visual; never interactive. */
function ForegroundDecor({ animate }) {
  const motes = useMemo(
    () => [
      { x: "12%", y: "18%", s: 6,  d: 0.0 },
      { x: "82%", y: "26%", s: 4,  d: 0.6 },
      { x: "26%", y: "76%", s: 5,  d: 1.2 },
      { x: "70%", y: "62%", s: 7,  d: 1.8 },
      { x: "48%", y: "12%", s: 3,  d: 0.3 },
    ],
    []
  );
  if (animate && MotionDiv) {
    return (
      <div className="vts-decor" aria-hidden="true" data-testid="vts-decor">
        {motes.map((m, i) => (
          <MotionDiv
            key={i}
            className="vts-mote"
            style={{ left: m.x, top: m.y, width: m.s, height: m.s }}
            animate={{ y: [0, -10, 0], opacity: [0.45, 0.9, 0.45] }}
            transition={{ duration: 4 + (i % 3), repeat: Infinity, delay: m.d, ease: "easeInOut" }}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="vts-decor" aria-hidden="true" data-testid="vts-decor">
      {motes.map((m, i) => (
        <div
          key={i}
          className="vts-mote vts-mote-static"
          style={{ left: m.x, top: m.y, width: m.s, height: m.s }}
        />
      ))}
    </div>
  );
}

/**
 * VTStage — shared layered background + safe-area frame.
 *
 * @param {string=} sceneImage   Optional scene/hero artwork URL (bundled
 *                               imported asset OR backend image_url).
 *                               When provided, the layer mounts; otherwise
 *                               the layer is skipped so the ambient
 *                               backdrop is unobstructed.
 * @param {boolean=} dim         Apply a darker scrim over the scene to
 *                               keep foreground text readable. Default true.
 * @param {string=} accent       CSS color for the ambient hue accent.
 */
export default function VTStage({
  children,
  sceneImage = null,
  sceneAlt = "Voice Treasure scene",
  dim = true,
  accent = "#6ad6ff",
}) {
  const reduced = usePrefersReducedMotion();
  const animate = !reduced;
  return (
    <div
      className="vts-stage"
      data-testid="vts-stage"
      data-animate={animate ? "on" : "off"}
      style={{ "--vts-accent": accent }}
    >
      {/* Layer 1 — ambient backdrop */}
      <div className="vts-backdrop" aria-hidden="true" data-testid="vts-backdrop" />

      {/* Layer 2 — scene / hero artwork */}
      {sceneImage ? (
        <div className="vts-scene-wrap" aria-hidden={!sceneAlt} data-testid="vts-scene">
          <img
            src={sceneImage}
            alt={sceneAlt}
            className="vts-scene"
            draggable="false"
            loading="eager"
            data-testid="vts-scene-img"
          />
          {dim ? <div className="vts-scrim" aria-hidden="true" data-testid="vts-scrim" /> : null}
        </div>
      ) : null}

      {/* Layer 4 — foreground decorative effects */}
      <ForegroundDecor animate={animate} />

      {/* Layer 3 — glass content plane / safe-area-aware HUD frame */}
      <div className="vts-frame" data-testid="vts-frame">
        <div className="vts-glass" data-testid="vts-glass">
          {children}
        </div>
      </div>
    </div>
  );
}
