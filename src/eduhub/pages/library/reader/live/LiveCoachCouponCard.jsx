/**
 * LiveCoachCouponCard.jsx — student-facing "Live Voice Coach Coupon" code
 * entry. Rendered inside LiveCoachStartCard's couponSlot (between the
 * session summary/balance row and the Start button), so it never appears
 * below the button. This component owns no mic/AudioContext/WebSocket
 * state and never touches the session-start flow: an empty or invalid
 * code can never block "Start for N points". Hidden entirely while the
 * backend flag (`config.couponRedemptionEnabled`) is off.
 *
 * State machine: idle → validating → (valid | invalid | expired |
 * unavailable | already_used) → redeeming → (success | network_error).
 * A network error preserves the entered code so the student can retry
 * without retyping it.
 *
 * Reason→copy mapping mirrors the backend's safe reason enum exactly
 * (edutalk_coupon_tools.py's _FRIENDLY_MESSAGES) — every reason has its
 * OWN specific, safe message (no internal ids, no DB details, no secrets)
 * except not_found, which stays deliberately generic so a code that
 * exists for a different purpose is never distinguishable from one that
 * doesn't exist at all.
 */
import { useEffect, useRef, useState } from "react";
import { Gift, Loader2, Sparkles } from "lucide-react";
import { validateLiveCoachCoupon, redeemLiveCoachCoupon } from "../../../../lib/edutalkLiveApi";

const FRIENDLY_STATE_MESSAGE = {
  not_found: "This code could not be used. Please check it and try again.",
  wrong_benefit_type: "This code is not a Live Voice Coach Coupon.",
  invalid_benefit_amount: "This code is not configured correctly. Please contact your teacher.",
  disabled: "This code is not currently active.",
  not_yet_active: "This code is not active yet.",
  expired: "This code has expired.",
  global_limit_reached: "This code has already reached its usage limit.",
  not_assigned: "This code is not assigned to this account.",
  credit_failed: "Your code was accepted, but the points could not be applied yet. Please try again.",
  empty: "Enter a coupon code.",
};

// Reasons that map to the "unavailable" (rejection) phase — everything
// else not_found/wrong_benefit_type/invalid_benefit_amount/not_yet_active/
// not_assigned falls into the generic "invalid" phase (different message,
// same neutral styling).
const UNAVAILABLE_REASONS = new Set(["disabled", "global_limit_reached"]);

export default function LiveCoachCouponCard({ enabled, onRedeemed }) {
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState("idle"); // idle|validating|valid|already_used|invalid|expired|unavailable|redeeming|success|network_error
  const [benefitAmount, setBenefitAmount] = useState(null);
  const [message, setMessage] = useState("");
  const abortRef = useRef(null);

  useEffect(() => () => {
    if (abortRef.current) abortRef.current.aborted = true;
  }, []);

  if (!enabled) return null;

  const resetToIdle = () => {
    setPhase("idle");
    setBenefitAmount(null);
    setMessage("");
  };

  const handleCodeChange = (e) => {
    setCode(e.target.value.toUpperCase());
    if (phase !== "idle" && phase !== "validating") resetToIdle();
  };

  // Maps a rejected/failed backend reason to the UI's (broad, style-only)
  // phase bucket. The displayed TEXT always comes from FRIENDLY_STATE_MESSAGE
  // (or the backend's own resp.message) and is reason-specific — this
  // bucket only controls visual treatment + data-testid grouping.
  const phaseForReason = (state) => {
    if (state === "expired") return "expired";
    if (UNAVAILABLE_REASONS.has(state)) return "unavailable";
    return "invalid";
  };

  const handleValidate = async () => {
    const trimmed = code.trim();
    if (!trimmed) {
      setPhase("invalid");
      setMessage(FRIENDLY_STATE_MESSAGE.empty);
      return;
    }
    const token = {};
    abortRef.current = token;
    setPhase("validating");
    setMessage("");
    try {
      const resp = await validateLiveCoachCoupon(trimmed);
      if (token.aborted) return;
      if (!resp || resp.ok !== true) {
        const state = (resp && resp.state) || "not_found";
        setPhase(phaseForReason(state));
        setMessage((resp && resp.message) || FRIENDLY_STATE_MESSAGE[state] || FRIENDLY_STATE_MESSAGE.not_found);
        return;
      }
      if (resp.state === "already_redeemed") {
        setPhase("already_used");
        setBenefitAmount(resp.benefit_amount ?? null);
        setMessage("You've already redeemed this code.");
        return;
      }
      // "valid" or "pending_retry" both mean: safe to show the redeem step.
      setBenefitAmount(resp.benefit_amount ?? null);
      setPhase("valid");
    } catch (e) {
      if (token.aborted) return;
      setPhase("network_error");
      setMessage(e && e.message ? e.message : "Network error. Please try again.");
    }
  };

  const handleRedeem = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    const token = {};
    abortRef.current = token;
    setPhase("redeeming");
    setMessage("");
    try {
      const resp = await redeemLiveCoachCoupon(trimmed);
      if (token.aborted) return;
      if (!resp || resp.ok !== true) {
        const state = (resp && resp.state) || "not_found";
        if (state === "credit_failed") {
          setPhase("network_error");
          setMessage((resp && resp.message) || FRIENDLY_STATE_MESSAGE.credit_failed);
          return;
        }
        setPhase(phaseForReason(state));
        setMessage((resp && resp.message) || FRIENDLY_STATE_MESSAGE[state] || FRIENDLY_STATE_MESSAGE.not_found);
        return;
      }
      setBenefitAmount(resp.benefit_amount ?? benefitAmount);
      setPhase("success");
      if (typeof onRedeemed === "function") onRedeemed(resp.benefit_amount);
    } catch (e) {
      if (token.aborted) return;
      setPhase("network_error");
      setMessage(e && e.message ? e.message : "Network error. Please try again.");
    }
  };

  const isBusy = phase === "validating" || phase === "redeeming";

  return (
    <div className="etlc-coupon-card" data-testid="live-coupon-card">
      <div className="etlc-coupon-card__label">
        <Gift size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
        Live Voice Coach Coupon
      </div>

      {phase === "success" ? (
        <div className="etlc-coupon-card__success" data-testid="live-coupon-success">
          <Sparkles size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          {benefitAmount != null ? `${benefitAmount} points added to your balance!` : "Points added to your balance!"}
        </div>
      ) : (
        <>
          <div className="etlc-coupon-card__row">
            <input
              type="text"
              value={code}
              onChange={handleCodeChange}
              placeholder="Enter coupon code"
              disabled={isBusy}
              data-testid="live-coupon-input"
              className="etlc-coupon-card__input"
            />
            {phase === "valid" ? (
              <button
                type="button"
                onClick={handleRedeem}
                disabled={isBusy}
                data-testid="live-coupon-redeem-btn"
                className="etlc-coupon-card__btn"
              >
                {phase === "redeeming" ? <Loader2 size={14} className="etlc-spin" /> : "Redeem"}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleValidate}
                disabled={isBusy || !code.trim()}
                data-testid="live-coupon-check-btn"
                className="etlc-coupon-card__btn"
              >
                {phase === "validating" ? <Loader2 size={14} className="etlc-spin" /> : "Check code"}
              </button>
            )}
          </div>

          {phase === "valid" && benefitAmount != null && (
            <div className="etlc-coupon-card__preview" data-testid="live-coupon-preview">
              This code is worth {benefitAmount} points. Redeem it now?
            </div>
          )}
          {phase === "already_used" && (
            <div className="etlc-coupon-card__preview" data-testid="live-coupon-already-used">
              {message}
            </div>
          )}
          {(phase === "invalid" || phase === "expired" || phase === "unavailable" || phase === "network_error") && message && (
            <div className="etlc-coupon-card__error" data-testid="live-coupon-error">
              {message}
            </div>
          )}
        </>
      )}
    </div>
  );
}
