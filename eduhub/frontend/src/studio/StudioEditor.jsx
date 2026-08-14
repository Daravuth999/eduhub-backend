/**
 * StudioEditor — block-based book editor.
 *
 * Opinionated design goals:
 *   • Authors shouldn't care about JSON — they add blocks and type prose.
 *   • Every block knows how to render its own tiny form.
 *   • Autosave to localStorage so accidental reloads don't lose work.
 *   • The canonical output shape matches booksService.normalizeBook.
 *
 * v8.6 — Transcript authoring overhaul (2026-05-05):
 *   The previous transcript editor forced authors to TYPE Start/End in
 *   raw seconds, which is unbearable for any book longer than a minute.
 *   This revision adds:
 *     • Smart MM:SS input (TimecodeInput) that still parses raw seconds
 *     • A per-chapter mini audio scrubber (ChapterAudioScrubber) that
 *       appears only when the chapter contains an audio block
 *     • Capture buttons next to Start / End that copy the scrubber's
 *       currentTime into the block — one tap = one timestamp
 *     • Per-block ▶ Preview that seeks the scrubber and plays
 *     • "✓ Use next start as my End" suggestion (explicit click only)
 *     • Optional keyboard shortcuts:  s = capture Start,  e = capture End
 *
 * The data on disk is BYTE-IDENTICAL to what was saved before — the
 * Reader's TranscriptParagraph still reads block.start, block.end,
 * block.text in seconds, exactly as today. Existing saved books load
 * unchanged. Every other block type, save/preview/newbook handler,
 * autosave key, classname and data-testid is preserved verbatim.
 */
import { useCallback, useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from "react";
import {
  Plus, Trash2, ArrowUp, ArrowDown, Save, Send, Eye, Loader2,
  Image as ImageIcon, Headphones, Film, Quote, MessageSquare,
  ListChecks, PenLine, FileText, AlignLeft, FilePlus2,
  Play, Pause, Crosshair, Check,
} from "lucide-react";
import { saveStudioBook, generateAiVoice, getStudioBook, listVoices } from "./api";
import ConversationVoiceStudio from "./ConversationVoiceStudio";

const BLOCK_TYPES = [
  { type: "paragraph", label: "Paragraph", Icon: AlignLeft },
  { type: "heading", label: "Heading", Icon: PenLine },
  { type: "quote", label: "Quote", Icon: Quote },
  { type: "image", label: "Image", Icon: ImageIcon },
  { type: "audio", label: "Audio", Icon: Headphones },
  { type: "video", label: "Video", Icon: Film },
  { type: "embed", label: "Embed", Icon: Film },
  { type: "dialog", label: "Dialog", Icon: MessageSquare },
  { type: "mcq", label: "MCQ", Icon: ListChecks },
  { type: "fillblank", label: "Fill-blank", Icon: PenLine },
  { type: "transcript", label: "Transcript", Icon: FileText },
  { type: "markdown", label: "Markdown", Icon: FileText },
];

const emptyBook = () => ({
  slug: "",
  title: "Untitled",
  subtitle: "",
  author: "Classroom Library",
  section: "story",
  coverEmoji: "📖",
  coverImage: "",
  coverGradient: "linear-gradient(155deg, #2a2140 0%, #4a3a6a 100%)",
  accent: "#D4A843",
  badge: "",
  level: "",
  readingMinutes: 6,
  price: 0,
  // v9.4 — Visual treatment badge selected by the Author. This field is
  // now the single source of truth for the book's visual styling on the
  // library shelf and reader page. When blank, runtime falls back to the
  // legacy price-band map so books authored before v9.4 keep their
  // previous appearance until the Author opens this editor and picks a
  // badge explicitly.
  tier: "",
  published: true,
  newUntil: "",
  contentType: "",
  format: "blocks",
  chapters: [{ title: "Chapter 1", blocks: [{ type: "paragraph", text: "" }] }],
});

const DRAFT_KEY = "studio_draft_v1";

// ── Dirty-state core (v-bookfactory) ───────────────────────────────────────
// Sentinel signature that no JSON.stringify output can ever equal, so a seed
// flagged dirty stays dirty until the first real save/edit.
const NEVER_SAVED = "\u0000__never_saved__";

/**
 * mediaFingerprint — lightweight, payload-sensitive fingerprint for a stripped
 * `data:` media string. NEVER serializes the full base64 payload. Derived from
 * a MIME/type prefix slice, total length, a short head slice and a short tail
 * slice, so DIFFERENT payloads produce DIFFERENT fingerprints while IDENTICAL
 * payloads produce IDENTICAL fingerprints.
 */
function mediaFingerprint(s) {
  const comma = s.indexOf(",");
  const prefix = comma >= 0 ? s.slice(0, Math.min(comma, 48)) : s.slice(0, 32);
  return `__media__:${prefix}:${s.length}:${s.slice(0, 24)}:${s.slice(-12)}`;
}

/**
 * buildLeanBook — the SINGLE lean transform used by autosave + dirty tracking.
 * Replaces any block whose `text` begins with `data:` with a small fingerprint
 * (preserving the existing performance safeguard: no multi-MB base64 ever hits
 * localStorage or JSON.stringify on a keystroke).
 */
export function buildLeanBook(book) {
  const src = book || {};
  return {
    ...src,
    chapters: (src.chapters || []).map((c) => ({
      ...c,
      blocks: (c.blocks || []).map((b) => {
        if (typeof b?.text === "string" && b.text.startsWith("data:")) {
          return { ...b, text: mediaFingerprint(b.text), _draftStripped: true };
        }
        return b;
      }),
    })),
  };
}

// A seed is "clean" only when it is a real saved book (truthy slug) AND it was
// not explicitly flagged as a dirty seed (Smart Paste / Book Factory handoff
// set `_seedDirty`). Blank books, recovered drafts (no initialBook), and
// flagged seeds are all dirty.
function isCleanSeed(initialBook) {
  return !!(initialBook && initialBook.slug && !initialBook._seedDirty);
}

function stripSeedMarker(book) {
  if (!book || !("_seedDirty" in book)) return book;
  const { _seedDirty, ...rest } = book;
  return rest;
}


/* ─────────────── v8.6 · Timecode helpers ─────────────── */

/**
 * Accepts the formats authors realistically type:
 *   "45"          → 45
 *   "45.3"        → 45.3
 *   "1:23"        → 83
 *   "01:23.5"     → 83.5
 *   "1:02:30"     → 3750
 *   ""            → 0
 * Anything that cannot be parsed coerces to 0 — same behavior as the
 * previous Number(v) || 0 path, so save flow can never see NaN.
 */
function parseTimecode(input) {
  if (input == null) return 0;
  const str = String(input).trim();
  if (!str) return 0;
  // Pure number (with optional decimals): treat as seconds.
  if (/^-?\d+(\.\d+)?$/.test(str)) return Math.max(0, Number(str) || 0);
  // m:ss(.f)? or h:mm:ss(.f)?
  const parts = str.split(":").map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) return 0;
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return 0;
  let total = 0;
  if (parts.length === 2) {
    total = Number(parts[0]) * 60 + Number(parts[1]);
  } else {
    total = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  }
  return Math.max(0, total || 0);
}

function formatTimecode(seconds, { hideZero = false } = {}) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return hideZero ? "" : "0:00";
  const sign = s < 0 ? "-" : "";
  const abs = Math.abs(s);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const sec = abs - h * 3600 - m * 60;
  const secStr = sec.toFixed(sec % 1 === 0 ? 0 : 1).padStart(sec >= 10 ? 2 : 4, "0").replace(/^0(?=\d)/, "0");
  // Easier: split into integer/fraction and pad whole part.
  const whole = Math.floor(sec);
  const frac = sec - whole;
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const sFmt = frac === 0 ? pad(whole) : `${pad(whole)}.${String(frac.toFixed(1)).split(".")[1]}`;
  if (h > 0) return `${sign}${h}:${pad(m)}:${sFmt}`;
  return `${sign}${m}:${sFmt}`;
}

/* ─────────────── v8.6 · Smart timecode input ─────────────── */

function TimecodeInput({ label, value, onChange, testid, captureLabel, onCapture, captureDisabled, captureTitle }) {
  // Local string state so the user can freely type "1:" without it
  // being normalized while they're mid-edit. We commit (parse + propagate)
  // on blur. Re-syncs whenever the parent passes a new numeric value.
  const [draft, setDraft] = useState(formatTimecode(value, { hideZero: true }));
  const lastCommittedRef = useRef(Number(value) || 0);

  useEffect(() => {
    const num = Number(value) || 0;
    if (num !== lastCommittedRef.current) {
      lastCommittedRef.current = num;
      setDraft(formatTimecode(num, { hideZero: true }));
    }
  }, [value]);

  const commit = (raw) => {
    const seconds = parseTimecode(raw);
    lastCommittedRef.current = seconds;
    setDraft(formatTimecode(seconds, { hideZero: true }));
    onChange(seconds);
  };

  return (
    <label className="block">
      <span className="block text-[10px] font-bold uppercase tracking-[0.18em] text-faded mb-1">{label}</span>
      <div className="flex items-stretch gap-1.5">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(e.currentTarget.value);
              e.currentTarget.blur();
            }
          }}
          placeholder="0:00"
          className="flex-1 min-w-0 rounded-lg border border-parchment/15 bg-black/30 px-3 py-2 text-[13px] text-parchment outline-none focus:border-gold tabular-nums"
          data-testid={testid}
        />
        {onCapture && (
          <button
            type="button"
            onClick={onCapture}
            disabled={!!captureDisabled}
            title={captureTitle || captureLabel || "Capture current time"}
            data-testid={testid ? `${testid}-capture` : undefined}
            className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-gold/40 bg-gold/10 px-2 text-[10px] font-bold uppercase tracking-[0.12em] text-gold hover:bg-gold/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Crosshair className="h-3 w-3" />
            <span className="hidden sm:inline">{captureLabel || "Set"}</span>
          </button>
        )}
      </div>
    </label>
  );
}

/* ─────────────── v8.6 · Chapter audio scrubber ───────────────
 * A self-contained inline player. Author-only — never persisted. The
 * chapter passes its first audio block's URL; we expose getCurrentTime,
 * seek and play APIs through a ref imperatively.
 */
function ChapterAudioScrubber({ src, externalRef, onTimeChange }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Expose imperative API to the parent so transcript editors can capture/seek.
  useEffect(() => {
    if (!externalRef) return;
    externalRef.current = {
      getCurrentTime: () => audioRef.current?.currentTime || 0,
      seekAndPlay: (sec) => {
        const el = audioRef.current;
        if (!el) return;
        try {
          el.currentTime = Math.max(0, Number(sec) || 0);
        } catch { /* ignore */ }
        const p = el.play();
        if (p && typeof p.then === "function") p.catch(() => {});
      },
      pause: () => audioRef.current?.pause(),
      isReady: () => !!audioRef.current && audioRef.current.readyState >= 1,
    };
    return () => { if (externalRef) externalRef.current = null; };
  }, [externalRef]);

  if (!src) return null;

  return (
    <div
      className="mb-3 rounded-xl border border-gold/20 p-2.5"
      style={{ background: "rgba(20,14,32,0.65)" }}
      data-testid="chapter-audio-scrubber"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            const el = audioRef.current;
            if (!el) return;
            if (el.paused) { const p = el.play(); if (p && p.catch) p.catch(() => {}); }
            else el.pause();
          }}
          aria-label={playing ? "Pause" : "Play"}
          className="grid h-8 w-8 place-items-center rounded-full bg-gold text-ink hover:bg-gold/80"
          data-testid="chapter-audio-toggle"
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          onChange={(e) => {
            const t = Number(e.target.value) || 0;
            const el = audioRef.current;
            if (el) {
              try { el.currentTime = t; } catch { /* ignore */ }
            }
            setCurrentTime(t);
          }}
          className="flex-1 accent-gold"
          data-testid="chapter-audio-seek"
        />
        <span className="text-[10.5px] font-bold uppercase tracking-wider text-parchment/80 tabular-nums shrink-0">
          {formatTimecode(currentTime)} / {formatTimecode(duration)}
        </span>
      </div>
      <p className="mt-1.5 text-[10px] uppercase tracking-[0.18em] text-faded">
        Editor-only · scrub then tap the ⊕ buttons inside transcript blocks to capture this time
      </p>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration || 0)}
        onTimeUpdate={() => {
          const t = audioRef.current?.currentTime || 0;
          setCurrentTime(t);
          if (onTimeChange) onTimeChange(t);
        }}
      />
    </div>
  );
}

/* ─────────────── Editor root ─────────────── */

const StudioEditor = forwardRef(function StudioEditor({ initialBook, onSaved, onPreview, onDirtyChange }, ref) {
  const [book, setBook] = useState(() => {
    if (initialBook) return structuredClone(stripSeedMarker(initialBook));
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.title) return parsed;
      }
    } catch { /* ignore */ }
    return emptyBook();
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  // ── Dirty-state signatures (single source signature, three consumers) ──
  // currentSignatureRef  — updated by the autosave effect on every book change.
  // lastSavedSignatureRef — the saved baseline; reset on seed change + on save.
  const currentSignatureRef = useRef(undefined);
  const lastSavedSignatureRef = useRef(undefined);
  if (lastSavedSignatureRef.current === undefined) {
    lastSavedSignatureRef.current = isCleanSeed(initialBook)
      ? JSON.stringify(buildLeanBook(stripSeedMarker(initialBook)))
      : NEVER_SAVED;
  }
  const emitDirty = useCallback(() => {
    onDirtyChange?.(currentSignatureRef.current !== lastSavedSignatureRef.current);
  }, [onDirtyChange]);

  useImperativeHandle(ref, () => ({
    // Returns an INDEPENDENT clone of the current full-fidelity book on demand
    // only (never streamed, never the live object).
    exportCurrentDraft: () => structuredClone(book),
    isDirty: () => currentSignatureRef.current !== lastSavedSignatureRef.current,
  }), [book]);

  // ElevenLabs AI Voice state (teacher-side only)
  const VOICE_LS_KEY = "studio_elevenlabs_voice_v1";
  const [elevenLabsLoading, setElevenLabsLoading] = useState(null); // chapterIndex | null
  const [elevenLabsSyncWarning, setElevenLabsSyncWarning] = useState(null);
  const [elevenLabsVoices, setElevenLabsVoices] = useState([]); // [{voice_id, name, gender, accent, ...}]
  const [elevenLabsVoice, setElevenLabsVoice] = useState(() => {
    try { return localStorage.getItem(VOICE_LS_KEY) || ""; } catch { return ""; }
  });
  const [elevenLabsDone, setElevenLabsDone] = useState({}); // { [chapterIndex]: wordCount }

  // ── Stable per-chapter CVS keys (session-only, never persisted) ──────────
  // Chapters have no stored ID, so we maintain a parallel array of random keys
  // in a ref. removeChapter and moveChapter keep this array in sync so CVS
  // state follows the correct chapter even after reordering or deletion.
  const cvsKeysRef = useRef(null);
  const getCvsKey = (ci) => {
    if (cvsKeysRef.current === null) cvsKeysRef.current = [];
    while (cvsKeysRef.current.length <= ci) {
      cvsKeysRef.current.push(Math.random().toString(36).slice(2, 10));
    }
    return cvsKeysRef.current[ci];
  };

  // cvsEverOpened: which chapter keys have ever been opened this session.
  // cvsVisible: which are currently expanded (hidden-but-mounted when absent).
  const [cvsEverOpened, setCvsEverOpened] = useState(() => new Set());
  const [cvsVisible, setCvsVisible] = useState(() => new Set());

  const openCvs = useCallback((key) => {
    setCvsEverOpened((prev) => { const s = new Set(prev); s.add(key); return s; });
    setCvsVisible((prev) => { const s = new Set(prev); s.add(key); return s; });
  }, []);
  const collapseCvs = useCallback((key) => {
    setCvsVisible((prev) => { const s = new Set(prev); s.delete(key); return s; });
  }, []);

  // Load available voices once on mount (teacher-side, requires admin session)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listVoices();
        if (cancelled) return;
        const list = Array.isArray(res?.voices) ? res.voices : [];
        setElevenLabsVoices(list);
        // Pick the saved voice if it's still valid, else server default, else first available
        setElevenLabsVoice((cur) => {
          if (cur && list.some((v) => v.voice_id === cur)) return cur;
          if (res?.default_voice_id && list.some((v) => v.voice_id === res.default_voice_id)) {
            return res.default_voice_id;
          }
          return list[0]?.voice_id || "";
        });
      } catch (e) {
        // Non-fatal: button will simply use the backend default
        console.warn("studio: failed to load ElevenLabs voices", e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist voice choice for this teacher
  useEffect(() => {
    try {
      if (elevenLabsVoice) localStorage.setItem(VOICE_LS_KEY, elevenLabsVoice);
    } catch { /* ignore */ }
  }, [elevenLabsVoice]);

  // v9.11 — "Sync words" karaoke opt-in (per-author preference, persists).
  // When ON, the backend auto-promotes paragraphs to transcript blocks so
  // the reader highlights words in real time. Default OFF — authors decide
  // per-book based on tier (Free/Limited → leave OFF, Premium → flip ON).
  const SYNC_LS_KEY = "studio_elevenlabs_sync_v1";
  const [elevenLabsSync, setElevenLabsSync] = useState(() => {
    try { return localStorage.getItem(SYNC_LS_KEY) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(SYNC_LS_KEY, elevenLabsSync ? "1" : "0"); } catch { /* ignore */ }
  }, [elevenLabsSync]);

  // Autosave draft to localStorage.
  // v9.8 — Strip data: URLs (ElevenLabs returns audio as a multi-MB base64
  // data URL, which blows past the 5 MB origin quota AND makes JSON.stringify
  // expensive on every keystroke). The full audio is still persisted on the
  // server inside the book revision, so reload always restores it.
  // Autosave draft to localStorage + drive dirty state (single stringify).
  // v9.8 perf safeguard preserved: data: media payloads are replaced with a
  // lightweight fingerprint by buildLeanBook BEFORE serialization, so no
  // multi-MB base64 ever hits localStorage or JSON.stringify on a keystroke.
  // The SAME lean signature feeds localStorage, currentSignatureRef, and the
  // onDirtyChange comparison — computed exactly once here.
  useEffect(() => {
    const sig = JSON.stringify(buildLeanBook(book));
    currentSignatureRef.current = sig;
    try {
      localStorage.setItem(DRAFT_KEY, sig);
    } catch { /* ignore — quota or serialization issues are non-fatal */ }
    emitDirty();
  }, [book, emitDirty]);

  // If initialBook changes (e.g. user loaded from Browse), reset editor + CVS
  // state AND the saved baseline — a previous book's signature must never
  // become the baseline for a replacement book.
  useEffect(() => {
    if (initialBook) {
      cvsKeysRef.current = null;
      setCvsEverOpened(new Set());
      setCvsVisible(new Set());
      const seed = stripSeedMarker(initialBook);
      // Update the baseline synchronously here (this effect runs on the render
      // where initialBook changed, before the autosave effect runs for the new
      // book on the subsequent render).
      lastSavedSignatureRef.current = isCleanSeed(initialBook)
        ? JSON.stringify(buildLeanBook(seed))
        : NEVER_SAVED;
      setBook(structuredClone(seed));
    }
  }, [initialBook]);

  const updateField = (k, v) => setBook((b) => ({ ...b, [k]: v }));

  const updateChapter = (idx, patch) => setBook((b) => ({
    ...b,
    chapters: b.chapters.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
  }));

  const updateBlock = (ci, bi, patch) => setBook((b) => ({
    ...b,
    chapters: b.chapters.map((c, i) =>
      i !== ci ? c : { ...c, blocks: c.blocks.map((bk, j) => (j === bi ? { ...bk, ...patch } : bk)) }
    ),
  }));

  const addChapter = () => setBook((b) => ({
    ...b,
    chapters: [...b.chapters, { title: `Chapter ${b.chapters.length + 1}`, blocks: [] }],
  }));
  const removeChapter = (idx) => {
    if (cvsKeysRef.current && idx >= 0 && idx < cvsKeysRef.current.length) {
      const [gone] = cvsKeysRef.current.splice(idx, 1);
      setCvsEverOpened((prev) => { const s = new Set(prev); s.delete(gone); return s; });
      setCvsVisible((prev) => { const s = new Set(prev); s.delete(gone); return s; });
    }
    setBook((b) => ({ ...b, chapters: b.chapters.filter((_, i) => i !== idx) }));
  };
  const moveChapter = (idx, dir) => {
    const j = idx + dir;
    if (cvsKeysRef.current && j >= 0 && j < cvsKeysRef.current.length) {
      [cvsKeysRef.current[idx], cvsKeysRef.current[j]] =
        [cvsKeysRef.current[j], cvsKeysRef.current[idx]];
    }
    setBook((b) => {
      const arr = [...b.chapters];
      if (j < 0 || j >= arr.length) return b;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
      return { ...b, chapters: arr };
    });
  };

  const addBlock = (ci, type) => setBook((b) => ({
    ...b,
    chapters: b.chapters.map((c, i) =>
      i !== ci ? c : { ...c, blocks: [...c.blocks, makeBlock(type)] }
    ),
  }));
  const removeBlock = (ci, bi) => setBook((b) => ({
    ...b,
    chapters: b.chapters.map((c, i) =>
      i !== ci ? c : { ...c, blocks: c.blocks.filter((_, j) => j !== bi) }
    ),
  }));
  const moveBlock = (ci, bi, dir) => setBook((b) => ({
    ...b,
    chapters: b.chapters.map((c, i) => {
      if (i !== ci) return c;
      const arr = [...c.blocks];
      const j = bi + dir;
      if (j < 0 || j >= arr.length) return c;
      [arr[bi], arr[j]] = [arr[j], arr[bi]];
      return { ...c, blocks: arr };
    }),
  }));

  const moveBlockTo = (ci, bi, targetIndex) => setBook((b) => ({
    ...b,
    chapters: b.chapters.map((c, i) => {
      if (i !== ci) return c;
      const arr = [...c.blocks];
      if (bi < 0 || bi >= arr.length) return c;
      const [item] = arr.splice(bi, 1);
      const ti = Math.max(0, Math.min(arr.length, targetIndex));
      arr.splice(ti, 0, item);
      return { ...c, blocks: arr };
    }),
  }));

  const handleNewBook = () => {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    // A brand-new blank book is dirty — reset the baseline so it can never
    // match the prior book's saved signature.
    lastSavedSignatureRef.current = NEVER_SAVED;
    setBook(emptyBook());
    setMsg(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setMsg(null);
    // Snapshot the FULL-fidelity book at click time for the network payload
    // (unstripped — the server must receive complete media, not fingerprints).
    const clickTimeSnapshot = book;
    try {
      const res = await saveStudioBook(clickTimeSnapshot);
      setMsg({ kind: "ok", text: `Saved revision ${res.revision}` });
      // Build the saved baseline from the click-time snapshot + server-confirmed
      // slug, then compare against currentSignatureRef (which reflects whatever
      // the teacher has typed up to this exact moment, INCLUDING edits made
      // while this request was in flight). NEVER compare against the `book`
      // closure variable after await — that is the save-click version, not the
      // latest edits, and would produce a false-clean state.
      const savedBaseline = { ...clickTimeSnapshot, slug: res.slug || clickTimeSnapshot.slug };
      lastSavedSignatureRef.current = JSON.stringify(buildLeanBook(savedBaseline));
      emitDirty();
      // Keep slug so next save is an edit (not a brand-new book).
      setBook((b) => ({ ...b, slug: res.slug }));
      onSaved?.(res);
    } catch (e) {
      setMsg({ kind: "err", text: e.message || "Save failed" });
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(null), 3000);
    }
  };

  // ElevenLabs — generate AI voice for one chapter, then reload the book
  // so the new audio block + per-block wordTimestamps are reflected.
  const handleGenerateVoice = useCallback(async (chapterIndex) => {
    setElevenLabsLoading(chapterIndex);
    setElevenLabsSyncWarning(null);
    try {
      // Auto-save first so the book exists in MongoDB with a valid slug
      const saved = await saveStudioBook(book);
      const slug = saved.slug;
      // §MEDIUM 15: capture the operation-start signature (the known state this
      // operation is based on: the saved book + confirmed slug). Any later
      // divergence in currentSignatureRef means the author edited mid-flight.
      const operationStartSignature = JSON.stringify(buildLeanBook({ ...book, slug }));
      setBook((b) => ({ ...b, slug }));
      // Pass the saved book directly to avoid MongoDB replication lag
      const data = await generateAiVoice(slug, {
        chapterIndex,
        voice: elevenLabsVoice,
        sync: elevenLabsSync,
        book: saved.book || null,
      });
      setElevenLabsDone((prev) => ({ ...prev, [chapterIndex]: data.wordCount }));
      try {
        const res = await getStudioBook(slug);
        const freshBook = res?.book || res;
        if (freshBook && freshBook.chapters) {
          if (currentSignatureRef.current !== operationStartSignature) {
            // Local edits occurred during the operation — do NOT overwrite the
            // local draft, do NOT advance the saved baseline, keep it dirty.
            setElevenLabsSyncWarning(
              "Your local edits were kept. New AI voice audio is saved on the server — reload the book to merge it when ready.");
          } else {
            const freshSignature = JSON.stringify(buildLeanBook(freshBook));
            lastSavedSignatureRef.current = freshSignature;
            setBook(structuredClone(freshBook));
          }
        }
      } catch { /* ignore reload failure — generation succeeded, baseline unchanged */ }
    } catch (e) {
      // Failure path: the saved baseline is never advanced.
      alert(`AI Voice generation failed: ${e.message || e}`);
    } finally {
      setElevenLabsLoading(null);
    }
  }, [book, elevenLabsVoice]); // eslint-disable-line react-hooks/exhaustive-deps

  // Conversation Voice Studio — generate multi-character dialogue audio
  const handleConversationPublished = useCallback(async (slugOrResult) => {
    // slugOrResult can be a slug string (from CVS) or legacy result object
    const resolvedSlug = typeof slugOrResult === "string" ? slugOrResult : book.slug;
    if (!resolvedSlug) return;
    setElevenLabsSyncWarning(null);
    try {
      const res = await getStudioBook(resolvedSlug);
      const freshBook = res?.book || res;
      if (freshBook && freshBook.chapters) {
        // §PHASE F2: check dirty-vs-saved-baseline, not the in-flight delta.
        // The in-flight delta check (`currentSig !== operationStartSig`) only
        // catches edits made DURING the async fetch — it silently overwrites any
        // unsaved changes the author made BEFORE the CV publish event fired.
        // The correct guard is: if the editor is currently dirty (any unsaved
        // edits vs. the saved baseline), warn and preserve the author's work.
        const isDirty = currentSignatureRef.current !== lastSavedSignatureRef.current;
        if (isDirty) {
          setElevenLabsSyncWarning(
            "Your local edits were kept. Newly published conversation audio is saved on the server — reload the book to merge it when ready.");
        } else {
          const freshSignature = JSON.stringify(buildLeanBook(freshBook));
          lastSavedSignatureRef.current = freshSignature;
          setBook(structuredClone(freshBook));
        }
      }
    } catch { /* ignore — failure never advances the saved baseline */ }
  }, [book.slug]);

  /* v8.6 — per-chapter audio scrubber refs (one per chapter, lazy-created) */
  const audioRefsRef = useRef({});
  const getAudioRef = (ci) => {
    if (!audioRefsRef.current[ci]) {
      audioRefsRef.current[ci] = { current: null };
    }
    return audioRefsRef.current[ci];
  };

  /* v8.6 — focused transcript block for keyboard shortcuts */
  const focusedRef = useRef(null); // { ci, bi } | null

  return (
    <div className="space-y-6" data-testid="studio-editor">
      {elevenLabsSyncWarning && (
        <div data-testid="studio-sync-warning"
             className="rounded-lg border border-amber-400/40 bg-amber-900/20 p-2.5 text-[12px] text-amber-200 flex items-center justify-between gap-3">
          <span>{elevenLabsSyncWarning}</span>
          <button data-testid="studio-sync-warning-dismiss" onClick={() => setElevenLabsSyncWarning(null)}
                  className="rounded-full border border-parchment/30 px-2 py-0.5 text-[11px] text-parchment">Dismiss</button>
        </div>
      )}
      {/* Book metadata */}
      <div className="grid gap-3 rounded-2xl border border-gold/20 p-4"
           style={{ background: "rgba(34,24,48,0.6)" }}>
        <div className="flex items-center justify-between">
          <h3 className="font-display text-[18px] text-parchment">Book details</h3>
          <div className="flex items-center gap-2">
            <button onClick={handleNewBook} data-testid="studio-new-book-btn"
                    className="inline-flex items-center gap-1.5 rounded-full border border-parchment/20 bg-walnut/80 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
              <FilePlus2 className="h-3.5 w-3.5" /> New Book
            </button>
            <button onClick={() => onPreview?.(book)} data-testid="studio-preview-btn"
                    className="inline-flex items-center gap-1.5 rounded-full border border-parchment/20 bg-walnut/80 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
              <Eye className="h-3.5 w-3.5" /> Preview
            </button>
            <button onClick={handleSave} disabled={saving} data-testid="studio-save-btn"
                    className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider text-ink disabled:opacity-60"
                    style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {saving ? "Saving" : "Save revision"}
            </button>
          </div>
        </div>
        {msg && (
          <div className={`rounded-xl px-3 py-2 text-[12px] ${msg.kind === "ok" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}
               data-testid="studio-save-msg">
            {msg.text}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="Title" value={book.title} onChange={(v) => updateField("title", v)} testid="studio-field-title" />
          <Input label="Subtitle" value={book.subtitle} onChange={(v) => updateField("subtitle", v)} />
          <Input label="Author" value={book.author} onChange={(v) => updateField("author", v)} />
          <Select label="Section" value={book.section} onChange={(v) => updateField("section", v)}
                  options={[{v:"story",l:"Story"},{v:"conversation",l:"Conversation"},{v:"exercise",l:"Exercise"}]} />
          <Input label="Cover emoji" value={book.coverEmoji} onChange={(v) => updateField("coverEmoji", v)} />
          <Input label="Cover image URL" value={book.coverImage} onChange={(v) => updateField("coverImage", v)} />
          <Input label="Badge (e.g. NEW)" value={book.badge} onChange={(v) => updateField("badge", v)} />
          <Input label="Level (A1/A2/B1)" value={book.level} onChange={(v) => updateField("level", v)} />
          <Input label="Price (pts)" type="number" value={book.price} onChange={(v) => updateField("price", Number(v) || 0)} />
          <Select label="Visual treatment badge" value={book.tier || ""} onChange={(v) => updateField("tier", v)}
                  options={[
                    {v:"",        l:"Auto (legacy price-band fallback)"},
                    {v:"free",    l:"Free — calm slate edge"},
                    {v:"standard",l:"Standard — neutral pill"},
                    {v:"premium", l:"Premium — golden aurora"},
                    {v:"limited", l:"Limited — holographic + pulse"},
                  ]}
                  testid="studio-field-tier" />
          <Input label="Reading minutes" type="number" value={book.readingMinutes} onChange={(v) => updateField("readingMinutes", Number(v) || 0)} />
          <Select label="Status" value={book.published ? "yes" : "no"} onChange={(v) => updateField("published", v === "yes")}
                  options={[{v:"yes",l:"Published"},{v:"no",l:"Draft / Hidden"}]} testid="studio-field-published" />
          <Select label="Content type override" value={book.contentType || ""} onChange={(v) => updateField("contentType", v)}
                  options={[{v:"",l:"Auto"},{v:"text",l:"Text"},{v:"audio",l:"Audio"},{v:"video",l:"Video"}]} />
        </div>
      </div>

      {/* Chapters */}
      {(book.chapters || []).map((ch, ci) => {
        const firstAudio = (ch.blocks || []).find((b) => b?.type === "audio");
        const chapterAudioSrc = firstAudio?.text || "";
        const audioRef = getAudioRef(ci);
        const cvsKey = getCvsKey(ci);
        const panelId = `cvs-panel-${cvsKey}`;
        const isEverOpened = cvsEverOpened.has(cvsKey);
        const isVisible = cvsVisible.has(cvsKey);
        return (
        <div key={ci} className="rounded-2xl border border-gold/20 p-4"
             style={{ background: "rgba(34,24,48,0.45)" }}
             data-testid={`studio-chapter-${ci}`}>
          {/* v9.11 — Chapter header (Row 1) + AI Voice toolbar (Row 2).
              Splitting the row prevents iPhone overflow and gives the
              author a dedicated, easy-to-tap voice toolbar. */}
          <div className="flex items-center gap-2 mb-2 min-w-0">
            <input value={ch.title} onChange={(e) => updateChapter(ci, { title: e.target.value })}
                   className="flex-1 min-w-0 bg-transparent border-b border-parchment/20 pb-1 font-display text-[17px] text-parchment outline-none focus:border-gold"
                   data-testid={`studio-chapter-title-${ci}`} />
            <IconBtn onClick={() => moveChapter(ci, -1)} icon={ArrowUp} title="Move up" />
            <IconBtn onClick={() => moveChapter(ci, 1)} icon={ArrowDown} title="Move down" />
            <IconBtn onClick={() => removeChapter(ci)} icon={Trash2} title="Delete chapter" />
          </div>

          {/* AI Voice toolbar — wraps cleanly from 320px → 1440px. */}
          <div
            className="flex flex-wrap items-center gap-2 mb-3"
            data-testid={`studio-chapter-${ci}-elevenlabs-toolbar`}
          >
            <select
              data-testid={`studio-chapter-${ci}-elevenlabs-voice`}
              value={elevenLabsVoice}
              onChange={(e) => setElevenLabsVoice(e.target.value)}
              disabled={elevenLabsLoading === ci || elevenLabsVoices.length === 0}
              title={elevenLabsVoices.find((v) => v.voice_id === elevenLabsVoice)?.name || "Choose AI voice"}
              style={{
                fontSize: "0.72rem",
                padding: "4px 8px",
                borderRadius: "999px",
                border: "1px solid rgba(155,92,255,0.4)",
                background: "rgba(34,24,48,0.8)",
                color: "#c084fc",
                minWidth: 0,
                maxWidth: "min(180px, 48vw)",
                textOverflow: "ellipsis",
                cursor: elevenLabsLoading === ci ? "wait" : "pointer",
              }}
            >
              {elevenLabsVoices.length === 0 && (
                <option value="">Loading voices…</option>
              )}
              {elevenLabsVoices.map((v) => {
                const tag = [v.gender, v.accent].filter(Boolean).join(" · ");
                return (
                  <option key={v.voice_id} value={v.voice_id}>
                    {v.name}{tag ? ` (${tag})` : ""}
                  </option>
                );
              })}
            </select>

            {/* v9.11 — Sync-words karaoke toggle. Persists per-author. */}
            <button
              type="button"
              role="switch"
              aria-checked={elevenLabsSync}
              onClick={() => setElevenLabsSync((s) => !s)}
              disabled={elevenLabsLoading === ci}
              data-testid={`studio-chapter-${ci}-elevenlabs-sync`}
              title={elevenLabsSync
                ? "Karaoke ON — paragraphs become synced transcripts. Tap to turn off."
                : "Karaoke OFF — audio only, no per-word highlighting. Tap to turn on."}
              style={{
                fontSize: "0.72rem",
                padding: "4px 10px",
                borderRadius: "999px",
                border: `1px solid ${elevenLabsSync ? "rgba(110,231,177,0.55)" : "rgba(155,92,255,0.4)"}`,
                background: elevenLabsSync ? "rgba(110,231,177,0.18)" : "rgba(34,24,48,0.8)",
                color: elevenLabsSync ? "#6ee7b7" : "#a094b8",
                cursor: elevenLabsLoading === ci ? "wait" : "pointer",
                whiteSpace: "nowrap",
                fontWeight: 600,
              }}
            >
              {elevenLabsSync ? "✓ Sync words" : "Sync words"}
            </button>

            <button
              type="button"
              data-testid={`studio-chapter-${ci}-elevenlabs`}
              onClick={() => handleGenerateVoice(ci)}
              disabled={elevenLabsLoading === ci}
              title="Generate AI Voice for this chapter (ElevenLabs)"
              aria-label="Generate AI Voice"
              style={{
                fontSize: "0.72rem",
                padding: "4px 12px",
                borderRadius: "999px",
                border: "1px solid rgba(155,92,255,0.4)",
                background: elevenLabsDone[ci]
                  ? "rgba(155,92,255,0.22)"
                  : "rgba(155,92,255,0.1)",
                color: "#c084fc",
                cursor: elevenLabsLoading === ci ? "wait" : "pointer",
                whiteSpace: "nowrap",
                fontWeight: 600,
                marginLeft: "auto", // push to right edge of the toolbar
                flexShrink: 0,
              }}
            >
              {elevenLabsLoading === ci
                ? "Generating..."
                : elevenLabsDone[ci]
                ? <><span className="hidden sm:inline">✅ AI Voice ({elevenLabsDone[ci]} words)</span><span className="sm:hidden">✅ {elevenLabsDone[ci]}w</span></>
                : <><span className="hidden sm:inline">✨ Generate AI Voice</span><span className="sm:hidden">✨ Generate</span></>}
            </button>
          </div>

          {/* Conversation Voice Studio — lazy-mount once, hidden (not destroyed) when collapsed.
              State (pasted script, speaker assignments) survives collapse/reopen within the session. */}
          <button
            type="button"
            aria-expanded={isVisible}
            aria-controls={panelId}
            onClick={() => isVisible ? collapseCvs(cvsKey) : openCvs(cvsKey)}
            data-testid={`studio-chapter-${ci}-cvs-toggle`}
            style={{
              fontSize: "0.72rem",
              padding: "4px 12px",
              borderRadius: "999px",
              border: "1px solid rgba(251,191,36,0.35)",
              background: isVisible ? "rgba(251,191,36,0.14)" : "rgba(34,24,48,0.7)",
              color: isVisible ? "#fbbf24" : "#a094b8",
              cursor: "pointer",
              fontWeight: 600,
              marginBottom: "6px",
            }}
          >
            {isVisible ? "Collapse Conversation Voice Studio" : "Open Conversation Voice Studio"}
          </button>
          {isEverOpened && (
            <div
              id={panelId}
              hidden={!isVisible}
              aria-hidden={!isVisible ? "true" : undefined}
              style={!isVisible ? { display: "none" } : undefined}
            >
              <ConversationVoiceStudio
                slug={book.slug}
                chapterIndex={ci}
                book={book}
                elevenLabsVoices={elevenLabsVoices}
                onPublished={() => handleConversationPublished(book.slug)}
                onClose={() => collapseCvs(cvsKey)}
                // Zero-copy seeding (§AMENDMENT 8): whatever dialog blocks this
                // chapter ALREADY has (hand-typed or Book-Factory-generated)
                // are offered via an explicit "Load generated dialogue" button
                // inside CVS — never auto-filled, never overwrites edited text.
                initialText={(ch.blocks || [])
                  .filter((b) => b?.type === "dialog" && String(b.text || "").trim())
                  .map((b) => `${b.speaker || "Speaker"}: ${b.text}`)
                  .join("\n")}
                initialChapterId={cvsKey}
                initialVoiceAssignments={book._bfSpeakerVoiceAssignments || undefined}
              />
            </div>
          )}
          <ChapterAudioScrubber src={chapterAudioSrc} externalRef={audioRef} />

          <div className="space-y-3">
            {(ch.blocks || []).map((bk, bi) => {
              const nextTranscriptStart = (() => {
                if (bk.type !== "transcript") return null;
                for (let j = bi + 1; j < ch.blocks.length; j++) {
                  const nb = ch.blocks[j];
                  if (nb?.type === "transcript" && Number(nb.start) > 0) return Number(nb.start);
                }
                return null;
              })();
              return (
                <BlockEditor
                  key={bi}
                  block={bk}
                  onChange={(patch) => updateBlock(ci, bi, patch)}
                  onUp={() => moveBlock(ci, bi, -1)}
                  onDown={() => moveBlock(ci, bi, 1)}
                  onDelete={() => removeBlock(ci, bi)}
                  onMoveToTop={() => moveBlockTo(ci, bi, 0)}
                  onMoveToBottom={() => moveBlockTo(ci, bi, (book.chapters[ci]?.blocks?.length ?? 1) - 1)}
                  testid={`studio-block-${ci}-${bi}`}
                  audioRef={audioRef}
                  nextTranscriptStart={nextTranscriptStart}
                  onFocusBlock={() => { focusedRef.current = { ci, bi }; }}
                />
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5" data-testid={`studio-addblock-${ci}`}>
            {BLOCK_TYPES.map(({ type, label, Icon }) => (
              <button key={type} onClick={() => addBlock(ci, type)}
                      className="inline-flex items-center gap-1 rounded-full border border-parchment/15 px-2.5 py-1 text-[10.5px] font-semibold text-parchment hover:border-gold hover:text-gold"
                      data-testid={`studio-addblock-${ci}-${type}`}>
                <Icon className="h-3 w-3" /> {label}
              </button>
            ))}
          </div>
        </div>
        );
      })}

      {/* v8.6 — keyboard shortcut listener (s = capture Start, e = capture End)
          Only fires when a transcript block is focused AND the focused element
          is not an input/textarea/contentEditable so it never steals letters. */}
      <KeyboardCaptureBridge
        focusedRef={focusedRef}
        getBlock={(ref) => {
          if (!ref?.current) return null;
          const { ci, bi } = ref.current;
          return book.chapters?.[ci]?.blocks?.[bi] || null;
        }}
        getAudioTime={(ref) => {
          if (!ref?.current) return 0;
          const { ci } = ref.current;
          const a = audioRefsRef.current[ci];
          return a?.current?.getCurrentTime?.() || 0;
        }}
        commit={(ref, patch) => {
          if (!ref?.current) return;
          const { ci, bi } = ref.current;
          updateBlock(ci, bi, patch);
        }}
      />

      <button onClick={addChapter} data-testid="studio-add-chapter"
              className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-gold/40 px-4 py-2 text-[12px] font-bold uppercase tracking-wider text-gold hover:bg-gold/10">
        <Plus className="h-4 w-4" /> Add chapter
      </button>
    </div>
  );
});

export default StudioEditor;

function makeBlock(type) {
  switch (type) {
    case "mcq":
      return { type, text: "", options: "A) \nB) \nC) ", answer: "A", explain: "" };
    case "fillblank":
      return { type, text: "", answer: "", explain: "" };
    case "dialog":
      return { type, speaker: "Teacher", text: "" };
    case "transcript":
      return { type, text: "", start: 0, end: 0 };
    default:
      return { type, text: "" };
  }
}

function BlockEditor({ block, onChange, onUp, onDown, onDelete, onMoveToTop, onMoveToBottom, testid, audioRef, nextTranscriptStart, onFocusBlock }) {
  return (
    <div className="rounded-xl border border-parchment/10 p-3"
         style={{ background: "rgba(20,14,32,0.5)" }}
         data-testid={testid}
         onFocus={onFocusBlock}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-faded">
          {block.type}
        </span>
        <div className="flex items-center gap-1">
          {block.type === "transcript" && audioRef && (
            <button
              type="button"
              onClick={() => audioRef?.current?.seekAndPlay?.(Number(block.start) || 0)}
              title="Preview from this block's start"
              data-testid={`${testid}-preview`}
              className="h-7 px-2 inline-flex items-center gap-1 rounded-full text-[10px] font-bold uppercase tracking-[0.12em] text-gold hover:bg-gold/10"
            >
              <Play className="h-3 w-3" /> Preview
            </button>
          )}
          {(block.type === "audio" || block._elevenlabs_audio || block._conversation_audio) && (
            <>
              <button type="button" onClick={onMoveToTop}
                title="Move to top"
                className="h-7 px-2 inline-flex items-center gap-1 rounded-full text-[10px] font-bold uppercase tracking-[0.12em] text-gold hover:bg-gold/10">
                ↑↑ Top
              </button>
              <button type="button" onClick={onMoveToBottom}
                title="Move to bottom"
                className="h-7 px-2 inline-flex items-center gap-1 rounded-full text-[10px] font-bold uppercase tracking-[0.12em] text-gold hover:bg-gold/10">
                ↓↓ Bot
              </button>
            </>
          )}
          <IconBtn onClick={onUp} icon={ArrowUp} title="Move up one" />
          <IconBtn onClick={onDown} icon={ArrowDown} title="Move down one" />
          <IconBtn onClick={onDelete} icon={Trash2} title="Delete block" />
        </div>
      </div>
      {block.type === "mcq" ? (
        <div className="grid gap-2">
          <TextArea label="Question" value={block.text} onChange={(v) => onChange({ text: v })} />
          <TextArea label="Options (one per line, e.g. A) text)" value={block.options || ""} onChange={(v) => onChange({ options: v })} />
          <Input label="Correct answer letter (e.g. B)" value={block.answer || ""} onChange={(v) => onChange({ answer: v })} />
          <Input label="Explanation (optional)" value={block.explain || ""} onChange={(v) => onChange({ explain: v })} />
        </div>
      ) : block.type === "fillblank" ? (
        <div className="grid gap-2">
          <TextArea label="Question" value={block.text} onChange={(v) => onChange({ text: v })} />
          <Input label="Correct answer" value={block.answer || ""} onChange={(v) => onChange({ answer: v })} />
          <Input label="Explanation (optional)" value={block.explain || ""} onChange={(v) => onChange({ explain: v })} />
        </div>
      ) : block.type === "dialog" ? (
        <div className="grid gap-2">
          <Input label="Speaker" value={block.speaker || ""} onChange={(v) => onChange({ speaker: v })} />
          <TextArea label="Line" value={block.text} onChange={(v) => onChange({ text: v })} />
        </div>
      ) : block.type === "transcript" ? (
        <div className="grid gap-2">
          <TextArea label="Passage" value={block.text} onChange={(v) => onChange({ text: v })} />
          <div className="grid grid-cols-2 gap-2">
            <TimecodeInput
              label="Start"
              value={block.start}
              onChange={(v) => onChange({ start: v })}
              testid={`${testid}-start`}
              captureLabel="Start"
              captureTitle="Capture chapter scrubber's current time as Start  (shortcut: S)"
              captureDisabled={!audioRef?.current}
              onCapture={() => {
                const t = audioRef?.current?.getCurrentTime?.();
                if (typeof t === "number") onChange({ start: Number(t.toFixed(2)) });
              }}
            />
            <TimecodeInput
              label="End"
              value={block.end}
              onChange={(v) => onChange({ end: v })}
              testid={`${testid}-end`}
              captureLabel="End"
              captureTitle="Capture chapter scrubber's current time as End  (shortcut: E)"
              captureDisabled={!audioRef?.current}
              onCapture={() => {
                const t = audioRef?.current?.getCurrentTime?.();
                if (typeof t === "number") onChange({ end: Number(t.toFixed(2)) });
              }}
            />
          </div>
          {nextTranscriptStart !== null && (Number(block.end) || 0) <= 0 && (
            <button
              type="button"
              onClick={() => onChange({ end: nextTranscriptStart })}
              className="self-start inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-300 hover:bg-emerald-500/20"
              data-testid={`${testid}-use-next-start`}
              title={`Use next block's start (${formatTimecode(nextTranscriptStart)}) as this block's End`}
            >
              <Check className="h-3 w-3" /> Use {formatTimecode(nextTranscriptStart)} as End
            </button>
          )}
          <p className="text-[10px] text-faded leading-snug">
            Tip — type <span className="font-mono">1:23</span> or <span className="font-mono">83</span>; both work. Press
            <span className="mx-1 px-1 py-px rounded bg-walnut/70 border border-parchment/15 font-mono">S</span>
            to capture Start,
            <span className="mx-1 px-1 py-px rounded bg-walnut/70 border border-parchment/15 font-mono">E</span>
            to capture End while the chapter audio plays.
          </p>
        </div>
      ) : block.type === "audio" && typeof block.text === "string" && (block.text.startsWith("data:") || block._elevenlabs_audio || block._conversation_audio) ? (
        // v9.8 — AI-generated audio is a multi-MB base64 data URL.
        // Rendering that inside a controlled <textarea> crashes React on
        // Vercel production (white screen). Instead show a compact player
        // card with size + a button to swap to a regular URL when needed.
        <AIVoiceBlockCard block={block} onChange={onChange} />
      ) : (
        <TextArea label={block.type === "image" || block.type === "audio" || block.type === "video" || block.type === "embed" ? "URL" : "Content"}
                  value={block.text}
                  onChange={(v) => onChange({ text: v })}
                  rows={block.type === "markdown" || block.type === "paragraph" ? 6 : 2} />
      )}
    </div>
  );
}

/**
 * KeyboardCaptureBridge — listens for `s` / `e` keys at the document level
 * and writes to the focused transcript block. Deliberately rendered as
 * a sibling so it has zero JSX impact on the existing block tree, and
 * checks `event.target` to avoid stealing keypresses while the user
 * is typing in any input/textarea/contentEditable.
 */
function KeyboardCaptureBridge({ focusedRef, getBlock, getAudioTime, commit }) {
  useEffect(() => {
    const onKey = (e) => {
      const k = (e.key || "").toLowerCase();
      if (k !== "s" && k !== "e") return;
      // Don't hijack while typing.
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // Need a focused transcript block.
      const fb = getBlock(focusedRef);
      if (!fb || fb.type !== "transcript") return;
      const time = getAudioTime(focusedRef);
      if (typeof time !== "number") return;
      e.preventDefault();
      const seconds = Number(time.toFixed(2));
      if (k === "s") commit(focusedRef, { start: seconds });
      else commit(focusedRef, { end: seconds });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusedRef, getBlock, getAudioTime, commit]);
  return null;
}

function IconBtn({ onClick, icon: Icon, title }) {
  return (
    <button onClick={onClick} title={title} type="button"
            className="h-7 w-7 grid place-items-center rounded-full text-parchment/70 hover:bg-white/10 hover:text-gold">
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

function Input({ label, value, onChange, type = "text", testid }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-bold uppercase tracking-[0.18em] text-faded mb-1">{label}</span>
      <input type={type} value={value ?? ""} onChange={(e) => onChange(e.target.value)}
             className="w-full rounded-lg border border-parchment/15 bg-black/30 px-3 py-2 text-[13px] text-parchment outline-none focus:border-gold"
             data-testid={testid} />
    </label>
  );
}

function TextArea({ label, value, onChange, rows = 4 }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-bold uppercase tracking-[0.18em] text-faded mb-1">{label}</span>
      <textarea rows={rows} value={value ?? ""} onChange={(e) => onChange(e.target.value)}
                className="w-full rounded-lg border border-parchment/15 bg-black/30 px-3 py-2 text-[13px] text-parchment outline-none focus:border-gold resize-y font-mono" />
    </label>
  );
}

function Select({ label, value, onChange, options, testid }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-bold uppercase tracking-[0.18em] text-faded mb-1">{label}</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}
              className="w-full rounded-lg border border-parchment/15 bg-black/30 px-3 py-2 text-[13px] text-parchment outline-none focus:border-gold"
              data-testid={testid}>
        {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </label>
  );
}

/**
 * AIVoiceBlockCard — compact card for AI-generated audio blocks whose
 * .text field is a data: URL (1–3 MB base64). Rendering that string inside
 * a controlled <textarea> crashes React on production. This card shows the
 * audio player + size + a "Replace with URL" affordance for authors who
 * want to swap to a hosted URL (e.g. R2 / CDN) later.
 */
function AIVoiceBlockCard({ block, onChange }) {
  const [editing, setEditing] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const kb = Math.round((block.text?.length || 0) / 1024);
  const heading = block.heading || "AI Voice";

  if (editing) {
    return (
      <div className="grid gap-2" data-testid="ai-voice-block-card-editing">
        <Input
          label="Replace with hosted audio URL (https://…)"
          value={urlDraft}
          onChange={setUrlDraft}
          testid="ai-voice-block-url-input"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              const v = urlDraft.trim();
              if (v) onChange({ text: v });
              setEditing(false);
            }}
            className="rounded-full bg-gold px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-ink"
            data-testid="ai-voice-block-url-save"
          >
            Save URL
          </button>
          <button
            type="button"
            onClick={() => { setEditing(false); setUrlDraft(""); }}
            className="rounded-full border border-parchment/20 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-parchment"
            data-testid="ai-voice-block-url-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border border-emerald-400/30 p-3"
      style={{ background: "rgba(16,52,38,0.35)" }}
      data-testid="ai-voice-block-card"
    >
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-300">
          🎙️ {heading}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-emerald-300/70">
            {kb.toLocaleString()} KB · embedded
          </span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-full border border-parchment/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold"
            data-testid="ai-voice-block-replace-btn"
            title="Replace this embedded audio with a hosted URL (e.g. R2 / S3 / CDN)"
          >
            Replace URL
          </button>
        </div>
      </div>
      <audio
        src={block.text}
        controls
        preload="metadata"
        className="w-full"
        data-testid="ai-voice-block-player"
      />
      <p className="mt-1.5 text-[10px] text-faded leading-snug">
        Generated by ElevenLabs and stored inline with this book revision.
        Students will hear this audio in the reader. Replace with a hosted
        URL if you want to keep book payloads small.
      </p>
    </div>
  );
}
