/**
 * LiveCoachRewardButton.jsx — Phase 1 SURPRISE REWARDS launcher.
 *
 * Renders a premium floating reward button INSIDE the active live session.
 * Visually distinct from the red "End session" button and the central
 * speaking orb. Never appears before the backend has emitted a
 * `reward_offer_available` event.
 *
 * Locked rules (Phase 1):
 *   - No reward amount preview before claim. The button shows ONLY the
 *     server-supplied label and a brief pre-claim message.
 *   - Tapping calls onClaim(offer_id). The parent debounces duplicate
 *     taps via `claiming`, never the button itself, so safe retry stays
 *     possible.
 *   - The button NEVER stops, restarts or interrupts the voice session.
 */
import { Sparkles } from "lucide-react";

export default function LiveCoachRewardButton({
  offerId,
  label = "Your surprise is ready",
  preClaimMessage = "",
  claiming = false,
  reducedMotion = false,
  onClaim,
}) {
  if (!offerId) return null;
  const motionCls = reducedMotion ? "etlc-reward-fab--no-motion" : "";
  const stateCls = claiming ? "etlc-reward-fab--claiming" : "";
  return (
    <button
      type="button"
      className={`etlc-reward-fab ${stateCls} ${motionCls}`}
      onClick={() => {
        if (claiming) return;
        try {
          onClaim && onClaim(offerId);
        } catch {
          /* parent surfaces error */
        }
      }}
      aria-label={claiming ? "Confirming your surprise" : label}
      data-testid="live-coach-reward-btn"
      data-offer-id={offerId}
    >
      <span className="etlc-reward-fab__halo" aria-hidden="true" />
      <span className="etlc-reward-fab__inner">
        <Sparkles size={16} aria-hidden="true" />
        <span className="etlc-reward-fab__label">
          {claiming ? "Confirming your surprise…" : label}
        </span>
      </span>
      {!claiming && preClaimMessage ? (
        <span
          className="etlc-reward-fab__hint"
          data-testid="live-coach-reward-hint"
        >
          {preClaimMessage}
        </span>
      ) : null}
    </button>
  );
}
