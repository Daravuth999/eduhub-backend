/**
 * LiveCoachTopUpNudge.jsx — the Smart Top-Up Nudge PILL.
 *
 * Presentational only. Rendered by EduTalkLiveCoach.jsx ONLY in
 * phase === "start" (from the backend per-mode preview) and phase === "report"
 * (from the Stage 3 finalization). It NEVER renders during phase === "live".
 *
 * Tapping the pill's CTA opens the SINGLE shared PointsPurchaseModal instance
 * owned by EduTalkLiveCoach (repeated-click protection lives there). This
 * component does not own a modal and does not fetch packages.
 *
 * Exact figures shown here come ONLY from the Stage 1 preview (start) or the
 * Stage 3 finalization (report) — the two places the spec permits numbers.
 *
 * BUG 3 hardening — an explicit dismiss (X) control, separate from the
 * top-up CTA, so a student can wave the reminder off without first opening
 * the purchase modal. The outer element is a plain <div>, not a <button>,
 * specifically so the CTA and the dismiss control can be two independent
 * sibling <button>s — nesting an interactive dismiss control inside the
 * whole-pill button (the earlier draft of this fix) is invalid HTML
 * (buttons cannot contain other focusable elements) and breaks keyboard
 * navigation.
 */
import { Coins, ArrowUpRight, X } from "lucide-react";

const WRAP = {
  position: "relative",
  width: "100%",
  marginTop: "12px",
  borderRadius: "16px",
  border: "1px solid rgba(45, 212, 191, 0.35)",
  background:
    "linear-gradient(135deg, rgba(13, 148, 136, 0.18), rgba(8, 47, 73, 0.35))",
  color: "#e2f6f3",
};

const CTA_BTN = {
  display: "flex",
  alignItems: "center",
  gap: "12px",
  width: "100%",
  textAlign: "left",
  padding: "12px 34px 12px 14px",
  border: "none",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
};

const DISMISS_BTN = {
  position: "absolute",
  top: "8px",
  right: "8px",
  width: "22px",
  height: "22px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "999px",
  border: "none",
  background: "rgba(255,255,255,0.08)",
  color: "rgba(226, 246, 243, 0.75)",
  cursor: "pointer",
};

const ICON = {
  flex: "0 0 auto",
  width: "36px",
  height: "36px",
  borderRadius: "12px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(45, 212, 191, 0.18)",
  color: "#5eead4",
};

export default function LiveCoachTopUpNudge({
  variant = "start",
  preview = null,
  finalization = null,
  onTopUp,
  onDismiss,
  disabled = false,
}) {
  const isReport = variant === "report";
  const balance = isReport
    ? (finalization && finalization.settled_balance)
    : (preview && preview.verified_current_balance);
  const showBalance = typeof balance === "number" && Number.isFinite(balance);

  const headline = isReport
    ? "Running low on points"
    : "Top up for your next session";
  const body = isReport
    ? "Keep your speaking practice going — add points whenever you're ready."
    : "You may want to add points so your next practice session is ready to go.";

  return (
    <div
      style={{ ...WRAP, opacity: disabled ? 0.6 : 1 }}
      data-testid={`live-topup-nudge-${variant}`}
    >
      <button
        type="button"
        style={CTA_BTN}
        onClick={disabled ? undefined : onTopUp}
        disabled={disabled}
        aria-label="Top up EduHub points"
      >
        <span style={ICON}><Coins size={18} /></span>
        <span style={{ flex: "1 1 auto", minWidth: 0 }}>
          <span style={{ display: "block", fontWeight: 700, fontSize: "13.5px" }}>
            {headline}
          </span>
          <span style={{ display: "block", fontSize: "12px", opacity: 0.82 }}>
            {body}
          </span>
          {showBalance && (
            <span
              style={{ display: "block", marginTop: "4px", fontSize: "11.5px",
                       opacity: 0.7 }}
              data-testid={`live-topup-nudge-balance-${variant}`}
            >
              Current balance: {Math.max(0, Math.round(balance))} pts
            </span>
          )}
        </span>
        <ArrowUpRight size={18} style={{ flex: "0 0 auto", color: "#5eead4" }} />
      </button>
      {typeof onDismiss === "function" && (
        <button
          type="button"
          style={DISMISS_BTN}
          onClick={onDismiss}
          data-testid={`live-topup-nudge-dismiss-${variant}`}
          aria-label="Dismiss reminder"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}
