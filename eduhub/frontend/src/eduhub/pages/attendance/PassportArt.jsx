/**
 * PassportArt.jsx — original, hand-authored SVG line-art for the Attendance
 * Passport (UI v2.1). NEW file. Everything here is drawn from primitives
 * (paths, circles, polylines) — there are no mascots, no characters, and no
 * reference to any copyrighted game franchise. Pure EduHub branding: a quiet
 * traveller's atlas in ink + brass on ivory.
 */
import { CheckCircle2, Clock3, CircleDashed, MinusCircle } from "lucide-react";
import { stampMeta } from "./attendancePassport";

/**
 * The Passport Cover hero scene: a winding path, distant mountains, a few
 * small route flags, and clouds. Line-art only, soft neutral depth.
 */
export function PassportScene({ className = "", style = {} }) {
  return (
    <svg
      viewBox="0 0 600 260"
      className={className}
      style={style}
      role="img"
      aria-label="An illustrated mountain trail with route flags"
      data-testid="passport-scene"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id="passSky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#20314f" />
          <stop offset="100%" stopColor="#2c4068" />
        </linearGradient>
      </defs>
      <rect width="600" height="260" fill="url(#passSky)" />
      {/* clouds */}
      <g stroke="#cdd7ea" strokeWidth="1.4" fill="none" opacity="0.5">
        <path d="M60 54 q14 -16 30 -4 q18 -10 30 6" />
        <path d="M420 40 q16 -16 32 -4 q18 -10 32 6" />
      </g>
      {/* distant mountains */}
      <g opacity="0.55">
        <polyline points="0,170 90,96 150,150 220,80 300,168" fill="none"
          stroke="#9fb0d6" strokeWidth="1.6" />
        <polyline points="280,168 360,92 430,150 500,84 600,160" fill="none"
          stroke="#8295c2" strokeWidth="1.6" />
      </g>
      {/* foreground ridge */}
      <path d="M0 210 Q150 168 300 196 T600 188 V260 H0 Z" fill="#16223b" opacity="0.85" />
      {/* the winding trail */}
      <path
        d="M40 244 C 150 214, 150 188, 250 184 S 380 176, 430 150 S 540 120, 566 96"
        fill="none" stroke="#C2992E" strokeWidth="2.4" strokeLinecap="round"
        strokeDasharray="2 9"
      />
      {/* small route flags along the trail */}
      {[
        [250, 184], [430, 150], [566, 96],
      ].map(([x, y], i) => (
        <g key={i} transform={`translate(${x} ${y})`}>
          <line x1="0" y1="0" x2="0" y2="-22" stroke="#E7DEC9" strokeWidth="1.6" />
          <path d="M0 -22 L14 -18 L0 -13 Z" fill="#C2992E" />
          <circle cx="0" cy="1" r="2.6" fill="#E7DEC9" />
        </g>
      ))}
    </svg>
  );
}

const STAMP_ICON = {
  full: CheckCircle2,
  late: Clock3,
  partial: CircleDashed,
  absent: MinusCircle,
};

/**
 * A single collectible Stamp — a perforated, postmark-style seal. The status
 * dictates the ink colour, glyph and label; `absent` reads as a faded,
 * un-earned impression so the ledger is legible at a glance.
 */
export function Stamp({ status, date, size = 92 }) {
  const m = stampMeta(status);
  const Icon = STAMP_ICON[m.key] || MinusCircle;
  const faded = m.key === "absent";
  const r = size / 2;
  // perforated dotted ring
  const dots = [];
  const dotCount = 28;
  for (let i = 0; i < dotCount; i += 1) {
    const a = (i / dotCount) * Math.PI * 2;
    dots.push(
      <circle
        key={i}
        cx={r + (r - 5) * Math.cos(a)}
        cy={r + (r - 5) * Math.sin(a)}
        r={1.1}
        fill={m.ink}
        opacity={faded ? 0.28 : 0.6}
      />,
    );
  }
  return (
    <div
      className="flex flex-col items-center gap-1.5 select-none"
      data-testid={`stamp-${m.key}`}
      title={`${m.label}${date ? ` · ${date}` : ""}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <rect
          x="4" y="4" width={size - 8} height={size - 8} rx="14"
          fill={m.paper}
          stroke={m.ink}
          strokeWidth="1.6"
          opacity={faded ? 0.55 : 1}
          transform={`rotate(${faded ? -3 : 2} ${r} ${r})`}
        />
        <g transform={`rotate(${faded ? -3 : 2} ${r} ${r})`}>{dots}</g>
      </svg>
      <div
        className="-mt-[58%] mb-[34%] flex flex-col items-center"
        style={{ color: m.ink, opacity: faded ? 0.6 : 1 }}
      >
        <Icon style={{ width: size * 0.3, height: size * 0.3 }} strokeWidth={1.8} />
        <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.16em]">
          {m.label}
        </span>
        {date && (
          <span className="mt-0.5 text-[9px] opacity-80 tracking-wide">{date}</span>
        )}
      </div>
    </div>
  );
}

/** A small route checkpoint marker for the Adventure Map. */
export function CheckpointMark({ status, n }) {
  const m = stampMeta(status);
  const reached = m.key !== "absent";
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" data-testid={`map-checkpoint-${n}`}>
      <circle cx="20" cy="20" r="13" fill={reached ? m.paper : "#efece3"}
        stroke={m.ink} strokeWidth="1.8" opacity={reached ? 1 : 0.45} />
      <circle cx="20" cy="20" r="4.5" fill={m.ink} opacity={reached ? 1 : 0.4} />
    </svg>
  );
}
