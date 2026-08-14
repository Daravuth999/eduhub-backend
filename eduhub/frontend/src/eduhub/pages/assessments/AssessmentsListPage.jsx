/**
 * AssessmentsListPage.jsx — student landing page for the AI Assessment /
 * Quiz Submission Lab: published assessments the student can submit a
 * photographed/scanned worksheet against, plus their own submission
 * status per assessment (never fabricated — straight from the backend's
 * `mySubmission` field on GET /api/student/assessments).
 */
import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck, ChevronRight, Loader2, Check, AlertTriangle, Clock } from "lucide-react";
import { listAssessments } from "./assessmentApi";
import SubmitAssessmentModal from "./SubmitAssessmentModal";
import "./assessments.css";

const GOLD = "var(--eh-gold, #D4A843)";

const STATUS_META = {
  processing: { label: "Processing", color: "#9fb0c3", Icon: Loader2, spin: true },
  needs_review: { label: "Awaiting review", color: "#f0a850", Icon: AlertTriangle },
  scored: { label: "Scored", color: GOLD, Icon: Check },
  reviewed: { label: "Reviewed", color: GOLD, Icon: Check },
  awarded: { label: "🎉 Points awarded", color: "#7dd08a", Icon: Check },
  failed: { label: "Couldn't process — try again", color: "#e08a8a", Icon: AlertTriangle },
};

// Score (what was answered correctly) and Points awarded (whether the
// teacher has actually credited the wallet for it) are two different
// backend facts — this renders them as two separate lines instead of one
// blended pill so a "Scored" submission never reads as if points already
// landed in the wallet.
function StatusPill({ submission, totalPoints }) {
  if (!submission) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-white/45"
            data-testid="assessment-status-pill">
        <Clock size={12} /> Not submitted
      </span>
    );
  }
  const meta = STATUS_META[submission.status] || STATUS_META.processing;
  const { Icon } = meta;
  const awarded = submission.status === "awarded";
  const maxPoints = totalPoints ?? submission.score?.total;
  return (
    <span className="inline-flex flex-col gap-0.5" data-testid="assessment-status-pill">
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: meta.color }}>
        <Icon size={12} className={meta.spin ? "animate-spin" : undefined} /> {meta.label}
        {submission.score ? ` · ${submission.score.correct}/${submission.score.total} correct · ${submission.score.scorePct}%` : ""}
      </span>
      {submission.score && (
        <span className="text-[10.5px] text-white/45" data-testid="assessment-status-pill-points">
          Score: {submission.score.pointsEarned}/{maxPoints} pts · Points awarded: {awarded ? submission.score.pointsEarned : "0 (pending teacher approval)"}
        </span>
      )}
    </span>
  );
}

function AssessmentCard({ assessment, onOpen }) {
  const sub = assessment.mySubmission;
  const canSubmit = !sub || sub.status === "failed";
  return (
    <button onClick={() => canSubmit && onOpen(assessment)}
            disabled={!canSubmit}
            data-testid="assessment-card"
            className={`w-full text-left rounded-xl border border-white/10 bg-white/[0.04] p-4 flex items-center gap-3 ${canSubmit ? "active:scale-[0.99]" : "opacity-90"}`}>
      <div className="w-11 h-11 rounded-lg flex items-center justify-center flex-shrink-0"
           style={{ background: "rgba(212,168,67,0.14)", border: "1px solid rgba(212,168,67,0.3)" }}>
        <ClipboardCheck size={18} style={{ color: GOLD }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-bold text-white truncate">{assessment.title}</div>
        <div className="text-[11.5px] text-white/45 mb-1">
          {assessment.subject || "Assessment"} · {assessment.totalPoints} pts
        </div>
        <StatusPill submission={sub} totalPoints={assessment.totalPoints} />
      </div>
      {canSubmit && <ChevronRight size={16} className="text-white/30 flex-shrink-0" />}
    </button>
  );
}

// Four real lifecycle buckets, derived only from the backend's own
// mySubmission.status (never a client-invented state). "Results" covers
// every status that carries a real score, whether or not points have
// been awarded yet — a student wants to see how they did the moment
// it's scored, not only after a teacher acts.
function bucketOf(assessment) {
  const status = assessment.mySubmission?.status;
  if (!status || status === "failed") return "assigned";
  if (status === "processing") return "in_progress";
  if (status === "needs_review") return "submitted";
  return "results"; // scored | reviewed | awarded
}

const TABS = [
  { key: "assigned", label: "Assigned" },
  { key: "in_progress", label: "In Progress" },
  { key: "submitted", label: "Submitted" },
  { key: "results", label: "Results" },
];

export default function AssessmentsListPage() {
  const [assessments, setAssessments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [active, setActive] = useState(null);
  const [tab, setTab] = useState("assigned");

  const load = useCallback((signal) => {
    setLoading(true);
    listAssessments(signal)
      .then((rows) => setAssessments(rows))
      .catch((e) => setError(e?.message || "Could not load assessments."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const buckets = { assigned: [], in_progress: [], submitted: [], results: [] };
  for (const a of assessments) buckets[bucketOf(a)].push(a);
  const visible = buckets[tab] || [];

  return (
    <div className="asmt-theme px-4 sm:px-6 pt-5 pb-24 max-w-2xl mx-auto" data-testid="assessments-list-page">
      <div className="flex items-center gap-2 mb-1">
        <ClipboardCheck size={18} style={{ color: GOLD }} />
        <span className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: GOLD }}>
          Assessments
        </span>
      </div>
      <h1 className="text-[19px] font-bold text-white mb-4">Submit a Worksheet</h1>

      {!loading && !error && (
        <div className="flex gap-1.5 mb-4 overflow-x-auto" data-testid="assessments-tabs">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
                    data-testid={`assessments-tab-${t.key}`}
                    className={`whitespace-nowrap text-[11.5px] font-semibold px-3 py-1.5 rounded-full border ${
                      tab === t.key ? "border-amber-400/50 text-amber-300 bg-amber-400/10" : "border-white/10 text-white/50"
                    }`}>
              {t.label}{buckets[t.key].length > 0 ? ` · ${buckets[t.key].length}` : ""}
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-16" data-testid="assessments-loading">
          <Loader2 className="animate-spin text-white/40" size={22} />
        </div>
      )}

      {!loading && error && (
        <p className="text-[12.5px] text-red-300" data-testid="assessments-error">{error}</p>
      )}

      {!loading && !error && assessments.length === 0 && (
        <div className="text-center py-16 text-white/45 text-[13px]" data-testid="assessments-empty">
          No assessments are open right now. Check back soon.
        </div>
      )}

      {!loading && !error && assessments.length > 0 && visible.length === 0 && (
        <div className="text-center py-16 text-white/45 text-[13px]" data-testid="assessments-tab-empty">
          Nothing here yet.
        </div>
      )}

      {!loading && !error && visible.length > 0 && (
        <div className="space-y-2.5">
          {visible.map((a) => (
            <AssessmentCard key={a.assessmentId} assessment={a} onOpen={setActive} />
          ))}
        </div>
      )}

      <SubmitAssessmentModal
        open={!!active}
        assessment={active}
        onClose={() => setActive(null)}
        onSubmitted={() => load()}
      />
    </div>
  );
}
