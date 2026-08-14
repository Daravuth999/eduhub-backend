/**
 * BookFactoryPublishFlow.jsx — server-authoritative Save Draft / Publish /
 * Cover / Narration / Conversation-Audio orchestration, mounted inside
 * BookFactoryHandoff.
 *
 * §AMENDMENT 6/10: this component treats the backend job document as the
 * ONLY source of truth for what has actually happened (saved slug/revision,
 * published state, cover state, per-chapter narration/conversation state). It
 * never infers "this paid stage already ran" from localStorage or from its
 * own component state — every action re-fetches the job afterward, and a
 * fresh mount re-fetches it too, so a page refresh mid-flow simply shows
 * exactly where things stand and lets the teacher continue.
 *
 * Conversation audio (§PHASE E): one click drives init → generate every
 * non-completed line → assemble, but each step is its own backend-fenced
 * request — a refresh mid-flow resumes from whatever the job document says,
 * never re-paying for an already-completed line. Zero-copy CVS *seeding*
 * (StudioEditor + ConversationVoiceStudio) remains available as a manual
 * fallback for fine-tuning emotion/acting notes per line.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightCircle, CheckCircle2, ImageIcon, Loader2, Mic, RefreshCcw, Send,
  MessagesSquare, Shuffle,
} from "lucide-react";
import * as api from "./bookFactoryApi";
import { listVoices } from "../api";
import BookFactoryVoicePicker from "./BookFactoryVoicePicker";
import { assignVoicesRoundRobin } from "./speakerVoiceAssignment";

function dialogSpeakersFor(chapter) {
  const seen = [];
  const set = new Set();
  for (const b of chapter?.blocks || []) {
    if (b?.type !== "dialog") continue;
    const s = String(b.speaker || "").trim() || "Speaker";
    if (!set.has(s)) { set.add(s); seen.push(s); }
  }
  return seen;
}

const LINE_STATE_COLOR = {
  completed: "text-emerald-300",
  failed_terminal: "text-red-300",
  unknown_outcome: "text-red-300",
  failed_retryable: "text-amber-300",
};

function ConversationChapterPanel({
  jobId, chapterId, title, chapter, conv, voices, refreshJob, onError,
}) {
  const speakers = useMemo(() => dialogSpeakersFor(chapter), [chapter]);
  const [assignments, setAssignments] = useState(() => assignVoicesRoundRobin(speakers, voices));
  const [busy, setBusy] = useState(false);

  const lineOrder = conv?.lineOrder || [];
  const lines = conv?.lines || {};
  const assembly = conv?.assembly || {};
  const allInitialized = lineOrder.length > 0;
  const allLinesDone = allInitialized && lineOrder.every((lid) => lines[lid]?.state === "completed");
  const assembled = assembly.state === "completed";
  const hasFailedLines = lineOrder.some((lid) => ["failed_retryable", "unknown_outcome"].includes(lines[lid]?.state));

  const autoVoicePack = () => setAssignments(assignVoicesRoundRobin(speakers, voices));

  const runOneShot = async () => {
    if (speakers.some((s) => !assignments[s])) {
      onError("Assign a voice to every speaker in this chapter first.");
      return;
    }
    setBusy(true);
    onError(null);
    try {
      await api.initConversationAudio(jobId, chapterId, { voiceAssignments: assignments });
      let fresh = await refreshJob();
      let c = fresh?.conversationAudio?.[chapterId];
      for (const lineId of c?.lineOrder || []) {
        if (c.lines[lineId]?.state === "completed") continue; // never regenerate a completed line
        // eslint-disable-next-line no-await-in-loop
        await api.generateConversationLine(jobId, chapterId, lineId);
        // eslint-disable-next-line no-await-in-loop
        fresh = await refreshJob();
        c = fresh?.conversationAudio?.[chapterId];
      }
      const done = (c?.lineOrder || []).length > 0
        && c.lineOrder.every((lid) => c.lines[lid]?.state === "completed");
      if (done) {
        await api.assembleConversationAudio(jobId, chapterId);
        await refreshJob();
      }
    } catch (e) {
      onError(e.message || "Conversation-audio generation failed");
    } finally {
      setBusy(false);
    }
  };

  const retryFailedOnly = async () => {
    setBusy(true);
    onError(null);
    try {
      for (const lineId of lineOrder) {
        const st = lines[lineId]?.state;
        if (!["failed_retryable", "unknown_outcome"].includes(st)) continue; // never touch pending/completed lines
        // eslint-disable-next-line no-await-in-loop
        await api.retryConversationLine(jobId, chapterId, lineId);
        // eslint-disable-next-line no-await-in-loop
        await api.generateConversationLine(jobId, chapterId, lineId);
        // eslint-disable-next-line no-await-in-loop
        await refreshJob();
      }
      const fresh = await refreshJob();
      const c = fresh?.conversationAudio?.[chapterId];
      const done = (c?.lineOrder || []).length > 0
        && c.lineOrder.every((lid) => c.lines[lid]?.state === "completed");
      if (done) {
        await api.assembleConversationAudio(jobId, chapterId);
        await refreshJob();
      }
    } catch (e) {
      onError(e.message || "Retry failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-gold/10 p-3 space-y-2" data-testid={`bf-conversation-chapter-${chapterId}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-parchment/90">{title}</span>
        {assembled && (
          <span className="text-[10.5px] text-emerald-300" data-testid={`bf-conversation-assembled-${chapterId}`}>
            ✓ Conversation audio ready
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {speakers.map((s) => (
          <label key={s} className="inline-flex items-center gap-1.5 text-[11px] text-parchment/80">
            {s}:
            <select
              value={assignments[s] || ""}
              onChange={(e) => setAssignments((a) => ({ ...a, [s]: e.target.value }))}
              disabled={busy}
              data-testid={`bf-conversation-voice-${chapterId}-${s}`}
              className="rounded-full border border-gold/25 bg-walnut/60 px-2 py-1 text-[11px] text-parchment"
            >
              {voices.length === 0 && <option value="">Loading…</option>}
              {voices.map((v) => <option key={v.voice_id} value={v.voice_id}>{v.name}</option>)}
            </select>
          </label>
        ))}
        <button type="button" onClick={autoVoicePack} disabled={busy}
                data-testid={`bf-auto-voice-pack-${chapterId}`}
                className="inline-flex items-center gap-1 rounded-full border border-gold/25 px-2 py-1 text-[10.5px] font-bold uppercase tracking-wider text-gold disabled:opacity-50">
          <Shuffle className="h-3 w-3" /> Auto voice pack
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={runOneShot} disabled={busy || allLinesDone && assembled}
                data-testid={`bf-generate-conversation-${chapterId}`}
                className="inline-flex items-center gap-2 rounded-full border border-gold/30 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-gold disabled:opacity-50">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessagesSquare className="h-3.5 w-3.5" />}
          {assembled ? "Conversation Audio Ready" : allInitialized ? "Continue Generating" : "Generate Conversation Audio"}
        </button>
        {hasFailedLines && (
          <button type="button" onClick={retryFailedOnly} disabled={busy}
                  data-testid={`bf-retry-failed-lines-${chapterId}`}
                  className="inline-flex items-center gap-1 rounded-full border border-amber-400/40 px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-wider text-amber-300 disabled:opacity-50">
            Retry failed lines only
          </button>
        )}
      </div>

      {lineOrder.length > 0 && (
        <div className="space-y-0.5">
          {lineOrder.map((lid) => {
            const l = lines[lid] || {};
            return (
              <div key={lid} className="flex items-center justify-between gap-2 text-[10.5px]" data-testid={`bf-conversation-line-${lid}`}>
                <span className="text-parchment/70 truncate">{l.speaker}: {l.text}</span>
                <span className={LINE_STATE_COLOR[l.state] || "text-faded"}>{l.state || "pending"}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function BookFactoryPublishFlow({
  jobId, coverEnabled, narrationEnabled, conversationAudioEnabled, onRefreshExport,
}) {
  const [job, setJob] = useState(null);
  const [loadingJob, setLoadingJob] = useState(true);
  const [error, setError] = useState(null);

  const [savingDraft, setSavingDraft] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirmingPublish, setConfirmingPublish] = useState(false);

  const [coverBusy, setCoverBusy] = useState(false);
  const [narrationVoice, setNarrationVoice] = useState("");
  const [syncedWords, setSyncedWords] = useState(true);
  const [narratingAll, setNarratingAll] = useState(false);
  const [busyChapterId, setBusyChapterId] = useState(null);
  const [voices, setVoices] = useState([]);

  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // Conversation-audio voice-pack assignment needs the raw voice list (not
  // just BookFactoryVoicePicker's private state) to round-robin per speaker.
  useEffect(() => {
    if (!conversationAudioEnabled) return;
    let cancelled = false;
    listVoices().then((res) => {
      if (!cancelled) setVoices(Array.isArray(res?.voices) ? res.voices : []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [conversationAudioEnabled]);

  const refreshJob = useCallback(async () => {
    if (!jobId) return null;
    try {
      const res = await api.getJob(jobId);
      if (mountedRef.current) setJob(res.job);
      return res.job;
    } catch (e) {
      if (mountedRef.current) setError(e.message || "Failed to load job status");
      return null;
    }
  }, [jobId]);

  // Backend-authoritative on mount AND on every refresh — never trust stale
  // client state for "was this already saved/published/narrated".
  useEffect(() => {
    setLoadingJob(true);
    refreshJob().finally(() => { if (mountedRef.current) setLoadingJob(false); });
  }, [refreshJob]);

  const handleSaveDraft = async () => {
    setSavingDraft(true);
    setError(null);
    try {
      await api.saveDraft(jobId);
      await refreshJob();
      onRefreshExport?.();
    } catch (e) {
      setError(e.message || "Save Draft failed");
    } finally {
      if (mountedRef.current) setSavingDraft(false);
    }
  };

  const handlePublish = async () => {
    if (!confirmingPublish) { setConfirmingPublish(true); return; }
    setConfirmingPublish(false);
    setPublishing(true);
    setError(null);
    try {
      await api.publishJob(jobId);
      await refreshJob();
    } catch (e) {
      setError(e.message || "Publish failed");
    } finally {
      if (mountedRef.current) setPublishing(false);
    }
  };

  const handleGenerateCover = async () => {
    setCoverBusy(true);
    setError(null);
    try {
      await api.generateCover(jobId);
      await refreshJob();
      onRefreshExport?.();
    } catch (e) {
      setError(e.message || "Cover generation failed");
    } finally {
      if (mountedRef.current) setCoverBusy(false);
    }
  };

  const handleRegenerateCover = async () => {
    setCoverBusy(true);
    setError(null);
    try {
      await api.regenerateCover(jobId);
      await api.generateCover(jobId);
      await refreshJob();
      onRefreshExport?.();
    } catch (e) {
      setError(e.message || "Cover regeneration failed");
    } finally {
      if (mountedRef.current) setCoverBusy(false);
    }
  };

  const narrateOne = async (chapterId) => {
    setBusyChapterId(chapterId);
    try {
      await api.narrateChapter(jobId, chapterId, { voice: narrationVoice, syncedWords });
      await refreshJob();
    } catch (e) {
      setError(e.message || "Narration failed for one chapter");
    } finally {
      if (mountedRef.current) setBusyChapterId(null);
    }
  };

  const handleNarrateAll = async () => {
    setNarratingAll(true);
    setError(null);
    const order = job?.chapterOrder || [];
    for (const cid of order) {
      const st = (job?.narration || {})[cid]?.state;
      if (st === "completed") continue; // never regenerate a completed chapter implicitly
      // eslint-disable-next-line no-await-in-loop
      await narrateOne(cid);
      // eslint-disable-next-line no-await-in-loop
      const fresh = await refreshJob();
      if (fresh) job.narration = fresh.narration; // keep loop's local read current
    }
    if (mountedRef.current) setNarratingAll(false);
  };

  if (!jobId) {
    return (
      <p className="text-[11px] text-faded" data-testid="bf-publish-flow-no-job">
        Publish actions are unavailable for this session (no job id).
      </p>
    );
  }

  const slug = job?.savedBookSlug;
  const cover = job?.cover || {};
  const narrationMap = job?.narration || {};
  const order = job?.chapterOrder || [];
  const chapters = job?.chapters || {};
  const allNarrated = order.length > 0 && order.every((cid) => narrationMap[cid]?.state === "completed");

  return (
    <div className="space-y-4 rounded-2xl border border-gold/25 bg-walnut/25 p-4" data-testid="bf-publish-flow">
      <h3 className="font-display text-[15px] text-parchment">Publish this book</h3>

      {error && (
        <div className="rounded-lg border border-red-400/40 bg-red-900/20 p-2.5 text-[12px] text-red-200" data-testid="bf-publish-flow-error">
          {error}
        </div>
      )}

      {/* ── Primary actions ─────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSaveDraft}
          disabled={savingDraft || loadingJob}
          data-testid="bf-save-draft-btn"
          className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-[12px] font-bold uppercase tracking-wider text-ink disabled:opacity-50"
          style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}
        >
          {savingDraft ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {slug ? "Save Again" : "Save to Library as Draft"}
        </button>

        <button
          type="button"
          onClick={handlePublish}
          disabled={!slug || publishing || loadingJob}
          data-testid="bf-publish-btn"
          className="inline-flex items-center gap-2 rounded-full border border-emerald-400/50 bg-emerald-500/10 px-4 py-2 text-[12px] font-bold uppercase tracking-wider text-emerald-300 disabled:opacity-40"
          title={!slug ? "Save to Library as Draft first" : undefined}
        >
          {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          {job?.publishedAt ? "Publish Again" : "Publish to Student Library"}
        </button>

        {slug && (
          <span className="text-[11px] text-faded" data-testid="bf-saved-slug">
            Saved as <span className="text-gold">{slug}</span> (rev {job?.savedBookRevision})
            {job?.publishedAt ? " · published" : " · draft"}
          </span>
        )}
      </div>

      {confirmingPublish && (
        <div className="rounded-lg border border-emerald-400/40 bg-emerald-900/15 p-3 text-[12px] text-emerald-200" data-testid="bf-publish-confirm">
          Publish now, even if cover/narration are unfinished or missing? This makes the book visible in the student Library.
          <div className="flex gap-2 mt-2">
            <button onClick={handlePublish} data-testid="bf-publish-confirm-yes"
                    className="rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-bold text-ink">Yes, publish</button>
            <button onClick={() => setConfirmingPublish(false)} data-testid="bf-publish-confirm-cancel"
                    className="rounded-full border border-parchment/30 px-3 py-1 text-[11px] text-parchment">Cancel</button>
          </div>
        </div>
      )}

      {/* ── Cover (optional) ─────────────────────────────────────── */}
      {coverEnabled && (() => {
        const coverStatus = job?.coverTeacherStatus || {};
        const isBadState = ["terminalFailure", "unknownOutcome", "keyUnavailable", "storageUnavailable"].includes(coverStatus.state);
        const fallbackNote = coverStatus.usingFallback === "manual_url"
          ? "Using your manual Cover Image URL."
          : coverStatus.usingFallback === "stylized"
            ? "Using the stylized fallback cover."
            : null;
        return (
          <div className="rounded-xl border border-gold/15 p-3 space-y-2" data-testid="bf-cover-panel">
            <div className="flex items-center gap-2">
              <ImageIcon className="h-4 w-4 text-gold" />
              <span className="text-[12px] font-bold uppercase tracking-wider text-parchment">AI Cover (optional)</span>
            </div>
            {coverStatus.message && (
              <p data-testid="bf-cover-status-message"
                 className={`text-[11px] ${isBadState ? "text-amber-300" : "text-parchment/80"}`}>
                {coverStatus.message}
              </p>
            )}
            {fallbackNote && (
              <p data-testid="bf-cover-fallback-note" className="text-[10.5px] text-faded">{fallbackNote}</p>
            )}
            {cover.coverImage && (
              <img src={cover.coverImage} alt="Generated cover preview" data-testid="bf-cover-preview"
                   className="h-40 w-auto rounded-lg border border-gold/20 object-cover" />
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={cover.coverImage ? handleRegenerateCover : handleGenerateCover}
                      disabled={coverBusy || coverStatus.state === "featureDisabled" || coverStatus.state === "keyUnavailable" || coverStatus.state === "storageUnavailable"}
                      data-testid="bf-generate-cover-btn"
                      className="inline-flex items-center gap-2 rounded-full border border-gold/30 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-gold disabled:opacity-50">
                {coverBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
                {cover.coverImage ? "Regenerate Cover" : "Generate Cover"}
              </button>
            </div>
            <p className="text-[10.5px] text-faded">
              Cover generation never blocks saving or publishing. Without a generated cover, the book uses a stylized
              placeholder cover automatically. Want your own image URL instead? Open in Editor — the Cover Image URL
              field there is never overwritten by this panel.
            </p>
          </div>
        );
      })()}

      {/* ── Narration (optional) ─────────────────────────────────── */}
      {narrationEnabled && (
        <div className="rounded-xl border border-gold/15 p-3 space-y-2" data-testid="bf-narration-panel">
          <div className="flex items-center gap-2">
            <Mic className="h-4 w-4 text-gold" />
            <span className="text-[12px] font-bold uppercase tracking-wider text-parchment">Story Narration (optional)</span>
          </div>
          {!slug ? (
            <p className="text-[11px] text-faded">Save to Library as Draft first.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <BookFactoryVoicePicker value={narrationVoice} onChange={setNarrationVoice} disabled={narratingAll} />
                <label className="inline-flex items-center gap-1.5 text-[11px] text-parchment/90">
                  <input type="checkbox" checked={syncedWords} onChange={(e) => setSyncedWords(e.target.checked)}
                         data-testid="bf-synced-words-toggle" disabled={narratingAll} />
                  Synced words (karaoke highlight)
                </label>
                <button type="button" onClick={handleNarrateAll} disabled={narratingAll || allNarrated}
                        data-testid="bf-narrate-all-btn"
                        className="ml-auto inline-flex items-center gap-2 rounded-full border border-gold/30 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-gold disabled:opacity-50">
                  {narratingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRightCircle className="h-3.5 w-3.5" />}
                  {allNarrated ? "All chapters narrated" : "Narrate All Chapters"}
                </button>
              </div>
              <div className="space-y-1">
                {order.map((cid, i) => {
                  const st = narrationMap[cid]?.state || "pending";
                  const title = chapters[cid]?.title || `Chapter ${i + 1}`;
                  return (
                    <div key={cid} className="flex items-center justify-between gap-2 text-[11px]" data-testid={`bf-narration-row-${cid}`}>
                      <span className="text-parchment/90">{title}</span>
                      <span className="flex items-center gap-2">
                        <span className={
                          st === "completed" ? "text-emerald-300"
                          : st === "failed_terminal" || st === "unknown_outcome" ? "text-red-300"
                          : st === "failed_retryable" ? "text-amber-300"
                          : "text-faded"
                        }>
                          {st}
                        </span>
                        {st !== "completed" && (
                          <button type="button" onClick={() => narrateOne(cid)}
                                  disabled={busyChapterId === cid || narratingAll}
                                  data-testid={`bf-narrate-chapter-${cid}`}
                                  className="text-gold underline underline-offset-2 text-[10.5px]">
                            {busyChapterId === cid ? "Working…" : st === "failed_retryable" ? "Retry" : "Narrate"}
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Conversation Audio (optional, one-click, persisted per-line) ── */}
      {conversationAudioEnabled && (() => {
        const dialogChapterIds = order.filter((cid) => (chapters[cid]?.blocks || []).some((b) => b?.type === "dialog"));
        if (!dialogChapterIds.length) return null;
        return (
          <div className="rounded-xl border border-gold/15 p-3 space-y-2" data-testid="bf-conversation-panel">
            <div className="flex items-center gap-2">
              <MessagesSquare className="h-4 w-4 text-gold" />
              <span className="text-[12px] font-bold uppercase tracking-wider text-parchment">Conversation Audio (optional)</span>
            </div>
            {!slug ? (
              <p className="text-[11px] text-faded">Save to Library as Draft first.</p>
            ) : (
              <div className="space-y-2">
                {dialogChapterIds.map((cid, i) => (
                  <ConversationChapterPanel
                    key={cid}
                    jobId={jobId}
                    chapterId={cid}
                    title={chapters[cid]?.title || `Chapter ${i + 1}`}
                    chapter={chapters[cid]}
                    conv={(job?.conversationAudio || {})[cid]}
                    voices={voices}
                    refreshJob={refreshJob}
                    onError={setError}
                  />
                ))}
              </div>
            )}
            <p className="text-[10.5px] text-faded">
              One click generates every speaker line and assembles the final conversation track — no manual
              retyping. For fine control over emotion or acting notes per line, Conversation Voice Studio in the
              Editor remains available: it offers this same dialogue via an explicit "Load generated dialogue"
              button (never auto-filled).
            </p>
          </div>
        );
      })()}
    </div>
  );
}
