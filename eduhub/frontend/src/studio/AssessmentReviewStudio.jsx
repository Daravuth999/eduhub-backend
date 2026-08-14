/**
 * AssessmentReviewStudio.jsx — Author Studio panel for the AI Assessment /
 * Quiz Submission Lab.
 *
 * Composed from three existing precedents (no single file in this
 * codebase already does all of this):
 *   - filter/stats shell            -> ReceiptManagementStudio.jsx
 *   - per-row busy state            -> PasswordResetRequestsPanel.jsx's busyId
 *   - status badge + guarded action -> SyncReviewStudio.jsx's reviewStatus ternary
 * Bulk-select checkboxes + "N selected" bar have no precedent anywhere in
 * this codebase (confirmed by search) and are built fresh here: a
 * `selectedIds` Set, one checkbox per row, and a sticky bulk-award bar that
 * calls the SAME single-award endpoint per id (bulkAwardAssessmentSubmissions
 * on the backend already loops the identical _award_one function server-
 * side — no separate bulk logic invented on either side).
 */
import { useCallback, useEffect, useState } from "react";
import {
  ClipboardList, Loader2, Check, AlertTriangle, Coins, RefreshCcw,
  Upload, Plus, ChevronDown, ChevronUp, X as XIcon, Wallet, Bell, RotateCcw,
  Pencil, ExternalLink, Trash2, HelpCircle,
} from "lucide-react";
import {
  extractAssessmentAnswerKey, createAssessment, listAssessments as apiListAssessments,
  listAssessmentSubmissions, awardAssessmentSubmission, bulkAwardAssessmentSubmissions,
  retryAssessmentGasSync, correctAssessmentSubmission, deleteAssessmentSubmission,
} from "./api";

// needs_review means "a teacher should look" — it is still awardable with
// its exact persisted calculated score, never a dead end.
const AWARDABLE_STATUSES = ["needs_review", "scored", "reviewed"];

const STATUS_STYLE = {
  processing: "text-slate-300 border-slate-400/40 bg-slate-400/10",
  needs_review: "text-amber-300 border-amber-400/40 bg-amber-400/10",
  scored: "text-sky-300 border-sky-400/40 bg-sky-400/10",
  reviewed: "text-sky-300 border-sky-400/40 bg-sky-400/10",
  awarded: "text-emerald-300 border-emerald-400/40 bg-emerald-400/10",
  failed: "text-red-300 border-red-400/40 bg-red-400/10",
};

function StatusBadge({ status }) {
  return (
    <span
      className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${STATUS_STYLE[status] || STATUS_STYLE.processing}`}
      data-testid="assessment-submission-status-badge"
    >
      {status}
    </span>
  );
}

/** Per-question given-vs-correct breakdown, straight from the persisted
 * submission's own score.details (assessment_scoring.py's real output —
 * nothing computed here). This is the direct diagnostic for "the student
 * really answered X but it scored as wrong" — including the exact raw
 * text Gemini extracted per question, so a mismatched vocabulary (e.g.
 * the prompt word instead of a LONG/SHORT classification) is visible at
 * a glance instead of an unexplained 0. */
const STATE_BADGE = {
  blank: { label: "blank", cls: "text-slate-300 border-slate-400/40 bg-slate-400/10" },
  uncertain: { label: "uncertain", cls: "text-amber-300 border-amber-400/40 bg-amber-400/10" },
};

function AnswerStateBadge({ state }) {
  const meta = STATE_BADGE[state];
  if (!meta) return null;
  return (
    <span className={`ml-1 text-[9px] font-bold uppercase px-1.5 py-px rounded-full border ${meta.cls}`}
          data-testid="assessment-answer-state-badge">
      {meta.label}
    </span>
  );
}

/** One correctable row: shows the prompt, what Gemini read (with its
 * physical answer state + confidence) and the answer key, plus an inline
 * teacher-correction editor. Applying a correction calls the backend's
 * /correct endpoint, which recalculates the deterministic score and
 * preserves the original Gemini extraction untouched. */
function DetailRow({ d, submissionId, locked, onCorrected }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const apply = async () => {
    setBusy(true);
    setErr(null);
    try {
      await correctAssessmentSubmission(submissionId, [{ qid: d.qid, answer: value.trim() }]);
      setEditing(false);
      onCorrected?.();
    } catch (e) {
      setErr(e.message || "Correction failed.");
    } finally {
      setBusy(false);
    }
  };

  const confPct = typeof d.confidence === "number" ? `${Math.round(d.confidence * 100)}%` : null;
  return (
    <>
      <tr className="border-t border-white/5" data-testid="assessment-submission-detail-row">
        <td className="pr-2 py-1 text-white/70 truncate max-w-[120px]">{d.prompt}</td>
        <td className="pr-2 py-1 text-white/80">
          {d.givenAnswer ?? <span className="text-white/30">—</span>}
          <AnswerStateBadge state={d.answerState} />
          {d.source === "teacher" && (
            <span className="ml-1 text-[9px] font-bold uppercase px-1.5 py-px rounded-full border text-sky-300 border-sky-400/40 bg-sky-400/10">
              teacher
            </span>
          )}
        </td>
        <td className="pr-2 py-1 text-white/50">{d.correctAnswer}</td>
        <td className="pr-2 py-1 text-white/40 whitespace-nowrap">{confPct || ""}</td>
        <td className="pr-2 py-1">
          {d.correct
            ? <Check size={12} className="text-emerald-400" />
            : d.answerState === "uncertain"
              ? <HelpCircle size={12} className="text-amber-400" />
              : <XIcon size={12} className="text-red-400" />}
        </td>
        <td className="py-1">
          {!locked && (
            <button onClick={() => { setEditing((v) => !v); setValue(d.givenAnswer || ""); setErr(null); }}
                    aria-label={`Correct ${d.prompt}`}
                    data-testid="assessment-correct-toggle-button"
                    className="p-1 text-white/35 hover:text-amber-300">
              <Pencil size={11} />
            </button>
          )}
        </td>
      </tr>
      {editing && (
        <tr className="border-t border-white/5 bg-amber-400/[0.04]" data-testid="assessment-correction-editor-row">
          <td colSpan={6} className="py-1.5 pr-2">
            <div className="flex items-center gap-2 pl-1">
              <span className="text-[10.5px] text-white/45">Teacher final answer:</span>
              <input value={value} onChange={(e) => setValue(e.target.value)}
                     data-testid="assessment-correction-input"
                     placeholder={d.correctAnswer}
                     className="flex-1 max-w-[160px] rounded bg-black/30 border border-amber-400/30 px-2 py-1 text-[11.5px] text-white" />
              <button onClick={apply} disabled={busy}
                      data-testid="assessment-apply-correction-button"
                      className="inline-flex items-center gap-1 text-[10.5px] font-bold text-black bg-amber-400 rounded px-2 py-1 disabled:opacity-50">
                {busy ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />} Apply Correction
              </button>
              {err && <span className="text-[10.5px] text-red-300">{err}</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function SubmissionDetail({ submission, onChanged }) {
  const details = submission?.score?.details || [];
  const extraction = submission?.extraction;
  const corrections = submission?.teacherCorrections || [];
  const correctionCount = corrections.filter((c) => typeof c === "object").length || corrections.length;
  const locked = submission?.status === "awarded";
  return (
    <div className="mt-2 pt-2 border-t border-white/10 space-y-2" data-testid="assessment-submission-detail">
      {extraction && (
        <div className="text-[10.5px] text-white/40" data-testid="assessment-submission-extraction-meta">
          Engine: {extraction.engine || "—"}{extraction.model ? ` · Model: ${extraction.model}` : ""}
          {extraction.extractedAt ? ` · Extracted: ${extraction.extractedAt}` : ""} · Gemini returned {extraction.rawAnswerCount} answer(s),
          {" "}{extraction.normalizedAnswerCount} matched a known question.
          {extraction.verification?.checkedQids?.length
            ? ` Verification pass re-checked ${extraction.verification.checkedQids.length} question(s).`
            : ""}
        </div>
      )}
      {submission?.mediaRef && (
        <a href={submission.mediaRef} target="_blank" rel="noreferrer"
           data-testid="assessment-view-original-paper"
           className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-sky-300 hover:text-sky-200">
          <ExternalLink size={11} /> View original paper (R2 evidence)
        </a>
      )}
      {correctionCount > 0 && (
        <div className="text-[10.5px] text-sky-300/80" data-testid="assessment-corrections-count">
          {correctionCount} teacher correction(s) applied — original Gemini extraction preserved.
        </div>
      )}
      {details.length === 0 ? (
        <div className="text-[11px] text-white/35">No extracted-answer detail available.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-white/40 text-left">
                <th className="font-medium pr-2 py-1">Prompt</th>
                <th className="font-medium pr-2 py-1">Given</th>
                <th className="font-medium pr-2 py-1">Correct</th>
                <th className="font-medium pr-2 py-1">Conf</th>
                <th className="font-medium pr-2 py-1"></th>
                <th className="font-medium py-1"></th>
              </tr>
            </thead>
            <tbody>
              {details.map((d) => (
                <DetailRow key={d.qid} d={d} submissionId={submission.submissionId}
                           locked={locked} onCorrected={onChanged} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Proves "AWARDED" is real, not just a status label. `submission.award`
 * is the exact outcome persisted by the backend at credit time — the
 * WALLET line reflects the real points_wallets.credit() result (the
 * actual money movement); the legacy-balance line and notification line
 * are separate, honestly-tracked downstream concerns that can fail
 * without the wallet credit ever being reversed. A failed legacy sync
 * offers "Retry sync", which re-attempts ONLY that leg — never a second
 * wallet credit. */
function AwardProof({ submission, onSynced }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const award = submission?.award;
  if (submission?.status !== "awarded" || !award) return null;

  const retrySync = async () => {
    setBusy(true);
    setErr(null);
    try {
      await retryAssessmentGasSync(submission.submissionId);
      onSynced?.();
    } catch (e) {
      setErr(e.message || "Retry failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 pt-2 border-t border-white/10 space-y-1" data-testid="assessment-award-proof">
      <div className="flex items-center gap-1.5 text-[11px] text-emerald-300">
        <Wallet size={12} />
        {award.pointsCredited} pts credited · student balance updated
        {typeof award.balanceAfter === "number" ? ` (now ${award.balanceAfter})` : ""}
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-white/50">
        <Bell size={12} />
        Notification {award.notifiedAt ? "sent" : "pending"}
      </div>
      {award.gasSynced === false ? (
        <div className="flex items-center gap-1.5 text-[11px] text-amber-300" data-testid="assessment-award-gas-sync-failed">
          <AlertTriangle size={12} />
          Legacy points-pill sync failed{award.gasSyncError ? ` (${award.gasSyncError})` : ""} — the
          real wallet credit above is unaffected.
          <button onClick={retrySync} disabled={busy}
                  data-testid="assessment-retry-gas-sync-button"
                  className="inline-flex items-center gap-1 text-amber-200 underline disabled:opacity-50">
            {busy ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />} Retry sync
          </button>
        </div>
      ) : award.gasSynced === true ? (
        <div className="flex items-center gap-1.5 text-[11px] text-white/40">
          <Check size={12} className="text-emerald-400" /> Legacy points pill synced
        </div>
      ) : null}
      {err && <p className="text-[11px] text-red-300">{err}</p>}
    </div>
  );
}

// ── answer-key extraction + create flow ───────────────────────────────────
function CreateAssessmentPanel({ onCreated }) {
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [questions, setQuestions] = useState([]);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const handleFile = async (file) => {
    if (!file) return;
    setErr(null);
    setExtracting(true);
    try {
      const result = await extractAssessmentAnswerKey(file);
      setQuestions(result.questions || []);
      if (!title) setTitle(file.name.replace(/\.[a-z0-9]+$/i, ""));
    } catch (e) {
      setErr(e.message || "Extraction failed.");
    } finally {
      setExtracting(false);
    }
  };

  const updateQuestion = (i, patch) => {
    setQuestions((qs) => qs.map((q, idx) => (idx === i ? { ...q, ...patch } : q)));
  };

  const save = async (publish) => {
    if (!title.trim() || questions.length === 0) return;
    setSaving(true);
    setErr(null);
    try {
      const payload = {
        title, subject,
        questions: questions.map((q, i) => ({
          qid: q.qid || `q${i + 1}`,
          prompt: q.prompt,
          correctAnswer: q.correctAnswer,
          points: Number(q.points) || 1,
        })),
        publish,
      };
      await createAssessment(payload);
      setTitle(""); setSubject(""); setQuestions([]);
      onCreated?.();
    } catch (e) {
      setErr(e.message || "Could not save assessment.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3" data-testid="assessment-create-panel">
      <div className="flex items-center gap-2 text-white font-bold text-[13.5px]">
        <Plus size={15} /> New Assessment
      </div>
      <label className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-white/20 py-4 text-[12.5px] text-white/55 cursor-pointer hover:border-white/40">
        <Upload size={14} />
        {extracting ? "Extracting…" : "Upload an answer key (image, PDF, or .docx)"}
        <input type="file" className="hidden" accept="image/*,application/pdf,.docx"
               data-testid="assessment-key-file-input"
               onChange={(e) => handleFile(e.target.files?.[0])} disabled={extracting} />
      </label>
      {err && <p className="text-[12px] text-red-300">{err}</p>}

      {questions.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title"
                   data-testid="assessment-title-input"
                   className="rounded-lg bg-black/30 border border-white/10 px-2.5 py-1.5 text-[13px] text-white" />
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject (optional)"
                   className="rounded-lg bg-black/30 border border-white/10 px-2.5 py-1.5 text-[13px] text-white" />
          </div>
          <div className="max-h-64 overflow-y-auto space-y-1.5" data-testid="assessment-question-editor">
            {questions.map((q, i) => (
              <div key={q.qid || i} className="flex items-center gap-1.5 text-[12px]">
                <span className="w-5 text-white/40">{i + 1}.</span>
                <input value={q.prompt || ""} onChange={(e) => updateQuestion(i, { prompt: e.target.value })}
                       className="flex-1 rounded bg-black/30 border border-white/10 px-2 py-1 text-white" />
                <input value={q.correctAnswer || q.answer || ""}
                       onChange={(e) => updateQuestion(i, { correctAnswer: e.target.value })}
                       className="w-24 rounded bg-black/30 border border-white/10 px-2 py-1 text-white" />
                <input type="number" step="0.5" value={q.points ?? 1}
                       onChange={(e) => updateQuestion(i, { points: e.target.value })}
                       className="w-14 rounded bg-black/30 border border-white/10 px-2 py-1 text-white" />
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={() => save(true)} disabled={saving}
                    data-testid="assessment-save-publish-button"
                    className="flex-1 py-2 rounded-lg text-[12.5px] font-bold text-black bg-amber-400 disabled:opacity-50">
              {saving ? <Loader2 size={13} className="animate-spin inline" /> : "Save & Publish"}
            </button>
            <button onClick={() => save(false)} disabled={saving}
                    data-testid="assessment-save-draft-button"
                    className="py-2 px-3 rounded-lg text-[12.5px] font-semibold text-white/70 border border-white/15">
              Save Draft
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── submissions review + award ────────────────────────────────────────────
function SubmissionsPanel({ assessment, onChanged }) {
  const [submissions, setSubmissions] = useState([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const refresh = useCallback(() => {
    if (!assessment) return;
    setLoading(true);
    listAssessmentSubmissions(assessment.assessmentId, statusFilter || undefined)
      .then((res) => setSubmissions(res.submissions || []))
      .catch((e) => setErr(e.message || "Failed to load submissions."))
      .finally(() => setLoading(false));
  }, [assessment, statusFilter]);

  useEffect(() => { refresh(); setSelectedIds(new Set()); }, [refresh]);

  if (!assessment) {
    return <div className="text-center text-white/40 text-[12.5px] py-10">Select an assessment to review submissions.</div>;
  }

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const awardOne = async (submissionId) => {
    setBusyId(submissionId);
    setErr(null);
    try {
      await awardAssessmentSubmission(submissionId);
      refresh();
      onChanged?.();
    } catch (e) {
      setErr(e.message || "Award failed.");
    } finally {
      setBusyId(null);
    }
  };

  const awardSelected = async () => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    setErr(null);
    try {
      await bulkAwardAssessmentSubmissions(Array.from(selectedIds));
      setSelectedIds(new Set());
      refresh();
      onChanged?.();
    } catch (e) {
      setErr(e.message || "Bulk award failed.");
    } finally {
      setBulkBusy(false);
    }
  };

  const removeOne = async (submissionId) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm("Delete this submission? The original paper in R2 will also be permanently deleted.")) return;
    setBusyId(submissionId);
    setErr(null);
    try {
      await deleteAssessmentSubmission(submissionId);
      refresh();
      onChanged?.();
    } catch (e) {
      setErr(e.message || "Delete failed.");
    } finally {
      setBusyId(null);
    }
  };

  const awardable = submissions.filter((s) => AWARDABLE_STATUSES.includes(s.status));

  return (
    <div className="space-y-3" data-testid="assessment-submissions-panel">
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1.5">
          {["", "needs_review", "scored", "reviewed", "awarded", "failed"].map((s) => (
            <button key={s || "all"} onClick={() => setStatusFilter(s)}
                    className={`text-[11px] px-2.5 py-1 rounded-full border ${statusFilter === s ? "border-amber-400/50 text-amber-300 bg-amber-400/10" : "border-white/10 text-white/50"}`}>
              {s || "All"}
            </button>
          ))}
        </div>
        <button onClick={refresh} className="text-white/40 hover:text-white" aria-label="Refresh">
          <RefreshCcw size={14} className={loading ? "animate-spin" : undefined} />
        </button>
      </div>

      {err && <p className="text-[12px] text-red-300">{err}</p>}

      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2"
             data-testid="assessment-bulk-award-bar">
          <span className="text-[12.5px] font-semibold text-amber-200">{selectedIds.size} selected</span>
          <button onClick={awardSelected} disabled={bulkBusy}
                  data-testid="assessment-bulk-award-button"
                  className="inline-flex items-center gap-1.5 text-[12px] font-bold text-black bg-amber-400 rounded-lg px-3 py-1.5 disabled:opacity-50">
            {bulkBusy ? <Loader2 size={13} className="animate-spin" /> : <Coins size={13} />} Award Points
          </button>
        </div>
      )}

      <div className="space-y-1.5">
        {submissions.map((s) => (
          <div key={s.submissionId} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2"
               data-testid="assessment-submission-row">
            <div className="flex items-center gap-2.5">
              <input type="checkbox" checked={selectedIds.has(s.submissionId)}
                     onChange={() => toggleSelect(s.submissionId)}
                     disabled={!AWARDABLE_STATUSES.includes(s.status)}
                     data-testid="assessment-submission-checkbox"
                     className="accent-amber-400" />
              <button
                onClick={() => setExpandedId((id) => (id === s.submissionId ? null : s.submissionId))}
                data-testid="assessment-submission-expand-button"
                className="flex-1 min-w-0 text-left"
              >
                <div className="text-[12.5px] font-semibold text-white truncate">{s.cleanId || s.studentId}</div>
                {s.score && (
                  <div className="text-[11px] text-white/45">
                    {s.score.correct}/{s.score.total} correct · {s.score.scorePct}% · {s.score.pointsEarned} pts
                    {s.status === "awarded" ? " · points awarded" : " · not yet awarded"}
                  </div>
                )}
              </button>
              <StatusBadge status={s.status} />
              {AWARDABLE_STATUSES.includes(s.status) && s.score && (
                <button onClick={() => awardOne(s.submissionId)} disabled={busyId === s.submissionId}
                        data-testid="assessment-award-button"
                        className="inline-flex items-center gap-1 text-[11.5px] font-bold text-black bg-amber-400 rounded-lg px-2.5 py-1.5 disabled:opacity-50">
                  {busyId === s.submissionId ? <Loader2 size={12} className="animate-spin" /> : <Coins size={12} />} Award {s.score.pointsEarned} pts
                </button>
              )}
              {s.status === "awarded" && <Check size={16} className="text-emerald-400" />}
              {s.status === "needs_review" && <AlertTriangle size={15} className="text-amber-400" />}
              {s.status !== "awarded" && (
                <button onClick={() => removeOne(s.submissionId)} disabled={busyId === s.submissionId}
                        aria-label="Delete submission" data-testid="assessment-delete-submission-button"
                        className="p-1 text-white/25 hover:text-red-400 disabled:opacity-50">
                  <Trash2 size={13} />
                </button>
              )}
              <button onClick={() => setExpandedId((id) => (id === s.submissionId ? null : s.submissionId))}
                      aria-label="Toggle detail" className="text-white/30 hover:text-white/60">
                {expandedId === s.submissionId ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            </div>
            <AwardProof submission={s} onSynced={refresh} />
            {expandedId === s.submissionId && (
              <SubmissionDetail submission={s} onChanged={() => { refresh(); onChanged?.(); }} />
            )}
          </div>
        ))}
        {!loading && submissions.length === 0 && (
          <div className="text-center text-white/35 text-[12px] py-8">No submissions yet.</div>
        )}
      </div>
      {awardable.length === 0 && submissions.length > 0 && (
        <p className="text-[11px] text-white/35">
          Submissions with a calculated score ("needs_review", "scored" or "reviewed") can be awarded.
        </p>
      )}
    </div>
  );
}

export default function AssessmentReviewStudio() {
  const [assessments, setAssessments] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAnswerKey, setShowAnswerKey] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    apiListAssessments()
      .then((res) => setAssessments(res.assessments || []))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="p-4 sm:p-6 space-y-5" data-testid="assessment-review-studio">
      <div className="flex items-center gap-2 text-white font-bold text-[16px]">
        <ClipboardList size={18} className="text-amber-400" /> Assessment Lab
      </div>

      <CreateAssessmentPanel onCreated={refresh} />

      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
        <div className="text-[13px] font-bold text-white">Assessments</div>
        {loading ? (
          <Loader2 size={16} className="animate-spin text-white/40" />
        ) : (
          <div className="space-y-1.5">
            {assessments.map((a) => (
              <button key={a.assessmentId}
                      onClick={() => { setSelected(a); setShowAnswerKey(false); }}
                      data-testid="assessment-select-row"
                      className={`w-full flex items-center justify-between text-left px-3 py-2 rounded-lg border ${selected?.assessmentId === a.assessmentId ? "border-amber-400/50 bg-amber-400/10" : "border-white/10 bg-black/20"}`}>
                <span className="text-[12.5px] font-semibold text-white truncate">{a.title}</span>
                <span className="flex items-center gap-2 text-[10.5px] text-white/40">
                  {a.status} · {a.totalPoints} pts <ChevronDown size={12} />
                </span>
              </button>
            ))}
            {assessments.length === 0 && (
              <div className="text-center text-white/35 text-[12px] py-4">No assessments yet — create one above.</div>
            )}
          </div>
        )}

        {selected && (
          <div>
            <button onClick={() => setShowAnswerKey((v) => !v)}
                    data-testid="assessment-view-answer-key-button"
                    className="text-[11.5px] font-semibold text-amber-300 hover:text-amber-200">
              {showAnswerKey ? "Hide" : "View"} answer key ({(selected.questions || []).length} questions)
            </button>
            {showAnswerKey && (
              <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-2"
                   data-testid="assessment-answer-key-view">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-white/40 text-left">
                      <th className="font-medium pr-2 py-1">#</th>
                      <th className="font-medium pr-2 py-1">Prompt</th>
                      <th className="font-medium pr-2 py-1">Correct Answer</th>
                      <th className="font-medium pr-2 py-1">Pts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(selected.questions || []).map((q, i) => (
                      <tr key={q.qid} className="border-t border-white/5" data-testid="assessment-answer-key-row">
                        <td className="pr-2 py-1 text-white/40">{i + 1}</td>
                        <td className="pr-2 py-1 text-white/70">{q.prompt}</td>
                        <td className="pr-2 py-1 text-white font-semibold">{q.correctAnswer}</td>
                        <td className="pr-2 py-1 text-white/50">{q.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div className="text-[13px] font-bold text-white mb-3">Submissions</div>
        <SubmissionsPanel assessment={selected} onChanged={refresh} />
      </div>
    </div>
  );
}
