/**
 * LiveCoachRewardPanel.jsx — PERSISTENT, backend-truth-driven Surprise Reward
 * panel for the active EduTalk Live Voice Coach dashboard (hotfix v1).
 *
 * Replaces the previously fully-hidden reward button with a compact panel that
 * stays visible during the active coaching session whenever Coach Rewards is
 * operational for that session. It renders ONLY what the backend reports.
 *
 * Locked rules:
 *   - Visible states: tracking (locked) → progressing (momentum) → eligible
 *     (clickable "Tap to reveal") → claiming ("Opening your surprise…") →
 *     confirmed (compact "Reward received"). disabled/unavailable hide.
 *   - The reward AMOUNT is never shown before a confirmed claim.
 *   - Non-clickable until a real server offer exists; one tap (the parent
 *     debounces via `claiming`, the backend service is idempotent).
 *   - Never stops / restarts / interrupts the voice session. The immersive
 *     confirmed reveal is owned by `LiveCoachRewardReveal` (parent); this
 *     panel only shows a calm compact confirmation.
 *   - 44px+ interactive target, accessible labels, reduced-motion aware,
 *     namespaced CSS (`.etlc-rwp-*`). No layout shift over End Session.
 */
import { Gift, Lock, Sparkles, Check, Loader2 } from "lucide-react";
import { deriveRewardPanel } from "./liveCoachRewardPanelLogic";

function PanelIcon({ icon, reducedMotion }) {
  if (icon === "gift") return <Gift size={18} aria-hidden="true" />;
  if (icon === "sparkle") return <Sparkles size={18} aria-hidden="true" />;
  if (icon === "check") return <Check size={18} aria-hidden="true" />;
  if (icon === "spinner") {
    return (
      <Loader2
        size={18}
        aria-hidden="true"
        className={reducedMotion ? "" : "etlc-rwp__spin"}
      />
    );
  }
  return <Lock size={18} aria-hidden="true" />;
}

export default function LiveCoachRewardPanel({
  status = null,
  reward = null,
  reducedMotion = false,
  showDiagnostics = false,
  onClaim,
}) {
  const view = deriveRewardPanel({ status, reward, showDiagnostics });
  if (!view.visible) return null;

  const motionCls = reducedMotion ? "etlc-rwp--no-motion" : "";
  const toneCls = `etlc-rwp--${view.tone}`;
  const clickable = !!view.clickable && !!view.offerId;

  const handleClick = () => {
    if (!clickable) return;
    try {
      onClaim && onClaim(view.offerId);
    } catch {
      /* parent surfaces error */
    }
  };

  const onKeyDown = (e) => {
    if (!clickable) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <div
      className={`etlc-rwp ${toneCls} ${motionCls}`}
      data-testid="live-coach-reward-panel"
      data-mode={view.mode}
      role={clickable ? "button" : "status"}
      aria-live="polite"
      aria-label={view.ariaLabel}
      aria-disabled={clickable ? undefined : true}
      tabIndex={clickable ? 0 : -1}
      onClick={clickable ? handleClick : undefined}
      onKeyDown={clickable ? onKeyDown : undefined}
    >
      {view.tone === "eligible" && !reducedMotion ? (
        <span className="etlc-rwp__halo" aria-hidden="true" />
      ) : null}
      <span className="etlc-rwp__icon" aria-hidden="true">
        <PanelIcon icon={view.icon} reducedMotion={reducedMotion} />
      </span>
      <span className="etlc-rwp__body">
        <span className="etlc-rwp__title" data-testid="live-coach-reward-panel-title">
          {view.title}
        </span>
        {view.subtitle ? (
          <span
            className="etlc-rwp__subtitle"
            data-testid="live-coach-reward-panel-subtitle"
          >
            {view.subtitle}
          </span>
        ) : null}
      </span>
      {clickable ? (
        <span
          className="etlc-rwp__cta"
          data-testid="live-coach-reward-panel-claim"
          aria-hidden="true"
        >
          Reveal
        </span>
      ) : null}
    </div>
  );
}
