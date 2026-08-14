/**
 * LiveCoachStartCard.jsx — pre-session card. Shows value, mode picker, cost,
 * duration and the student's current points balance BEFORE charging.
 *
 * v1.5 — adds the Khmer/English explanation-language toggle. Default is
 * Khmer because the vast majority of EduHub students are Khmer speakers.
 * The toggle controls EXPLANATION language only; practice sentences and
 * the student's own speaking answers are always English (enforced
 * server-side in edutalk_live_tools._build_system_instruction).
 */
import { Check, Coins, Clock, Mic, Sparkles, Globe } from "lucide-react";

const VALUE_LINES = [
  "Live voice conversation with your coach",
  "Real-time pronunciation correction",
  "Better sentence suggestions",
  "A personal speaking report saved to your profile",
];

export default function LiveCoachStartCard({
  modes = [],
  selectedMode,
  onSelectMode,
  balance,
  starting,
  error,
  freeTrialAvailable,
  onStart,
  // v1.5 — Khmer/English explanation language toggle.
  explainLang = "km",
  onExplainLangChange = () => {},
  // Live Voice Coach Coupon — an optional ReactNode slotted in between the
  // session summary/balance row and the Start button (required order: mode
  // selector -> benefit checklist -> session summary -> coupon -> Start
  // button -> refund note). Purely a rendered slot: this component has no
  // knowledge of coupon state/logic, so the Start button's disabled/onStart
  // wiring below is completely untouched by whatever renders here.
  couponSlot = null,
}) {
  const mode = modes.find((m) => m.key === selectedMode) || modes[0];
  const cost = freeTrialAvailable ? 0 : mode?.cost_points ?? 0;
  const mins = Math.round((mode?.duration_seconds ?? 0) / 60);

  return (
    <div data-testid="live-start-card">
      {/* v1.5 — explanation language toggle. Khmer is the default. The
          choice ONLY affects the coach's explanation language; the
          practice sentences and the student's own speaking answers are
          always English (enforced server-side). */}
      <div className="etlc-langtoggle" data-testid="live-lang-toggle">
        <div className="etlc-langtoggle__label">
          <Globe size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Coach explanation language
          <span className="etlc-langtoggle__hint">
            (practice stays in English)
          </span>
        </div>
        <div className="etlc-langtoggle__row" role="group" aria-label="Explanation language">
          <button
            type="button"
            className={`etlc-langbtn ${explainLang === "km" ? "is-active" : ""}`}
            onClick={() => onExplainLangChange("km")}
            data-testid="live-lang-km"
            aria-pressed={explainLang === "km"}
          >
            <span lang="km">ពន្យល់ជាខ្មែរ</span>
          </button>
          <button
            type="button"
            className={`etlc-langbtn ${explainLang === "en" ? "is-active" : ""}`}
            onClick={() => onExplainLangChange("en")}
            data-testid="live-lang-en"
            aria-pressed={explainLang === "en"}
          >
            Explain in English
          </button>
        </div>
      </div>

      <div className="etlc-modegrid">
        {modes.map((m) => (
          <button
            key={m.key}
            type="button"
            className={`etlc-mode ${m.key === selectedMode ? "is-active" : ""}`}
            onClick={() => onSelectMode(m.key)}
            data-testid={`live-mode-${m.key}`}
          >
            <div className="etlc-mode__name">{m.label}</div>
            <div className="etlc-mode__meta">
              {m.cost_points} pts · {Math.round(m.duration_seconds / 60)} min
            </div>
          </button>
        ))}
      </div>

      <ul className="etlc-value" data-testid="live-value-list">
        {VALUE_LINES.map((v) => (
          <li key={v}>
            <Check size={15} /> {v}
          </li>
        ))}
      </ul>

      <div className="etlc-meta-row">
        <span><Coins size={13} style={{ verticalAlign: "-2px" }} /> Session cost</span>
        <b data-testid="live-cost">
          {freeTrialAvailable ? "Free trial" : `${cost} points`}
        </b>
      </div>
      <div className="etlc-meta-row">
        <span><Clock size={13} style={{ verticalAlign: "-2px" }} /> Duration</span>
        <b>{mins} min</b>
      </div>
      <div className="etlc-meta-row">
        <span><Sparkles size={13} style={{ verticalAlign: "-2px" }} /> Mode</span>
        <b>{mode?.label}</b>
      </div>
      {balance != null && (
        <div className="etlc-meta-row">
          <span>Your balance</span>
          <b data-testid="live-balance">{balance} points</b>
        </div>
      )}

      {couponSlot}

      {error && <div className="etlc-error" data-testid="live-start-error">{error}</div>}

      <button
        type="button"
        className="etlc-btn"
        disabled={starting || !mode}
        onClick={onStart}
        data-testid="live-start-btn"
        style={{ marginTop: 12 }}
      >
        <Mic size={16} style={{ verticalAlign: "-3px", marginRight: 6 }} />
        {starting
          ? "Connecting…"
          : freeTrialAvailable
          ? "Start free trial"
          : `Start for ${cost} points`}
      </button>
      <div className="etlc-note">
        Points are reserved when you start. If the connection fails before your
        session begins, your points are refunded automatically.
      </div>
    </div>
  );
}
