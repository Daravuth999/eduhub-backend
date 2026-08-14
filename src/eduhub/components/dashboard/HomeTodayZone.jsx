/**
 * HomeTodayZone.jsx — Dashboard Foundation Phase 1.
 *
 * Wraps the Home Today section sequence (Hero, Promotion, Announcement,
 * Activity, Top Earner) in ONE shared ambient canvas + spacing rhythm,
 * so scrolling through them reads as one continuous surface instead of
 * independent cards dropped on a plain white page.
 *
 * Deliberately a thin PRESENTATIONAL wrapper only:
 *   - owns background + inter-section spacing.
 *   - owns NO data fetching, NO business logic, NO change to any child's
 *     own render output. Every child keeps its existing hook
 *     (useTopEarners, useNotifications, useEduHubConfig, ...) untouched.
 *
 * Background — one static CSS gradient, GPU-cheap (no blur, no scroll
 * listener, no JS height measurement): a `position:relative` container
 * with an `inset:0` absolutely-positioned child naturally stretches to
 * the parent's real content height with zero measurement code. Built
 * from the SAME --bgfx-1/2/3 custom properties BackgroundFx.jsx already
 * defines per theme (index.css), using the SAME "rgba overlay on top of
 * the neutral base" technique BackgroundFx's own .bgfx-base already uses
 * in index.css — not color-mix(), which isn't supported on the older
 * Safari/iOS versions this PWA has needed to account for elsewhere this
 * session, and isn't the pattern already established in this codebase.
 * An emerald-tinted top settles into the existing neutral canvas by the
 * bottom — one additional layer, not a second background system.
 *
 * Spacing rhythm — deliberately does NOT touch the "primary" gaps between
 * ordinary adjacent children (Hero/Promotion/Announcement/Activity already
 * carry their own reasonable margins — re-deriving every one of those from
 * the wrapper would mean editing each child's own file and risks doubling
 * up with its existing margin). The one rhythm change that actually
 * matters here: a deliberate `sectionRhythm.pause` breathing gap ADDED
 * before the LAST child (Top Earner — the "Achievement Zone" beat), so it
 * reads as the start of a new content group rather than just another card
 * in the same undifferentiated stack. Per designTokens.js's named rhythm
 * tokens.
 */
import { sectionRhythm } from "../../styles/tokens/designTokens";

// Emerald tint overlay + the existing neutral --bgfx-1/2/3 base, stacked as
// two comma-separated layers in ONE `background` shorthand — exactly the
// multi-layer-gradient technique .bgfx-base already uses in index.css, just
// with the tint concentrated at the top and fading out by 55% down the
// zone, so it reads as "emerald light source at the top, settling into the
// existing canvas" rather than a uniform wash.
export const ZONE_BACKGROUND_CSS =
  "radial-gradient(120% 60% at 50% 0%, rgba(19,75,52,0.16) 0%, rgba(19,75,52,0.05) 45%, transparent 70%)," +
  "linear-gradient(180deg, var(--bgfx-1) 0%, var(--bgfx-2) 55%, var(--bgfx-3) 100%)";

const zoneBackgroundStyle = {
  position: "absolute",
  inset: 0,
  zIndex: 0,
  pointerEvents: "none",
  background: ZONE_BACKGROUND_CSS,
};

export default function HomeTodayZone({ children }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : [children].filter(Boolean);

  return (
    <div className="relative" data-testid="home-today-zone">
      <div aria-hidden data-testid="home-today-zone-bg" style={zoneBackgroundStyle} />
      <div className="relative" style={{ zIndex: 1 }}>
        {items.map((child, i) => {
          const isLast = i === items.length - 1 && items.length > 1;
          return (
            <div
              key={child.key ?? i}
              data-testid={isLast ? "home-today-zone-pause" : undefined}
              style={isLast ? { marginTop: `${sectionRhythm.pause}rem` } : undefined}
            >
              {child}
            </div>
          );
        })}
      </div>
    </div>
  );
}
