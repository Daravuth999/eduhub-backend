import { useEffect, useState } from "react";
import { Ticket } from "lucide-react";
import * as api from "./api";
import "./VoiceTreasure.css";

/** VT Pass A — confirmed rewards listing.
 *
 *  This view renders ONLY rewards whose grant has been CONFIRMED by the
 *  backend. Configured, eligible, pending, unavailable, blocked, error, and
 *  failed reward types are NEVER shown here. Points + First Voice Card
 *  behavior is preserved. Voucher and EduTalk Pass rows appear only when
 *  the backend payload reports state === "granted" (the safe public
 *  contract — internal codes, refs, and provider payloads are never
 *  exposed). */
export default function VoiceTreasureRewards() {
  const [rewards, setRewards] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api.getRewards()
      .then((r) => { if (alive) setRewards(r.rewards || []); })
      .catch((e) => { if (alive) setError(e?.message || "Could not load rewards."); });
    return () => { alive = false; };
  }, []);

  if (error) return <Shell><div className="vt-error" data-testid="vt-rewards-error">{error}</div></Shell>;
  if (rewards === null) return <Shell><div className="vt-dim" data-testid="vt-rewards-loading">Loading…</div></Shell>;

  return (
    <Shell>
      <div className="vt-panel vt-card-glow" data-testid="vt-rewards">
        <div className="vt-h1">Confirmed rewards</div>
        {rewards.length === 0 ? (
          <p className="vt-sub" data-testid="vt-rewards-empty">No confirmed rewards yet.</p>
        ) : (
          rewards.map((r) => {
            const cardOwned = r.first_voice_card && r.first_voice_card !== "not_eligible";
            const voucherGranted = r.voucher && r.voucher.state === "granted";
            const passGranted = r.edutalk_pass && r.edutalk_pass.state === "granted";
            return (
              <div
                key={r.attempt_id}
                data-testid={`vt-rewards-row-${r.attempt_id}`}
                style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "8px 0" }}
              >
                <div className="vt-score-row">
                  <span className="vt-dim">
                    {r.claimed_at ? new Date(r.claimed_at).toLocaleDateString() : ""}
                  </span>
                  <span className="vt-cost" data-testid={`vt-rewards-points-${r.attempt_id}`}>
                    +{r.points_credited} pts
                  </span>
                </div>
                {cardOwned && (
                  <div
                    className="vt-score-row"
                    data-testid={`vt-rewards-card-${r.attempt_id}`}
                  >
                    <span>First Voice Card</span>
                    <Ticket
                      size={16}
                      className="vt-balance"
                      aria-label="First Voice Card collectible"
                      data-testid={`vt-rewards-card-icon-${r.attempt_id}`}
                    />
                  </div>
                )}
                {voucherGranted && (
                  <div
                    className="vt-score-row"
                    data-testid={`vt-rewards-voucher-${r.attempt_id}`}
                  >
                    <span>{r.voucher.title || "Voice Treasure Voucher"}</span>
                    <span className="vt-balance" data-testid={`vt-rewards-voucher-state-${r.attempt_id}`}>
                      Granted
                    </span>
                  </div>
                )}
                {passGranted && (
                  <div
                    className="vt-score-row"
                    data-testid={`vt-rewards-pass-${r.attempt_id}`}
                  >
                    <span>
                      EduTalk Pass
                      {r.edutalk_pass.feature ? ` · ${r.edutalk_pass.feature}` : ""}
                      {r.edutalk_pass.quantity > 1 ? ` × ${r.edutalk_pass.quantity}` : ""}
                    </span>
                    <span className="vt-balance" data-testid={`vt-rewards-pass-state-${r.attempt_id}`}>
                      Granted
                    </span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }) {
  return <div className="vt-root"><div className="vt-wrap">{children}</div></div>;
}
