import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Flame, Sparkles, BookOpen, BarChart3, Mic } from "lucide-react";
import * as api from "./api";
import { useVoiceTreasureTitle, VoiceTreasureIdentity } from "./useVoiceTreasureIdentity";
import VTStage from "./VTStage";
import { resolveBundledImage } from "./sceneAssets";
import "./VoiceTreasure.css";

/**
 * Voice Treasure Dashboard — Pass B.1 immersive reconstruction.
 *
 * sits on top of VTStage so it inherits the shared layered backdrop. The
 * dashboard renders ONLY authoritative data from the existing public
 * endpoints (`getToday`, `getConfigPublic`, `getProgress`) and never
 * invents virtual currencies, alternate stores, season passes, cosmetic
 * skin slots, or temporary booster items. The hero scene is taken from the assigned mission's bundled
 * scene resolver (`resolveBundledImage`) — if the mission was assigned a
 * generated scene (image_kind === "generated"), the dashboard uses the
 * authenticated `image_url` instead. If neither resolves, VTStage falls
 * back to the ambient backdrop alone (no fake placeholder).
 *
 * Hierarchy:
 *   1. Voice Treasure identity (from VoiceTreasureIdentity)
 *   2. student/avatar row
 *   3. authoritative Points balance
 *   4. real streak chip (when present)
 *   5. illustrated mission hero (scene-art on VTStage layer 2)
 *   6. mission difficulty + entry cost + only-effectively-enabled rewards
 *   7. pending / reconciliation status strip
 *   8. missions / streak / collection stat cards
 *   9. Collection + Progress shortcuts
 *  10. Start Speaking CTA
 */
export default function VoiceTreasureDashboard() {
  useVoiceTreasureTitle("Dashboard");
  const nav = useNavigate();
  const [today, setToday] = useState(null);
  const [pub, setPub] = useState(null);
  const [progress, setProgress] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [t, p, pr] = await Promise.all([
          api.getToday(),
          api.getConfigPublic?.().catch(() => null) || null,
          api.getProgress?.().catch(() => null) || null,
        ]);
        if (!alive) return;
        setToday(t); setPub(p); setProgress(pr);
      } catch (e) {
        if (alive) setError(e?.message || "Could not load today's mission.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Resolve the assigned mission's scene art for the VTStage layer.
  // Bundled refs → CRA-fingerprinted import; generated → authenticated URL.
  // If neither is available we pass null and VTStage skips the layer.
  const mission = today?.mission || null;
  const sceneImage = (() => {
    if (!mission) return null;
    if (mission.image_kind === "generated" && mission.image_url) return mission.image_url;
    return resolveBundledImage({ imageRef: mission.image_ref, sceneId: mission.scene_id });
  })();

  if (loading) {
    return (
      <VTStage>
        <Identity />
        <div className="vt-dim" data-testid="vt-loading">Loading…</div>
      </VTStage>
    );
  }
  if (error) {
    return (
      <VTStage>
        <Identity />
        <div className="vt-error" data-testid="vt-dash-error">{error}</div>
      </VTStage>
    );
  }
  if (!today || !today.available) {
    return (
      <VTStage>
        <Identity />
        <div className="vt-panel" data-testid="vt-dash-unavailable">
          Voice Treasure isn't available right now.
        </div>
      </VTStage>
    );
  }

  const cost = today.entry?.entry_cost_points ?? 0;
  const balance = today.balance?.points ?? 0;
  const studentName = today.student?.display_name || today.student?.username || "Explorer";
  const initial = (studentName || "?").trim().charAt(0).toUpperCase();
  const limitReached = today.limits?.limit_reached;
  const alreadyPaid = today.existing_entry?.paid;
  const pendingState = today.existing_entry?.attempt_state || null;

  // Only-effectively-enabled rewards. Voucher and EduTalk Pass advertise
  // ONLY when the backend's public projection marks them available (master
  // switch ON + runtime grant adapter present). Never invent currencies.
  const cfg = pub?.config?.rewards || pub?.rewards || {};
  const eff = pub?.effective || {};
  const pointsEnabled = !!(eff.master_points_reward_enabled && cfg.points_reward_enabled);
  const rewardMin = pointsEnabled ? (cfg.base_points_reward ?? 0) : 0;
  const rewardMax = pointsEnabled ? (cfg.maximum_points_reward ?? rewardMin) : 0;
  const cardEnabled = cfg.first_voice_card_enabled !== false;
  const voucherAvailable = !!cfg.voucher_reward_available;
  const passAvailable = !!cfg.edutalk_pass_reward_available;

  const goPlay = () => nav(alreadyPaid ? "/game/voice-treasure/mission" : "/game/voice-treasure/confirm");

  return (
    <VTStage sceneImage={sceneImage} sceneAlt={mission?.title || "Today's mission scene"}>
      <Identity subtitle="Speak, discover, collect" />

      <div className="vt-dash-header" data-testid="vt-dashboard">
        <div className="vt-avatar" data-testid="vt-student-initial">{initial}</div>
        <div>
          <div style={{ fontWeight: 800 }} data-testid="vt-student-name">{studentName}</div>
          <div className="vt-dim" style={{ fontSize: 12 }}>Voice Explorer</div>
        </div>
      </div>

      <div className="vt-balance-row" data-testid="vt-balance-row">
        <span className="vt-balance-chip" data-testid="vt-balance-points">
          {balance.toLocaleString()} pts
        </span>
        {progress?.streak_days ? (
          <span
            className="vt-balance-chip"
            data-testid="vt-streak"
            style={{ background: "rgba(106,214,255,0.12)", color: "#6ad6ff", borderColor: "rgba(106,214,255,0.34)", display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <Flame size={14} aria-hidden="true" data-testid="vt-streak-icon" />
            {progress.streak_days}-day streak
          </span>
        ) : null}
      </div>

      <section className="vt-panel vt-card-glow vt-hero" data-testid="vt-hero-mission">
        <div className="vt-hero-meta">
          <span className="vt-tag" data-testid="vt-hero-difficulty">{mission?.difficulty || "beginner"}</span>
          <span className="vt-tag gold" data-testid="vt-hero-cost">Costs {cost} pts</span>
          {pointsEnabled ? (
            <span className="vt-tag gold" data-testid="vt-hero-reward-range">
              +{rewardMin}{rewardMax > rewardMin ? `–${rewardMax}` : ""} pts possible
            </span>
          ) : (
            <span className="vt-tag" data-testid="vt-hero-reward-disabled">Points reward off today</span>
          )}
          {cardEnabled ? <span className="vt-tag" data-testid="vt-hero-fvc">First Voice Card available</span> : null}
          {voucherAvailable ? <span className="vt-tag" data-testid="vt-hero-voucher">Voucher possible</span> : null}
          {passAvailable ? <span className="vt-tag" data-testid="vt-hero-pass">EduTalk Pass possible</span> : null}
        </div>
        <div className="vt-h1" data-testid="vt-hero-title">{mission?.title || "Today's Mission"}</div>
        <p className="vt-sub" data-testid="vt-hero-prompt">{mission?.prompt}</p>

        {pendingState ? (
          <div
            className="vt-balance-chip"
            data-testid="vt-pending-state"
            style={{ marginBottom: 10 }}
          >
            Pending: {pendingState}
          </div>
        ) : null}

        <button
          className="vt-btn vt-btn-gold"
          data-testid="vt-start-speaking"
          onClick={goPlay}
          disabled={limitReached && !alreadyPaid}
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          <Mic size={16} aria-hidden="true" />
          {alreadyPaid ? "Continue mission" : limitReached ? "Daily limit reached" : "Start Speaking"}
        </button>
      </section>

      <section className="vt-panel" data-testid="vt-progress-strip">
        <div className="vt-stat-grid">
          <div className="vt-stat">
            <div className="vt-stat-l">Missions completed</div>
            <div className="vt-stat-v" data-testid="vt-stat-missions">{progress?.missions_completed ?? 0}</div>
          </div>
          <div className="vt-stat">
            <div className="vt-stat-l">Best streak</div>
            <div className="vt-stat-v" data-testid="vt-stat-best-streak">{progress?.longest_streak ?? 0}</div>
          </div>
          <div className="vt-stat">
            <div className="vt-stat-l">Collection</div>
            <div className="vt-stat-v" data-testid="vt-stat-collection">{progress?.collection_count ?? 0}</div>
          </div>
        </div>
      </section>

      <div style={{ display: "flex", gap: 10 }}>
        <button
          className="vt-btn vt-btn-ghost"
          data-testid="vt-to-collection"
          onClick={() => nav("/game/voice-treasure/collection")}
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          <BookOpen size={14} aria-hidden="true" />
          Collection
        </button>
        <button
          className="vt-btn vt-btn-ghost"
          data-testid="vt-to-progress"
          onClick={() => nav("/game/voice-treasure/progress")}
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          <BarChart3 size={14} aria-hidden="true" />
          Progress
        </button>
      </div>
    </VTStage>
  );
}

function Identity({ subtitle = "" }) {
  return <VoiceTreasureIdentity subtitle={subtitle} />;
}
