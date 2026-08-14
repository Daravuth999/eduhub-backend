import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../../context/AuthContext";
import PointsGateModal from "../../library/reader/PointsGateModal";
import { useVoiceTreasureTitle, VoiceTreasureIdentity } from "./useVoiceTreasureIdentity";
import * as api from "./api";
import "./VoiceTreasure.css";

/**
 * Entry confirmation. The GAS password comes ONLY from the in-memory auth
 * session; if absent we show a safe re-auth requirement rather than attempting
 * a debit. confirm:false preview first (authoritative balance), then an
 * explicit confirm:true commit. Duplicate taps are blocked while in flight.
 */
export default function VoiceTreasureEntryConfirm() {
  useVoiceTreasureTitle("Confirm Entry");
  const nav = useNavigate();
  const { student } = useAuth();
  const password = student?.password || student?.portalData?.Password || "";

  const [offer, setOffer] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [topUpOpen, setTopUpOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const t = await api.getToday();
        if (!alive) return;
        if (!t.available) { setError("unavailable"); return; }
        setOffer(t);
        if (t.existing_entry?.paid) { nav("/game/voice-treasure/mission"); return; }
        if (!password) { setLoading(false); return; }
        const pv = await api.entryPreview({ password });
        if (alive) setPreview(pv);
      } catch (e) {
        if (alive) setError(e?.message || "Could not load entry.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [password, nav]);

  if (loading) return <Shell><div className="vt-dim">Loading…</div></Shell>;
  if (error === "unavailable") return <Shell><div className="vt-panel">Voice Treasure isn't available right now.</div></Shell>;
  if (!password) {
    return (
      <Shell>
        <div className="vt-panel" data-testid="vt-reauth">
          <div className="vt-h1">Please sign in again</div>
          <p className="vt-sub">For your security we need you to re-enter your account to spend points. No debit was attempted.</p>
          <button className="vt-btn vt-btn-ghost" onClick={() => nav("/")}>Go to sign in</button>
        </div>
      </Shell>
    );
  }

  const cost = offer?.entry?.entry_cost_points ?? 0;
  const missionId = offer?.mission?.mission_id;
  const balance = preview?.balance;
  const sufficient = preview?.sufficient;

  const onConfirm = async () => {
    if (busy) return;           // duplicate-tap guard
    setBusy(true);
    setError("");
    try {
      const res = await api.entryConfirm({ password, missionId, expectedCost: cost });
      const state = res?.entry?.state;
      if (res?.already_paid || state === "succeeded") {
        nav("/game/voice-treasure/mission");
      } else if (state === "needs_manual_reconciliation") {
        setError("We couldn't confirm your payment. Our team will review it — you were not charged twice.");
      } else {
        setError("Payment didn't go through. You can try again.");
      }
    } catch (e) {
      if (e.status === 402) setError("Not enough points. Please top up and try again.");
      else if (e.status === 429) setError("You've reached today's play limit.");
      else setError(e?.message || "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <div className="vt-panel vt-card-glow" data-testid="vt-confirm">
        <div className="vt-h1">Unlock today's mission?</div>
        <div className="vt-score-row"><span className="vt-dim">Entry cost</span><span className="vt-cost">{cost} pts</span></div>
        <div className="vt-score-row">
          <span className="vt-dim">Your balance</span>
          <span className="vt-balance" data-testid="vt-balance">{balance == null ? "…" : `${balance} pts`}</span>
        </div>
        {sufficient === false && (
          <div data-testid="vt-insufficient" style={{ marginTop: 10 }}>
            <p className="vt-error">Not enough points to play today's mission.</p>
            <div className="vt-score-row"><span className="vt-dim">Your balance</span><span className="vt-balance">{balance == null ? "…" : `${balance} pts`}</span></div>
            <div className="vt-score-row"><span className="vt-dim">Entry cost</span><span className="vt-cost">{cost} pts</span></div>
            <div className="vt-score-row"><span className="vt-dim">You need</span><span className="vt-cost" data-testid="vt-shortfall">{balance == null ? "…" : `${Math.max(0, cost - balance)} more pts`}</span></div>
            <button
              className="vt-btn vt-btn-gold"
              data-testid="vt-topup"
              style={{ marginTop: 8 }}
              onClick={() => setTopUpOpen(true)}
            >
              Top up points
            </button>
          </div>
        )}
        {error && <p className="vt-error" data-testid="vt-confirm-error" style={{ marginTop: 10 }}>{error}</p>}
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button className="vt-btn vt-btn-ghost" onClick={() => nav("/game/voice-treasure")}>Cancel</button>
          <button
            className="vt-btn vt-btn-gold"
            data-testid="vt-spend"
            disabled={busy || sufficient === false || balance == null}
            onClick={onConfirm}
          >
            {busy ? "Processing…" : `Spend ${cost} pts`}
          </button>
        </div>
      </div>

      {/* Top-Up handoff — reuses the existing EduHub points purchase flow.
          Voice Treasure never creates its own payment intent.

          Wiring contract (Spec I):
            • onResume   = called by PointsGateModal when the balance becomes
                           sufficient. We refresh the authoritative GAS preview
                           and stay on the same Voice Treasure mission offer
                           so the student does NOT lose the mission they were
                           about to unlock. We do NOT auto-debit; the student
                           must still tap "Spend ___ pts" explicitly.
            • onClose    = called on cancel or background tap. We also refresh
                           harmlessly so a manual top-up that completed
                           outside the auto-resume window is detected.
            • Internal payment / KHQR / ABA / receipts are NOT modified. */}
      <PointsGateModal
        open={topUpOpen}
        onClose={async () => {
          setTopUpOpen(false);
          try {
            const pv = await api.entryPreview({ password });
            setPreview(pv);
          } catch { /* leave prior preview */ }
        }}
        onResume={async () => {
          setTopUpOpen(false);
          try {
            const pv = await api.entryPreview({ password });
            setPreview(pv);
          } catch { /* leave prior preview */ }
        }}
        requiredPoints={cost}
        balance={balance == null ? 0 : balance}
        featureLabel="Voice Treasure"
        triggerReason="insufficient"
      />
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="vt-root">
      <div className="vt-wrap">
        <VoiceTreasureIdentity subtitle="Confirm Entry" />
        {children}
      </div>
    </div>
  );
}
