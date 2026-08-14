/**
 * SyncReviewStudio.jsx — the Synchronization Review Studio, Author Studio's
 * flagship transcript review workflow.
 *
 * Full-screen overlay over the Video Factory. Left: the actual lesson
 * media with live synchronized highlighting (the same canonical document
 * students will consume). Right: sentence-by-sentence editor — transcript
 * text edits, word timing nudges, split/merge, speaker relabeling — every
 * action is one atomic backend operation (sync_studio_tools.apply_sync_
 * edits), so the server document is always the single source of truth and
 * "compare original" always has a real snapshot to diff against.
 * Approval walks pending → in_review → approved; publishing a lesson
 * requires the approved version (enforced server-side).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X, Check, Play, Scissors, Merge, Loader2, Eye, RotateCcw,
  ChevronLeft, ChevronRight, Type, Clock, Undo2, Redo2, Repeat, Search,
} from "lucide-react";
import { getSyncAdmin, editSync, approveSync, rejectSync, resolveMediaSrc, undoSync, redoSync } from "./videoLibraryApi";
import Teleprompter from "../../eduhub/components/teleprompter/Teleprompter";
import { studioSafeAreaTop } from "../safeArea";

const GOLD = "#D4A843";
const SPEAKER_COLORS = ["#D4A843", "#7DB8F0", "#8FD6A8", "#E8A0BF", "#C7A8F0", "#F0C987"];
const LOW_CONFIDENCE = 0.7;

function wordConfidence(w) {
  const c = w?.confidence || {};
  const vals = Object.values(c).filter((v) => typeof v === "number");
  return vals.length ? Math.min(...vals) : null;
}

/** TimelineStrip — the sentence-block timeline: one block per sentence,
 * width proportional to duration, colored by speaker, live playhead.
 * Click any block to jump. */
function TimelineStrip({ sync, currentTime, onSeek, activeIdx }) {
  const sentences = useMemo(() => {
    const out = [];
    (sync?.paragraphs || []).forEach((p) => (p.sentences || []).forEach((s) => out.push(s)));
    return out;
  }, [sync]);
  const speakers = sync?.speakers || [];
  const colorOf = (sid) => {
    const i = speakers.findIndex((sp) => sp.id === sid);
    return i >= 0 ? SPEAKER_COLORS[i % SPEAKER_COLORS.length] : "rgba(255,255,255,0.35)";
  };
  const total = Number(sync?.durationSec) || (sentences.length ? sentences[sentences.length - 1].end : 0);
  if (!sentences.length || !total) return null;
  return (
    <div className="px-3 py-2 border-b border-white/10 flex-shrink-0" data-testid="review-timeline">
      <div className="relative h-7 rounded-md bg-black/40 overflow-hidden">
        {sentences.map((s, i) => (
          <button key={s.id || i} onClick={() => onSeek(s.start)}
                  title={(s.words || []).slice(0, 6).map((w) => w.word).join(" ")}
                  data-testid={`review-timeline-block-${i}`}
                  className="absolute top-[3px] bottom-[3px] rounded-[3px] transition-opacity"
                  style={{
                    left: `${(s.start / total) * 100}%`,
                    width: `${Math.max(0.4, ((s.end - s.start) / total) * 100 - 0.15)}%`,
                    background: colorOf(s.speakerId),
                    opacity: i === activeIdx ? 1 : 0.45,
                  }} />
        ))}
        <div className="absolute top-0 bottom-0 w-[2px] bg-white pointer-events-none"
             style={{ left: `${Math.min(100, (currentTime / total) * 100)}%` }} />
      </div>
    </div>
  );
}

function fmt(t) {
  const s = Math.max(0, Number(t) || 0);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}.${String(Math.floor((s % 1) * 10))}`;
}

/**
 * Perf fix: currentTime updates ~4x/sec during playback and previously
 * re-rendered every SentenceRow in the list (one per transcript sentence,
 * each rendering every word as its own interactive span) on every single
 * tick, since the parent re-renders on each `timeupdate`. On a long lesson
 * this saturated the JS main thread on mobile Safari badly enough to make
 * touch input (including the close button) appear completely unresponsive
 * — confirmed as the Author Studio "random freeze" root cause. React.memo
 * + stable onOp/onSeek references (see useCallback below) means only the
 * 1-2 rows whose `isActive` flag actually flips on a given tick re-render;
 * every other row bails out before touching its word list.
 */
export const SentenceRow = memo(function SentenceRow({ pIdx, sIdx, globalIdx, sentence, speakers, isActive, busy, onOp, onSeek }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [selectedWord, setSelectedWord] = useState(null);

  const startEdit = () => {
    setText((sentence.words || []).map((w) => w.word).join(" "));
    setEditing(true);
  };

  const commitText = () => {
    setEditing(false);
    const current = (sentence.words || []).map((w) => w.word).join(" ");
    if (text.trim() && text.trim() !== current) {
      onOp({ op: "replace_sentence_text", p: pIdx, s: sIdx, text: text.trim() });
    }
  };

  const nudge = (delta, field) => {
    if (selectedWord == null) return;
    const w = sentence.words[selectedWord];
    if (!w) return;
    onOp({
      op: "set_word_timing", p: pIdx, s: sIdx, w: selectedWord,
      start: field === "start" ? Math.max(0, w.start + delta) : w.start,
      end: field === "end" ? Math.max(w.start, w.end + delta) : w.end,
    });
  };

  return (
    <div className={`rounded-lg border p-2.5 space-y-1.5 transition-colors ${
      isActive ? "border-amber-400/50 bg-amber-400/[0.06]" : "border-white/10 bg-white/[0.02]"
    }`} data-testid={`review-sentence-${globalIdx}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => onSeek(sentence.start)} className="text-[10px] tabular-nums text-faded hover:text-amber-300 flex items-center gap-1"
                data-testid={`review-sentence-${globalIdx}-seek`}>
          <Play size={9} /> {fmt(sentence.start)} – {fmt(sentence.end)}
        </button>
        <select
          value={sentence.speakerId || ""}
          onChange={(e) => onOp({ op: "set_sentence_speaker", p: pIdx, s: sIdx, speakerId: e.target.value })}
          disabled={busy}
          data-testid={`review-sentence-${globalIdx}-speaker`}
          className="rounded border border-white/10 bg-black/30 px-1.5 py-0.5 text-[10px] text-parchment"
        >
          <option value="">— no speaker —</option>
          {speakers.map((sp) => <option key={sp.id} value={sp.id}>{sp.label || sp.id}</option>)}
        </select>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={startEdit} disabled={busy} title="Edit sentence text"
                  data-testid={`review-sentence-${globalIdx}-edit-text`}
                  className="p-1 rounded hover:bg-white/10 text-faded hover:text-parchment"><Type size={11} /></button>
          <button onClick={() => selectedWord != null && selectedWord > 0 &&
                    onOp({ op: "split_sentence", p: pIdx, s: sIdx, at: selectedWord })}
                  disabled={busy || selectedWord == null || selectedWord === 0}
                  title="Split before selected word"
                  data-testid={`review-sentence-${globalIdx}-split`}
                  className="p-1 rounded hover:bg-white/10 text-faded hover:text-parchment disabled:opacity-30"><Scissors size={11} /></button>
          <button onClick={() => onOp({ op: "merge_sentences", p: pIdx, s: sIdx })} disabled={busy}
                  title="Merge with next sentence"
                  data-testid={`review-sentence-${globalIdx}-merge`}
                  className="p-1 rounded hover:bg-white/10 text-faded hover:text-parchment"><Merge size={11} /></button>
        </div>
      </div>

      {editing ? (
        <div className="space-y-1.5">
          <textarea value={text} onChange={(e) => setText(e.target.value)} autoFocus
                    data-testid={`review-sentence-${globalIdx}-textarea`}
                    className="w-full rounded border border-amber-400/40 bg-black/40 p-2 text-[12.5px] text-parchment min-h-[60px]" />
          <div className="flex gap-2">
            <button onClick={commitText} data-testid={`review-sentence-${globalIdx}-save-text`}
                    className="text-[11px] font-semibold px-2.5 py-1 rounded bg-amber-500/90 text-black">Save</button>
            <button onClick={() => setEditing(false)} className="text-[11px] px-2.5 py-1 rounded border border-white/10 text-faded">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="text-[12.5px] leading-relaxed">
          {(sentence.words || []).map((w, i) => {
            const conf = wordConfidence(w);
            const lowConf = conf !== null && conf < LOW_CONFIDENCE;
            return (
              <span key={i} onClick={() => setSelectedWord(selectedWord === i ? null : i)}
                    className="cursor-pointer rounded px-[1px]"
                    title={lowConf ? `Low confidence (${Math.round(conf * 100)}%)` : undefined}
                    style={selectedWord === i
                      ? { background: "rgba(212,168,67,0.25)", color: "#FFE19A" }
                      : lowConf
                        ? { background: "rgba(240,80,80,0.12)", color: "#f0a8a8", textDecoration: "underline dotted rgba(240,80,80,0.6)" }
                        : undefined}>
                {w.word}{" "}
              </span>
            );
          })}
        </div>
      )}

      {selectedWord != null && sentence.words?.[selectedWord] && !editing && (
        <div className="flex items-center gap-2 text-[10px] text-faded flex-wrap rounded bg-black/30 px-2 py-1.5"
             data-testid={`review-sentence-${globalIdx}-word-tools`}>
          <Clock size={10} />
          <span className="tabular-nums">“{sentence.words[selectedWord].word}” {fmt(sentence.words[selectedWord].start)} – {fmt(sentence.words[selectedWord].end)}</span>
          <span className="flex items-center gap-0.5">start
            <button onClick={() => nudge(-0.1, "start")} className="p-0.5 rounded hover:bg-white/10"><ChevronLeft size={11} /></button>
            <button onClick={() => nudge(0.1, "start")} className="p-0.5 rounded hover:bg-white/10"><ChevronRight size={11} /></button>
          </span>
          <span className="flex items-center gap-0.5">end
            <button onClick={() => nudge(-0.1, "end")} className="p-0.5 rounded hover:bg-white/10"><ChevronLeft size={11} /></button>
            <button onClick={() => nudge(0.1, "end")} className="p-0.5 rounded hover:bg-white/10"><ChevronRight size={11} /></button>
          </span>
          <button
            onClick={() => {
              const next = window.prompt("Correct this word:", sentence.words[selectedWord].word);
              if (next && next.trim()) onOp({ op: "edit_word", p: pIdx, s: sIdx, w: selectedWord, word: next.trim() });
            }}
            data-testid={`review-sentence-${globalIdx}-edit-word`}
            className="ml-auto text-amber-300 hover:text-amber-200 font-semibold">Edit word</button>
        </div>
      )}
    </div>
  );
});

export default function SyncReviewStudio({ lesson, onClose, onChanged }) {
  const mediaRef = useRef(null);
  const [sync, setSync] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [showOriginal, setShowOriginal] = useState(false);
  const [tab, setTab] = useState("editor"); // editor | teleprompter
  const [search, setSearch] = useState("");
  const [looping, setLooping] = useState(false);
  const loopRef = useRef(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      setSync(await getSyncAdmin(lesson.syncId));
    } catch (e) {
      setErr(e.message || "Failed to load the synchronization document.");
    } finally {
      setLoading(false);
    }
  }, [lesson.syncId]);

  useEffect(() => { load(); }, [load]);

  // useCallback: a stable reference is required for SentenceRow's
  // React.memo (above) to actually skip re-renders — a fresh function
  // identity on every parent render (from the plain-function form this used
  // to be) would defeat memoization entirely, since `onOp` is a prop.
  const applyOp = useCallback(async (op) => {
    setErr(null);
    setBusy(true);
    try {
      setSync(await editSync(lesson.syncId, [op]));
      onChanged?.();
    } catch (e) {
      setErr(e.message || "Edit failed.");
    } finally {
      setBusy(false);
    }
  }, [lesson.syncId, onChanged]);

  const handleApprove = async () => {
    setErr(null);
    setBusy(true);
    try {
      setSync(await approveSync(lesson.syncId, sync?.reviewStatus));
      onChanged?.();
    } catch (e) {
      setErr(e.message || "Approval failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    setErr(null);
    setBusy(true);
    try {
      setSync(await rejectSync(lesson.syncId, sync?.reviewStatus));
      onChanged?.();
    } catch (e) {
      setErr(e.message || "Rejection failed.");
    } finally {
      setBusy(false);
    }
  };

  const renameSpeaker = (sp) => {
    const next = window.prompt(`Rename speaker "${sp.label || sp.id}":`, sp.label || sp.id);
    if (next && next.trim()) applyOp({ op: "rename_speaker", id: sp.id, label: next.trim() });
  };

  const handleUndo = async () => {
    setErr(null);
    setBusy(true);
    try { setSync(await undoSync(lesson.syncId)); onChanged?.(); }
    catch (e) { setErr(e.message || "Undo failed."); }
    finally { setBusy(false); }
  };

  const handleRedo = async () => {
    setErr(null);
    setBusy(true);
    try { setSync(await redoSync(lesson.syncId)); onChanged?.(); }
    catch (e) { setErr(e.message || "Redo failed."); }
    finally { setBusy(false); }
  };

  // useCallback for the same reason as applyOp above — passed to every
  // memoized SentenceRow as `onSeek`. mediaRef is a ref (stable identity),
  // so an empty dependency array is correct.
  const seekTo = useCallback((t) => {
    if (mediaRef.current) mediaRef.current.currentTime = Math.max(0, t);
  }, []);

  const handleTimeUpdate = () => {
    const t = mediaRef.current?.currentTime || 0;
    if (loopRef.current && t > loopRef.current.end) {
      mediaRef.current.currentTime = loopRef.current.start;
      return;
    }
    setCurrentTime(t);
  };

  const toggleLoop = () => {
    if (looping) { loopRef.current = null; setLooping(false); return; }
    const t = mediaRef.current?.currentTime || 0;
    const all = [];
    (sync?.paragraphs || []).forEach((p) => (p.sentences || []).forEach((s) => all.push(s)));
    const s = all.find((x) => t >= x.start && t <= x.end) || all[0];
    if (!s) return;
    loopRef.current = { start: s.start, end: s.end };
    setLooping(true);
  };

  const displayDoc = useMemo(() => {
    if (!sync) return null;
    if (showOriginal && sync.originalParagraphs) {
      return { ...sync, paragraphs: sync.originalParagraphs, speakers: sync.originalSpeakers || sync.speakers };
    }
    return sync;
  }, [sync, showOriginal]);

  const rows = useMemo(() => {
    const out = [];
    let g = -1;
    (displayDoc?.paragraphs || []).forEach((p, pIdx) => {
      (p.sentences || []).forEach((s, sIdx) => {
        g += 1;
        out.push({ pIdx, sIdx, globalIdx: g, sentence: s });
      });
    });
    return out;
  }, [displayDoc]);

  const isVideo = (lesson.contentType || "").startsWith("video/");
  const mediaSrc = resolveMediaSrc(lesson.mediaRef);
  const suggestions = sync?.speakerLabelSuggestions || {};
  // Stable reference for SentenceRow's `speakers` prop — `displayDoc
  // ?.speakers || []` would otherwise allocate a fresh empty array on
  // every render whenever there are no speakers yet, silently defeating
  // React.memo for every row on every currentTime tick.
  const speakersList = useMemo(() => displayDoc?.speakers || [], [displayDoc]);

  return (
    <div className="fixed inset-0 z-[200] flex flex-col" style={{ background: "#0F0A16" }}
         data-testid="sync-review-studio">
      {/* Top bar — iOS safe-area fix via the shared studioSafeAreaTop()
          convention (safeArea.js). This is a `fixed inset-0` overlay
          outside AppShell (same as ProductionStudio), so it does not
          inherit AppShell's Header.jsx safe-area padding and was
          rendering flush against the Dynamic Island / status bar on
          iPhone. */}
      <div className="flex items-center gap-3 px-4 pb-2.5 pr-14 border-b border-white/10 flex-wrap"
           style={{ paddingTop: studioSafeAreaTop(10) }}>
        <button onClick={onClose} data-testid="review-studio-close" aria-label="Close Review Studio"
                className="p-1.5 rounded-lg hover:bg-white/10 text-parchment"><X size={16} /></button>
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-parchment truncate">Synchronization Review — {lesson.title}</div>
          <div className="text-[10.5px] text-faded">
            {sync ? `v${sync.alignmentVersion} · ${sync.providerVersion || sync.providerCategory}` : ""}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {sync && (
            <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
              sync.reviewStatus === "approved" ? "text-emerald-300 border-emerald-400/40 bg-emerald-400/10"
                : sync.reviewStatus === "rejected" ? "text-red-300 border-red-400/40 bg-red-400/10"
                  : "text-amber-300 border-amber-400/40 bg-amber-400/10"
            }`} data-testid="review-status-badge">{sync.reviewStatus}</span>
          )}
          {sync?.originalParagraphs && (
            <button onClick={() => setShowOriginal(!showOriginal)}
                    data-testid="review-compare-toggle"
                    className={`inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border ${
                      showOriginal ? "border-amber-400/50 text-amber-300 bg-amber-400/10" : "border-white/10 text-faded hover:text-parchment"
                    }`}>
              <RotateCcw size={11} /> {showOriginal ? "Viewing original" : "Compare original"}
            </button>
          )}
          <button onClick={handleUndo} disabled={busy || !sync || !(sync.undoDepth > 0)}
                  data-testid="review-undo-button" title={`Undo (${sync?.undoDepth || 0} available)`}
                  className="p-1.5 rounded-lg border border-white/10 text-faded hover:text-parchment disabled:opacity-30">
            <Undo2 size={13} />
          </button>
          <button onClick={handleRedo} disabled={busy || !sync || !(sync.redoDepth > 0)}
                  data-testid="review-redo-button" title={`Redo (${sync?.redoDepth || 0} available)`}
                  className="p-1.5 rounded-lg border border-white/10 text-faded hover:text-parchment disabled:opacity-30">
            <Redo2 size={13} />
          </button>
          <button onClick={toggleLoop}
                  data-testid="review-loop-button" title={looping ? "Stop looping" : "Loop current sentence"}
                  className="p-1.5 rounded-lg border"
                  style={looping
                    ? { borderColor: "rgba(212,168,67,0.5)", color: GOLD, background: "rgba(212,168,67,0.10)" }
                    : { borderColor: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.55)" }}>
            <Repeat size={13} />
          </button>
          <button onClick={() => setTab(tab === "editor" ? "teleprompter" : "editor")}
                  data-testid="review-teleprompter-toggle"
                  className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border border-white/10 text-faded hover:text-parchment">
            <Eye size={11} /> {tab === "editor" ? "Teleprompter preview" : "Back to editor"}
          </button>
          <button onClick={handleReject}
                  disabled={busy || !sync || sync.reviewStatus === "rejected" || sync.reviewStatus === "approved"}
                  title={sync?.reviewStatus === "approved" ? "Edit the synchronization first — an approved document is terminal until changed" : undefined}
                  data-testid="review-reject-button"
                  className="text-[11px] font-semibold px-3 py-1.5 rounded-lg border border-red-400/30 text-red-300 hover:bg-red-400/10 disabled:opacity-40">
            Reject
          </button>
          <button onClick={handleApprove} disabled={busy || !sync || sync.reviewStatus === "approved"}
                  data-testid="review-approve-button"
                  className="inline-flex items-center gap-1.5 text-[11px] font-bold px-3.5 py-1.5 rounded-lg text-black disabled:opacity-40"
                  style={{ background: GOLD }}>
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Approve synchronization
          </button>
        </div>
      </div>

      {err && <div className="px-4 py-2 text-[11.5px] text-red-400 border-b border-white/10" data-testid="review-error">{err}</div>}

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        {/* Media + live highlight preview */}
        <div className="flex flex-col min-h-0 border-b lg:border-b-0 lg:border-r border-white/10">
          <div className="bg-black flex-shrink-0">
            {isVideo ? (
              <video ref={mediaRef} src={mediaSrc} controls className="w-full max-h-[42vh]"
                     onTimeUpdate={handleTimeUpdate}
                     data-testid="review-media-video" />
            ) : (
              <audio ref={mediaRef} src={mediaSrc} controls className="w-full px-3 py-4"
                     onTimeUpdate={handleTimeUpdate}
                     data-testid="review-media-audio" />
            )}
          </div>
          <div className="flex-1 min-h-0 text-parchment">
            <Teleprompter sync={displayDoc} currentTime={currentTime} onSeek={seekTo}
                          className="h-full" mode="auto" />
          </div>
        </div>

        {/* Editor column */}
        <div className="flex flex-col min-h-0">
          <TimelineStrip sync={displayDoc} currentTime={currentTime} onSeek={seekTo}
                         activeIdx={rows.findIndex(({ sentence }) => currentTime >= sentence.start && currentTime <= sentence.end)} />
          {/* Transcript search */}
          <div className="px-3 py-2 border-b border-white/10 flex-shrink-0">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faded" />
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                     placeholder="Search transcript…"
                     data-testid="review-search-input"
                     className="w-full rounded-lg border border-white/10 bg-black/30 py-1.5 pr-3 text-[12px] text-parchment placeholder:text-faded focus:outline-none focus:border-amber-400/40"
                     style={{ paddingLeft: 30 }} />
            </div>
          </div>
          {/* Speakers */}
          {(displayDoc?.speakers || []).length > 0 && (
            <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-bold uppercase tracking-wider text-faded">Speakers</span>
              {(displayDoc.speakers || []).map((sp) => (
                <button key={sp.id} onClick={() => renameSpeaker(sp)} disabled={busy || showOriginal}
                        data-testid={`review-speaker-${sp.id}`}
                        title={suggestions[sp.id] ? `AI suggestion: ${suggestions[sp.id]}` : "Rename"}
                        className="text-[11px] px-2 py-0.5 rounded-full border border-white/15 text-parchment hover:border-amber-400/50">
                  {sp.label || sp.id}
                  {suggestions[sp.id] && suggestions[sp.id] !== sp.label && (
                    <span className="text-amber-300/70 ml-1">→ {suggestions[sp.id]}?</span>
                  )}
                </button>
              ))}
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2" data-testid="review-sentence-list">
            {loading ? (
              <div className="text-[12px] text-faded p-4 flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> Loading synchronization…</div>
            ) : !sync ? (
              <div className="text-[12px] text-faded p-4">No synchronization document.</div>
            ) : sync.alignmentStatus !== "complete" ? (
              <div className="text-[12px] text-faded p-4" data-testid="review-not-aligned">
                Alignment status: <b>{sync.alignmentStatus}</b> — run the processing pipeline first.
              </div>
            ) : showOriginal ? (
              <div className="text-[11px] text-amber-300/80 p-2 rounded bg-amber-400/5 border border-amber-400/20">
                Read-only view of the ORIGINAL provider output. Toggle “Compare original” off to continue editing.
              </div>
            ) : null}
            {rows
              .filter(({ sentence }) => {
                const needle = search.trim().toLowerCase();
                if (!needle) return true;
                return (sentence.words || []).map((w) => w.word).join(" ").toLowerCase().includes(needle);
              })
              .map(({ pIdx, sIdx, globalIdx, sentence }) => (
              showOriginal ? (
                <div key={globalIdx} className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5 text-[12.5px] text-parchment/80">
                  <span className="text-[10px] tabular-nums text-faded mr-2">{fmt(sentence.start)}</span>
                  {(sentence.words || []).map((w) => w.word).join(" ")}
                </div>
              ) : (
                <SentenceRow key={`${sync?.alignmentVersion}-${globalIdx}`}
                             pIdx={pIdx} sIdx={sIdx} globalIdx={globalIdx} sentence={sentence}
                             speakers={speakersList} busy={busy}
                             isActive={currentTime >= sentence.start && currentTime <= sentence.end}
                             onOp={applyOp} onSeek={seekTo} />
              )
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
