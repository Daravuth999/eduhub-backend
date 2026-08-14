/**
 * LiveCoachReportCard.jsx — post-session report card.
 *
 * BUG 5/6 upgrade — the backend now generates bilingual (English + Khmer)
 * pronunciation_focus/mistake_explanation/coaching_note/next_mission/
 * summary fields (edutalk_live_tools.py's _build_report_prompt). This
 * component adds an EN/KM toggle so the student reads their report in
 * whichever language they prefer — this directly implements the "Khmer
 * Explanation" / "English Explanation" post-session actions. Every new
 * field is read defensively (falls back to whichever language variant IS
 * present) so an OLDER report saved before this upgrade — which has none
 * of the *_km fields — still renders exactly as it did before, with no
 * broken toggle and no visible "undefined".
 */
import { useState } from "react";
import { Award, Target, Trophy, Wand2, AlertTriangle, Clock3, Lightbulb, MessageCircleHeart } from "lucide-react";

function RefundBanner({ refundState }) {
  if (!refundState || refundState === "refunded" || refundState === "none") return null;
  const pending = refundState === "refund_pending" || refundState === "refund_processing";
  return (
    <div
      data-testid="live-refund-banner"
      style={{
        display: "flex", gap: 8, alignItems: "flex-start",
        fontSize: 12.5, lineHeight: 1.5, borderRadius: 12, padding: "10px 12px",
        margin: "10px 0",
        background: pending ? "rgba(234,179,8,0.12)" : "rgba(244,63,94,0.12)",
        border: `1px solid ${pending ? "rgba(234,179,8,0.4)" : "rgba(244,63,94,0.4)"}`,
        color: pending ? "#fde68a" : "#fda4af",
      }}
    >
      {pending ? <Clock3 size={15} style={{ flex: "none", marginTop: 1 }} />
               : <AlertTriangle size={15} style={{ flex: "none", marginTop: 1 }} />}
      <span>
        {pending
          ? "Your points refund is being processed and will be returned to your balance shortly."
          : "We couldn't return your points automatically yet. They are safely queued for refund — if they don't reappear soon, please contact support."}
      </span>
    </div>
  );
}

function LangToggle({ lang, onChange, hasKhmer }) {
  if (!hasKhmer) return null;
  const pill = (value, label) => (
    <button
      type="button"
      onClick={() => onChange(value)}
      data-testid={`live-report-lang-${value}`}
      aria-pressed={lang === value}
      style={{
        padding: "4px 11px",
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 700,
        border: "1px solid rgba(94, 234, 212, 0.4)",
        background: lang === value ? "rgba(45, 212, 191, 0.28)" : "transparent",
        color: lang === value ? "#5eead4" : "rgba(226, 246, 243, 0.7)",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 10 }} data-testid="live-report-lang-toggle">
      {pill("en", "English")}
      {pill("km", "ខ្មែរ")}
    </div>
  );
}

/** Reads a bilingual field pair, always falling back to whichever variant
 * actually has content — never blank just because the OTHER language was
 * requested and this particular field only has one variant (e.g. an
 * older pre-upgrade report, or a Gemini response that dropped one key). */
function bi(report, lang, enKey, kmKey) {
  const en = report[enKey];
  const km = report[kmKey];
  if (lang === "km") return km || en || "";
  return en || km || "";
}

export default function LiveCoachReportCard({
  report, pointsCharged, refundState, explainLang, onClose, onPracticeAgain,
}) {
  const [lang, setLang] = useState(explainLang === "km" ? "km" : "en");

  if (!report) {
    return (
      <div data-testid="live-report-empty" className="etlc-report-block">
        <RefundBanner refundState={refundState} />
        <p>Your session has ended. No report was generated for this session.</p>
        <button type="button" className="etlc-btn etlc-btn--ghost" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  const corrected = Array.isArray(report.corrected_sentences)
    ? report.corrected_sentences
    : [];
  const hasKhmer = Boolean(
    report.summary_km || report.pronunciation_focus_km
    || report.mistake_explanation_km || report.coaching_note_km || report.next_mission_km,
  );

  const pronunciationFocus = bi(report, lang, "pronunciation_focus", "pronunciation_focus_km");
  const mistakeExplanation = bi(report, lang, "mistake_explanation", "mistake_explanation_km");
  const coachingNote = bi(report, lang, "coaching_note", "coaching_note_km");
  const nextMission = bi(report, lang, "next_mission", "next_mission_km");
  const summary = bi(report, lang, "summary", "summary_km");

  return (
    <div data-testid="live-report-card">
      <RefundBanner refundState={refundState} />
      <LangToggle lang={lang} onChange={setLang} hasKhmer={hasKhmer} />

      <div className="etlc-scores">
        <div className="etlc-score">
          <div className="etlc-score__num" data-testid="live-confidence">
            {report.confidence_score ?? "—"}
          </div>
          <div className="etlc-score__lbl">Confidence</div>
        </div>
        <div className="etlc-score">
          <div className="etlc-score__num" data-testid="live-clarity">
            {report.clarity_score ?? "—"}
          </div>
          <div className="etlc-score__lbl">Clarity</div>
        </div>
      </div>

      {pronunciationFocus && (
        <div className="etlc-report-block">
          <h4><Target size={12} style={{ verticalAlign: "-1px" }} /> Pronunciation focus</h4>
          <span className="etlc-chip" data-testid="live-report-pronunciation-focus">{pronunciationFocus}</span>
        </div>
      )}

      {corrected.length > 0 && (
        <div className="etlc-report-block" data-testid="live-report-corrections">
          <h4><Wand2 size={12} style={{ verticalAlign: "-1px" }} /> Corrected sentences</h4>
          <ul style={{ paddingLeft: 16, margin: 0 }}>
            {corrected.map((c, i) => (
              <li key={i}>{typeof c === "string" ? c : JSON.stringify(c)}</li>
            ))}
          </ul>
        </div>
      )}

      {mistakeExplanation && (
        <div className="etlc-report-block" data-testid="live-report-mistake-explanation">
          <h4><Lightbulb size={12} style={{ verticalAlign: "-1px" }} /> Why this happened</h4>
          <p>{mistakeExplanation}</p>
        </div>
      )}

      {report.best_sentence && (
        <div className="etlc-report-block">
          <h4><Trophy size={12} style={{ verticalAlign: "-1px" }} /> Your best sentence</h4>
          <p>“{report.best_sentence}”</p>
        </div>
      )}

      {report.improved_sentence && (
        <div className="etlc-report-block">
          <h4>Make it even better</h4>
          <p>“{report.improved_sentence}”</p>
        </div>
      )}

      {coachingNote && (
        <div className="etlc-report-block" data-testid="live-report-coaching-note">
          <h4><MessageCircleHeart size={12} style={{ verticalAlign: "-1px" }} /> Coach's note</h4>
          <p>{coachingNote}</p>
        </div>
      )}

      {nextMission && (
        <div className="etlc-report-block">
          <h4><Award size={12} style={{ verticalAlign: "-1px" }} /> Next practice mission</h4>
          <p>{nextMission}</p>
        </div>
      )}

      {summary && (
        <div className="etlc-report-block">
          <p style={{ color: "#a5f3fc" }}>{summary}</p>
        </div>
      )}

      <div className="etlc-meta-row" style={{ marginTop: 10 }}>
        <span>Points charged</span>
        <b data-testid="live-report-charged">{pointsCharged ?? report.points_charged ?? 0} points</b>
      </div>

      <div style={{ display: "flex", gap: 9, marginTop: 12, flexWrap: "wrap" }}>
        <button type="button" className="etlc-btn etlc-btn--ghost" onClick={onClose} data-testid="live-report-close">
          Close
        </button>
        <button type="button" className="etlc-btn" onClick={onPracticeAgain} data-testid="live-report-again">
          Practice again
        </button>
      </div>
    </div>
  );
}
