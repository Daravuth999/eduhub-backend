/**
 * VideoLessonPlayer.jsx — EduHub's signature premium learning player.
 *
 * Rendered OUTSIDE AppShell (see App.js's /video-library/watch/:lessonId
 * route) for a focused, distraction-free surface. Consumes the APPROVED
 * canonical synchronization document via the shared Universal
 * Synchronization Engine (GET /api/sync/{syncId}) — speech recognition
 * NEVER happens at playback time.
 *
 * Premium controls: custom control bar (play/seek/time/speed), theater
 * mode, fullscreen, chapter navigation (from sync paragraphs), sentence/
 * paragraph looping, transcript search, teleprompter settings (author
 * defaults + local reading overrides), resume, backend progress reporting,
 * and the backend-authoritative purchase gate.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  ArrowLeft, Lock, Bookmark, BookmarkCheck, StickyNote, Loader2,
  AlignLeft, MonitorPlay, GraduationCap, Music, Play, Pause,
  Maximize, Minimize, RectangleHorizontal, ListVideo, Repeat, Search,
  Settings2, BookMarked, X, Sparkles, AlertTriangle,
} from "lucide-react";
import {
  getLesson, getSyncDocument, reportProgress, resolveMediaSrc,
  toggleBookmark, listBookmarks, listRecentlyWatched, getNote, saveNote,
} from "./videoLibraryApi";
import { computeActiveSentence } from "../../lib/syncConsumption";
import {
  useSyncHighlight, useActiveSentence, useSentenceState, buildSentenceMetas,
} from "../../lib/useSyncHighlight";
import useAutoFollow from "../../lib/useAutoFollow";
import Teleprompter from "../../components/teleprompter/Teleprompter";
import TeleprompterSettings from "../../components/teleprompter/TeleprompterSettings";
import {
  mergeTeleprompterConfig, readLocalOverrides, writeLocalOverrides,
} from "../../components/teleprompter/teleprompterConfig";
import PurchaseLessonModal from "./PurchaseLessonModal";
import formatPoints from "../../lib/formatPoints";
import { describeMediaError, STALL_THRESHOLD_MS } from "../../lib/mediaDiagnostics";
import "./videoLibrary.css";

const GOLD = "#D4A843";
const PROGRESS_REPORT_INTERVAL_SEC = 5;
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

function bookmarksKey(lessonId) { return `eduhub_video_bookmarks_${lessonId}`; }

function fmt(t) {
  const s = Math.max(0, Math.floor(Number(t) || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Chapters — one per sync paragraph, labeled by its opening words. */
function deriveChapters(sync) {
  const out = [];
  for (const p of sync?.paragraphs || []) {
    const sentences = p.sentences || [];
    if (!sentences.length) continue;
    const words = (sentences[0].words || []).slice(0, 5).map((w) => w.word).join(" ");
    out.push({
      id: p.id,
      start: sentences[0].start || 0,
      end: sentences[sentences.length - 1].end || 0,
      label: words ? `${words}…` : `Chapter ${out.length + 1}`,
    });
  }
  return out;
}

function flatSentences(sync) {
  const out = [];
  for (const p of sync?.paragraphs || []) for (const s of p.sentences || []) out.push({ ...s, paragraphId: p.id });
  return out;
}

/** Legacy/backward-compatibility gate for the bilingual toggle (directive
 * requirement: never show a control for a capability this lesson doesn't
 * actually have): true only if at least one sentence in this lesson's own
 * sync document actually carries a Khmer translation. */
function hasAnyTranslation(sync) {
  for (const p of sync?.paragraphs || []) {
    for (const s of p.sentences || []) {
      if (s.translationKm) return true;
    }
  }
  return false;
}

/** Premium compact EN / EN+KM show-hide control — the master directive's
 * "not a plain HTML checkbox" requirement. A two-state segmented pill,
 * touch-friendly (32px tall), with a sliding highlight and clear active/
 * inactive state via aria-pressed. Purely a display preference: toggling
 * it never touches sync/store/playback — only config.showTranslation,
 * which Teleprompter.jsx reads to decide whether to render a sentence's
 * (already-existing) translationKm. */
function TranslationToggle({ value, onChange }) {
  return (
    <div className="tp-translation-toggle" role="group" aria-label="Khmer translation display">
      <button
        type="button"
        onClick={() => onChange(false)}
        aria-pressed={!value}
        data-testid="video-translation-toggle-off"
        className="tp-translation-toggle-opt"
        style={!value ? { color: "#111", background: GOLD } : { color: "rgba(255,255,255,0.55)" }}
      >
        EN
      </button>
      <button
        type="button"
        onClick={() => onChange(true)}
        aria-pressed={value}
        data-testid="video-translation-toggle-on"
        className="tp-translation-toggle-opt"
        style={value ? { color: "#111", background: GOLD } : { color: "rgba(255,255,255,0.55)" }}
      >
        EN+KM
      </button>
    </div>
  );
}

/* ── Transcript panel: search + loop + live karaoke follow ───────────── */
const TranscriptSentence = memo(function TranscriptSentence({ meta, idx, store, onSeek, registerRef }) {
  const state = useSentenceState(store, idx, meta.wordOffset, meta.count);
  const active = typeof state === "number";
  const past = state === "past";
  // tp-sentence-story / tp-word reserve their highlight padding at all
  // times (see teleprompter.css) — activation only ever changes color/
  // background/opacity, never the word's or sentence's layout footprint.
  // A conditional padding/font-weight here would widen the active word,
  // shifting every word after it on the line on each transition.
  return (
    <span ref={(el) => registerRef(idx, el)}
          className="tp-sentence tp-sentence-story"
          style={{
            background: active ? "rgba(212,168,67,0.10)" : "transparent",
            opacity: past ? 0.5 : 1,
          }}>
      {(meta.s.words || []).map((w, i) => (
        <span key={i} onClick={() => onSeek?.(w.start)} className="tp-word cursor-pointer"
              style={i === state
                ? { color: GOLD, background: "rgba(212,168,67,0.14)" }
                : { background: "transparent" }}>
          {w.word}{" "}
        </span>
      ))}
    </span>
  );
});

const TranscriptPanel = memo(function TranscriptPanel({ sync, store, onSeek, loop, onToggleLoop }) {
  const [search, setSearch] = useState("");
  const containerRef = useRef(null);
  const sentenceRefs = useRef({});
  const registerRef = useCallback((idx, el) => { sentenceRefs.current[idx] = el; }, []);
  const metas = useMemo(() => buildSentenceMetas(sync), [sync]);
  const sentences = useMemo(() => flatSentences(sync), [sync]);
  const totalWords = useMemo(() => metas.reduce((acc, m) => acc + m.count, 0), [metas]);
  const activeSentenceIdx = useActiveSentence(store);
  const getTargetEl = useCallback(() => sentenceRefs.current[activeSentenceIdx], [activeSentenceIdx]);
  const { following, resumeFollow } = useAutoFollow({
    containerRef, activeIdx: activeSentenceIdx, getTargetEl,
  });
  const handleSeek = useCallback((t) => { onSeek?.(t); resumeFollow(); }, [onSeek, resumeFollow]);
  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return [];
    return sentences
      .map((s, idx) => ({ idx, s, text: (s.words || []).map((w) => w.word).join(" ") }))
      .filter((row) => row.text.toLowerCase().includes(needle))
      .slice(0, 25);
  }, [search, sentences]);

  if (!sync || totalWords === 0) {
    return (
      <div className="p-4 text-[13px] text-white/45" data-testid="video-transcript-empty">
        The synchronized transcript for this lesson is still being prepared — playback works normally in the meantime.
      </div>
    );
  }
  let flatIdx = -1;

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="px-3 pt-3 pb-2 flex items-center gap-2 flex-shrink-0">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/35" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
                 placeholder="Search transcript…"
                 data-testid="video-transcript-search"
                 className="w-full rounded-lg bg-white/5 border border-white/10 pl-7.5 pr-7 py-1.5 text-[12px] text-white placeholder:text-white/30 focus:outline-none focus:border-[rgba(212,168,67,0.4)]"
                 style={{ paddingLeft: 30 }} />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/40">
              <X size={11} />
            </button>
          )}
        </div>
        <button onClick={onToggleLoop}
                data-testid="video-loop-sentence-button"
                title={loop ? "Stop looping" : "Loop the current sentence"}
                className="p-1.5 rounded-lg border text-[11px] flex items-center gap-1 flex-shrink-0"
                style={loop
                  ? { borderColor: "rgba(212,168,67,0.5)", color: GOLD, background: "rgba(212,168,67,0.10)" }
                  : { borderColor: "rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.55)" }}>
          <Repeat size={12} /> {loop ? "Looping" : "Loop"}
        </button>
      </div>

      {search.trim() ? (
        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1" data-testid="video-transcript-search-results">
          {matches.length === 0 ? (
            <div className="text-[12px] text-white/40 p-2">No matches.</div>
          ) : matches.map(({ idx, s, text }) => (
            <button key={idx} onClick={() => { handleSeek(s.start); setSearch(""); }}
                    className="block w-full text-left rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 px-2.5 py-2">
              <span className="text-[10px] tabular-nums mr-2" style={{ color: GOLD }}>{fmt(s.start)}</span>
              <span className="text-[12px] text-white/75">{text}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="relative flex-1 min-h-0 flex flex-col">
          <div ref={containerRef}
               className="tp-viewport flex-1 min-h-0 overflow-y-auto p-4 space-y-3 text-[14px] leading-relaxed"
               data-testid="video-transcript-panel">
            {(sync.paragraphs || []).map((p) => (
              <p key={p.id}>
                {(p.sentences || []).map((s) => {
                  flatIdx += 1;
                  const idx = flatIdx;
                  return (
                    <TranscriptSentence key={s.id || idx} meta={metas[idx]} idx={idx}
                                        store={store} onSeek={handleSeek} registerRef={registerRef} />
                  );
                })}
              </p>
            ))}
            <div className="h-16" />
          </div>
          {!following && (
            <button className="tp-follow-chip" onClick={resumeFollow} data-testid="video-transcript-follow-chip">
              Follow playback
            </button>
          )}
        </div>
      )}
    </div>
  );
});

/* ── Vocabulary / Grammar drawers (Gemini learning metadata) ──────────── */
function Section({ title, children }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-bold uppercase tracking-wider text-white/50">{title}</div>
      {children}
    </div>
  );
}

function SummaryCard({ learning }) {
  if (!learning?.summary && !learning?.cefrLevel) return null;
  return (
    <div className="rounded-lg p-3" style={{ background: "rgba(212,168,67,0.08)", border: "1px solid rgba(212,168,67,0.2)" }}>
      <div className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: GOLD }}>AI lesson summary</div>
      {learning.cefrLevel && (
        <span className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded mb-1.5"
              style={{ background: "rgba(212,168,67,0.2)", color: "#FFE19A" }}>
          CEFR {learning.cefrLevel}
        </span>
      )}
      {learning.summary && <p className="text-[12.5px] text-white/75 leading-relaxed">{learning.summary}</p>}
    </div>
  );
}

function VocabularyPanel({ learning }) {
  if (!learning || (
    !(learning.vocabulary || []).length && !(learning.keyExpressions || []).length &&
    !(learning.phrasalVerbs || []).length && !(learning.idioms || []).length
  )) {
    return (
      <div className="p-4 text-[13px] text-white/45" data-testid="video-vocabulary-empty">
        Vocabulary insights for this lesson are being prepared.
      </div>
    );
  }
  return (
    <div className="p-4 space-y-4" data-testid="video-vocabulary-panel">
      <SummaryCard learning={learning} />
      {(learning.learningObjectives || []).length > 0 && (
        <Section title="You will learn">
          <ul className="space-y-1">
            {learning.learningObjectives.map((o, i) => (
              <li key={i} className="text-[12.5px] text-white/70 flex gap-1.5"><span style={{ color: GOLD }}>•</span>{o}</li>
            ))}
          </ul>
        </Section>
      )}
      {(learning.vocabulary || []).length > 0 && (
        <Section title="Vocabulary">
          <div className="space-y-2">
            {learning.vocabulary.map((v, i) => (
              <div key={i} className="rounded-lg bg-white/5 border border-white/10 p-2.5" data-testid={`vocab-item-${i}`}>
                <div className="text-[13px] font-bold" style={{ color: GOLD }}>{v.word}</div>
                {v.definition && <div className="text-[12px] text-white/70 mt-0.5">{v.definition}</div>}
                {v.example && <div className="text-[11.5px] text-white/45 italic mt-0.5">“{v.example}”</div>}
                {/* Khmer explanation — a genuine explanation of MEANING in
                    natural Khmer (Gemini's meaningKm/usageKm fields), never
                    a mechanical word-for-word translation of `definition`.
                    Absent for a legacy lesson or if Gemini translation
                    failed — gracefully hidden, never fabricated. */}
                {(v.meaningKm || v.usageKm) && (
                  <div className="mt-1.5 pt-1.5 border-t border-white/10 space-y-0.5" data-testid={`vocab-item-${i}-km`}>
                    {v.meaningKm && (
                      <div className="tp-km-text text-[12px]" style={{ color: "rgba(255,255,255,0.85)" }} lang="km">
                        {v.meaningKm}
                      </div>
                    )}
                    {v.usageKm && (
                      <div className="tp-km-text text-[11px] text-white/45" lang="km">{v.usageKm}</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}
      {(learning.keyExpressions || []).length > 0 && (
        <Section title="Key expressions">
          <div className="flex flex-wrap gap-1.5">
            {learning.keyExpressions.map((e, i) => (
              <span key={i} className="text-[11.5px] px-2 py-1 rounded-full bg-white/5 border border-white/10 text-white/70">{e}</span>
            ))}
          </div>
        </Section>
      )}
      {(learning.phrasalVerbs || []).length > 0 && (
        <Section title="Phrasal verbs">
          {learning.phrasalVerbs.map((p, i) => (
            <div key={i} className="text-[12.5px] text-white/70"><b style={{ color: GOLD }}>{p.phrase}</b> — {p.meaning}</div>
          ))}
        </Section>
      )}
      {(learning.idioms || []).length > 0 && (
        <Section title="Idioms">
          {learning.idioms.map((p, i) => (
            <div key={i} className="text-[12.5px] text-white/70"><b style={{ color: GOLD }}>{p.phrase}</b> — {p.meaning}</div>
          ))}
        </Section>
      )}
    </div>
  );
}

function GrammarPanel({ learning }) {
  if (!learning || !(learning.grammarPoints || []).length) {
    return (
      <div className="p-4 text-[13px] text-white/45" data-testid="video-grammar-empty">
        Grammar notes for this lesson are being prepared.
      </div>
    );
  }
  return (
    <div className="p-4 space-y-4" data-testid="video-grammar-panel">
      <SummaryCard learning={learning} />
      <Section title="Grammar notes">
        <div className="space-y-2">
          {learning.grammarPoints.map((g, i) => (
            <div key={i} className="rounded-lg bg-white/5 border border-white/10 p-2.5" data-testid={`grammar-item-${i}`}>
              <div className="text-[12.5px] font-bold text-white/85">{g.point}</div>
              <div className="text-[12px] text-white/60 mt-0.5">{g.explanation}</div>
              {/* Same "genuinely useful Khmer explanation, not mechanical
                  translation" treatment as vocabulary above. */}
              {g.explanationKm && (
                <div className="mt-1.5 pt-1.5 border-t border-white/10 tp-km-text text-[12px]"
                     style={{ color: "rgba(255,255,255,0.85)" }} lang="km" data-testid={`grammar-item-${i}-km`}>
                  {g.explanationKm}
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function NotesPanel({ lessonId }) {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState("idle");
  const timerRef = useRef(null);

  useEffect(() => {
    let alive = true;
    getNote(lessonId).then((n) => { if (alive) { setText(n.text || ""); setLoaded(true); } })
      .catch(() => setLoaded(true));
    return () => { alive = false; };
  }, [lessonId]);

  const handleChange = (value) => {
    setText(value);
    setSaveState("saving");
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try { await saveNote(lessonId, value); setSaveState("saved"); }
      catch { setSaveState("idle"); }
    }, 800);
  };

  return (
    <div className="p-4 space-y-2 flex-1 flex flex-col" data-testid="video-notes-panel">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold flex items-center gap-1.5 text-white/70">
          <StickyNote size={13} /> Study notes
        </span>
        <span className="text-[10px] text-white/35">
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved ✓" : "Synced across devices"}
        </span>
      </div>
      <textarea value={text} onChange={(e) => handleChange(e.target.value)} disabled={!loaded}
                placeholder="Take notes while you watch…"
                data-testid="video-notes-textarea"
                className="w-full flex-1 min-h-[140px] rounded-lg bg-white/5 border border-white/10 p-2.5 text-[12.5px] text-white placeholder:text-white/30 resize-none" />
    </div>
  );
}

function PurchaseGate({ lesson, onPurchased }) {
  const [showModal, setShowModal] = useState(false);
  return (
    <div className="relative flex flex-col items-center justify-center text-center px-6 py-14 overflow-hidden"
         data-testid="video-purchase-gate">
      {lesson.thumbnailUrl && (
        <div aria-hidden className="absolute inset-0 opacity-25"
             style={{ backgroundImage: `url(${lesson.thumbnailUrl})`, backgroundSize: "cover",
                      backgroundPosition: "center", filter: "blur(18px)" }} />
      )}
      <div className="absolute inset-0" style={{ background: "linear-gradient(to top, rgba(0,0,0,0.92), rgba(0,0,0,0.55))" }} />
      <div className="relative space-y-4 max-w-md flex flex-col items-center">
        {lesson.thumbnailUrl ? (
          <img src={lesson.thumbnailUrl} alt=""
               className="w-56 aspect-video object-cover rounded-xl border border-white/15 shadow-2xl" />
        ) : (
          <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: "rgba(212,168,67,0.14)" }}>
            <Lock size={20} style={{ color: GOLD }} />
          </div>
        )}
        <div>
          <h2 className="text-[17px] font-bold text-white mb-1">{lesson.title}</h2>
          {lesson.description && <p className="text-[12px] text-white/45 mb-1 line-clamp-3">{lesson.description}</p>}
          <p className="text-[13px] text-white/55">Premium lesson · {formatPoints(lesson.price)} EduHub Points</p>
        </div>
        <button onClick={() => setShowModal(true)}
                data-testid="video-purchase-gate-unlock-button"
                className="px-6 py-3 rounded-xl text-[14px] font-bold text-black inline-flex items-center gap-2 transition-transform active:scale-[0.98]"
                style={{ background: GOLD }}>
          <Lock size={14} /> Unlock Lesson
        </button>
      </div>
      <PurchaseLessonModal lesson={lesson} open={showModal}
                           onClose={() => setShowModal(false)}
                           onUnlocked={() => { setShowModal(false); onPurchased(); }} />
    </div>
  );
}

const TABS = [
  { key: "transcript", label: "Transcript", Icon: AlignLeft },
  { key: "teleprompter", label: "Teleprompter", Icon: MonitorPlay },
  { key: "vocabulary", label: "Vocabulary", Icon: GraduationCap },
  { key: "grammar", label: "Grammar", Icon: BookMarked },
  { key: "notes", label: "Notes", Icon: StickyNote },
];

export default function VideoLessonPlayer() {
  const { lessonId } = useParams();
  const navigate = useNavigate();
  const mediaRef = useRef(null);
  // Fullscreen target — deliberately wraps the Stage AND the side panel
  // (see the grid div below), not just the video. Previously bound to the
  // video stage alone, so native Fullscreen showed only the video and
  // silently dropped the transcript/teleprompter panel, which lives in a
  // sibling div outside the stage. Renamed from `stageRef` accordingly.
  const playerRef = useRef(null);
  const lastReportedRef = useRef(0);
  const resumeRef = useRef(0);
  const tabRailRef = useRef(null);
  const tabButtonRefs = useRef({});
  const loopRef = useRef(null); // {start, end} while looping
  // The additive AI Narration track — a SEPARATE <audio> element kept in
  // sync with the video's own currentTime (never a second independent
  // clock: every correction below reads mediaRef.current.currentTime as
  // the source of truth). The original video's own soundtrack is never
  // muxed/replaced — it's simply muted while this plays over it.
  const narrationAudioRef = useRef(null);

  const [lesson, setLesson] = useState(null);
  const [sync, setSync] = useState(null);
  const [narrationSync, setNarrationSync] = useState(null);
  const [audioMode, setAudioMode] = useState("original"); // "original" | "narration"
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("transcript");
  const [speed, setSpeed] = useState(1);
  const [theater, setTheater] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showChapters, setShowChapters] = useState(false);
  const [looping, setLooping] = useState(false);
  const [bookmarks, setBookmarks] = useState([]);
  const [saved, setSaved] = useState(false);
  const [savedBusy, setSavedBusy] = useState(false);
  const [showTpSettings, setShowTpSettings] = useState(false);
  const [tpOverrides, setTpOverrides] = useState(() => readLocalOverrides());
  // Honest playback diagnostics for the main media element — distinct from
  // `error` above (which is only the lesson-fetch API failure). Never a
  // fake "ready" state while the browser is actually stuck buffering or
  // has hit a real MediaError; see mediaDiagnostics.js and
  // video_render_tools.py's -movflags +faststart fix for the root cause
  // this surfaces (a final master rendered without faststart forces the
  // browser to fetch the whole file before duration/seek resolve).
  const [mediaIssue, setMediaIssue] = useState(null);
  const stallTimerRef = useRef(null);

  const tpConfig = useMemo(
    // centerFocus is forced on here, not carried as an author/local
    // override — it's this specific surface's cinematic reading mode (see
    // Teleprompter.jsx's docstring), not a student reading preference like
    // fontScale/autoScroll. Author Studio's own Teleprompter preview does
    // NOT pass this, so it keeps rendering exactly as before.
    () => mergeTeleprompterConfig(lesson?.teleprompterConfig, tpOverrides, { centerFocus: true }),
    [lesson, tpOverrides],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const doc = await getLesson(lessonId);
      setLesson(doc);
      if (doc?.owned && doc?.syncId) {
        setSync(await getSyncDocument(doc.syncId));
      }
      if (doc?.owned && doc?.aiNarrationAvailable && doc?.aiNarrationSyncId) {
        getSyncDocument(doc.aiNarrationSyncId).then(setNarrationSync).catch(() => {});
      }
      if (doc?.owned) {
        listRecentlyWatched().then((all) => {
          const mine = all.find((p) => p.lessonId === lessonId);
          if (mine && !mine.completed && mine.positionSec > 3) resumeRef.current = mine.positionSec;
        }).catch(() => {});
      }
      if (doc?.status !== "draft") {
        try {
          const mine = await listBookmarks();
          setSaved(mine.some((b) => b.lessonId === lessonId));
        } catch { /* non-critical */ }
      }
    } catch (e) {
      setError(e.message || "Could not load this lesson.");
    } finally {
      setLoading(false);
    }
  }, [lessonId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(bookmarksKey(lessonId));
      setBookmarks(raw ? JSON.parse(raw) : []);
    } catch { /* ignore */ }
  }, [lessonId]);

  useEffect(() => {
    const onFsChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // Mobile tab rail: keep the active tab scrolled into view (it can start
  // partially/fully off-screen once the rail scrolls horizontally instead
  // of squeezing every tab to fit — see the tab bar's render below).
  useEffect(() => {
    tabButtonRefs.current[tab]?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [tab]);

  const chapters = useMemo(() => deriveChapters(sync), [sync]);
  const sentences = useMemo(() => flatSentences(sync), [sync]);
  // A rendered final master (real embedded-audio MP4 — see video_render_
  // tools.py) is an OPTIONAL upgrade over the additive dual-audio-element
  // track: when present, "AI Narrated" mode simply swaps the video's own
  // src to the master file — one element, one native audio stream, no
  // separate <audio> to keep in sync. Lessons without a rendered master
  // keep using the additive track exactly as before (this branch is purely
  // additive; the non-master code paths below are byte-for-byte unchanged).
  const hasMaster = Boolean(lesson?.aiNarrationMasterAvailable && lesson?.aiNarrationMasterMediaRef);
  // The audio the student actually hears determines the synchronization
  // (per the AI Narration principle): when the narration track is
  // selected, the karaoke engine reads from the narration <audio> element
  // (or, with a rendered master, the video element itself — the master's
  // embedded audio timing is identical to the assembled narration track it
  // was muxed from) and its own sync document — real ElevenLabs
  // per-character alignment, not the original video's transcript.
  const activeMediaRef = (audioMode === "narration" && !hasMaster) ? narrationAudioRef : mediaRef;
  const activeSync = audioMode === "narration" ? narrationSync : sync;
  const lessonHasTranslation = useMemo(() => hasAnyTranslation(activeSync), [activeSync]);
  // Real-time karaoke engine — rAF-samples the active media element's own
  // clock while playing; per-sentence subscribers re-render only on
  // transitions.
  const syncStore = useSyncHighlight(activeMediaRef, activeSync, currentTime);

  const handleTimeUpdate = () => {
    const t = mediaRef.current?.currentTime || 0;
    setCurrentTime(t);
    if (loopRef.current && t > loopRef.current.end) {
      mediaRef.current.currentTime = loopRef.current.start;
      return;
    }
    // Drift correction only — the video remains the single playback clock
    // driving play/pause/seek; this narrows any accumulated gap between
    // the two elements' independent decoders, never introduces a second
    // timer or reassigns authority over currentTime. Not needed with a
    // rendered master — there is only one element, one native clock.
    if (!hasMaster && audioMode === "narration" && narrationAudioRef.current) {
      const drift = Math.abs(narrationAudioRef.current.currentTime - t);
      if (drift > 0.3) narrationAudioRef.current.currentTime = t;
    }
    if (Math.abs(t - lastReportedRef.current) >= PROGRESS_REPORT_INTERVAL_SEC) {
      lastReportedRef.current = t;
      const dur = mediaRef.current?.duration || lesson?.durationSec || 0;
      reportProgress(lessonId, { positionSec: t, durationSec: dur }).catch(() => {});
    }
  };

  const handleLoadedMetadata = () => {
    setDuration(mediaRef.current?.duration || 0);
    if (resumeRef.current > 0 && mediaRef.current) {
      mediaRef.current.currentTime = resumeRef.current;
      resumeRef.current = 0;
    }
  };

  const clearStallTimer = () => {
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  };
  const handleMediaLoadStart = () => {
    clearStallTimer();
    setMediaIssue(null);
  };
  const armStallTimer = () => {
    clearStallTimer();
    stallTimerRef.current = setTimeout(() => {
      setMediaIssue({
        kind: "stall",
        message: "Playback is taking unusually long to buffer. Check your connection, or try reloading.",
      });
    }, STALL_THRESHOLD_MS);
  };
  const handleMediaWaiting = () => {
    armStallTimer();
  };
  // `progress` fires repeatedly (roughly every ~350ms per the HTML5 media
  // spec) for as long as the browser is actively receiving bytes — it is
  // the browser's own signal that the download hasn't stopped, distinct
  // from `waiting`, which just means playback has paused because it
  // doesn't have enough buffered yet to resume. A large file can
  // legitimately need more than STALL_THRESHOLD_MS of continuous download
  // before there's enough buffer to play, which used to trip this same
  // timer even while data kept arriving the whole time (root cause of the
  // "taking unusually long to buffer" warning firing during ordinary
  // buffering, not just genuine stalls). Re-arming — rather than clearing
  // — on progress means a real stall (bytes genuinely stop arriving) still
  // reports honestly once STALL_THRESHOLD_MS passes with no further
  // progress; only continued, live progress keeps deferring it. Only
  // re-arms when a stall timer is already pending (mid-"waiting"), so this
  // is a no-op during ordinary playback where nothing is buffering.
  const handleMediaProgress = () => {
    if (stallTimerRef.current) armStallTimer();
  };
  const handleMediaRecovered = () => {
    clearStallTimer();
    setMediaIssue(null);
  };
  const handleMediaError = () => {
    clearStallTimer();
    setMediaIssue({ kind: "error", message: describeMediaError(mediaRef.current) || "The media failed to load." });
  };
  useEffect(() => clearStallTimer, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { handleMediaLoadStart(); }, [lesson?.mediaRef, audioMode]);

  const togglePlay = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) {
      el.play();
      if (!hasMaster && audioMode === "narration") narrationAudioRef.current?.play().catch(() => {});
    } else {
      el.pause();
      if (!hasMaster) narrationAudioRef.current?.pause();
    }
  };

  const seekTo = useCallback((sec) => {
    const t = Math.max(0, sec);
    if (mediaRef.current) mediaRef.current.currentTime = t;
    if (!hasMaster && audioMode === "narration" && narrationAudioRef.current) narrationAudioRef.current.currentTime = t;
  }, [audioMode, hasMaster]);

  /** Original / AI Narration — an additive audio track choice, never a
   * video-editing operation. Switching mutes/unmutes the video's own
   * soundtrack and hands control of the (single) media clock's audio
   * output to whichever element is selected, syncing the newly-active
   * track to the video's current position immediately. */
  const handleAudioModeChange = (mode) => {
    if (mode === audioMode) return;
    setAudioMode(mode);
    const el = mediaRef.current;
    const t = el?.currentTime || 0;

    if (hasMaster) {
      // One element, one native audio stream — swap the video's own src
      // between the original upload and the rendered embedded-audio
      // master. No muting, no second element to keep in sync.
      if (!el) return;
      const wasPlaying = !el.paused;
      el.src = resolveMediaSrc(mode === "narration" ? lesson.aiNarrationMasterMediaRef : lesson.mediaRef);
      el.load();
      el.currentTime = t;
      // Promise.resolve(...) wrapper (not a direct .catch()) because
      // HTMLMediaElement.play() is not spec-guaranteed to return a Promise
      // in every environment this runs in (e.g. jsdom returns undefined).
      if (wasPlaying) Promise.resolve(el.play()).catch(() => {});
      return;
    }

    if (mode === "narration") {
      if (el) el.muted = true;
      if (narrationAudioRef.current) {
        narrationAudioRef.current.currentTime = t;
        if (el && !el.paused) narrationAudioRef.current.play().catch(() => {});
      }
    } else {
      if (el) el.muted = false;
      narrationAudioRef.current?.pause();
    }
  };

  const cycleSpeed = () => {
    const idx = SPEEDS.indexOf(speed);
    const next = SPEEDS[(idx + 1) % SPEEDS.length];
    setSpeed(next);
    if (mediaRef.current) mediaRef.current.playbackRate = next;
  };

  const toggleLoop = useCallback(() => {
    if (looping) {
      loopRef.current = null;
      setLooping(false);
      return;
    }
    const idx = computeActiveSentence(sync, mediaRef.current?.currentTime || 0);
    const s = sentences[idx];
    if (!s) return;
    loopRef.current = { start: s.start, end: s.end };
    setLooping(true);
  }, [looping, sync, sentences]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else playerRef.current?.requestFullscreen?.();
  };

  const handleToggleSaved = async () => {
    if (savedBusy) return;
    setSavedBusy(true);
    try {
      const result = await toggleBookmark(lessonId);
      setSaved(Boolean(result?.bookmarked));
    } catch { /* ignore */ }
    finally { setSavedBusy(false); }
  };

  const handleAddBookmark = () => {
    const t = mediaRef.current?.currentTime || 0;
    const next = [...bookmarks, { atSec: Math.round(t), label: `Bookmark at ${fmt(t)}` }];
    setBookmarks(next);
    try { localStorage.setItem(bookmarksKey(lessonId), JSON.stringify(next)); } catch { /* ignore */ }
  };

  const handleTpChange = (next) => {
    setTpOverrides(next);
    writeLocalOverrides(next);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <Loader2 className="animate-spin text-white/40" size={28} />
      </div>
    );
  }

  if (error || !lesson) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-[14px] text-white/70">{error || "Lesson not found."}</div>
        <Link to="/video-library" className="text-[13px]" style={{ color: GOLD }}>Back to Video Library</Link>
      </div>
    );
  }

  const isLocked = Number(lesson.price) > 0 && !lesson.owned;
  const isAudio = (lesson.contentType || "").startsWith("audio/");
  const showSidePanel = !isLocked && !theater;
  const currentChapterIdx = chapters.findIndex((c) => currentTime >= c.start && currentTime <= c.end + 0.5);

  return (
    <div className="h-screen bg-black text-white flex flex-col overflow-hidden" data-testid="video-lesson-player">
      {/* Top bar — this player renders OUTSIDE AppShell (its own full-bleed
          route, see this file's module docstring), so it gets none of
          Header.jsx's safe-area handling for free. On a notch/Dynamic
          Island device this bar sits directly under the status bar without
          explicit top/left/right insets. */}
      <div className="flex items-center gap-3 px-4 py-3"
           style={{
             paddingTop: "max(0.75rem, env(safe-area-inset-top))",
             paddingLeft: "max(1rem, env(safe-area-inset-left))",
             paddingRight: "max(1rem, env(safe-area-inset-right))",
           }}>
        <button onClick={() => navigate("/video-library")} data-testid="video-player-back-button" aria-label="Back to Video Library">
          <ArrowLeft size={20} />
        </button>
        <div className="text-[13px] font-semibold truncate flex-1">{lesson.title}</div>
        {!isLocked && (
          <>
            <button onClick={cycleSpeed} data-testid="video-speed-button"
                    className="text-[11px] font-bold tabular-nums px-2 py-1 rounded-md border border-white/15 text-white/70 hover:text-white">
              {speed}×
            </button>
            <button onClick={handleToggleSaved} disabled={savedBusy}
                    data-testid="video-save-lesson-button"
                    aria-label={saved ? "Remove from My Bookmarks" : "Save to My Bookmarks"}
                    aria-pressed={saved}
                    className="p-1.5 disabled:opacity-50">
              {saved ? <BookmarkCheck size={18} style={{ color: GOLD }} /> : <Bookmark size={18} className="text-white/60" />}
            </button>
          </>
        )}
      </div>

      {/* flex-1 min-h-0 is the fix for Bug 3's real root cause: this grid
          previously had no bounded height of its own (the old root was
          min-h-screen, which grows to fit content rather than clipping to
          the device viewport), so its overflow-y-auto never engaged — the
          WHOLE PAGE scrolled instead of just this pane, and the mobile side
          panel's max-h-[70vh] (a fraction of the FULL screen, blind to how
          much of it the video/controls/dock above already consumed) could
          push the layout past the real viewport bottom. Confirmed via real
          browser DOM measurement: .tp-viewport's own internal scroll logic
          was always correct — it just never got a correctly-bounded parent
          to measure against. grid-rows-[auto_1fr] gives the Stage its
          natural height and the side panel exactly the real remaining
          space; lg: reverts to the unaffected, unchanged desktop two-column
          layout. */}
      <div ref={playerRef}
           className={`grid grid-cols-1 gap-0 bg-black overflow-y-auto flex-1 min-h-0 ${showSidePanel ? "grid-rows-[auto_1fr] lg:grid-rows-none lg:grid-cols-[1fr_400px]" : ""}`}>
        {/* Stage */}
        <div className="relative bg-black flex flex-col">
          {isLocked ? (
            <PurchaseGate lesson={lesson} onPurchased={load} />
          ) : isAudio ? (
            <div className="flex flex-col items-center justify-center py-10 px-6 gap-5"
                 style={{ background: "linear-gradient(160deg, rgba(212,168,67,0.10), rgba(0,0,0,0) 70%)" }}>
              <div className="w-20 h-20 rounded-full flex items-center justify-center"
                   style={{ background: "rgba(212,168,67,0.14)", border: "1px solid rgba(212,168,67,0.3)" }}>
                <Music size={30} style={{ color: GOLD }} />
              </div>
              <div className="text-center">
                <div className="text-[15px] font-bold">{lesson.title}</div>
                {lesson.instructor && <div className="text-[12px] text-white/50 mt-0.5">{lesson.instructor}</div>}
              </div>
              <audio ref={mediaRef} src={resolveMediaSrc(lesson.mediaRef)} controls className="w-full max-w-md"
                     onTimeUpdate={handleTimeUpdate} onLoadedMetadata={handleLoadedMetadata}
                     onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
                     onLoadStart={handleMediaLoadStart} onWaiting={handleMediaWaiting}
                     onProgress={handleMediaProgress}
                     onCanPlay={handleMediaRecovered} onPlaying={handleMediaRecovered}
                     onError={handleMediaError}
                     data-testid="video-player-element" />
              {mediaIssue && (
                <div className={`w-full max-w-md flex items-start gap-1.5 px-3 py-2 rounded-lg text-[11px] ${mediaIssue.kind === "error" ? "bg-red-500/10 text-red-300" : "bg-amber-500/10 text-amber-200"}`}
                     data-testid="video-media-issue">
                  <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                  <span>{mediaIssue.message}</span>
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Reading-mode compaction (Bug 3): shrinking the video while
                  the Teleprompter tab is open is the ONLY lever, besides
                  the height-chain fix above, that meaningfully moves the
                  active sentence toward the screen's visual center — real
                  measurement showed the anchor-ratio math alone cannot get
                  there on a phone without an impractically tiny video (the
                  math: closing the remaining gap to true center would
                  require the video to shrink below ~35px). This is a
                  bounded, honest compromise (16/7 cinematic crop, mobile
                  only, this tab only — desktop/lg: and every other tab keep
                  the full aspect-video player unchanged), not a claim of
                  literal geometric centering. object-cover on the <video>
                  crops top/bottom instead of stretching/distorting. */}
              <div className={`relative group/stage min-h-0 ${tab === "teleprompter" ? "aspect-[16/7] lg:aspect-video" : "aspect-video"}`}>
                <video ref={mediaRef} src={resolveMediaSrc(lesson.mediaRef)} playsInline
                       className="w-full h-full object-cover" onClick={togglePlay}
                       onTimeUpdate={handleTimeUpdate} onLoadedMetadata={handleLoadedMetadata}
                       onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
                       onLoadStart={handleMediaLoadStart} onWaiting={handleMediaWaiting}
                       onProgress={handleMediaProgress}
                       onCanPlay={handleMediaRecovered} onPlaying={handleMediaRecovered}
                       onError={handleMediaError}
                       data-testid="video-player-element" />
                {mediaIssue && (
                  <div className={`absolute left-2 right-2 bottom-2 flex items-start gap-1.5 px-3 py-2 rounded-lg text-[11px] backdrop-blur-sm ${mediaIssue.kind === "error" ? "bg-red-500/20 text-red-200" : "bg-amber-500/20 text-amber-100"}`}
                       data-testid="video-media-issue">
                    <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                    <span>{mediaIssue.message}</span>
                  </div>
                )}
                {!playing && (
                  <button onClick={togglePlay} aria-label="Play"
                          data-testid="video-big-play-button"
                          className="absolute inset-0 m-auto w-16 h-16 rounded-full flex items-center justify-center transition-transform hover:scale-105"
                          style={{ background: "rgba(212,168,67,0.92)" }}>
                    <Play size={26} className="text-black ml-1" fill="currentColor" />
                  </button>
                )}
              </div>

              {/* Additive AI Narration track — a separate audio element,
                  never rendered as a visible <video>/<audio> control; the
                  Audio toggle below drives which track the student hears.
                  The original video's own soundtrack is never replaced.
                  Not needed when a rendered master exists (hasMaster) —
                  that mode swaps the video's own src instead. */}
              {lesson.aiNarrationAvailable && !hasMaster && (
                <audio ref={narrationAudioRef} src={resolveMediaSrc(lesson.aiNarrationMediaRef)}
                       preload="auto" data-testid="video-narration-audio-element" />
              )}

              {/* Custom control bar. Bottom/side insets matter specifically
                  in native Fullscreen (toggleFullscreen below): the
                  fullscreen element fills the physical screen, so this bar
                  can end up flush against a home-indicator or landscape
                  notch edge — max(...) is a no-op (falls back to the base
                  padding) everywhere else. */}
              <div className="px-3 py-2 bg-[#0c0c0c] border-t border-white/5 space-y-1.5" data-testid="video-control-bar"
                   style={{
                     paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))",
                     paddingLeft: "max(0.75rem, env(safe-area-inset-left))",
                     paddingRight: "max(0.75rem, env(safe-area-inset-right))",
                   }}>
                {lesson.aiNarrationAvailable && (
                  <div className="flex items-center gap-1.5" data-testid="video-audio-mode-toggle">
                    <span className="text-[9.5px] font-bold uppercase tracking-wider text-white/35 mr-1">Audio</span>
                    {[{ key: "original", label: "Original" }, { key: "narration", label: "AI Narrated" }].map((opt) => (
                      <button key={opt.key} onClick={() => handleAudioModeChange(opt.key)}
                              data-testid={`video-audio-mode-${opt.key}`}
                              className="inline-flex items-center gap-1 text-[10.5px] font-semibold px-2 py-0.5 rounded-full border transition-colors"
                              style={audioMode === opt.key
                                ? { color: GOLD, borderColor: "rgba(212,168,67,0.5)", background: "rgba(212,168,67,0.10)" }
                                : { color: "rgba(255,255,255,0.5)", borderColor: "rgba(255,255,255,0.12)" }}>
                        {opt.key === "narration" && <Sparkles size={9} />}
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
                {/* Seek bar with chapter ticks */}
                <div className="relative h-4 flex items-center">
                  <input type="range" min={0} max={duration || 0} step={0.1}
                         value={Math.min(currentTime, duration || 0)}
                         onChange={(e) => seekTo(Number(e.target.value))}
                         data-testid="video-seek-slider"
                         className="w-full accent-[#D4A843] h-1 cursor-pointer" />
                  {duration > 0 && chapters.map((c) => (
                    <span key={c.id} className="absolute top-1/2 -translate-y-1/2 w-[3px] h-[7px] rounded-sm bg-white/40 pointer-events-none"
                          style={{ left: `${(c.start / duration) * 100}%` }} />
                  ))}
                </div>
                <div className="flex items-center gap-3">
                  <button onClick={togglePlay} data-testid="video-play-pause-button" aria-label={playing ? "Pause" : "Play"}
                          className="text-white/85 hover:text-white">
                    {playing ? <Pause size={17} /> : <Play size={17} fill="currentColor" />}
                  </button>
                  <span className="text-[11px] tabular-nums text-white/55">{fmt(currentTime)} / {fmt(duration)}</span>
                  {currentChapterIdx >= 0 && (
                    <span className="hidden sm:inline text-[10.5px] text-white/40 truncate max-w-[180px]">
                      {chapters[currentChapterIdx].label}
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-2.5">
                    {chapters.length > 1 && (
                      <button onClick={() => setShowChapters(!showChapters)}
                              data-testid="video-chapters-button" title="Chapters"
                              className={showChapters ? "text-[#D4A843]" : "text-white/60 hover:text-white"}>
                        <ListVideo size={15} />
                      </button>
                    )}
                    <button onClick={cycleSpeed} className="text-[10.5px] font-bold tabular-nums text-white/60 hover:text-white">
                      {speed}×
                    </button>
                    <button onClick={() => setTheater(!theater)} title="Theater mode"
                            data-testid="video-theater-button"
                            className={`hidden lg:block ${theater ? "text-[#D4A843]" : "text-white/60 hover:text-white"}`}>
                      <RectangleHorizontal size={15} />
                    </button>
                    <button onClick={toggleFullscreen} title="Fullscreen"
                            data-testid="video-fullscreen-button"
                            className="text-white/60 hover:text-white">
                      {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
                    </button>
                  </div>
                </div>
              </div>

              {/* Chapter drawer */}
              {showChapters && chapters.length > 0 && (
                <div className="px-3 py-2 bg-[#0c0c0c] border-t border-white/5 flex gap-2 overflow-x-auto vl-row-scroll"
                     data-testid="video-chapter-list">
                  {chapters.map((c, i) => (
                    <button key={c.id} onClick={() => seekTo(c.start)}
                            data-testid={`video-chapter-${i}`}
                            className="flex-shrink-0 rounded-lg border px-2.5 py-1.5 text-left"
                            style={i === currentChapterIdx
                              ? { borderColor: "rgba(212,168,67,0.5)", background: "rgba(212,168,67,0.10)" }
                              : { borderColor: "rgba(255,255,255,0.1)" }}>
                      <div className="text-[10px] tabular-nums" style={{ color: GOLD }}>{fmt(c.start)}</div>
                      <div className="text-[11px] text-white/70 max-w-[140px] truncate">{c.label}</div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Study side panel */}
        {showSidePanel && (
          <div className="border-t lg:border-t-0 lg:border-l border-white/10 flex flex-col min-h-0 lg:max-h-[calc(100vh-52px)]">
            {/* Learning Dock: the primary way a student moves between
                Read/Teleprompter/Vocabulary/Grammar/Notes. Every tab
                button is >=44px tall (real touch-target minimum, not just
                a visual approximation) and the active tab gets a filled
                gold pill rather than a thin underline — a stronger, calmer
                visual hierarchy than a conventional dev-tool tab strip,
                per the "obvious, not intrusive" bar this surface is held
                to. Mobile: below lg (where the side panel is full-width,
                not the fixed 400px desktop column), tabs size to their own
                content and the row scrolls horizontally instead of
                squeezing every label into an unreadable sliver — the same
                vl-row-scroll rail used elsewhere in this file
                (lg:flex-1 lg:min-w-0 restores the equal-width desktop look
                unchanged). Keys/testids are the existing feature names —
                stable for existing tests and deep links. */}
            <div ref={tabRailRef} className="flex items-stretch gap-1 border-b border-white/10 px-1.5 pt-1.5 pb-2 text-[12px] flex-shrink-0 overflow-x-auto vl-row-scroll">
              {TABS.map(({ key, label, Icon }) => {
                const isActive = tab === key;
                return (
                  <button key={key} onClick={() => setTab(key)}
                          ref={(el) => { tabButtonRefs.current[key] = el; }}
                          data-testid={`video-tab-${key}`}
                          className={`relative flex-shrink-0 lg:flex-1 lg:min-w-0 min-h-[44px] px-3.5 flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl transition-all duration-200 active:scale-[0.97] ${isActive ? "font-bold" : "font-semibold"}`}
                          style={isActive
                            ? { color: GOLD, background: "rgba(212,168,67,0.14)", boxShadow: "inset 0 0 0 1px rgba(212,168,67,0.35)" }
                            : { color: "rgba(255,255,255,0.55)", background: "transparent" }}>
                    <Icon size={16} className="flex-shrink-0" strokeWidth={isActive ? 2.4 : 2} />
                    <span className="lg:truncate">{label}</span>
                    {/* "You are here" marker — a small centered gold dot below
                        the active tab, reinforcing the filled-pill state
                        without adding a second competing visual language
                        (no separate underline treatment). */}
                    {isActive && (
                      <span aria-hidden="true"
                            className="absolute left-1/2 -bottom-1.5 -translate-x-1/2 w-1 h-1 rounded-full"
                            style={{ background: GOLD }} />
                    )}
                  </button>
                );
              })}
              {tab === "teleprompter" && lessonHasTranslation && !showTpSettings && (
                <TranslationToggle
                  value={tpConfig.showTranslation}
                  onChange={(v) => handleTpChange({ ...tpConfig, showTranslation: v })}
                />
              )}
              {tab === "teleprompter" && (
                <button onClick={() => setShowTpSettings(!showTpSettings)}
                        data-testid="video-teleprompter-settings-button"
                        title="Reading preferences"
                        className="min-h-[44px] min-w-[44px] flex items-center justify-center flex-shrink-0 rounded-xl transition-colors duration-200"
                        style={{ color: showTpSettings ? GOLD : "rgba(255,255,255,0.58)", background: showTpSettings ? "rgba(212,168,67,0.14)" : "transparent" }}>
                  <Settings2 size={17} />
                </button>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
              {tab === "transcript" && (
                <TranscriptPanel sync={activeSync} store={syncStore} onSeek={seekTo}
                                 loop={looping} onToggleLoop={toggleLoop} />
              )}
              {tab === "teleprompter" && (
                <Teleprompter sync={activeSync} mediaRef={activeMediaRef} store={syncStore} onSeek={seekTo}
                              config={tpConfig} className="flex-1 min-h-0 text-white" />
              )}
              {tab === "vocabulary" && <VocabularyPanel learning={lesson.learning} />}
              {tab === "grammar" && <GrammarPanel learning={lesson.learning} />}
              {tab === "notes" && <NotesPanel lessonId={lessonId} />}
            </div>

            {tab === "transcript" && (
              <div className="border-t border-white/10 p-3 space-y-2 flex-shrink-0">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-semibold flex items-center gap-1.5 text-white/70"
                        title="Timestamp bookmarks are kept on this device; use the header bookmark to save the lesson across devices">
                    <Bookmark size={13} /> Bookmarks <span className="text-[9px] font-normal text-white/35">(this device)</span>
                  </span>
                  <button onClick={handleAddBookmark} data-testid="video-add-bookmark-button" className="text-[11px]" style={{ color: GOLD }}>
                    + Add at current time
                  </button>
                </div>
                {bookmarks.length === 0 ? (
                  <div className="text-[11.5px] text-white/40">No bookmarks yet.</div>
                ) : (
                  <div className="space-y-1 max-h-24 overflow-y-auto">
                    {bookmarks.map((b, i) => (
                      <button key={i} onClick={() => seekTo(b.atSec)} className="block text-[12px] text-white/70 hover:text-white">
                        {b.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Reading Preferences — a real bottom sheet, not an in-flow panel
          swap. Root cause of the old behavior (settings content able to
          extend under the home indicator / become unreachable): the
          previous version rendered TeleprompterSettings INSIDE the side
          panel's own `max-h-[70vh]` + `overflow-y-auto` flow, itself
          inside the page-level `overflow-y-auto` player grid — nested
          scroll containers with no safe-area awareness of their own, and
          a height budget (70vh) that has no relationship to how much
          screen the video/control bar/dock chrome above it already used.
          `position: fixed` anchors this to the real viewport regardless
          of any of that, `env(safe-area-inset-*)` keeps its header and
          scrollable body clear of the Dynamic Island and home indicator,
          and its own `max-h` + `overflow-y-auto` guarantees the Save/
          Reset controls stay reachable by scrolling the SHEET, not the
          page. Teleprompter itself is unaffected — it keeps rendering
          underneath at its normal size the whole time (see the tab body
          above), so reopening it never resizes/remounts the reading
          surface. */}
      {showTpSettings && (
        <div className="fixed inset-0 z-50 flex items-end justify-center lg:items-center"
             data-testid="video-teleprompter-settings-backdrop"
             onClick={() => setShowTpSettings(false)}>
          <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" aria-hidden="true" />
          <div className="relative w-full lg:max-w-md bg-[#111214] border border-white/10 rounded-t-2xl lg:rounded-2xl flex flex-col shadow-2xl"
               style={{ maxHeight: "min(82vh, 640px)", marginBottom: "env(safe-area-inset-bottom)" }}
               onClick={(e) => e.stopPropagation()}
               data-testid="video-teleprompter-settings-sheet">
            {/* Drag-handle affordance — premium bottom-sheet convention,
                also a second, larger hit target for closing on mobile. */}
            <div className="flex justify-center pt-2.5 pb-1 flex-shrink-0 lg:hidden">
              <span className="w-9 h-1 rounded-full bg-white/20" aria-hidden="true" />
            </div>
            <div className="flex items-center justify-between px-4 flex-shrink-0 border-b border-white/10"
                 style={{ paddingTop: "max(0.6rem, env(safe-area-inset-top))", paddingBottom: "0.75rem" }}>
              <div className="text-[12.5px] font-bold uppercase tracking-wider text-white/70">Reading preferences</div>
              <button onClick={() => setShowTpSettings(false)}
                      data-testid="video-teleprompter-settings-close"
                      aria-label="Close reading preferences"
                      className="min-w-[44px] min-h-[44px] -mr-2 flex items-center justify-center rounded-full text-white/55 hover:text-white hover:bg-white/5 transition-colors">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-3"
                 style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}>
              <TeleprompterSettings config={tpConfig} onChange={handleTpChange}
                                    onReset={() => handleTpChange({})} showModeControls />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
