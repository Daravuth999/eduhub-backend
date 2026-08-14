import { useId } from "react";
import { useReducedMotion } from "../../hooks/useReducedMotion";

export type RingTone =
  | "violet"
  | "teal"
  | "coral"
  | "excellent"
  | "good"
  | "needs";

interface Props {
  /** Current value (same unit as max). */
  value: number;
  /** Maximum value the ring represents. Defaults to 10. */
  max?: number;
  /** Diameter in px. */
  size?: number;
  /** Stroke width in px. */
  stroke?: number;
  /** Gradient family for the progress arc. */
  tone?: RingTone;
  /** Large centre content (e.g. the score number). Falls back to value. */
  centerLabel?: React.ReactNode;
  /** Small caption under the centre label. */
  caption?: string;
  className?: string;
  "data-testid"?: string;
}

const TONE_STOPS: Record<RingTone, [string, string]> = {
  violet: ["#9b5cff", "#ff3da6"],
  teal: ["#2fd4bd", "#1f9e8c"],
  coral: ["#ffb079", "#ff7a50"],
  excellent: ["#4ed1a6", "#2fa37a"],
  good: ["#ffd166", "#f2b73b"],
  needs: ["#ff8a88", "#e35d5b"],
};

/**
 * ScoreRing -- a lightweight circular progress ring built on SVG.
 *
 * Presentational only. Honours prefers-reduced-motion (the arc snaps to
 * its value instead of transitioning). Uses explicit hex stops that
 * mirror the Aurora gradient tokens so the SVG gradient renders reliably
 * across browsers.
 */
export function ScoreRing({
  value,
  max = 10,
  size = 116,
  stroke = 11,
  tone = "violet",
  centerLabel,
  caption,
  className,
  "data-testid": testId,
}: Props) {
  const reduced = useReducedMotion();
  const gid = useId().replace(/:/g, "");
  const radius = (size - stroke) / 2;
  const circ = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  const dashOffset = circ * (1 - pct);
  const [from, to] = TONE_STOPS[tone];

  return (
    <div
      className={className}
      style={{ width: size, height: size, position: "relative" }}
      data-testid={testId}
      data-ring-tone={tone}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <defs>
          <linearGradient id={`ring-${gid}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={from} />
            <stop offset="100%" stopColor={to} />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-line)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={`url(#ring-${gid})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{
            transition: reduced
              ? undefined
              : "stroke-dashoffset 900ms var(--ease-out, cubic-bezier(.2,.7,.2,1))",
          }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-2">
        <div className="display text-2xl font-bold tnum leading-none text-[color:var(--color-ink)]">
          {centerLabel ?? value}
        </div>
        {caption ? (
          <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[color:var(--color-ink-mute)]">
            {caption}
          </div>
        ) : null}
      </div>
    </div>
  );
}
