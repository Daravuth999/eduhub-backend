import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../../../context/AuthContext";
import * as api from "./api";
import {
  chestPresentation, shouldPoll, canClaim, revealsReward,
  shouldRevealVoucher, shouldRevealEdutalkPass,
  CHEST_COMPLETED,
} from "./chestView";
import { ChestSVG } from "./ChestAssets.jsx";
import { firstVoiceCard as firstVoiceCardImg } from "./chestAssets";
import { useVoiceTreasureTitle, VoiceTreasureIdentity } from "./useVoiceTreasureIdentity";
import "./VoiceTreasure.css";

// Pass B.1.1 — shared opening-sequence duration. Matches the full CSS
// timeline in VoiceTreasure.css (latch + lid + rays + particles +
// reward-card emergence ⇒ 2500ms). Single source of truth so the JS
// timer and tests can never drift away from the CSS.
export const CHEST_OPENING_MS = 2500;

/**
 * Chest for /game/voice-treasure/chest/:attemptId. Loads authoritative status
 * (survives refresh + direct link), shows a sealed chest until the backend
 * confirms `completed`, polls ONLY while processing (status route never
 * initiates GAS), and offers Claim/Retry only when the backend allows it.
 * Reduced motion is honored via CSS (no JS animation here).
 */
export default function VoiceTreasureChest() {
  useVoiceTreasureTitle("Treasure Chest");
  const { attemptId } = useParams();
  const nav = useNavigate();
  const auth = useAuth() || {};
  const [chest, setChest] = useState(null);
  const [status, setStatus] = useState("loading"); // loading|notfound|error|ready
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  const load = async () => {
    try {
      const res = await api.getClaimStatus(attemptId);
      setChest(res.chest);
      setStatus("ready");
      return res.chest;
    } catch (e) {
      setStatus(e.status === 404 ? "notfound" : "error");
      return null;
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [attemptId]);

  // When the reward completes but no trusted balance was returned, refresh the
  // authoritative points from the existing source (never fabricate a number).
  const refreshedRef = useRef(false);
  useEffect(() => {
    const r = chest?.reward;
    if (chest?.chest_state === "completed" && r?.balance_status === "refresh_required"
        && !refreshedRef.current && typeof auth.refreshPoints === "function") {
      refreshedRef.current = true;
      try { auth.refreshPoints(); } catch { /* best-effort */ }
    }
    // eslint-disable-next-line
  }, [chest?.chest_state, chest?.reward?.balance_status]);

  // Poll only while processing.
  useEffect(() => {
    const st = chest?.chest_state;
    if (st && shouldPoll(st)) {
      pollRef.current = setInterval(load, 2500);
      return () => clearInterval(pollRef.current);
    }
    if (pollRef.current) clearInterval(pollRef.current);
    return undefined;
    // eslint-disable-next-line
  }, [chest?.chest_state]);

  // Pass B.1 — transient frontend-only opening phase.
  //
  // Contract:
  //   • The backend `chest_state` remains AUTHORITATIVE for grant truth.
  //   • The visual phase is `sealed → opening → completed` and is computed
  //     PURELY from local state. We never store reward truth in
  //     localStorage; this state lives only in React.
  //   • `opening` triggers only when the backend transitions
  //     (anything-not-completed) → completed in this session. A direct
  //     visit to a chest already in `completed` jumps straight to
  //     `completed` (no animation replay) so refresh / direct-link can
  //     never play a granting cinematic out of context.
  //   • Reduced motion skips `opening` entirely.
  //   • Animation NEVER calls api.claim() — see invariant test.
  //   • Replay (component re-render after the phase ends) never calls
  //     the backend either; the chestView gates make `completed` idempotent.
  const [visualPhase, setVisualPhase] = useState("idle"); // idle|opening|completed
  const prevStateRef = useRef(null);
  const prefersReducedMotion = (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  useEffect(() => {
    const st = chest?.chest_state;
    if (!st) return;
    const prev = prevStateRef.current;
    if (st === CHEST_COMPLETED && prev && prev !== CHEST_COMPLETED) {
      // Real transition into completed during this session — play the
      // transient opening only if motion is allowed.
      if (prefersReducedMotion) {
        setVisualPhase("completed");
      } else {
        setVisualPhase("opening");
      }
    } else if (st === CHEST_COMPLETED && !prev) {
      // First load already shows completed (refresh / direct link) — go
      // straight to the stable completed frame, no replay.
      setVisualPhase("completed");
    } else if (st !== CHEST_COMPLETED) {
      // Backend is still processing/reconciling/etc. — stay sealed.
      setVisualPhase("idle");
    }
    prevStateRef.current = st;
  }, [chest?.chest_state, prefersReducedMotion]);
  // Pass B.1.1 — shared timing constant matches the full CSS sequence
  // in VoiceTreasure.css (latch 700 + lid 900 from 700ms + rays 900 from
  // 1300ms + particles 1100 from 1400ms + card 900 from 1600ms ⇒ 2500ms).
  // The timer is reliable, single-source, and cleaned up on visualPhase
  // changes and on unmount.
  useEffect(() => {
    if (visualPhase !== "opening") return undefined;
    const t = setTimeout(() => setVisualPhase("completed"), CHEST_OPENING_MS);
    return () => clearTimeout(t);
  }, [visualPhase]);

  const onClaim = async () => {
    if (busy) return;            // duplicate-tap guard
    setBusy(true);
    try {
      const res = await api.claim(attemptId);
      setChest(res.chest);
    } catch {
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (status === "loading") return <Shell><div className="vt-dim" data-testid="vt-chest-loading">Loading…</div></Shell>;
  if (status === "notfound") return <Shell><div className="vt-panel" data-testid="vt-chest-notfound">We couldn't find that chest.</div></Shell>;
  if (status === "error") return <Shell><div className="vt-error" data-testid="vt-chest-error">Something went wrong.</div></Shell>;

  const st = chest?.chest_state;
  const p = chestPresentation(st);
  const reward = chest?.reward;

  // Pass B.1.1 — drive the chest artwork with the transient visual phase
  // when (and only when) we're inside an in-session opening cinematic.
  // Backend `st` remains AUTHORITATIVE for grant truth, claim eligibility,
  // sealed gates (processing / reconciliation / failed), and reward
  // reveal. The opening override is purely cosmetic and never widens any
  // gate — it only swaps the SVG's `data-state` so the CSS sequence runs.
  const visualChestState = visualPhase === "opening" ? "opening" : st;

  return (
    <Shell>
      <div className="vt-panel vt-card-glow" data-testid="vt-chest" data-state={st} data-visual-phase={visualPhase}>
        <div
          className="vt-chest-visual"
          data-testid={p.sealed ? "vt-chest-sealed" : (visualPhase === "opening" ? "vt-chest-opening" : "vt-chest-open")}
          data-chest-state={st}
          data-visual-phase={visualPhase}
        >
          {/* Pass 2 / B.1.1: original layered SVG chest. CSS keyframes are
              keyed on data-state. The component never triggers a backend
              claim and never replays unless the backend state changes.
              `visualChestState` swaps the SVG `data-state` to "opening"
              only during the transient in-session cinematic. */}
          <ChestSVG state={visualChestState} testId="vt-chest-svg" />
        </div>
        <div className="vt-h1" style={{ textAlign: "center" }}>{p.title}</div>

        {st === "reconciliation_required" && (
          <p className="vt-sub" data-testid="vt-chest-reconcile">
            {chest.message} {chest.support_reference ? `Reference: ${chest.support_reference}` : ""}
          </p>
        )}
        {st === "confirmed_failed" && (
          <p className="vt-sub" data-testid="vt-chest-failed">{chest.message}</p>
        )}
        {st === "ineligible" && (
          <p className="vt-sub" data-testid="vt-chest-ineligible">
            You didn't earn a reward this time — keep practicing to unlock the chest.
          </p>
        )}

        {revealsReward(st) && reward && (
          <div className="vt-panel" data-testid="vt-reveal" style={{ marginTop: 12 }}>
            <div className="vt-score-row"><span>Points credited</span><span className="vt-cost" data-testid="vt-reward-points">{reward.points_credited}</span></div>
            {reward.streak_bonus > 0 && (
              <div className="vt-score-row"><span>Streak bonus</span><span className="vt-cost">{reward.streak_bonus}</span></div>
            )}
            {reward.first_voice_card && reward.first_voice_card !== "not_eligible" && (
              <div className="vt-score-row">
                <span>First Voice Card</span>
                <span className="vt-balance" data-testid="vt-reward-card">
                  {reward.first_voice_card === "already_owned" ? "Owned" : "New!"}
                </span>
              </div>
            )}
            {reward.first_voice_card === "newly_granted" && (
              <div className="vt-first-voice-card" data-testid="vt-first-voice-card">
                <img src={firstVoiceCardImg} alt="First Voice Card collectible" draggable="false" />
              </div>
            )}
            {/* Pass A.1 — confirmed Voucher reveal. The chestView helper
                gates on `state === "granted"` AND the presence of a
                `voucher_detail` block. Pending / eligible / blocked /
                unavailable / failed / reconciliation / absent vouchers are
                never shown as won. We never expose internal voucher
                references, stock IDs, provider payloads, or auto-generated
                codes; the redemption code only appears if the backend
                fulfillment explicitly marked it student-visible. */}
            {shouldRevealVoucher(reward) && (
              <div className="vt-panel" data-testid="vt-reveal-voucher" style={{ marginTop: 10 }}>
                <div className="vt-score-row">
                  <span data-testid="vt-reveal-voucher-title">
                    {reward.voucher_detail.title}
                  </span>
                  <span className="vt-balance" data-testid="vt-reveal-voucher-state">Granted</span>
                </div>
                {reward.voucher_detail.subtitle && (
                  <div className="vt-dim" data-testid="vt-reveal-voucher-subtitle">
                    {reward.voucher_detail.subtitle}
                  </div>
                )}
                {reward.voucher_detail.discount_summary && (
                  <div className="vt-score-row">
                    <span className="vt-dim">Discount</span>
                    <span data-testid="vt-reveal-voucher-discount">
                      {reward.voucher_detail.discount_summary}
                    </span>
                  </div>
                )}
                {reward.voucher_detail.redemption_code && (
                  <div className="vt-score-row">
                    <span className="vt-dim">Redeem code</span>
                    <span data-testid="vt-reveal-voucher-code">
                      {reward.voucher_detail.redemption_code}
                    </span>
                  </div>
                )}
                {reward.voucher_detail.expires_at && (
                  <div className="vt-score-row">
                    <span className="vt-dim">Expires</span>
                    <span data-testid="vt-reveal-voucher-expires">
                      {new Date(reward.voucher_detail.expires_at).toLocaleDateString()}
                    </span>
                  </div>
                )}
              </div>
            )}
            {/* Pass A.1 — confirmed EduTalk Pass reveal. Same gating rules.
                Eligible-book scope is shown only when the Author Studio
                actually configured one (already student-safe slugs). */}
            {shouldRevealEdutalkPass(reward) && (
              <div className="vt-panel" data-testid="vt-reveal-pass" style={{ marginTop: 10 }}>
                <div className="vt-score-row">
                  <span data-testid="vt-reveal-pass-title">
                    EduTalk Pass
                    {reward.edutalk_pass_detail.feature
                      ? ` · ${reward.edutalk_pass_detail.feature}` : ""}
                  </span>
                  <span className="vt-balance" data-testid="vt-reveal-pass-state">Granted</span>
                </div>
                <div className="vt-score-row">
                  <span className="vt-dim">Quantity</span>
                  <span data-testid="vt-reveal-pass-quantity">
                    {reward.edutalk_pass_detail.quantity ?? 1}
                  </span>
                </div>
                {reward.edutalk_pass_detail.expires_at && (
                  <div className="vt-score-row">
                    <span className="vt-dim">Expires</span>
                    <span data-testid="vt-reveal-pass-expires">
                      {new Date(reward.edutalk_pass_detail.expires_at).toLocaleDateString()}
                    </span>
                  </div>
                )}
                {Array.isArray(reward.edutalk_pass_detail.eligible_books)
                  && reward.edutalk_pass_detail.eligible_books.length > 0 && (
                  <div className="vt-score-row">
                    <span className="vt-dim">Eligible books</span>
                    <span data-testid="vt-reveal-pass-books">
                      {reward.edutalk_pass_detail.eligible_books.join(", ")}
                    </span>
                  </div>
                )}
              </div>
            )}
            {/* Explicit balance contract: trusted number, or refresh-required.
                Never fabricate a post-credit balance. */}
            {reward.balance_status === "trusted" && reward.balance != null && (
              <div className="vt-score-row"><span>New balance</span><span className="vt-balance" data-testid="vt-balance-trusted">{reward.balance}</span></div>
            )}
            {reward.balance_status === "refresh_required" && (
              <div className="vt-score-row">
                <span>New balance</span>
                <span className="vt-dim" data-testid="vt-balance-refresh">Updating… check your points</span>
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          {canClaim(st) && (
            <button className="vt-btn vt-btn-gold" data-testid="vt-chest-claim" disabled={busy} onClick={onClaim}>
              {busy ? "Working…" : p.action}
            </button>
          )}
          {st === CHEST_COMPLETED && (
            <>
              <button className="vt-btn vt-btn-ghost" data-testid="vt-go-collection" onClick={() => nav("/game/voice-treasure/collection")}>Collection</button>
              <button className="vt-btn" data-testid="vt-go-progress" onClick={() => nav("/game/voice-treasure/progress")}>Progress</button>
            </>
          )}
          {st === "ineligible" && (
            <button className="vt-btn" onClick={() => nav("/game/voice-treasure/progress")}>See progress</button>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="vt-root">
      <div className="vt-wrap">
        <VoiceTreasureIdentity subtitle="Treasure Chest" />
        {children}
      </div>
    </div>
  );
}
