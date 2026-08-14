import { useVoiceTreasureTitle, VoiceTreasureIdentity } from "./useVoiceTreasureIdentity";
import "./VoiceTreasure.css";

export default function VoiceTreasureUnavailable({ message }) {
  useVoiceTreasureTitle("Unavailable");
  return (
    <div className="vt-root" data-testid="vt-unavailable">
      <div className="vt-wrap">
        <VoiceTreasureIdentity subtitle="Unavailable" />
        <div className="vt-panel vt-card-glow" style={{ textAlign: "center", marginTop: 12 }}>
          <div className="vt-h1">Voice Treasure is not available</div>
          <p className="vt-sub" style={{ marginTop: 8 }}>
            {message || "This adventure isn't open for your account right now. Check back soon."}
          </p>
        </div>
      </div>
    </div>
  );
}
