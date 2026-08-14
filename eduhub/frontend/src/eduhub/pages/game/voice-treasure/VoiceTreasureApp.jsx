import { useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import * as api from "./api";
import VoiceTreasureDashboard from "./VoiceTreasureDashboard";
import VoiceTreasureEntryConfirm from "./VoiceTreasureEntryConfirm";
import VoiceTreasureMission from "./VoiceTreasureMission";
import VoiceTreasureRecorder from "./VoiceTreasureRecorder";
import VoiceTreasureEvaluation from "./VoiceTreasureEvaluation";
import VoiceTreasureResult from "./VoiceTreasureResult";
import VoiceTreasureChest from "./VoiceTreasureChest";
import VoiceTreasureRewards from "./VoiceTreasureRewards";
import VoiceTreasureCollection from "./VoiceTreasureCollection";
import VoiceTreasureProgress from "./VoiceTreasureProgress";
import VoiceTreasureUnavailable from "./VoiceTreasureUnavailable";
import "./VoiceTreasure.css";

/**
 * VoiceTreasureApp — internal router mounted at /game/voice-treasure/*.
 * Gates the whole feature on the student-safe public config: when unavailable,
 * every Voice Treasure URL renders the Unavailable screen (the Home tile is
 * hidden separately by the tile grid).
 */
export default function VoiceTreasureApp() {
  const [available, setAvailable] = useState(null); // null=loading

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await api.getConfigPublic();
        if (alive) setAvailable(!!cfg.available);
      } catch {
        if (alive) setAvailable(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  if (available === null) {
    return <div className="vt-root"><div className="vt-wrap"><div className="vt-dim">Loading…</div></div></div>;
  }
  if (!available) return <VoiceTreasureUnavailable />;

  return (
    <Routes>
      <Route index element={<VoiceTreasureDashboard />} />
      <Route path="confirm" element={<VoiceTreasureEntryConfirm />} />
      <Route path="mission" element={<VoiceTreasureMission />} />
      <Route path="record" element={<VoiceTreasureRecorder />} />
      {/* VT Pass A — Evaluation is a real, refresh-safe transient route. The
          Recorder submits once and navigates here; Evaluation polls the
          authoritative attempt and forwards to /result when ready. Direct
          links recover by reading the same backend attempt. Failure routes
          back to /record using the existing safe-retry contract (no second
          charge). */}
      <Route path="evaluation/:attemptId" element={<VoiceTreasureEvaluation />} />
      <Route path="result/:attemptId" element={<VoiceTreasureResult />} />
      <Route path="chest/:attemptId" element={<VoiceTreasureChest />} />
      <Route path="rewards" element={<VoiceTreasureRewards />} />
      <Route path="collection" element={<VoiceTreasureCollection />} />
      <Route path="progress" element={<VoiceTreasureProgress />} />
      <Route path="unavailable" element={<VoiceTreasureUnavailable />} />
      <Route path="*" element={<Navigate to="/game/voice-treasure" replace />} />
    </Routes>
  );
}
