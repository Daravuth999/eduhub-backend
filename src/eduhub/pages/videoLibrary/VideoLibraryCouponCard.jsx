/**
 * VideoLibraryCouponCard.jsx — student-facing "Have a voucher?" entry point
 * for the Video Library. A subtle, muted link (styled after the header's own
 * tier/points badges — never a dominant CTA) that opens a premium sheet
 * mirroring PurchaseLessonModal.jsx's exact visual language (vl-modal-overlay/
 * vl-modal-card, dark card, gold accent, same particle-burst success state)
 * so the coupon experience reads as part of the same product, not a bolted-on
 * widget.
 *
 * Talks ONLY to the isolated /api/student/video-library/coupon/* routes
 * (video_library_coupon_tools.py) via videoLibraryApi.js. Entirely hidden
 * (renders nothing, not even the trigger) until getVideoLibraryCouponStatus()
 * confirms the backend flag is on — fails closed on any error.
 *
 * State machine mirrors LiveCoachCouponCard.jsx exactly: idle → validating →
 * (valid | already_used | invalid | expired | unavailable) → redeeming →
 * (success | network_error). A network error preserves the entered code so
 * the student can retry without retyping it. Redeemed points land in the
 * SAME shared GAS balance lesson purchases debit from — refreshPoints() is
 * called on success so the header's points pill updates immediately.
 *
 * Reason→copy mapping mirrors the backend's safe reason enum exactly
 * (video_library_coupon_tools.py's _FRIENDLY_MESSAGES) — no internal ids,
 * no DB details, no secrets. not_found stays deliberately generic so a code
 * that exists for a different purpose is indistinguishable from one that
 * doesn't exist at all.
 */
import { useEffect, useRef, useState } from "react";
import { Gift, Loader2, Sparkles, X, Check } from "lucide-react";
import {
  getVideoLibraryCouponStatus,
  validateVideoLibraryCoupon,
  redeemVideoLibraryCoupon,
} from "./videoLibraryApi";
import { useAuth } from "../../context/AuthContext";
import "./videoLibrary.css";

const GOLD = "#D4A843";

const FRIENDLY_STATE_MESSAGE = {
  not_found: "This code could not be used. Please check it and try again.",
  wrong_benefit_type: "This code is not a Video Library voucher.",
  invalid_benefit_amount: "This code is not configured correctly. Please contact your teacher.",
  disabled: "This code is not currently active.",
  not_yet_active: "This code is not active yet.",
  expired: "This code has expired.",
  global_limit_reached: "This code has already reached its usage limit.",
  not_assigned: "This code is not assigned to this account.",
  credit_failed: "Your code was accepted, but the points could not be applied yet. Please try again.",
  empty: "Enter a coupon code.",
};

// Reasons that map to the "unavailable" (rejection) phase — everything else
// (not_found/wrong_benefit_type/invalid_benefit_amount/not_yet_active/
// not_assigned) falls into the generic "invalid" phase (different message,
// same neutral styling).
const UNAVAILABLE_REASONS = new Set(["disabled", "global_limit_reached"]);

export default function VideoLibraryCouponCard({ onRedeemed }) {
  const [available, setAvailable] = useState(null); // null=checking, true|false
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState("idle"); // idle|validating|valid|already_used|invalid|expired|unavailable|redeeming|success|network_error
  const [benefitAmount, setBenefitAmount] = useState(null);
  const [message, setMessage] = useState("");
  const abortRef = useRef(null);

  // Optional auth context — graceful when mounted without a provider (tests).
  let auth = null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  try { auth = useAuth(); } catch { /* no provider */ }

  useEffect(() => {
    let cancelled = false;
    getVideoLibraryCouponStatus().then((status) => {
      if (!cancelled) setAvailable(!!status?.enabled);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => {
    if (abortRef.current) abortRef.current.aborted = true;
  }, []);

  if (!available) return null;

  const resetToIdle = () => {
    setPhase("idle");
    setBenefitAmount(null);
    setMessage("");
  };

  const closeSheet = () => {
    if (phase === "validating" || phase === "redeeming") return;
    setOpen(false);
    setCode("");
    resetToIdle();
  };

  const handleCodeChange = (e) => {
    setCode(e.target.value.toUpperCase());
    if (phase !== "idle" && phase !== "validating") resetToIdle();
  };

  // Maps a rejected/failed backend reason to the UI's (broad, style-only)
  // phase bucket. The displayed TEXT always comes from FRIENDLY_STATE_MESSAGE
  // (or the backend's own resp.message) and is reason-specific.
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
      const resp = await validateVideoLibraryCoupon(trimmed);
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
      const resp = await redeemVideoLibraryCoupon(trimmed);
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
      Promise.resolve(auth?.refreshPoints?.()).catch(() => {});
      if (typeof onRedeemed === "function") onRedeemed(resp.benefit_amount);
    } catch (e) {
      if (token.aborted) return;
      setPhase("network_error");
      setMessage(e && e.message ? e.message : "Network error. Please try again.");
    }
  };

  const isBusy = phase === "validating" || phase === "redeeming";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="video-library-coupon-trigger"
        className="inline-flex items-center gap-1 text-[11px] font-semibold text-zinc-500 dark:text-white/45 hover:text-zinc-700 dark:hover:text-white/70 transition-colors"
      >
        <Gift size={11} style={{ color: GOLD }} /> Have a voucher?
      </button>

      {open && (
        <div className="vl-modal-overlay fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-6"
             style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}
             data-testid="video-library-coupon-sheet"
             onClick={closeSheet}>
          <div className="vl-modal-card relative w-full sm:max-w-sm bg-[#141414] border border-white/10 rounded-t-2xl sm:rounded-2xl p-5 space-y-4"
               style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
               onClick={(e) => e.stopPropagation()}>
            {phase !== "redeeming" && (
              <button onClick={closeSheet} aria-label="Close" data-testid="video-library-coupon-close-button"
                      className="absolute top-3.5 right-3.5 z-10 min-w-[36px] min-h-[36px] flex items-center justify-center text-white/45 hover:text-white">
                <X size={16} />
              </button>
            )}

            {phase === "success" ? (
              <div className="text-center space-y-4 pt-3 pb-1" data-testid="video-library-coupon-success">
                <div className="w-14 h-14 mx-auto rounded-full flex items-center justify-center"
                     style={{ background: "rgba(212,168,67,0.16)", border: "1.5px solid rgba(212,168,67,0.55)" }}>
                  <Check size={24} style={{ color: GOLD }} strokeWidth={3} />
                </div>
                <div className="space-y-1">
                  <h2 className="text-[16px] font-bold text-white">Voucher Redeemed</h2>
                  <p className="text-[13px] text-white/60">
                    {benefitAmount != null
                      ? `${benefitAmount} EduHub Points added to your balance.`
                      : "Points added to your balance."}
                  </p>
                  <p className="text-[12px] text-white/40">Spend them on any lesson in the Video Library.</p>
                </div>
                <button onClick={closeSheet}
                        data-testid="video-library-coupon-done-button"
                        className="w-full py-3 rounded-xl text-[14px] font-bold text-black"
                        style={{ background: GOLD }}>
                  Done
                </button>
              </div>
            ) : (
              <>
                <div className="text-center space-y-1 pt-1">
                  <div className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: GOLD }}>
                    Video Library Voucher
                  </div>
                  <h2 className="text-[15px] font-bold text-white">Have a voucher code?</h2>
                  <p className="text-[12.5px] text-white/50">Redeem it for EduHub Points to spend on any lesson.</p>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={code}
                    onChange={handleCodeChange}
                    placeholder="Enter code"
                    disabled={isBusy}
                    data-testid="video-library-coupon-input"
                    className="flex-1 min-w-0 rounded-xl bg-white/[0.04] border border-white/10 px-3.5 py-3 text-[14px] font-semibold tracking-wide text-white placeholder:text-white/30 placeholder:font-normal outline-none focus:border-white/25"
                  />
                  {phase === "valid" ? (
                    <button
                      type="button"
                      onClick={handleRedeem}
                      disabled={isBusy}
                      data-testid="video-library-coupon-redeem-btn"
                      className="flex-shrink-0 min-w-[44px] px-4 py-3 rounded-xl text-[13px] font-bold text-black flex items-center justify-center"
                      style={{ background: GOLD }}>
                      {phase === "redeeming" ? <Loader2 size={15} className="animate-spin" /> : "Redeem"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleValidate}
                      disabled={isBusy || !code.trim()}
                      data-testid="video-library-coupon-check-btn"
                      className="flex-shrink-0 min-w-[44px] px-4 py-3 rounded-xl text-[13px] font-bold text-black flex items-center justify-center disabled:opacity-40"
                      style={{ background: GOLD }}>
                      {phase === "validating" ? <Loader2 size={15} className="animate-spin" /> : "Check"}
                    </button>
                  )}
                </div>

                {phase === "valid" && benefitAmount != null && (
                  <div className="rounded-xl bg-white/[0.04] border border-white/10 p-3 text-[12.5px] text-white/70 flex items-center gap-2"
                       data-testid="video-library-coupon-preview">
                    <Sparkles size={13} style={{ color: GOLD }} />
                    This code is worth {benefitAmount} points. Redeem it now?
                  </div>
                )}
                {phase === "already_used" && (
                  <div className="rounded-xl bg-white/[0.04] border border-white/10 p-3 text-[12.5px] text-white/60"
                       data-testid="video-library-coupon-already-used">
                    {message}
                  </div>
                )}
                {(phase === "invalid" || phase === "expired" || phase === "unavailable" || phase === "network_error") && message && (
                  <div className="rounded-xl p-3 text-[12.5px]"
                       style={{ background: "rgba(240,80,80,0.10)", color: "#f0a8a8" }}
                       data-testid="video-library-coupon-error">
                    {message}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
