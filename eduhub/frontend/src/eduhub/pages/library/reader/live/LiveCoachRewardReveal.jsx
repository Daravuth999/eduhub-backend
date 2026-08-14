/**
 * LiveCoachRewardReveal.jsx — Phase 1 SURPRISE REWARDS confirmed reveal.
 *
 * Renders a short, premium confirmation overlay AFTER the backend persists
 * a confirmed claim. The live session continues running underneath — this
 * is a contained reveal, NOT a session restart.
 *
 * Locked rules:
 *   - Show only what the backend confirmed (`reward_summary` + `reward_type`
 *     + optional `reward_amount`). Never invent values.
 *   - One clear continue action; close returns to the live practice.
 *   - Respects reduced motion. No gambling / casino motifs.
 */
import { useEffect } from "react";
import { Sparkles, ArrowRight } from "lucide-react";

export default function LiveCoachRewardReveal({
  open,
  result,
  message = "Practice streak reward — you earned this through strong practice!",
  reducedMotion = false,
  onContinue,
}) {
  // Esc closes the reveal but does NOT end the voice session.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onContinue && onContinue();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onContinue]);

  if (!open || !result) return null;
  const motionCls = reducedMotion ? "etlc-reward-reveal--no-motion" : "";
  const summary =
    result.reward_summary ||
    (result.reward_amount ? `${result.reward_amount} EduHub Points` : "Reward");

  return (
    <div
      className={`etlc-reward-reveal ${motionCls}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="etlc-reward-reveal-title"
      data-testid="live-coach-reward-reveal"
    >
      <div className="etlc-reward-reveal__scrim" aria-hidden="true" />
      <div className="etlc-reward-reveal__card">
        <div className="etlc-reward-reveal__orb" aria-hidden="true">
          <div className="etlc-reward-reveal__ring" />
          <Sparkles size={32} />
        </div>
        <div
          id="etlc-reward-reveal-title"
          className="etlc-reward-reveal__kicker"
          data-testid="live-coach-reward-kicker"
        >
          Practice streak reward
        </div>
        <div
          className="etlc-reward-reveal__amount"
          data-testid="live-coach-reward-amount"
        >
          {summary}
        </div>
        <div
          className="etlc-reward-reveal__body"
          data-testid="live-coach-reward-message"
        >
          {message}
        </div>
        <button
          type="button"
          className="etlc-reward-reveal__continue"
          onClick={() => onContinue && onContinue()}
          data-testid="live-coach-reward-continue"
        >
          Keep practising <ArrowRight size={16} aria-hidden="true" />
        </button>
        <div className="etlc-reward-reveal__footnote">
          You earned this through strong practice. Keep your momentum going.
        </div>
      </div>
    </div>
  );
}
