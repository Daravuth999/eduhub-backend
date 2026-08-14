/**
 * AuroraBackdrop — Quiet Library reskin (Phase 1)
 *
 * Replaces the previous neon teal/coral/violet radial "aurora" wash with a
 * calm, editorial dawn-over-the-hills illustration (QuietHorizonBackdrop).
 *
 * Performance guardrail preserved: ONE static, low-cost SVG layer — no
 * animation, no will-change, no stacked blurred radials. (See v10
 * heat-surgery notes: animated blurred radials caused thermal throttling
 * on mid-range Android. Do NOT add animation or extra blurred layers.)
 *
 * The illustration draws entirely from the active theme tokens
 * (--color-surface-2 / --color-bg / --color-accent / --color-accent-warm),
 * so it adapts automatically to whichever theme the GLOBAL controller
 * resolves (Daylight or Midnight). This component owns no theme state and
 * exposes no props — same public surface as before.
 */
import { QuietHorizonBackdrop } from "../portal-art/QuietLibraryArt";

export function AuroraBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden -z-10"
    >
      {/* Top-anchored dawn horizon. Capped height keeps the art as a calm
          masthead behind the hero, fading into the page background below. */}
      <QuietHorizonBackdrop
        className="quiet-backdrop"
        style={{ position: "absolute", top: 0, left: 0, right: 0, height: 440 }}
      />
    </div>
  );
}
