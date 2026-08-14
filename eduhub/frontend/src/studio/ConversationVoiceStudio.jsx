/**
 * ConversationVoiceStudio.jsx — Multi-character AI conversation voice generator
 * for Author Studio. v1.0
 *
 * SAFEGUARD: This is a NEW, self-contained component. It does NOT modify
 * any existing StudioEditor.jsx logic, routes, or data structures.
 * It is rendered as an additional panel/tab within the existing chapter editor.
 *
 * Teacher workflow:
 *   1. Paste full conversation text (Speaker: line format)
 *   2. System auto-detects unique speakers
 *   3. Assign ElevenLabs voice per speaker (from existing /api/studio/voices)
 *   4. Set emotion + acting notes per line (global or per-line)
 *   5. Adjust voice settings sliders (optional)
 *   6. Generate → preview → publish
 *
 * Data output shape per dialog block (backward-compatible with existing reader):
 *   { type:"dialog", speaker, text, emotion, voiceId,
 *     start, end, wordTimestamps, audio? }
 *
 * Depends on:
 *   - generateConversationAudio from ./api (new export)
 *   - conversationPresets helpers from ./conversationPresets (new file)
 *   - Existing elevenLabsVoices array passed as prop from StudioEditor
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Mic, Sparkles, Play, Pause, ChevronDown, ChevronUp,
  Save, Trash2, RotateCcw, User, Sliders, Eye, CheckCircle2,
  AlertTriangle, Loader2, Plus, X,
} from "lucide-react";
import { generateConversationAudio, saveStudioBook } from "./api";
import {
  EMOTION_OPTIONS, SPEAKER_COLORS, getDefaultColor,
  loadPresets, savePreset, getPreset,
} from "./conversationPresets";

/* ─── RE_DIALOG: same regex as content_parser.py ─── */
const RE_DIALOG = /^([A-Za-z][\w\s.'\-]{0,40}?):\s+(.+)$/;

/* ─── Default voice settings ─── */
const DEFAULT_VS = { stability: 0.5, similarity_boost: 0.75, style: 0.0 };

/* ─── Pause options ─── */
const PAUSE_OPTIONS = [0, 0.2, 0.35, 0.5, 0.75, 1.0, 1.5, 2.0];

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  MAIN COMPONENT                                                             */
/* ═══════════════════════════════════════════════════════════════════════════ */

export default function ConversationVoiceStudio({
  slug,
  chapterIndex,
  book,
  elevenLabsVoices = [],
  onPublished,           // callback(updatedBook) after successful generation
  onClose,              // dismiss/collapse the studio panel
  // ── Zero-copy seed props (all optional, fully backward-compatible) ──────
  // When absent, every existing behavior is byte-for-byte unchanged.
  initialText,            // "Speaker: line" script the teacher can choose to load
  initialChapterId,       // stable identity resetting the "touched" guard below
  initialVoiceAssignments, // { speakerName -> voiceId } applied as a parse-time default
}) {
  /* ── Parse state ─────────────────────────────────────────── */
  const [rawText, setRawText] = useState("");
  const [lines, setLines] = useState([]);          // parsed ConversationLine[]
  const [speakers, setSpeakers] = useState({});    // { name → SpeakerConfig }
  const [isParsed, setIsParsed] = useState(false);

  /* ── Zero-copy seeding safety (§AMENDMENT 8) ─────────────────
   * A blind `useState(() => initialText || "")` is unsafe: it would only
   * seed once at mount, but real usage keeps the SAME component instance
   * mounted across chapter switches and regenerations, so a naive effect
   * keyed on `initialText` changing would silently overwrite text the
   * teacher has already edited. Instead:
   *   - `touchedRef` flips true the moment the teacher edits the textarea.
   *   - `loadedTextRef` remembers which `initialText` value was last loaded.
   *   - The "Load generated dialogue" button is a distinct, explicit action
   *     — it NEVER fires automatically, and it stays available (relabeled
   *     "Load updated dialogue") whenever `initialText` differs from what
   *     was last loaded, even after the teacher has typed.
   *   - Switching to a different chapter (`initialChapterId` changes) resets
   *     the touched/loaded guards so a stale warning never follows a fresh
   *     chapter around.
   */
  const touchedRef = useRef(false);
  const loadedTextRef = useRef(null);
  const lastChapterIdRef = useRef(initialChapterId);
  if (lastChapterIdRef.current !== initialChapterId) {
    lastChapterIdRef.current = initialChapterId;
    touchedRef.current = false;
    loadedTextRef.current = null;
  }
  const hasLoadableDialogue = !!(initialText && initialText.trim())
    && initialText !== loadedTextRef.current;
  const loadGeneratedDialogue = useCallback(() => {
    if (!initialText) return;
    setRawText(initialText);
    loadedTextRef.current = initialText;
    touchedRef.current = false; // freshly loaded text is not yet "edited"
  }, [initialText]);

  /* ── Generation state ────────────────────────────────────── */
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState(0);  // 0–100
  const [genError, setGenError] = useState(null);
  const [result, setResult] = useState(null);  // server response

  /* ── Preview state ───────────────────────────────────────── */
  const [previewing, setPreviewing] = useState(false);
  const previewAudioRef = useRef(null);

  /* ── Generation interval ref — cleared on every exit and on unmount ── */
  const genIntervalRef = useRef(null);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(false);

  /* ── Global voice settings toggle ───────────────────────── */
  const [showGlobalVS, setShowGlobalVS] = useState(false);
  const [globalVS, setGlobalVS] = useState({ ...DEFAULT_VS });
  const [globalPause, setGlobalPause] = useState(0.35);

  /* Clear any active generation interval when this instance unmounts. */
  useEffect(() => () => {
    if (genIntervalRef.current !== null) {
      clearInterval(genIntervalRef.current);
      genIntervalRef.current = null;
    }
  }, []);

  /* ─────────────────────────────────────────────────────────── */
  /*  Step 1: Parse raw conversation text                         */
  /* ─────────────────────────────────────────────────────────── */
  const parseConversation = useCallback(() => {
    const parsed = rawText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line, i) => {
        const m = RE_DIALOG.exec(line);
        if (!m) return null;
        return {
          id: i,
          speaker: m[1].trim(),
          text: m[2].trim(),
          emotion: "neutral",
          actingNote: "",
          useGlobalVS: true,
          voiceSettings: { ...DEFAULT_VS },
          pauseAfter: globalPause,
          expanded: false,
        };
      })
      .filter(Boolean);

    if (!parsed.length) {
      setGenError("No valid 'Speaker: line' format found. Use format like:\nLina: Hello there!\nNoah: Hi!");
      return;
    }

    setGenError(null);

    // Build unique speaker map, applying saved presets
    const uniqueSpeakers = {};
    let colorIdx = 0;
    parsed.forEach((l) => {
      if (!uniqueSpeakers[l.speaker]) {
        const preset = getPreset(l.speaker);
        // Zero-copy seed: a caller-supplied speaker→voice suggestion (e.g.
        // Book Factory's round-robin assignment) wins over the built-in
        // rotation, but a saved per-speaker PRESET still wins over both —
        // the teacher's own past choice for a named speaker is authoritative.
        const seededVoice = initialVoiceAssignments && initialVoiceAssignments[l.speaker];
        uniqueSpeakers[l.speaker] = {
          name: l.speaker,
          voiceId: preset?.voiceId || seededVoice || elevenLabsVoices[colorIdx % elevenLabsVoices.length]?.voice_id || "",
          color: preset?.color || getDefaultColor(colorIdx),
          avatar: preset?.avatar || "",
          voiceSettings: preset?.voiceSettings || { ...DEFAULT_VS },
          defaultEmotion: preset?.emotion || "neutral",
        };
        colorIdx++;
      }
    });

    // Apply speaker's default emotion to lines
    const withEmotion = parsed.map((l) => ({
      ...l,
      emotion: uniqueSpeakers[l.speaker]?.defaultEmotion || "neutral",
    }));

    setSpeakers(uniqueSpeakers);
    setLines(withEmotion);
    setIsParsed(true);
    setResult(null);
    setPreviewing(false);
  }, [rawText, elevenLabsVoices, globalPause, initialVoiceAssignments]);

  /* ─────────────────────────────────────────────────────────── */
  /*  Update helpers                                              */
  /* ─────────────────────────────────────────────────────────── */
  const updateLine = useCallback((idx, patch) => {
    setLines((prev) => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
  }, []);

  const updateSpeaker = useCallback((name, patch) => {
    setSpeakers((prev) => {
      const updated = { ...prev, [name]: { ...prev[name], ...patch } };
      // Also apply voiceId change to all lines belonging to this speaker
      if (patch.voiceId !== undefined || patch.defaultEmotion !== undefined) {
        setLines((prevLines) =>
          prevLines.map((l) =>
            l.speaker === name
              ? {
                  ...l,
                  emotion: patch.defaultEmotion !== undefined
                    ? patch.defaultEmotion
                    : l.emotion,
                }
              : l
          )
        );
      }
      return updated;
    });
  }, []);

  const saveSpeakerPreset = useCallback((name) => {
    const sp = speakers[name];
    if (!sp) return;
    savePreset(name, {
      voiceId: sp.voiceId,
      emotion: sp.defaultEmotion,
      color: sp.color,
      voiceSettings: sp.voiceSettings,
    });
  }, [speakers]);

  /* ─────────────────────────────────────────────────────────── */
  /*  Step 7: Generate                                            */
  /* ─────────────────────────────────────────────────────────── */
  const handleGenerate = useCallback(async () => {
    // Validate title
    if (!book.title || book.title === "Untitled") {
      setGenError("Please give the book a title before generating.");
      return;
    }
    if (!lines.length) {
      setGenError("No conversation lines to generate.");
      return;
    }

    setGenerating(true);
    setGenError(null);
    setGenProgress(0);
    setPreviewing(false);

    try {
      // Step 1: Auto-save book to get a real slug (same as handleGenerateVoice)
      const saved = await saveStudioBook(book);
      const realSlug = saved.slug;

      // Step 2: Build dialog blocks from parsed lines
      const dialogBlocks = lines.map((l) => ({
        type: "dialog",
        speaker: l.speaker,
        text: l.text,
        emotion: l.emotion || "neutral",
      }));

      // Step 3: Inject dialog blocks into the chapter, replacing existing ones
      const updatedChapters = (saved.book || book).chapters.map((ch, ci) => {
        if (ci !== chapterIndex) return ch;
        const nonDialogBlocks = (ch.blocks || []).filter(
          (b) => b.type !== "dialog" && !b._conversation_audio
        );
        return { ...ch, blocks: [...nonDialogBlocks, ...dialogBlocks] };
      });

      const bookWithDialogs = {
        ...(saved.book || book),
        slug: realSlug,
        chapters: updatedChapters,
      };

      // Step 4: Save again with dialog blocks so backend has them
      const saved2 = await saveStudioBook(bookWithDialogs);

      // Step 5: Build payload with correct lineIndex mapping
      const payload = {
        chapterIndex,
        book: saved2.book || bookWithDialogs,
        lines: lines.map((l, i) => {
          const sp = speakers[l.speaker] || {};
          return {
            lineIndex: (saved2.book || bookWithDialogs).chapters[chapterIndex].blocks
              .findIndex((b, bi) =>
                b.type === "dialog" && b.speaker === l.speaker &&
                b.text === l.text
              ),
            speaker: l.speaker,
            text: l.text,
            voiceId: sp.voiceId || ELEVENLABS_FALLBACK,
            emotion: l.emotion,
            actingNote: l.actingNote || "",
            voiceSettings: l.useGlobalVS ? globalVS : (sp.voiceSettings || DEFAULT_VS),
            pauseAfter: l.pauseAfter ?? globalPause,
          };
        }),
      };

      // Progress simulation — tracked via ref so it is always cleared:
      // on success, on API error, on thrown exception, and on unmount.
      const totalMs = lines.length * 2800;
      genIntervalRef.current = setInterval(() => {
        setGenProgress((p) => Math.min(p + (100 / (totalMs / 250)), 90));
      }, 250);

      const res = await generateConversationAudio(realSlug, payload);
      setGenProgress(100);
      setResult(res);
      Object.keys(speakers).forEach(saveSpeakerPreset);
      onPublished?.(realSlug, res);

    } catch (err) {
      setGenError(err.message || "Generation failed. Check your ElevenLabs API key.");
    } finally {
      if (genIntervalRef.current !== null) {
        clearInterval(genIntervalRef.current);
        genIntervalRef.current = null;
      }
      setGenerating(false);
    }
  }, [lines, speakers, book, chapterIndex, globalVS, globalPause, saveSpeakerPreset, onPublished]);

  /* ─────────────────────────────────────────────────────────── */
  /*  Preview audio                                               */
  /* ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!result?.audioUrl || !previewing) return;
    const el = new Audio(result.audioUrl);
    el.addEventListener("timeupdate", () => setPreviewTime(el.currentTime));
    el.addEventListener("play", () => setPreviewPlaying(true));
    el.addEventListener("pause", () => setPreviewPlaying(false));
    el.addEventListener("ended", () => { setPreviewPlaying(false); setPreviewTime(0); });
    previewAudioRef.current = el;
    el.play().catch(() => {});
    return () => { el.pause(); el.src = ""; };
  }, [result?.audioUrl, previewing]);

  const togglePreview = () => {
    if (!result?.audioUrl) return;
    if (previewing) {
      previewAudioRef.current?.pause();
      setPreviewing(false);
    } else {
      setPreviewing(true);
    }
  };

  /* ─────────────────────────────────────────────────────────── */
  /*  Publish                                                     */
  /* ─────────────────────────────────────────────────────────── */
  const handlePublish = () => {
    if (!result) return;
    onPublished?.(slug, result);
  };

  /* ─────────────────────────────────────────────────────────── */
  /*  Render                                                      */
  /* ─────────────────────────────────────────────────────────── */
  return (
    <div className="cvs" data-testid="conversation-voice-studio">
      {/* ── Header ── */}
      <div className="cvs__header">
        <div className="cvs__header-left">
          <Mic className="h-4 w-4 text-gold" />
          <span className="cvs__title">Conversation Voice Studio</span>
          <span className="cvs__badge">NEW</span>
        </div>
        {onClose && (
          <button
            type="button"
            className="cvs__close"
            onClick={onClose}
            aria-label="Close Conversation Voice Studio"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ── Step 1: Paste conversation ── */}
      {!isParsed && (
        <PasteStep
          rawText={rawText}
          onChangeRaw={(v) => { touchedRef.current = true; setRawText(v); }}
          onParse={parseConversation}
          error={genError}
          globalPause={globalPause}
          onChangePause={setGlobalPause}
          hasLoadableDialogue={hasLoadableDialogue}
          alreadyTouched={touchedRef.current}
          onLoadGenerated={loadGeneratedDialogue}
        />
      )}

      {/* ── Step 2+: Speaker config + Line editor ── */}
      {isParsed && !result && (
        <>
          {/* Speaker panel */}
          <SpeakerPanel
            speakers={speakers}
            voices={elevenLabsVoices}
            onUpdateSpeaker={updateSpeaker}
            onSavePreset={saveSpeakerPreset}
          />

          {/* Global voice settings */}
          <div className="cvs__section">
            <button
              type="button"
              className="cvs__section-toggle"
              onClick={() => setShowGlobalVS((v) => !v)}
            >
              <Sliders className="h-3.5 w-3.5" />
              <span>Global Voice Settings</span>
              {showGlobalVS ? <ChevronUp className="h-3.5 w-3.5 ml-auto" /> : <ChevronDown className="h-3.5 w-3.5 ml-auto" />}
            </button>
            {showGlobalVS && (
              <VoiceSettingsPanel
                settings={globalVS}
                onChange={(patch) => setGlobalVS((v) => ({ ...v, ...patch }))}
                pause={globalPause}
                onChangePause={setGlobalPause}
              />
            )}
          </div>

          {/* Line editor */}
          <div className="cvs__section">
            <div className="cvs__section-header">
              <span className="cvs__section-title">Conversation Lines ({lines.length})</span>
              <button
                type="button"
                className="cvs__text-btn"
                onClick={() => { setIsParsed(false); setLines([]); setSpeakers({}); }}
              >
                <RotateCcw className="h-3 w-3" /> Edit Script
              </button>
            </div>
            <div className="cvs__lines">
              {lines.map((line, i) => (
                <ConversationLineRow
                  key={line.id}
                  index={i}
                  line={line}
                  speakerConfig={speakers[line.speaker]}
                  onUpdate={(patch) => updateLine(i, patch)}
                  globalPause={globalPause}
                />
              ))}
            </div>
          </div>

          {/* Generate button */}
          {genError && (
            <div className="cvs__error">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{genError}</span>
            </div>
          )}
          <button
            type="button"
            className="cvs__generate-btn"
            onClick={handleGenerate}
            disabled={generating || !lines.length}
            data-testid="cvs-generate-btn"
          >
            {generating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Generating… {Math.round(genProgress)}%</span>
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                <span>Generate Conversation Audio</span>
              </>
            )}
          </button>
          {generating && (
            <div className="cvs__progress-bar">
              <div className="cvs__progress-fill" style={{ width: `${genProgress}%` }} />
            </div>
          )}
        </>
      )}

      {/* ── Step 9: Preview + Publish ── */}
      {result && (
        <ResultPanel
          result={result}
          lines={lines}
          speakers={speakers}
          previewTime={previewTime}
          previewPlaying={previewPlaying}
          onTogglePreview={togglePreview}
          onPublish={handlePublish}
          onRegenerate={() => setResult(null)}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  SUB-COMPONENTS                                                             */
/* ═══════════════════════════════════════════════════════════════════════════ */

/* ── Step 1: Paste ─────────────────────────────────────────── */
function PasteStep({
  rawText, onChangeRaw, onParse, error, globalPause, onChangePause,
  hasLoadableDialogue, alreadyTouched, onLoadGenerated,
}) {
  return (
    <div className="cvs__section">
      <label className="cvs__label">Paste your conversation script</label>
      {hasLoadableDialogue && (
        <button
          type="button"
          className="cvs__load-generated-btn"
          onClick={onLoadGenerated}
          data-testid="cvs-load-generated-btn"
          title="Zero-copy: fill this box from the chapter's already-generated dialogue"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {alreadyTouched ? "Load updated dialogue (replaces your current text)" : "Load generated dialogue"}
        </button>
      )}
      <textarea
        className="cvs__textarea"
        rows={10}
        placeholder={
          "Lina: Did you see the falling star?\n" +
          "Noah: Yes! It landed near the forest.\n" +
          "Teacher: What should they do next?\n" +
          "Lina: I think we should follow it.\n" +
          "Noah: I agree, but we must be careful."
        }
        value={rawText}
        onChange={(e) => onChangeRaw(e.target.value)}
        data-testid="cvs-paste-textarea"
        spellCheck={false}
      />
      <div className="cvs__paste-footer">
        <label className="cvs__inline-label">
          <span>Default pause between speakers</span>
          <select
            className="cvs__select"
            value={String(globalPause)}
            onChange={(e) => onChangePause(Number(e.target.value))}
          >
            {PAUSE_OPTIONS.map((p) => (
              <option key={p} value={String(p)}>{p === 0 ? "None" : `${p}s`}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="cvs__parse-btn"
          onClick={onParse}
          disabled={!rawText.trim()}
          data-testid="cvs-parse-btn"
        >
          Auto-detect Speakers →
        </button>
      </div>
      {error && (
        <div className="cvs__error">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span style={{ whiteSpace: "pre-line" }}>{error}</span>
        </div>
      )}
    </div>
  );
}

/* ── Speaker panel ─────────────────────────────────────────── */
function SpeakerPanel({ speakers, voices, onUpdateSpeaker, onSavePreset }) {
  return (
    <div className="cvs__section">
      <div className="cvs__section-header">
        <span className="cvs__section-title">Speakers ({Object.keys(speakers).length})</span>
      </div>
      <div className="cvs__speakers">
        {Object.values(speakers).map((sp) => (
          <SpeakerCard
            key={sp.name}
            speaker={sp}
            voices={voices}
            onUpdate={(patch) => onUpdateSpeaker(sp.name, patch)}
            onSavePreset={() => onSavePreset(sp.name)}
          />
        ))}
      </div>
    </div>
  );
}

function SpeakerCard({ speaker, voices, onUpdate, onSavePreset }) {
  return (
    <div className="cvs__speaker-card" data-testid={`cvs-speaker-${speaker.name}`}>
      <div
        className="cvs__speaker-avatar"
        style={{ background: speaker.color }}
      >
        {speaker.avatar || initials(speaker.name)}
      </div>
      <div className="cvs__speaker-body">
        <span className="cvs__speaker-name">{speaker.name}</span>
        <div className="cvs__speaker-controls">
          {/* Voice selector */}
          <select
            className="cvs__select cvs__select--voice"
            value={speaker.voiceId}
            onChange={(e) => onUpdate({ voiceId: e.target.value })}
            title="ElevenLabs voice for this speaker"
            data-testid={`cvs-speaker-voice-${speaker.name}`}
          >
            {voices.length === 0 && <option value="">No voices loaded</option>}
            {voices.map((v) => (
              <option key={v.voice_id} value={v.voice_id}>{v.name}</option>
            ))}
          </select>
          {/* Default emotion */}
          <select
            className="cvs__select"
            value={speaker.defaultEmotion || "neutral"}
            onChange={(e) => onUpdate({ defaultEmotion: e.target.value })}
            title="Default emotion for all lines of this speaker"
            data-testid={`cvs-speaker-emotion-${speaker.name}`}
          >
            {EMOTION_OPTIONS.map((em) => (
              <option key={em.value} value={em.value}>
                {em.emoji} {em.label}
              </option>
            ))}
          </select>
          {/* Color picker */}
          <input
            type="color"
            value={speaker.color}
            onChange={(e) => onUpdate({ color: e.target.value })}
            className="cvs__color-pick"
            title="Speaker bubble color"
          />
          {/* Save preset */}
          <button
            type="button"
            className="cvs__icon-btn"
            onClick={onSavePreset}
            title="Save speaker preset"
          >
            <Save className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Per-line row ──────────────────────────────────────────── */
function ConversationLineRow({ index, line, speakerConfig, onUpdate, globalPause }) {
  const color = speakerConfig?.color || "#888";
  return (
    <div
      className="cvs__line"
      style={{ "--spk-color": color }}
      data-testid={`cvs-line-${index}`}
    >
      <div
        className="cvs__line-avatar"
        style={{ background: color }}
        title={line.speaker}
      >
        {speakerConfig?.avatar || initials(line.speaker)}
      </div>
      <div className="cvs__line-body">
        <div className="cvs__line-top">
          <span className="cvs__line-speaker">{line.speaker}</span>
          {/* Emotion selector */}
          <select
            className="cvs__select cvs__select--sm"
            value={line.emotion}
            onChange={(e) => onUpdate({ emotion: e.target.value })}
            data-testid={`cvs-line-emotion-${index}`}
          >
            {EMOTION_OPTIONS.map((em) => (
              <option key={em.value} value={em.value}>
                {em.emoji} {em.label}
              </option>
            ))}
          </select>
          {/* Expand for acting note + pause settings */}
          <button
            type="button"
            className="cvs__icon-btn"
            onClick={() => onUpdate({ expanded: !line.expanded })}
            title={line.expanded ? "Collapse" : "Acting note + pause settings"}
          >
            {line.expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        </div>

        <p className="cvs__line-text">{line.text}</p>

        {line.expanded && (
          <div className="cvs__line-extra">
            <label className="cvs__label">
              Acting note (optional)
              <input
                type="text"
                className="cvs__input"
                placeholder="e.g. speak softly like a shy student"
                value={line.actingNote}
                onChange={(e) => onUpdate({ actingNote: e.target.value })}
                data-testid={`cvs-line-note-${index}`}
              />
            </label>
            <label className="cvs__inline-label">
              Pause after
              <select
                className="cvs__select cvs__select--sm"
                value={String(line.pauseAfter ?? globalPause)}
                onChange={(e) => onUpdate({ pauseAfter: Number(e.target.value) })}
              >
                {PAUSE_OPTIONS.map((p) => (
                  <option key={p} value={String(p)}>{p === 0 ? "None" : `${p}s`}</option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Voice settings panel ──────────────────────────────────── */
function VoiceSettingsPanel({ settings, onChange, pause, onChangePause }) {
  return (
    <div className="cvs__vs-panel">
      <SliderRow
        label="Stability"
        value={settings.stability}
        min={0} max={1} step={0.05}
        hint="Higher = more consistent, less expressive"
        onChange={(v) => onChange({ stability: v })}
      />
      <SliderRow
        label="Similarity Boost"
        value={settings.similarity_boost}
        min={0} max={1} step={0.05}
        hint="Higher = closer to original voice"
        onChange={(v) => onChange({ similarity_boost: v })}
      />
      <SliderRow
        label="Style Exaggeration"
        value={settings.style}
        min={0} max={1} step={0.05}
        hint="Higher = more expressive style"
        onChange={(v) => onChange({ style: v })}
      />
      <label className="cvs__inline-label">
        <span>Default pause between lines</span>
        <select
          className="cvs__select cvs__select--sm"
          value={String(pause)}
          onChange={(e) => onChangePause(Number(e.target.value))}
        >
          {PAUSE_OPTIONS.map((p) => (
            <option key={p} value={String(p)}>{p === 0 ? "None" : `${p}s`}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

function SliderRow({ label, value, min, max, step, hint, onChange }) {
  return (
    <div className="cvs__slider-row">
      <div className="cvs__slider-label">
        <span>{label}</span>
        <span className="cvs__slider-value">{Number(value).toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="cvs__slider"
      />
      {hint && <span className="cvs__slider-hint">{hint}</span>}
    </div>
  );
}

/* ── Result panel ──────────────────────────────────────────── */
function ResultPanel({ result, lines, speakers, previewTime, previewPlaying, onTogglePreview, onPublish, onRegenerate }) {
  const fmt = (s) => {
    if (!Number.isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, "0")}`;
  };

  const activeLine = result?.lines?.find(
    (l) => previewTime >= l.start && previewTime <= l.end
  );

  return (
    <div className="cvs__result">
      <div className="cvs__result-header">
        <CheckCircle2 className="h-4 w-4 text-green-400" />
        <span className="cvs__result-title">Conversation Audio Ready</span>
        <span className="cvs__result-meta">
          {result.lines?.length} lines · {fmt(result.totalDuration)} total
        </span>
      </div>

      {/* Preview player */}
      <div className="cvs__preview-player">
        <button
          type="button"
          className="cvs__preview-btn"
          onClick={onTogglePreview}
        >
          {previewPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {previewPlaying ? "Pause Preview" : "Preview Conversation"}
        </button>
        {previewPlaying && (
          <span className="cvs__preview-time">{fmt(previewTime)} / {fmt(result.totalDuration)}</span>
        )}
      </div>

      {/* Live preview: dialog bubbles with active highlight */}
      {previewPlaying && (
        <div className="cvs__preview-bubbles">
          {lines.slice(0, 8).map((line, i) => {
            const lr = result?.lines?.[i];
            const isActive = lr && previewTime >= lr.start && previewTime <= lr.end;
            const sp = speakers[line.speaker];
            return (
              <div
                key={i}
                className={`cvs__preview-bubble ${isActive ? "cvs__preview-bubble--active" : ""}`}
                style={{ "--spk-color": sp?.color || "#888" }}
              >
                <span
                  className="cvs__preview-avatar"
                  style={{ background: sp?.color || "#888" }}
                >
                  {initials(line.speaker)}
                </span>
                <div className="cvs__preview-text">
                  <span className="cvs__preview-speaker">{line.speaker}</span>
                  <span>{line.text}</span>
                </div>
              </div>
            );
          })}
          {lines.length > 8 && (
            <p className="cvs__preview-more">+{lines.length - 8} more lines</p>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="cvs__result-actions">
        <button
          type="button"
          className="cvs__text-btn"
          onClick={onRegenerate}
        >
          <RotateCcw className="h-3 w-3" /> Regenerate
        </button>
        <button
          type="button"
          className="cvs__publish-btn"
          onClick={onPublish}
          data-testid="cvs-publish-btn"
        >
          <CheckCircle2 className="h-4 w-4" />
          Publish to Books Library
        </button>
      </div>
    </div>
  );
}

/* ─── Helpers ─────────────────────────────────────────────── */

function initials(name) {
  const clean = String(name || "").replace(/[^A-Za-z0-9 ]/g, "").trim();
  if (!clean) return "?";
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function findDialogBlockIndex(book, chapterIndex, lineIndex) {
  // Map parsed line index to actual dialog block index in the chapter
  // (dialog blocks may be interspersed with other block types)
  const chapter = book?.chapters?.[chapterIndex];
  if (!chapter) return lineIndex;
  const dialogIndices = chapter.blocks
    .map((b, i) => (b.type === "dialog" ? i : -1))
    .filter((i) => i >= 0);
  return dialogIndices[lineIndex] ?? lineIndex;
}

const ELEVENLABS_FALLBACK = "21m00Tcm4TlvDq8ikWAM";

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  CSS — injected as a <style> block                                          */
/*  In production, move these to reader.css / studio.css                      */
/* ═══════════════════════════════════════════════════════════════════════════ */

const CVS_STYLES = `
.cvs {
  background: rgba(20,16,32,0.95);
  border: 1px solid rgba(212,168,67,0.18);
  border-radius: 14px;
  overflow: hidden;
  margin: 16px 0;
  font-size: 13px;
  color: #d4cfc8;
}

.cvs__header {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255,255,255,0.07);
  background: rgba(212,168,67,0.06);
  gap: 8px;
}
.cvs__header-left { display: flex; align-items: center; gap: 8px; flex: 1; }
.cvs__title { font-weight: 700; letter-spacing: 0.03em; font-size: 13px; color: #e8e0cc; }
.cvs__badge {
  font-size: 9px; font-weight: 800; letter-spacing: 0.15em;
  background: linear-gradient(90deg, #D4A843, #f0c96e);
  color: #1a1420; padding: 2px 7px; border-radius: 100px;
}
.cvs__close {
  background: none; border: none; cursor: pointer; color: #7a7268;
  padding: 4px; border-radius: 4px;
}
.cvs__close:hover { color: #d4cfc8; }

.cvs__section { padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.05); }
.cvs__section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.cvs__section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; color: #9d8e72; }
.cvs__section-toggle {
  display: flex; align-items: center; gap: 6px; width: 100%;
  background: none; border: none; cursor: pointer; color: #9d8e72; font-size: 12px; font-weight: 600;
  padding: 0; text-align: left;
}
.cvs__section-toggle:hover { color: #d4cfc8; }

.cvs__label { display: block; font-size: 11px; font-weight: 600; color: #9d8e72; margin-bottom: 6px; }
.cvs__inline-label { display: flex; align-items: center; gap: 8px; font-size: 11px; color: #9d8e72; }

.cvs__textarea {
  width: 100%; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px; padding: 10px 12px; color: #d4cfc8; font-size: 13px;
  resize: vertical; font-family: "JetBrains Mono", monospace; line-height: 1.6;
  outline: none;
}
.cvs__textarea:focus { border-color: rgba(212,168,67,0.4); }

.cvs__paste-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; flex-wrap: wrap; gap: 8px; }

.cvs__load-generated-btn {
  display: flex; align-items: center; gap: 6px; width: 100%; margin-bottom: 10px;
  background: rgba(139,92,246,0.14); border: 1px solid rgba(139,92,246,0.35);
  border-radius: 8px; color: #c084fc; font-size: 12px; font-weight: 700;
  padding: 9px 12px; cursor: pointer; justify-content: center;
}
.cvs__load-generated-btn:hover { background: rgba(139,92,246,0.22); }

.cvs__input {
  display: block; width: 100%; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 7px; padding: 7px 10px; color: #d4cfc8; font-size: 12px; margin-top: 4px; outline: none;
}
.cvs__input:focus { border-color: rgba(212,168,67,0.4); }

.cvs__select {
  background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.12);
  border-radius: 6px; color: #d4cfc8; font-size: 12px; padding: 5px 8px; outline: none; cursor: pointer;
}
.cvs__select--voice { max-width: 180px; flex: 1; }
.cvs__select--sm { font-size: 11px; padding: 3px 6px; }
.cvs__select:focus { border-color: rgba(212,168,67,0.4); }

.cvs__color-pick {
  width: 28px; height: 28px; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px;
  cursor: pointer; padding: 2px; background: rgba(0,0,0,0.3);
}

.cvs__icon-btn {
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px; color: #9d8e72; cursor: pointer; padding: 5px; display: inline-flex; align-items: center;
}
.cvs__icon-btn:hover { color: #D4A843; border-color: rgba(212,168,67,0.3); }

.cvs__text-btn {
  display: inline-flex; align-items: center; gap: 4px; background: none; border: none;
  color: #9d8e72; font-size: 11px; cursor: pointer; padding: 0;
}
.cvs__text-btn:hover { color: #D4A843; }

.cvs__parse-btn {
  background: linear-gradient(135deg, #D4A843, #c49535); border: none; border-radius: 8px;
  color: #1a1420; font-size: 12px; font-weight: 700; padding: 8px 16px; cursor: pointer; white-space: nowrap;
}
.cvs__parse-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.cvs__parse-btn:not(:disabled):hover { background: linear-gradient(135deg, #e0b84e, #d4a843); }

.cvs__error {
  display: flex; align-items: flex-start; gap: 8px; background: rgba(239,68,68,0.1);
  border: 1px solid rgba(239,68,68,0.2); border-radius: 8px; padding: 10px 12px;
  color: #f87171; font-size: 12px; margin-top: 10px;
}

/* Speakers */
.cvs__speakers { display: flex; flex-direction: column; gap: 8px; }
.cvs__speaker-card {
  display: flex; align-items: center; gap: 10px;
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07);
  border-radius: 10px; padding: 10px;
}
.cvs__speaker-avatar {
  width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center;
  justify-content: center; font-size: 13px; font-weight: 700; color: white; shrink: 0;
  flex-shrink: 0; text-shadow: 0 1px 2px rgba(0,0,0,0.4);
}
.cvs__speaker-body { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.cvs__speaker-name { font-size: 13px; font-weight: 700; color: #e8e0cc; }
.cvs__speaker-controls { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }

/* Lines */
.cvs__lines { display: flex; flex-direction: column; gap: 6px; }
.cvs__line {
  display: flex; gap: 10px; padding: 10px;
  background: rgba(255,255,255,0.02); border-radius: 10px;
  border-left: 3px solid var(--spk-color, #888);
}
.cvs__line-avatar {
  width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center;
  justify-content: center; font-size: 11px; font-weight: 700; color: white; flex-shrink: 0;
}
.cvs__line-body { flex: 1; min-width: 0; }
.cvs__line-top { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
.cvs__line-speaker { font-size: 11px; font-weight: 700; color: #e8e0cc; flex: 0 0 auto; }
.cvs__line-text { font-size: 12px; color: #9d8e72; line-height: 1.5; margin: 0; }
.cvs__line-extra { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }

/* Voice settings */
.cvs__vs-panel { display: flex; flex-direction: column; gap: 12px; padding-top: 12px; }
.cvs__slider-row { display: flex; flex-direction: column; gap: 4px; }
.cvs__slider-label { display: flex; justify-content: space-between; font-size: 11px; color: #9d8e72; }
.cvs__slider-value { font-weight: 700; font-family: "JetBrains Mono", monospace; color: #D4A843; }
.cvs__slider {
  width: 100%; accent-color: #D4A843; height: 4px; cursor: pointer;
}
.cvs__slider-hint { font-size: 10px; color: #5a5248; }

/* Progress bar */
.cvs__progress-bar {
  height: 3px; background: rgba(255,255,255,0.08); border-radius: 2px; margin: 0 16px 12px;
}
.cvs__progress-fill {
  height: 100%; background: linear-gradient(90deg, #D4A843, #f0c96e);
  border-radius: 2px; transition: width 0.3s ease;
}

/* Generate button */
.cvs__generate-btn {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  width: calc(100% - 32px); margin: 12px 16px 4px;
  background: linear-gradient(135deg, #D4A843 0%, #c49535 100%);
  border: none; border-radius: 10px; color: #1a1420;
  font-size: 14px; font-weight: 800; padding: 14px; cursor: pointer;
  letter-spacing: 0.02em;
}
.cvs__generate-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.cvs__generate-btn:not(:disabled):hover { background: linear-gradient(135deg, #e0b84e, #d4a843); }

/* Result */
.cvs__result { padding: 16px; }
.cvs__result-header { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
.cvs__result-title { font-size: 14px; font-weight: 700; color: #e8e0cc; flex: 1; }
.cvs__result-meta { font-size: 11px; color: #9d8e72; }

.cvs__preview-player { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.cvs__preview-btn {
  display: flex; align-items: center; gap: 6px;
  background: rgba(212,168,67,0.12); border: 1px solid rgba(212,168,67,0.3);
  border-radius: 8px; color: #D4A843; font-size: 12px; font-weight: 700;
  padding: 8px 14px; cursor: pointer;
}
.cvs__preview-btn:hover { background: rgba(212,168,67,0.2); }
.cvs__preview-time { font-size: 12px; color: #9d8e72; font-family: "JetBrains Mono", monospace; }

.cvs__preview-bubbles { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.cvs__preview-bubble {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  background: rgba(255,255,255,0.02); border-radius: 8px;
  transition: background 0.2s ease, box-shadow 0.2s ease;
  font-size: 12px;
}
.cvs__preview-bubble--active {
  background: rgba(212,168,67,0.1);
  box-shadow: 0 0 0 1px rgba(212,168,67,0.3);
}
.cvs__preview-avatar {
  width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center;
  justify-content: center; font-size: 10px; font-weight: 700; color: white; flex-shrink: 0;
}
.cvs__preview-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.cvs__preview-speaker { font-size: 10px; font-weight: 700; color: var(--spk-color, #9d8e72); }
.cvs__preview-more { font-size: 11px; color: #5a5248; text-align: center; padding: 4px 0; }

.cvs__result-actions { display: flex; align-items: center; justify-content: space-between; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.06); margin-top: 12px; }

.cvs__publish-btn {
  display: flex; align-items: center; gap: 6px;
  background: linear-gradient(135deg, #22c55e, #16a34a);
  border: none; border-radius: 9px; color: white;
  font-size: 13px; font-weight: 700; padding: 10px 20px; cursor: pointer;
}
.cvs__publish-btn:hover { background: linear-gradient(135deg, #4ade80, #22c55e); }

@media (max-width: 480px) {
  .cvs__speaker-controls { flex-direction: column; align-items: flex-start; }
  .cvs__select--voice { max-width: 100%; }
  .cvs__paste-footer { flex-direction: column; align-items: stretch; }
}
`;

// Inject styles once
if (typeof document !== "undefined" && !document.getElementById("cvs-styles")) {
  const style = document.createElement("style");
  style.id = "cvs-styles";
  style.textContent = CVS_STYLES;
  document.head.appendChild(style);
}
