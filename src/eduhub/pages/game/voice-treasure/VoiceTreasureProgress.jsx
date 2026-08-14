import { useEffect, useState } from "react";
import { Flame, Trophy, Coins, Award, Star, Sparkles, TrendingUp, Target } from "lucide-react";
import { useVoiceTreasureTitle, VoiceTreasureIdentity } from "./useVoiceTreasureIdentity";
import VTStage from "./VTStage";
import * as api from "./api";
import "./VoiceTreasure.css";

/**
 * Pass B.2 — Progress visual reconstruction.
 *
 * Authoritative backend data ONLY (never localStorage). Renders only the
 * implemented metrics — missions completed, current/longest streak,
 * Points spent, Points earned, strongest/improvement category, recent
 * attempt scores, recent confirmed rewards. The 🔥 emoji previously used
 * for the streak chip is replaced with the Lucide `Flame` icon.
 *
 * No XP, gems, diamonds, season pass, skins, titles, boosts.
 */
export default function VoiceTreasureProgress() {
  useVoiceTreasureTitle("Progress");
  const [p, setP] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api.getProgress()
      .then((d) => { if (alive) setP(d); })
      .catch((e) => { if (alive) setError(e?.message || "Could not load progress."); });
    return () => { alive = false; };
  }, []);

  if (error) {
    return (
      <VTStage>
        <VoiceTreasureIdentity subtitle="Progress" />
        <div className="vt-error" data-testid="vt-progress-error">{error}</div>
      </VTStage>
    );
  }
  if (p === null) {
    return (
      <VTStage>
        <VoiceTreasureIdentity subtitle="Progress" />
        <div className="vt-dim" data-testid="vt-progress-loading">Loading…</div>
      </VTStage>
    );
  }

  const currentStreak = p.current_streak ?? p.streak_days ?? 0;
  const recent = Array.isArray(p.recent_attempts) ? p.recent_attempts : [];
  const recentRewards = Array.isArray(p.recent_rewards) ? p.recent_rewards : [];

  const StatCard = ({ icon: Icon, label, value, testId, tone = "default" }) => (
    <div className={`vt-stat vt-stat-tone-${tone}`} data-testid={`vt-stat-${testId}`}>
      <div className="vt-stat-l" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {Icon ? <Icon size={12} aria-hidden="true" /> : null}
        <span>{label}</span>
      </div>
      <div className="vt-stat-v" data-testid={testId}>{value}</div>
    </div>
  );

  return (
    <VTStage>
      <VoiceTreasureIdentity subtitle="Progress" />
      <div className="vt-panel vt-card-glow vt-progress" data-testid="vt-progress">
        <div className="vt-h1">Your progress</div>
        <p className="vt-sub">Every figure here comes directly from your saved attempts and rewards.</p>

        <div className="vt-stat-grid" data-testid="vt-progress-grid">
          <StatCard icon={Trophy}   label="Missions completed" value={p.missions_completed ?? 0} testId="vt-missions" tone="gold" />
          <StatCard
            icon={Flame}
            label="Current streak"
            value={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span data-testid="vt-current-streak-value">{currentStreak}</span>
                <Flame size={14} aria-hidden="true" data-testid="vt-current-streak-icon" />
              </span>
            }
            testId="vt-current-streak"
            tone="warm"
          />
          <StatCard icon={Star}   label="Longest streak"  value={p.longest_streak ?? 0} testId="vt-longest-streak" />
          <StatCard icon={Coins}  label="Points spent"    value={p.points_spent ?? 0}   testId="vt-spent" />
          <StatCard icon={Award}  label="Points earned"   value={p.points_earned ?? 0}  testId="vt-earned" tone="gold" />
          <StatCard icon={Star}   label="First Voice Card" value={p.first_voice_card_owned ? "Owned" : "—"} testId="vt-card-owned" />
        </div>

        <div className="vt-progress-pair">
          {p.strongest_category ? (
            <div className="vt-panel vt-progress-callout" data-testid="vt-strongest">
              <div className="vt-stat-l" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <TrendingUp size={12} aria-hidden="true" />
                Your strongest area
              </div>
              <div className="vt-balance">{p.strongest_category}</div>
            </div>
          ) : null}

          {p.improvement_category ? (
            <div className="vt-panel vt-progress-callout" data-testid="vt-improvement">
              <div className="vt-stat-l" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Target size={12} aria-hidden="true" />
                Coaching focus
              </div>
              <div className="vt-balance">{p.improvement_category}</div>
            </div>
          ) : null}
        </div>
      </div>

      {recent.length > 0 && (
        <div className="vt-panel vt-recent" data-testid="vt-recent">
          <div className="vt-stat-l" style={{ marginBottom: 8, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Sparkles size={12} aria-hidden="true" />
            Recent attempts
          </div>
          {recent.map((a) => (
            <div className="vt-score-row" key={a.attempt_id} data-testid={`vt-recent-${a.attempt_id}`}>
              <span className="vt-dim">{a.at ? new Date(a.at).toLocaleDateString() : ""}</span>
              <span className="vt-balance">{a.overall ?? "—"}</span>
            </div>
          ))}
        </div>
      )}

      {recentRewards.length > 0 && (
        <div className="vt-panel vt-recent" data-testid="vt-recent-rewards">
          <div className="vt-stat-l" style={{ marginBottom: 8, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Award size={12} aria-hidden="true" />
            Recent confirmed rewards
          </div>
          {recentRewards.map((r, i) => (
            <div className="vt-score-row" key={r.id || r.attempt_id || i} data-testid={`vt-recent-reward-${i}`}>
              <span className="vt-dim">{r.label || r.title || "Reward"}</span>
              <span className="vt-balance">{r.points_credited != null ? `+${r.points_credited} pts` : r.summary || "Granted"}</span>
            </div>
          ))}
        </div>
      )}

      {(p.missions_completed ?? 0) === 0 && (
        <div className="vt-panel vt-empty-state" data-testid="vt-progress-empty" style={{ marginTop: 12 }}>
          <div className="vt-dim">No attempts yet. Try today's mission to start building your streak.</div>
        </div>
      )}
    </VTStage>
  );
}
