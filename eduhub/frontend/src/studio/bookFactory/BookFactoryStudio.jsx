/**
 * BookFactoryStudio.jsx — the ONLY Book Factory file imported by StudioPage
 * (via React.lazy). Orchestrates: config → blueprint → EXPLICIT approval →
 * bounded chapter generation → review → safe handoff.
 *
 * Safety:
 *  - Generate is enabled only when the backend confirms enabled AND geminiEnabled.
 *  - A synchronous submit-lock ref blocks rapid double-clicks before rerender.
 *  - §MEDIUM 13: every request accepts an AbortSignal; mount recovery and
 *    export both use an AbortController; unmount aborts all in-flight work and
 *    no promise continuation updates state after unmount.
 *  - §BLOCKER 1: the active job id is persisted under an OWNER-SCOPED
 *    localStorage key (bf_active_job_v1:<admin identity>); an admin account
 *    switch in the same browser can never restore another admin's job.
 *  - §HIGH 6: an explicit restoration state map turns each persisted job state
 *    into the correct UI (never a blank blueprint-review for an in-flight job).
 *  - §HIGH 7: when localStorage has no usable job, the recent-jobs endpoint is
 *    queried and the newest resumable job is OFFERED (never auto-created).
 *  - Chapters never auto-generate before approval.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { Boxes, Lock, ShieldCheck, AlertTriangle } from "lucide-react";
import { defaultConfig, productionCost } from "./bookFactorySchema";
import * as api from "./bookFactoryApi";
import BookFactoryConfigForm from "./BookFactoryConfigForm";
import BookFactoryProgress from "./BookFactoryProgress";
import BookFactoryChapterReview from "./BookFactoryChapterReview";
import BookFactoryHandoff from "./BookFactoryHandoff";

const ACTIVE_JOB_KEY_BASE = "bf_active_job_v1";
const RESUMABLE_STATES = new Set(["pending", "failed_retryable", "unknown_outcome"]);

// §BLOCKER 1: scope the recovery pointer to the authenticated admin identity.
function activeJobKey(identity) {
  return identity ? `${ACTIVE_JOB_KEY_BASE}:${identity}` : ACTIVE_JOB_KEY_BASE;
}
function saveActiveJob(identity, id) { try { localStorage.setItem(activeJobKey(identity), id); } catch { /* ignore */ } }
function readActiveJob(identity) { try { return localStorage.getItem(activeJobKey(identity)) || ""; } catch { return ""; } }
function clearActiveJob(identity) { try { localStorage.removeItem(activeJobKey(identity)); } catch { /* ignore */ } }

// §HIGH 6: explicit restoration state map — one persisted job state → one UI.
export function restoreStateFor(job) {
  if (!job) return null;
  if (job.state === "cancelled") return { category: "cancelled", resumable: false };
  if (job.blueprintApprovedAt) {
    const chapters = job.chapters || {};
    const order = job.chapterOrder || [];
    const pending = order.some((cid) => RESUMABLE_STATES.has((chapters[cid] || {}).state));
    return { category: pending ? "approved-progress" : "completed", resumable: true };
  }
  const bp = (job.blueprint || {}).state;
  switch (bp) {
    case "completed": return { category: "blueprint-review", resumable: true };
    case "pending": return { category: "blueprint-start", resumable: true };
    case "claimed":
    case "provider_pending": return { category: "blueprint-progress", resumable: true };
    case "failed_retryable": return { category: "blueprint-retryable", resumable: true };
    case "failed_terminal": return { category: "blueprint-terminal", resumable: false };
    case "unknown_outcome": return { category: "blueprint-unknown", resumable: false };
    default: return { category: "blueprint-start", resumable: true };
  }
}

const RESTORE_LABELS = {
  "cancelled": "This job was cancelled.",
  "approved-progress": "Chapters are approved — resume generating the remaining chapters.",
  "completed": "This job is complete — review and hand off.",
  "blueprint-review": "The outline is ready to review and approve.",
  "blueprint-start": "The outline has not started yet — resume to generate it.",
  "blueprint-progress": "Outline generation was interrupted — reload its status.",
  "blueprint-retryable": "Outline generation failed — you can retry it.",
  "blueprint-terminal": "Outline generation failed permanently — start over.",
  "blueprint-unknown": "Outline outcome is unknown — manual review required before retry.",
};

export default function BookFactoryStudio({
  enabled = false, geminiEnabled = false, editorDirty = false, adminIdentity = "",
  coverEnabled = false, narrationEnabled = false, conversationAudioEnabled = false,
  directPublishEnabled = false,
  onHandoff, onDownloadCurrentDraft,
}) {
  const [config, setConfig] = useState(defaultConfig);
  const [stage, setStage] = useState("config"); // config | plan | blueprint-review | generating | review
  const [showPlan, setShowPlan] = useState(false);
  const [job, setJob] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [exportedBook, setExportedBook] = useState(null);
  const [exportMeta, setExportMeta] = useState(null);
  const [error, setError] = useState(null);
  const [busyChapterId, setBusyChapterId] = useState(null);
  const [resumeCandidate, setResumeCandidate] = useState(null); // { job, category, resumable, fromFallback }

  const abortRef = useRef(null);
  const recoveryAbortRef = useRef(null);
  const exportAbortRef = useRef(null);
  const mountedRef = useRef(true);
  const submitLockRef = useRef(false); // synchronous duplicate-submit guard

  const canGenerate = enabled && geminiEnabled;
  const disabledReason = !enabled
    ? "Book Factory is disabled by an administrator."
    : !geminiEnabled
      ? "Gemini generation is not configured (flag off or missing API key)."
      : null;

  const setJobSafe = useCallback((j) => { if (mountedRef.current) setJob(j); }, []);
  const isAbort = (e) => e?.name === "AbortError" || e?.message === "canceled";

  // Abort ALL in-flight requests on unmount; block later state updates.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      recoveryAbortRef.current?.abort();
      exportAbortRef.current?.abort();
    };
  }, []);

  // §HIGH 6/7 + §MEDIUM 13: recover a persisted active job on mount (never
  // auto-create). If none is usable, fall back to the recent-jobs listing.
  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    recoveryAbortRef.current = ac;
    (async () => {
      const id = readActiveJob(adminIdentity);
      if (id) {
        try {
          const res = await api.getJob(id, ac.signal);
          if (!mountedRef.current) return;
          if (res?.job) {
            setResumeCandidate({ ...restoreStateFor(res.job), job: res.job });
            return;
          }
        } catch (e) {
          if (isAbort(e)) return;
          if (e?.status !== 404) return; // transient failure: keep pointer, no fallback
          clearActiveJob(adminIdentity); // stored id no longer exists → fall through
        }
      }
      // §HIGH 7: fallback discovery of the newest resumable recent job.
      try {
        const list = await api.listJobs(20, ac.signal);
        if (!mountedRef.current) return;
        const jobs = (list && list.jobs) || [];
        const newest = jobs.find((j) => j.state !== "cancelled");
        if (newest) {
          const full = await api.getJob(newest.jobId, ac.signal);
          if (!mountedRef.current) return;
          if (full?.job) setResumeCandidate({ ...restoreStateFor(full.job), job: full.job, fromFallback: true });
        }
      } catch (e) { if (!isAbort(e)) { /* fallback is best-effort */ } }
    })();
    return () => { ac.abort(); };
  }, [enabled, adminIdentity]);

  const newAbort = () => { const ac = new AbortController(); abortRef.current = ac; return ac; };

  const generateRemaining = async (jobId, jobDoc, signal) => {
    const order = jobDoc.chapterOrder || [];
    const chapters = jobDoc.chapters || {};
    for (const cid of order) {
      const ch = chapters[cid] || {};
      if (ch.locked || ch.state === "completed" || ch.state === "failed_terminal") continue;
      if (!RESUMABLE_STATES.has(ch.state)) continue;
      const r = await api.stepJob(jobId, { chapterId: cid }, signal);
      if (!mountedRef.current) return;
      setJobSafe(r.job);
    }
  };

  const startGeneration = async () => {
    if (submitLockRef.current) return; // synchronous guard (pre-rerender)
    submitLockRef.current = true;
    setError(null);
    setGenerating(true);
    setStage("generating");
    const ac = newAbort();
    try {
      const created = await api.createJob(config, ac.signal);
      const jobId = created.job.jobId;
      saveActiveJob(adminIdentity, jobId);
      setJobSafe(created.job);
      try {
        const bp = await api.stepJob(jobId, { stage: "blueprint" }, ac.signal);
        if (!mountedRef.current) return;
        setJobSafe(bp.job);
        // §PHASE E1: derive UI state from actual job state via restoreStateFor
        // so a blueprint that completes in state "failed" or "generating" is
        // shown correctly rather than being unconditionally labelled "blueprint-review".
        setStage(restoreStateFor(bp.job).category);
      } catch (e) {
        // §HIGH 6: after create succeeds, a later blueprint failure/abort must
        // RETAIN and display the created job — never return to a blank config
        // where Generate could create a duplicate.
        if (isAbort(e)) return;
        setError(e.message || "Outline generation failed");
        setStage("blueprint-review");
      }
    } catch (e) {
      if (!isAbort(e)) { setError(e.message || "Generation failed"); setStage("config"); }
    } finally {
      submitLockRef.current = false;
      if (mountedRef.current) setGenerating(false);
    }
  };

  const approveAndGenerate = async () => {
    if (!job || submitLockRef.current) return;
    submitLockRef.current = true;
    setError(null);
    setGenerating(true);
    setStage("generating");
    const ac = newAbort();
    try {
      const ap = await api.approveJob(job.jobId, ac.signal);
      if (!mountedRef.current) return;
      setJobSafe(ap.job);
      await generateRemaining(job.jobId, ap.job, ac.signal);
      if (mountedRef.current) setStage("review");
    } catch (e) {
      if (!isAbort(e)) { setError(e.message || "Chapter generation failed"); setStage("review"); }
    } finally {
      submitLockRef.current = false;
      if (mountedRef.current) setGenerating(false);
    }
  };

  // §HIGH 6: resume a persisted/offered job into the correct UI state.
  const resumeJob = async () => {
    const cand = resumeCandidate;
    if (!cand?.job) return;
    const j = cand.job;
    setResumeCandidate(null);
    setJobSafe(j);
    saveActiveJob(adminIdentity, j.jobId);
    const info = restoreStateFor(j);
    if (!info) return;
    switch (info.category) {
      case "cancelled":
        setStage("review");
        return;
      case "completed":
        setStage("review");
        return;
      case "blueprint-review":
        setStage("blueprint-review");
        return;
      case "blueprint-progress":
      case "blueprint-start":
      case "blueprint-retryable": {
        // deliberately (re)start / reload the blueprint stage
        setGenerating(true);
        setStage("generating");
        const ac = newAbort();
        try {
          const bp = await api.stepJob(j.jobId, { stage: "blueprint" }, ac.signal);
          if (!mountedRef.current) return;
          setJobSafe(bp.job);
          setStage("blueprint-review");
        } catch (e) { if (!isAbort(e)) { setError(e.message || "Resume failed"); setStage("blueprint-review"); } }
        finally { if (mountedRef.current) setGenerating(false); }
        return;
      }
      case "blueprint-terminal":
      case "blueprint-unknown":
        // no auto-retry — surface the job read-only; deliberate start-over only
        setStage("blueprint-review");
        return;
      case "approved-progress":
      default: {
        setGenerating(true);
        setStage("generating");
        const ac = newAbort();
        try {
          await generateRemaining(j.jobId, j, ac.signal);
          if (mountedRef.current) setStage("review");
        } catch (e) { if (!isAbort(e)) { setError(e.message || "Resume failed"); setStage("review"); } }
        finally { if (mountedRef.current) setGenerating(false); }
        return;
      }
    }
  };

  const dismissResume = () => { setResumeCandidate(null); clearActiveJob(adminIdentity); };

  const retry = async (cid) => {
    if (!job) return;
    setBusyChapterId(cid);
    const ac = newAbort();
    try {
      await api.retryChapter(job.jobId, cid, ac.signal);
      const r = await api.stepJob(job.jobId, { chapterId: cid }, ac.signal);
      setJobSafe(r.job);
    } catch (e) { if (!isAbort(e)) setError(e.message || "Retry failed"); }
    finally { if (mountedRef.current) setBusyChapterId(null); }
  };

  const regenerate = async (cid, instruction) => {
    if (!job) return;
    setBusyChapterId(cid);
    const ac = newAbort();
    try {
      await api.regenerateChapter(job.jobId, cid, instruction, ac.signal);
      const r = await api.stepJob(job.jobId, { chapterId: cid }, ac.signal);
      setJobSafe(r.job);
    } catch (e) { if (!isAbort(e)) setError(e.message || "Regenerate failed"); }
    finally { if (mountedRef.current) setBusyChapterId(null); }
  };

  // §HOTFIX: explicit, teacher-confirmed recovery for a failed_terminal /
  // unknown_outcome chapter. Confirmation itself lives in
  // BookFactoryChapterReview — by the time this fires the teacher has already
  // confirmed. Never called automatically (not on mount, not on resume).
  const retryFailed = async (cid) => {
    if (!job) return;
    setBusyChapterId(cid);
    const ac = newAbort();
    try {
      await api.retryFailedChapter(job.jobId, cid, ac.signal);
      const r = await api.stepJob(job.jobId, { chapterId: cid }, ac.signal);
      setJobSafe(r.job);
    } catch (e) { if (!isAbort(e)) setError(e.message || "Retry failed"); }
    finally { if (mountedRef.current) setBusyChapterId(null); }
  };

  const toggleLock = async (cid, locked) => {
    if (!job) return;
    const ac = newAbort();
    try {
      const r = locked ? await api.unlockChapter(job.jobId, cid, ac.signal)
                       : await api.lockChapter(job.jobId, cid, ac.signal);
      setJobSafe(r.job);
    } catch (e) { if (!isAbort(e)) setError(e.message || "Lock change failed"); }
  };

  const cancelJob = async () => {
    if (!job) return;
    const ac = newAbort();
    try {
      const r = await api.cancelJob(job.jobId, ac.signal);
      setJobSafe(r.job);
      clearActiveJob(adminIdentity);
      setStage("review");
    } catch (e) { if (!isAbort(e)) setError(e.message || "Cancel failed"); }
  };

  const openHandoff = async () => {
    if (!job) return;
    const ac = new AbortController();
    exportAbortRef.current = ac;
    try {
      const res = await api.exportJob(job.jobId, ac.signal);
      if (!mountedRef.current) return;
      setExportedBook(res.book);
      setExportMeta({ completed: res.completedChapters, total: res.totalChapters, incomplete: res.incomplete });
    } catch (e) { if (!isAbort(e)) setError(e.message || "Export failed"); }
  };

  const handoffDone = (book) => {
    clearActiveJob(adminIdentity); // successful handoff clears the active-job pointer
    onHandoff?.(book);
  };

  const startOver = () => {
    abortRef.current?.abort();
    clearActiveJob(adminIdentity);
    setStage("config"); setJob(null); setExportedBook(null); setExportMeta(null); setError(null);
  };

  return (
    <div className="space-y-5" data-testid="book-factory-studio">
      <div className="flex items-center gap-2">
        <Boxes className="h-5 w-5 text-gold" />
        <h2 className="font-display text-[16px] text-parchment">AI Book Factory</h2>
        <span className="text-[11px] text-faded">Gemini draft generator · unpublished output</span>
      </div>

      {!canGenerate && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-900/15 p-3" data-testid="book-factory-disabled-banner">
          <p className="text-[12px] text-amber-200 inline-flex items-center gap-1.5">
            <Lock className="h-4 w-4" /> Generation is currently disabled.
          </p>
          <p className="text-[11.5px] text-amber-100/80 mt-1" data-testid="bf-disabled-reason">{disabledReason}</p>
        </div>
      )}

      {resumeCandidate && (
        <div className="rounded-xl border border-gold/30 bg-walnut/30 p-3"
             data-testid="bf-resume-banner" data-resume-category={resumeCandidate.category}>
          <p className="text-[12px] text-parchment/90" data-testid="bf-resume-message">
            An earlier Book Factory job (<span className="text-gold">{resumeCandidate.job?.config?.title || resumeCandidate.job?.jobId}</span>){resumeCandidate.fromFallback ? " was found" : " is still open"}.
            {" "}{RESTORE_LABELS[resumeCandidate.category] || ""}
          </p>
          <div className="flex gap-2 mt-2">
            {resumeCandidate.resumable && (
              <button data-testid="bf-resume-continue" onClick={resumeJob}
                      className="rounded-full bg-gold px-3 py-1 text-[11px] font-bold text-ink">
                {resumeCandidate.category === "blueprint-review" ? "Review outline"
                  : resumeCandidate.category === "blueprint-retryable" ? "Retry"
                  : resumeCandidate.category === "completed" ? "Open" : "Continue"}
              </button>
            )}
            {!resumeCandidate.resumable && (resumeCandidate.category === "blueprint-terminal" || resumeCandidate.category === "blueprint-unknown") && (
              <span className="inline-flex items-center gap-1 text-[11px] text-amber-200" data-testid="bf-resume-warning">
                <AlertTriangle className="h-3.5 w-3.5" /> Manual review required — no automatic retry.
              </span>
            )}
            {resumeCandidate.category === "cancelled" && (
              <span className="text-[11px] text-faded" data-testid="bf-resume-cancelled">This job is cancelled.</span>
            )}
            <button data-testid="bf-resume-dismiss" onClick={dismissResume}
                    className="rounded-full border border-parchment/30 px-3 py-1 text-[11px] text-parchment">Dismiss & start new</button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-400/40 bg-red-900/20 p-2.5 text-[12px] text-red-200" data-testid="book-factory-error">
          {error}
        </div>
      )}

      {stage === "config" && !showPlan && (
        <BookFactoryConfigForm config={config} onChange={setConfig}
                               onGenerate={() => setShowPlan(true)} canGenerate={canGenerate} generating={generating} />
      )}

      {stage === "config" && showPlan && (
        <GenerateCompleteBookPlan
          config={config}
          coverEnabled={coverEnabled}
          narrationEnabled={narrationEnabled}
          conversationAudioEnabled={conversationAudioEnabled}
          onBack={() => setShowPlan(false)}
          onConfirm={() => { setShowPlan(false); startGeneration(); }}
        />
      )}

      {stage === "generating" && (
        <>
          <p className="text-[11.5px] text-faded" data-testid="bf-resume-note">
            Generation continues while Book Factory is open. You may leave and safely resume later.
          </p>
          <BookFactoryProgress job={job} />
        </>
      )}

      {stage === "blueprint-review" && job && (
        <div className="space-y-3" data-testid="bf-blueprint-review">
          <p className="text-[12px] text-parchment/90">Review the generated outline, then approve to generate chapters.</p>
          <div className="space-y-2">
            {(job.chapterOrder || []).map((cid) => {
              const ch = (job.chapters || {})[cid] || {};
              return (
                <div key={cid} className="rounded-lg border border-gold/15 bg-walnut/20 p-3"
                     data-testid="bf-blueprint-chapter" data-chapter-id={cid}>
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] text-parchment/90">{ch.position + 1}. {ch.title}</span>
                    {ch.isReview && <span className="text-[10px] text-gold uppercase tracking-wider">Review</span>}
                  </div>
                  {ch.objective && <p className="text-[11px] text-faded mt-1">{ch.objective}</p>}
                  {ch.outline && <p className="text-[11px] text-parchment/70 mt-0.5">{ch.outline}</p>}
                </div>
              );
            })}
          </div>
          <button data-testid="bf-approve-generate" disabled={generating || !canGenerate} onClick={approveAndGenerate}
                  className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-[12px] font-bold uppercase tracking-wider text-ink disabled:opacity-40"
                  style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}>
            <ShieldCheck className="h-4 w-4" /> Approve and generate
          </button>
          <button data-testid="bf-start-over" onClick={startOver} className="ml-2 text-[11px] text-faded underline underline-offset-2">Start over</button>
        </div>
      )}

      {stage === "review" && (
        <div className="space-y-4">
          <BookFactoryProgress job={job} />
          <BookFactoryChapterReview job={job} onRetry={retry} onRegenerate={regenerate} onRetryFailed={retryFailed}
                                    onToggleLock={toggleLock} onCancel={cancelJob} busyChapterId={busyChapterId} />
          {!exportedBook ? (
            <PrepareHandoffButton job={job} onPrepare={openHandoff} />
          ) : (
            <BookFactoryHandoff book={exportedBook} meta={exportMeta} editorDirty={editorDirty}
                                jobId={job?.jobId}
                                coverEnabled={coverEnabled}
                                narrationEnabled={narrationEnabled}
                                conversationAudioEnabled={conversationAudioEnabled}
                                directPublishEnabled={directPublishEnabled}
                                onOpenInEditor={handoffDone} onCancel={startOver}
                                onDownloadCurrentDraft={onDownloadCurrentDraft}
                                onRefreshExport={openHandoff} />
          )}
          <button data-testid="bf-start-over" onClick={startOver} className="ml-2 text-[11px] text-faded underline underline-offset-2">Start over</button>
        </div>
      )}
    </div>
  );
}

/**
 * PrepareHandoffButton — §HOTFIX: guards against silently handing off an
 * incomplete draft. When every chapter is complete, behaves exactly as
 * before (one click). When one or more chapters are missing/failed, requires
 * an explicit confirmation naming how many chapters will be left out.
 */
function PrepareHandoffButton({ job, onPrepare }) {
  const [confirming, setConfirming] = useState(false);
  const order = job?.chapterOrder || [];
  const chapters = job?.chapters || {};
  const incompleteCount = order.filter((cid) => (chapters[cid] || {}).state !== "completed").length;
  const hasIncomplete = incompleteCount > 0;

  if (!hasIncomplete) {
    return (
      <button data-testid="bf-prepare-handoff" onClick={onPrepare}
              className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-[12px] font-bold uppercase tracking-wider text-ink"
              style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}>
        Prepare handoff
      </button>
    );
  }
  if (!confirming) {
    return (
      <button data-testid="bf-prepare-handoff" onClick={() => setConfirming(true)}
              className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-[12px] font-bold uppercase tracking-wider text-ink"
              style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}>
        Prepare handoff
      </button>
    );
  }
  return (
    <div className="rounded-lg border border-amber-400/30 bg-amber-900/10 p-2.5 space-y-1.5" data-testid="bf-prepare-handoff-confirm">
      <p className="text-[11.5px] text-amber-100/90">
        {incompleteCount} chapter{incompleteCount === 1 ? "" : "s"} did not complete and will be left out of this draft.
        Prepare handoff anyway?
      </p>
      <div className="flex gap-2">
        <button data-testid="bf-prepare-handoff-confirm-go" onClick={() => { setConfirming(false); onPrepare(); }}
                className="rounded-full bg-gold px-3 py-1 text-[11px] font-bold text-ink">Prepare anyway</button>
        <button data-testid="bf-prepare-handoff-cancel" onClick={() => setConfirming(false)}
                className="rounded-full border border-parchment/30 px-3 py-1 text-[11px] text-parchment">Cancel</button>
      </div>
    </div>
  );
}

/**
 * GenerateCompleteBookPlan — one explicit confirmation showing every stage
 * "Generate Complete Book" will run and a rough call-count estimate, before
 * any provider is called. Optional stages only appear when their backend
 * flag is on; unavailable stages are never silently skipped without saying
 * so, so the teacher always knows what today's build can and cannot do yet.
 */
function GenerateCompleteBookPlan({ config, coverEnabled, narrationEnabled, conversationAudioEnabled, onBack, onConfirm }) {
  const cost = productionCost(config);
  const rows = [
    { label: "Outline (blueprint)", detail: "1 Gemini call" },
    { label: `Chapter text × ${cost.chapters}`, detail: `${cost.chapters} Gemini call${cost.chapters === 1 ? "" : "s"}` },
    coverEnabled
      ? { label: "AI cover image", detail: "1 Gemini image call, after you click Generate Cover" }
      : { label: "AI cover image", detail: "Not enabled — StylizedCover or your own Cover Image URL will be used", muted: true },
    narrationEnabled
      ? { label: "Story narration + synced words", detail: "1 ElevenLabs call per chapter you choose to narrate" }
      : { label: "Story narration", detail: "Not enabled — narrate manually in the Editor after handoff", muted: true },
    { label: "Conversation dialogue", detail: conversationAudioEnabled
        ? "Zero-copy seeding into Conversation Voice Studio — you still generate audio there"
        : "Zero-copy seeding into Conversation Voice Studio (dialog automation is not part of this build)" },
  ];
  return (
    <div className="space-y-3" data-testid="bf-generate-plan">
      <p className="text-[12px] text-parchment/90">
        This is exactly what will happen. Nothing paid runs until you confirm, and every optional stage below is a
        separate, later click — this confirmation only starts the outline + chapter text.
      </p>
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between gap-3 rounded-lg border border-gold/15 bg-walnut/20 px-3 py-2"
               data-testid={`bf-plan-row-${i}`}>
            <span className={`text-[12px] font-semibold ${r.muted ? "text-faded" : "text-parchment"}`}>{r.label}</span>
            <span className="text-[11px] text-faded text-right">{r.detail}</span>
          </div>
        ))}
      </div>
      <p className="text-[10.5px] text-faded">Estimates may vary with content length and retries.</p>
      <div className="flex gap-2">
        <button data-testid="bf-plan-confirm" onClick={onConfirm}
                className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-[12px] font-bold uppercase tracking-wider text-ink"
                style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}>
          Confirm &amp; Generate Complete Book
        </button>
        <button data-testid="bf-plan-back" onClick={onBack}
                className="rounded-full border border-parchment/30 px-4 py-2 text-[12px] text-parchment">
          Back
        </button>
      </div>
    </div>
  );
}
