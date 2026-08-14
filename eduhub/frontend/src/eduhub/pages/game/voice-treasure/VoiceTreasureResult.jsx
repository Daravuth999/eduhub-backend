import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as api from "./api";
import { useVoiceTreasureTitle, VoiceTreasureIdentity } from "./useVoiceTreasureIdentity";
import "./VoiceTreasure.css";

/**
 * Pass 2 premium Voice Treasure Result.
 *
 * Layout: identity → performance hero → five categories grid → coaching
 * cards (strongest skill / next improvement / coach feedback) → Open Chest
 * CTA. The five categories rendered are ONLY the supported normalized
 * categories — relevance, visual_grounding, detail, organization,
 * understandable_language. No fabricated pronunciation / fluency /
 * vocabulary / confidence scores. Bilingual rendering is applied when the
 * server-side language policy is bilingual or match-response.
 */
const CATEGORY_LABELS = {
  relevance: { en: "Relevance", km: "ភាពពាក់ព័ន្ធ" },
  visual_grounding: { en: "Visual grounding", km: "សំអាងលើរូបភាព" },
  detail: { en: "Detail", km: "ព័ត៌មានលំអិត" },
  organization: { en: "Organization", km: "រចនាសម្ព័ន្ធ" },
  understandable_language: { en: "Understandable language", km: "ភាសាងាយយល់" },
};
const ORDER = ["relevance", "visual_grounding", "detail", "organization", "understandable_language"];

export default function VoiceTreasureResult() {
  useVoiceTreasureTitle("Result");
  const nav = useNavigate();
  const { attemptId } = useParams();
  const [r, setR] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const x = await api.getAttempt(attemptId);
        if (!alive) return;
        setR(x);
      } catch (e) {
        if (alive) setError(e?.message || "Could not load result.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [attemptId]);

  if (loading) return <Shell><div className="vt-dim" data-testid="vt-result-loading">Loading…</div></Shell>;
  if (error) return <Shell><div className="vt-error" data-testid="vt-result-error">{error}</div></Shell>;

  const attempt = r?.attempt || r || {};
  const result = attempt.result || {};
  const scores = result.scores || {};
  const overall = result.overall ?? null;
  const fb = result.coach_feedback || "";
  const strongest = result.strongest_skill || "";
  const nextImp = result.next_improvement || "";
  const lang = (r?.language_policy?.feedback_language) || "english";
  const bilingual = lang === "bilingual";
  const km = lang === "khmer";

  return (
    <Shell>
      {/* Pass A.1 — expose the resolved language policy at the test surface
          so mounted tests can pin the actual UI branch. Internal selector
          values (english | khmer | bilingual | match) are server-derived. */}
      <div
        data-testid="vt-result"
        data-language={lang}
        data-feedback-language={lang}
        style={{ display: "contents" }}
      >
      <section className="vt-panel vt-card-glow" data-testid="vt-result-hero">
        <div className="vt-h1" data-testid="vt-result-title">
          {km ? "លទ្ធផល" : bilingual ? "Your result · លទ្ធផល" : "Your result"}
        </div>
        {overall != null ? (
          <div data-testid="vt-result-overall" style={{ fontSize: 44, fontWeight: 900, color: "#ffe19a", lineHeight: 1 }}>
            {Math.round(overall)}
          </div>
        ) : null}
        <p className="vt-sub" data-testid="vt-result-summary">
          {result.understanding_summary || (km ? "ល្អណាស់!" : "Good speaking work.")}
        </p>
      </section>

      <section className="vt-panel" data-testid="vt-result-categories">
        <div className="vt-h1" style={{ fontSize: 16 }} data-testid="vt-result-categories-title">
          {bilingual ? "Skill breakdown · បំបែកជំនាញ" : km ? "បំបែកជំនាញ" : "Skill breakdown"}
        </div>
        <div className="vt-cat-grid">
          {ORDER.map((k) => {
            const v = Math.max(0, Math.min(100, Number(scores[k] ?? 0)));
            const label = CATEGORY_LABELS[k];
            return (
              <div className="vt-cat" key={k} data-testid={`vt-cat-${k}`}>
                <div className="vt-cat-l">{km ? label.km : label.en}</div>
                <div className="vt-cat-bar"><i style={{ width: `${v}%` }} /></div>
                <div className="vt-cat-v">{v}</div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="vt-panel vt-coach" data-testid="vt-result-coaching">
        {strongest ? (
          <div className="vt-coach-card" data-testid="vt-coach-strongest">
            <div className="vt-coach-l">{km ? "ជំនាញខ្លាំងបំផុត" : bilingual ? "Strongest skill · ជំនាញខ្លាំងបំផុត" : "Strongest skill"}</div>
            <div className="vt-coach-v" lang={km ? "km" : undefined}>{strongest}</div>
          </div>
        ) : null}
        {nextImp ? (
          <div className="vt-coach-card" data-testid="vt-coach-next">
            <div className="vt-coach-l">{km ? "កែលំអបន្ទាប់" : bilingual ? "Next improvement · កែលំអបន្ទាប់" : "Next improvement"}</div>
            <div className="vt-coach-v" lang={km ? "km" : undefined}>{nextImp}</div>
          </div>
        ) : null}
        {fb ? (
          <div className="vt-coach-card" data-testid="vt-coach-feedback">
            <div className="vt-coach-l">{km ? "មតិពីគ្រូ" : bilingual ? "Coach feedback · មតិពីគ្រូ" : "Coach feedback"}</div>
            <div className="vt-coach-v" lang={km ? "km" : undefined}>{fb}</div>
          </div>
        ) : null}
      </section>

      <button
        className="vt-btn vt-btn-gold"
        data-testid="vt-open-chest-cta"
        onClick={() => nav(`/game/voice-treasure/chest/${encodeURIComponent(attempt.attempt_id || attemptId)}`)}
      >
        {km ? "បើកសម្បកនិទាន" : "Open your treasure chest"}
      </button>
      </div>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="vt-root">
      <div className="vt-wrap">
        <VoiceTreasureIdentity subtitle="Coaching result" />
        {children}
      </div>
    </div>
  );
}
