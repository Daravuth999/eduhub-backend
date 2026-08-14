// SpinWheel.tsx — P0 Surgeries B + C + G + H (drop-in replacement)
//
// Behavior contract (UNCHANGED):
//   • Same props (prizes, rotation, isSpinning, isLoading, onAnimationComplete,
//     onTick, prizeImages, winningIndex)
//   • Same 3-stage spin sequence: nearMiss → overshoot → spring settle
//   • Same imperative useEffect on [rotation, isSpinning]
//   • Same loading-state slow infinite rotation
//   • Same useMotionValueEvent segment-tick (just throttled — see Surgery G)
//   • Same WinSpotlight SVG inside the rotating wheel
//
// What changed (perf-only):
//   B) The pulsing halo no longer animates `filter: blur()`. It is now a
//      static pre-blurred radial gradient with a CSS opacity+scale pulse.
//      Identical visual feel; massively cheaper on iOS Safari because the
//      Gaussian blur shader does NOT re-run every frame.
//   C) The 24 LED dots are no longer 24 Framer Motion tickers. They share
//      a single CSS @keyframes (`spwLed`) with per-dot animation-delay.
//      Spin-state speedup is via an attribute on the wheel root so it
//      doesn't depend on app-wide body attrs. ~24 main-thread tickers
//      collapse to zero.
//   G) onTick is throttled to a 120ms minimum gap (still fires per
//      segment-crossing; just rate-limited). Caps haptic/audio bridge
//      cost on long spins, plus produces a more realistic decelerating
//      tick cadence.
//   H) Component is wrapped in React.memo. Wheel body and conic-gradient
//      surface get explicit `will-change: transform` and `translateZ(0)`
//      so WebKit keeps the rotating layer composited. The outer container
//      gets `contain: layout paint` to isolate repaints from siblings.
import { memo, useEffect, useMemo, useRef } from "react";
import {
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
} from "framer-motion";
import { Sparkles } from "lucide-react";
import type { Prize } from "../lib/api";

const SEGMENT_COLORS: [string, string][] = [
  ["#FFD85C", "#F59E0B"],
  ["#13C2C2", "#0E9F9F"],
  ["#FF4081", "#D81B60"],
  ["#7C3AED", "#5B21B6"],
  ["#10B981", "#059669"],
  ["#F97316", "#C2410C"],
  ["#3B82F6", "#1D4ED8"],
  ["#EC4899", "#BE185D"],
];

interface SpinWheelProps {
  prizes: Prize[];
  rotation: number;
  isSpinning: boolean;
  isLoading: boolean;
  onAnimationComplete: () => void;
  onTick?: () => void;
  prizeImages?: Record<string, string>;
  winningIndex?: number | null;
}

// Inline keyframes block — scoped via unique class names, idempotent across mounts.
// Using a string keyed on the keyframe names so it's only injected once.
const STYLE_ID = "spw-anim-keyframes";
function ensureKeyframes() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
    @keyframes spwHalo {
      0%, 100% { opacity: 0.55; transform: scale(1); }
      50%      { opacity: 0.80; transform: scale(1.04); }
    }
    @keyframes spwHaloFast {
      0%, 100% { opacity: 0.70; transform: scale(1); }
      50%      { opacity: 1.00; transform: scale(1.08); }
    }
    @keyframes spwLed {
      0%, 100% { opacity: 0.35; }
      50%      { opacity: 1; }
    }
    @keyframes spwPtr {
      0%, 100% { transform: translateY(0); }
      50%      { transform: translateY(-3px); }
    }
    [data-spw-spinning="true"] .spw-halo { animation: spwHaloFast 1.2s ease-in-out infinite !important; }
    [data-spw-spinning="true"] .spw-led  { animation-duration: 0.4s !important; }
  `;
  document.head.appendChild(el);
}

function SpinWheelImpl({
  prizes,
  rotation,
  isSpinning,
  isLoading,
  onAnimationComplete,
  onTick,
  prizeImages,
  winningIndex,
}: SpinWheelProps) {
  const count = Math.max(prizes.length, 1);
  const segAngle = 360 / count;
  const lastSegmentRef = useRef<number>(-1);
  const motionRotation = useMotionValue(rotation);

  // Surgery G — throttle tick to 120ms minimum.
  const lastTickAtRef = useRef<number>(0);

  useEffect(() => { ensureKeyframes(); }, []);

  useMotionValueEvent(motionRotation, "change", (latest) => {
    if (!onTick) return;
    const seg = Math.floor(((latest % 360) + 360) / segAngle) % count;
    if (lastSegmentRef.current !== seg) {
      const now = performance.now();
      if (lastSegmentRef.current !== -1 && now - lastTickAtRef.current > 120) {
        onTick();
        lastTickAtRef.current = now;
      }
      lastSegmentRef.current = seg;
    }
  });

  // Imperative spin sequence — 3-stage anticipation (UNCHANGED logic).
  useEffect(() => {
    if (!isSpinning) return;
    const target = rotation;
    let cancelled = false;

    const seq = async () => {
      const nearMiss = target - segAngle * 0.55;
      const overshoot = target + segAngle * 0.18;

      await animate(motionRotation, nearMiss, {
        duration: 3.6,
        ease: [0.08, 0, 0.2, 1],
      });
      if (cancelled) return;

      await animate(motionRotation, overshoot, {
        duration: 0.85,
        ease: [0.55, 0.05, 0.45, 1],
      });
      if (cancelled) return;

      await animate(motionRotation, target, {
        type: "spring",
        stiffness: 140,
        damping: 14,
      });
      if (!cancelled) onAnimationComplete();
    };

    void seq();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotation, isSpinning]);

  // Loading state — slow infinite rotation while preparing the spin (UNCHANGED).
  useEffect(() => {
    if (!isLoading) return;
    const start = motionRotation.get();
    const ctrl = animate(motionRotation, start + 360, {
      duration: 2,
      ease: "linear",
      repeat: Infinity,
    });
    return () => ctrl.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  const conic = useMemo(() => {
    if (count === 1) return SEGMENT_COLORS[0][0];
    const stops: string[] = [];
    for (let i = 0; i < count; i++) {
      const [c] = SEGMENT_COLORS[i % SEGMENT_COLORS.length];
      const start = i * segAngle;
      const end = (i + 1) * segAngle;
      stops.push(`${c} ${start}deg ${end}deg`);
    }
    return `conic-gradient(from -${segAngle / 2}deg, ${stops.join(", ")})`;
  }, [count, segAngle]);

  // Decorative LED dots around the rim (24).
  const ledCount = 24;
  const leds = useMemo(
    () =>
      Array.from({ length: ledCount }, (_, i) => {
        const angle = (i / ledCount) * 360;
        const a = ((angle - 90) * Math.PI) / 180;
        const x = 50 + 47 * Math.cos(a);
        const y = 50 + 47 * Math.sin(a);
        return { x, y, i };
      }),
    [],
  );

  return (
    <div
      className="relative mx-auto aspect-square w-full max-w-[500px]"
      data-spw-spinning={isSpinning ? "true" : "false"}
      style={{ contain: "layout paint" } as React.CSSProperties}
    >
      {/*
        Surgery B — static pre-blurred halo with CSS opacity+scale pulse.
        No filter:blur on a moving element. Idle pulse 3s; spin pulse 1.2s
        via the [data-spw-spinning="true"] .spw-halo override.
      */}
      <div
        className="spw-halo absolute -inset-6 rounded-full pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgba(255,216,92,0.55) 0%, rgba(255,216,92,0.30) 22%, rgba(19,194,194,0.22) 45%, rgba(124,58,237,0.10) 65%, transparent 78%)",
          animation: "spwHalo 3s ease-in-out infinite",
        }}
      />

      {/* Outer dark ring with gold bezel */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background:
            "radial-gradient(circle at 30% 30%, #4a3a8a, #1A0E4D 70%, #0B0520)",
          boxShadow:
            "0 0 60px rgba(255,216,92,0.35), 0 0 0 6px rgba(255,216,92,0.18), inset 0 6px 20px rgba(0,0,0,0.7)",
        }}
      />

      {/* Surgery C — 24 LEDs as ONE CSS @keyframes (no Framer tickers) */}
      <div className="absolute inset-0 pointer-events-none">
        {leds.map((led) => (
          <div
            key={led.i}
            className="spw-led absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              left: `${led.x}%`,
              top: `${led.y}%`,
              background: led.i % 2 === 0 ? "#FFD85C" : "#13C2C2",
              boxShadow: `0 0 8px ${led.i % 2 === 0 ? "#FFD85C" : "#13C2C2"}`,
              animation: "spwLed 1.6s ease-in-out infinite",
              animationDelay: `${(led.i % 6) * 0.08}s`,
            }}
          />
        ))}
      </div>

      {/* Wheel body — Surgery H: explicit GPU layer hint */}
      <div
        className="absolute inset-[5%] rounded-full border-[6px] border-slate-900 overflow-hidden shadow-[0_0_50px_rgba(0,0,0,0.45),inset_0_0_30px_rgba(0,0,0,0.5)]"
        style={{ willChange: "transform", transform: "translateZ(0)" }}
      >
        <motion.div
          className="relative h-full w-full rounded-full"
          style={{ background: conic, rotate: motionRotation, willChange: "transform" }}
        >
          {/* Subtle radial highlight for 3D feel */}
          <div
            className="pointer-events-none absolute inset-0 rounded-full"
            style={{
              background:
                "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.32) 0%, transparent 38%), radial-gradient(circle at 70% 80%, rgba(0,0,0,0.45) 0%, transparent 55%)",
              mixBlendMode: "overlay",
            }}
          />

          {/* Segment content (image OR emoji + name) */}
          {prizes.map((prize, i) => {
            const angle = i * segAngle + segAngle / 2;
            const rad = ((angle - 90) * Math.PI) / 180;
            const r = 50 * 0.62;
            const x = 50 + r * Math.cos(rad);
            const y = 50 + r * Math.sin(rad);
            const img = prizeImages?.[prize.PrizeName.toLowerCase().trim()];
            return (
              <div
                key={`${prize.PrizeName}-${i}`}
                className="absolute flex flex-col items-center justify-center text-center"
                style={{
                  top: `${y}%`,
                  left: `${x}%`,
                  transform: `translate(-50%, -50%) rotate(${angle}deg)`,
                  width: "30%",
                }}
              >
                {img ? (
                  <div
                    className="mb-0.5 overflow-hidden rounded-full ring-2 ring-white/85"
                    style={{
                      width: "clamp(2.4rem, 7.5vmin, 3.6rem)",
                      height: "clamp(2.4rem, 7.5vmin, 3.6rem)",
                      boxShadow:
                        "0 3px 8px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,216,92,0.4)",
                    }}
                  >
                    <img
                      src={img}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  </div>
                ) : (
                  <div className="text-[clamp(1.4rem,4.2vmin,2.5rem)] drop-shadow-[0_2px_4px_rgba(0,0,0,0.6)]">
                    {prize.Emoji}
                  </div>
                )}
                <div className="text-[clamp(0.5rem,1.4vmin,0.85rem)] font-bold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)] leading-tight px-1">
                  {prize.PrizeName}
                </div>
              </div>
            );
          })}

          {/* Segment dividers — gold-tinted hairlines */}
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            {Array.from({ length: count }).map((_, i) => {
              const a = (i * segAngle - 90) * (Math.PI / 180);
              const x = 50 + 50 * Math.cos(a);
              const y = 50 + 50 * Math.sin(a);
              return (
                <line
                  key={i}
                  x1="50"
                  y1="50"
                  x2={x}
                  y2={y}
                  stroke="rgba(255,216,92,0.55)"
                  strokeWidth="0.3"
                />
              );
            })}
          </svg>

          {/* Winning-segment spotlight (UNCHANGED — renders rotated INSIDE
              the wheel so it visually sits on the won slice once settled) */}
          {!isSpinning &&
            !isLoading &&
            winningIndex !== null &&
            winningIndex !== undefined && (
              <WinSpotlight index={winningIndex} segAngle={segAngle} />
            )}
        </motion.div>
      </div>

      {/* Center hub — single Framer instance, kept (cheap). */}
      <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
        <motion.div
          animate={{ rotate: isSpinning ? 360 : 0 }}
          transition={
            isSpinning
              ? { duration: 1.5, repeat: Infinity, ease: "linear" }
              : { duration: 0 }
          }
          className="flex h-[18%] aspect-square min-h-14 min-w-14 items-center justify-center rounded-full text-[#0B0520] shadow-[0_0_25px_rgba(255,216,92,0.9)] ring-4 ring-[#0B0520]"
          style={{
            background: "linear-gradient(135deg, #FFD85C, #13C2C2)",
            willChange: "transform",
          }}
        >
          <Sparkles className="h-1/2 w-1/2" strokeWidth={2.5} />
        </motion.div>
      </div>

      {/* Pointer at 12 o'clock — Surgery F: pure CSS keyframe wobble while spinning */}
      <div className="absolute left-1/2 top-0 z-20 -translate-x-1/2">
        <div
          className="relative"
          style={{
            filter: "drop-shadow(0 0 12px rgba(255,216,92,0.95))",
            animation: isSpinning ? "spwPtr 0.15s ease-in-out infinite" : "none",
          }}
        >
          <div
            className="h-12 w-10"
            style={{
              background: "linear-gradient(180deg, #FFD85C 0%, #F59E0B 100%)",
              clipPath: "polygon(50% 100%, 0% 0%, 100% 0%)",
            }}
          />
          <div
            className="absolute left-1/2 top-1 h-3 w-3 -translate-x-1/2 rounded-full"
            style={{
              background: "#fff",
              boxShadow: "0 0 8px #fff",
            }}
          />
        </div>
      </div>
    </div>
  );
}

// Surgery H — memoize with explicit prop comparison.
export const SpinWheel = memo(SpinWheelImpl, (prev, next) => {
  return (
    prev.rotation === next.rotation &&
    prev.isSpinning === next.isSpinning &&
    prev.isLoading === next.isLoading &&
    prev.prizes === next.prizes &&
    prev.prizeImages === next.prizeImages &&
    prev.winningIndex === next.winningIndex &&
    prev.onTick === next.onTick &&
    prev.onAnimationComplete === next.onAnimationComplete
  );
});

// Highlight beam over the winning segment — sits inside the rotated wheel
// so it lines up with the prize slice the user actually won. (UNCHANGED.)
function WinSpotlight({
  index,
  segAngle,
}: {
  index: number;
  segAngle: number;
}) {
  const cx = 50;
  const cy = 50;
  const start = index * segAngle - 90 - segAngle / 2;
  const end = start + segAngle;
  const startRad = (start * Math.PI) / 180;
  const endRad = (end * Math.PI) / 180;
  const x1 = cx + 50 * Math.cos(startRad);
  const y1 = cy + 50 * Math.sin(startRad);
  const x2 = cx + 50 * Math.cos(endRad);
  const y2 = cy + 50 * Math.sin(endRad);
  const path = `M ${cx} ${cy} L ${x1} ${y1} A 50 50 0 0 1 ${x2} ${y2} Z`;

  return (
    <motion.svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 1, 0.6, 1, 0.6] }}
      transition={{ duration: 2.6, ease: "easeOut" }}
    >
      <defs>
        <radialGradient id="winGlow" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.0)" />
          <stop offset="55%" stopColor="rgba(255,255,255,0.0)" />
          <stop offset="80%" stopColor="rgba(255,216,92,0.55)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0.95)" />
        </radialGradient>
      </defs>
      <path d={path} fill="url(#winGlow)" />
      <motion.path
        d={path}
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="0.8"
        strokeLinejoin="round"
        animate={{ opacity: [0.2, 1, 0.2] }}
        transition={{ duration: 0.9, repeat: 2, ease: "easeInOut" }}
        style={{ filter: "drop-shadow(0 0 1.2px #FFD85C)" }}
      />
    </motion.svg>
  );
}
