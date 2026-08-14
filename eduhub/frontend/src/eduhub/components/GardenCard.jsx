import React from "react";

/**
 * GardenCard — premium SVG "sticker" card primitive.
 *
 * Renders an organic blob shape with subtle gradient + sticker-shadow
 * that adapts to light/dark via the [data-theme] CSS variables. Used
 * as a background for big dashboard CTAs (Spin, Library, Portal,
 * Assistant). All text/content is layered above as plain CSS — keeps
 * crisp text rendering and zero raster cost.
 *
 * Variants tuned for the EduHub palette: emerald/teal/coral/amber.
 *  - "teal"    (default — primary actions)
 *  - "coral"   (rewards / spin)
 *  - "amber"   (library)
 *  - "emerald" (assistant / AI)
 *
 * Heat-cost: ~0. One <svg> per card; no animation by default. A gentle
 * 200ms transform-only hover lift is applied on fine-pointer devices.
 */
const PALETTES = {
  teal:    { from: "rgb(var(--bgfx-accent))",       to: "rgb(var(--bgfx-accent) / 0.55)" },
  coral:   { from: "rgb(var(--bgfx-accent-warm))",  to: "rgb(var(--bgfx-accent-warm) / 0.55)" },
  amber:   { from: "#F2B25C",                        to: "#E36B5C" },
  emerald: { from: "#3DDC97",                        to: "#0E8E7A" },
};

const SHAPES = [
  // Organic blob path (viewBox 0 0 200 140)
  "M30 20 C 6 30 -2 70 12 96 C 24 120 60 134 110 130 C 158 126 198 102 196 70 C 194 38 170 14 130 10 C 86 6 50 12 30 20 Z",
  // Cloud-like shape
  "M40 20 C 10 24 4 60 16 88 C 28 116 70 132 116 126 C 162 120 196 96 198 66 C 200 36 168 14 124 14 C 80 14 60 16 40 20 Z",
];

export function GardenCard({
  children,
  variant = "teal",
  shape = 0,
  className = "",
  onClick,
  testId,
  as: Tag = "div",
  ...rest
}) {
  const palette = PALETTES[variant] || PALETTES.teal;
  const path = SHAPES[shape % SHAPES.length];
  const interactive = !!onClick;
  const id = `gc-${variant}-${shape}`;

  return (
    <Tag
      onClick={onClick}
      data-testid={testId}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      className={[
        "relative isolate select-none transition-transform duration-200",
        interactive ? "cursor-pointer hover:-translate-y-0.5 active:translate-y-0" : "",
        className,
      ].join(" ")}
      {...rest}
    >
      <svg
        viewBox="0 0 200 140"
        preserveAspectRatio="none"
        className="absolute inset-0 -z-10 h-full w-full"
        aria-hidden
      >
        <defs>
          <linearGradient id={id} x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%"  stopColor={palette.from} />
            <stop offset="100%" stopColor={palette.to} />
          </linearGradient>
          <filter id={`${id}-shadow`} x="-10%" y="-10%" width="120%" height="130%">
            <feDropShadow dx="0" dy="4" stdDeviation="4" floodOpacity="0.18" />
          </filter>
        </defs>
        <path d={path} fill={`url(#${id})`} filter={`url(#${id}-shadow)`} />
        {/* glossy highlight */}
        <path
          d="M30 20 C 30 20 90 6 130 10 C 158 12 178 22 188 36"
          stroke="rgb(255 255 255 / 0.4)"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      <div className="relative z-10">{children}</div>
    </Tag>
  );
}

export default GardenCard;
