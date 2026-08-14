/**
 * AiSceneBuilder.jsx — AI Scene Builder panel for Author Studio.
 *
 * v1.0 — Additive only. Does NOT modify the existing 3D book reader,
 * ElevenLabs pipeline, any existing studio tab, or any production module.
 *
 * Philosophy:
 *   English-first speaking fluency is the core of EduHub.
 *   Khmer is optional support only — stored as hidden metadata.
 *   This panel generates preview blocks that the Author manually reviews
 *   before copying into the chapter via the existing StudioEditor.
 *
 * Usage: imported and rendered in StudioPage.jsx as a new "AI Scene" tab.
 *
 * What this component does:
 *   1. Checks if GEMINI_API_KEY is configured on the server.
 *   2. Shows a form for topic, level, style, and generation options.
 *   3. Calls POST /api/studio/books/{slug}/ai-scene.
 *   4. Displays the preview blocks in English-first order.
 *   5. Lets the Author copy the JSON blocks for manual insertion via Editor.
 *
 * What this component does NOT do:
 *   - Does NOT auto-insert blocks into any book.
 *   - Does NOT call ElevenLabs.
 *   - Does NOT modify ReaderPage, ChapterBlocks, or AudioPlayerContext.
 *   - Does NOT display Khmer as primary content.
 */

import { useEffect, useState, useCallback } from "react";
import {
  Sparkles, Loader2, AlertTriangle, CheckCircle2, ChevronDown,
  ChevronUp, Copy, RefreshCw, BookOpen, Mic, ListChecks,
  BookMarked, Volume2, Image as ImageIcon, Info, Wand2,
} from "lucide-react";
import { checkAiSceneStatus, generateAiScene, listStudioBooks } from "./api";

/* ── Constants ─────────────────────────────────────────────────────────── */

const LEVELS = ["A1", "A2", "B1"];
const STYLES = ["Adventure", "Funny", "Mystery", "Emotional", "Classroom"];

const LEVEL_DESCRIPTIONS = {
  A1: "Beginner · very short sentences",
  A2: "Elementary · simple daily language",
  B1: "Intermediate · longer ideas, natural flow",
};

const STYLE_DESCRIPTIONS = {
  Adventure: "Exciting journey or discovery",
  Funny:     "Light-hearted, humorous scene",
  Mystery:   "Curious, suspenseful moment",
  Emotional: "Warm, heartfelt interaction",
  Classroom: "Real school / daily life scene",
};

/* ── Main component ─────────────────────────────────────────────────────── */

export default function AiSceneBuilder() {
  /* ── Server capability check ── */
  const [aiStatus, setAiStatus]   = useState(null); // null | { enabled, model }
  const [statusError, setStatusError] = useState(null);

  /* ── Book selector ── */
  const [books, setBooks]         = useState([]);
  const [selectedSlug, setSelectedSlug] = useState("");

  /* ── Form state ── */
  const [topic, setTopic]         = useState("");
  const [level, setLevel]         = useState("A2");
  const [style, setStyle]         = useState("Adventure");
  const [includeKhmer, setIncludeKhmer]     = useState(false);
  const [generateQuiz, setGenerateQuiz]     = useState(true);
  const [generateVocab, setGenerateVocab]   = useState(true);
  const [generateSpeaking, setGenerateSpeaking] = useState(true);

  /* ── Generation state ── */
  const [generating, setGenerating] = useState(false);
  const [result, setResult]          = useState(null);  // server response
  const [genError, setGenError]      = useState(null);

  /* ── UI ── */
  const [khmerExpanded, setKhmerExpanded]   = useState(false);
  const [copiedSceneId, setCopiedSceneId]   = useState(null);
  const [copiedBlockIdx, setCopiedBlockIdx] = useState(null);

  /* ── Load server status + book list on mount ── */
  useEffect(() => {
    checkAiSceneStatus()
      .then(setAiStatus)
      .catch((e) => setStatusError(e.message || "Could not reach server."));

    listStudioBooks()
      .then((data) => {
        const list = Array.isArray(data) ? data : (data?.books || []);
        setBooks(list);
        if (list.length > 0) setSelectedSlug(list[0].slug || "");
      })
      .catch(() => {/* books list failure is non-fatal */});
  }, []);

  /* ── Generate handler ── */
  const handleGenerate = useCallback(async () => {
    if (!selectedSlug) {
      setGenError("Please select a book first. The slug is used to tag the generated scene.");
      return;
    }
    if (!topic.trim()) {
      setGenError("Please enter a scene topic.");
      return;
    }

    setGenerating(true);
    setGenError(null);
    setResult(null);

    try {
      const data = await generateAiScene(selectedSlug, {
        topic:           topic.trim(),
        level,
        style,
        includeKhmer,
        generateQuiz,
        generateVocab,
        generateSpeaking,
      });
      setResult(data);
    } catch (err) {
      setGenError(err.message || "Generation failed. Please try again.");
    } finally {
      setGenerating(false);
    }
  }, [selectedSlug, topic, level, style, includeKhmer, generateQuiz, generateVocab, generateSpeaking]);

  /* ── Copy block JSON to clipboard ── */
  const copyBlock = useCallback(async (block, idx) => {
    try {
      // Strip internal underscore metadata before copying for the Editor
      const clean = Object.fromEntries(
        Object.entries(block).filter(([k]) => !k.startsWith("_"))
      );
      await navigator.clipboard.writeText(JSON.stringify(clean, null, 2));
      setCopiedBlockIdx(idx);
      setTimeout(() => setCopiedBlockIdx(null), 1800);
    } catch { /* clipboard not available */ }
  }, []);

  /* ── Copy all blocks ── */
  const copyAllBlocks = useCallback(async () => {
    if (!result?.previewBlocks) return;
    try {
      const clean = result.previewBlocks.map((block) =>
        Object.fromEntries(Object.entries(block).filter(([k]) => !k.startsWith("_")))
      );
      await navigator.clipboard.writeText(JSON.stringify(clean, null, 2));
      setCopiedSceneId(result.sceneId);
      setTimeout(() => setCopiedSceneId(null), 2000);
    } catch { /* clipboard not available */ }
  }, [result]);

  /* ── Render ─────────────────────────────────────────────────────────── */

  return (
    <div className="space-y-5" data-testid="ai-scene-builder">

      {/* ── Header ── */}
      <div className="flex items-start gap-3">
        <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl"
             style={{ background: "linear-gradient(135deg, #2D1F3E 0%, #1A1420 100%)",
                      boxShadow: "inset 0 1px 0 rgba(212,168,67,0.2)" }}>
          <Wand2 className="h-4 w-4 text-gold" />
        </div>
        <div>
          <h2 className="font-display text-[15px] text-parchment">AI Scene Builder</h2>
          <p className="text-[11px] text-faded mt-0.5 leading-relaxed max-w-[520px]">
            Generate English-first speaking scenes with Gemini. Preview the blocks,
            then copy them manually into the Editor. The live book is never changed automatically.
          </p>
        </div>
      </div>

      {/* ── Server status banner ── */}
      <AiStatusBanner status={aiStatus} error={statusError} />

      {/* ── Form ── */}
      <div className="rounded-2xl border border-white/8 p-5 space-y-4"
           style={{ background: "rgba(20,14,32,0.55)", backdropFilter: "blur(8px)" }}>

        {/* Book selector */}
        <FormRow label="Book" hint="The generated scene will be tagged with this book's slug.">
          <select
            value={selectedSlug}
            onChange={(e) => setSelectedSlug(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-walnut/50 px-3 py-2 text-[12px] text-parchment"
            data-testid="ai-book-select"
          >
            <option value="">— select a book —</option>
            {books.map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.title} ({b.slug})
              </option>
            ))}
          </select>
        </FormRow>

        {/* Topic */}
        <FormRow label="Scene Topic" hint="Describe what the scene is about. English preferred.">
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. Dara visits Angkor Wat for the first time"
            className="w-full rounded-lg border border-white/10 bg-walnut/50 px-3 py-2 text-[12px] text-parchment placeholder:text-faded"
            data-testid="ai-topic-input"
            maxLength={200}
          />
        </FormRow>

        {/* Level + Style row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormRow label="CEFR Level" hint={LEVEL_DESCRIPTIONS[level]}>
            <div className="flex gap-2">
              {LEVELS.map((l) => (
                <button key={l} onClick={() => setLevel(l)}
                        data-testid={`ai-level-${l}`}
                        className="flex-1 rounded-lg px-2 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-all"
                        style={level === l ? activePill : inactivePill}>
                  {l}
                </button>
              ))}
            </div>
          </FormRow>

          <FormRow label="Scene Style" hint={STYLE_DESCRIPTIONS[style]}>
            <select
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-walnut/50 px-3 py-2 text-[12px] text-parchment"
              data-testid="ai-style-select"
            >
              {STYLES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </FormRow>
        </div>

        {/* Generation toggles */}
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-faded">Generate</p>
          <div className="flex flex-wrap gap-2">
            <Toggle
              label="Speaking Prompt" icon={<Mic className="h-3 w-3" />}
              active={generateSpeaking} onChange={setGenerateSpeaking}
              testId="ai-toggle-speaking"
            />
            <Toggle
              label="Vocabulary" icon={<BookMarked className="h-3 w-3" />}
              active={generateVocab} onChange={setGenerateVocab}
              testId="ai-toggle-vocab"
            />
            <Toggle
              label="Quiz (MCQ)" icon={<ListChecks className="h-3 w-3" />}
              active={generateQuiz} onChange={setGenerateQuiz}
              testId="ai-toggle-quiz"
            />
          </div>
        </div>

        {/* Khmer support toggle — secondary / optional */}
        <div className="rounded-xl border border-white/6 p-3"
             style={{ background: "rgba(255,255,255,0.02)" }}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] font-semibold text-parchment/80">
                Khmer Support (Optional)
              </p>
              <p className="text-[10px] text-faded mt-0.5 leading-relaxed max-w-[400px]">
                Stores Khmer as hidden metadata only — it is <em>never</em> shown as a
                primary paragraph. English and speaking fluency remain the center of the experience.
              </p>
            </div>
            <button
              onClick={() => setIncludeKhmer((v) => !v)}
              data-testid="ai-toggle-khmer"
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                includeKhmer ? "bg-gold" : "bg-white/15"
              }`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                includeKhmer ? "translate-x-4" : "translate-x-0.5"
              }`} />
            </button>
          </div>
        </div>

        {/* Generate button */}
        <button
          onClick={handleGenerate}
          disabled={generating || !aiStatus?.enabled || !topic.trim() || !selectedSlug}
          data-testid="ai-generate-btn"
          className="w-full inline-flex items-center justify-center gap-2 rounded-full px-5 py-3 text-[12px] font-bold uppercase tracking-wider transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)", color: "#1a1420" }}
        >
          {generating ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Generating with Gemini…</>
          ) : (
            <><Sparkles className="h-4 w-4" /> Generate Scene</>
          )}
        </button>

        {/* Error */}
        {genError && (
          <div className="flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-900/20 px-3 py-2.5"
               data-testid="ai-error-banner">
            <AlertTriangle className="h-4 w-4 text-red-300 shrink-0 mt-0.5" />
            <p className="text-[11px] text-red-200 leading-relaxed">{genError}</p>
          </div>
        )}
      </div>

      {/* ── Result ── */}
      {result && (
        <ScenePreview
          result={result}
          includeKhmer={includeKhmer}
          khmerExpanded={khmerExpanded}
          onToggleKhmer={() => setKhmerExpanded((v) => !v)}
          copiedBlockIdx={copiedBlockIdx}
          copiedSceneId={copiedSceneId}
          onCopyBlock={copyBlock}
          onCopyAll={copyAllBlocks}
          onRegenerate={handleGenerate}
          generating={generating}
        />
      )}

      {/* ── Usage note ── */}
      <div className="flex items-start gap-2 rounded-xl border border-white/6 px-3 py-2.5"
           style={{ background: "rgba(255,255,255,0.02)" }}>
        <Info className="h-3.5 w-3.5 text-faded shrink-0 mt-0.5" />
        <p className="text-[10px] text-faded leading-relaxed">
          <strong className="text-parchment/60">How to apply:</strong> Copy individual blocks
          or all blocks, then paste the JSON into the <strong className="text-parchment/60">Editor</strong> tab
          using the block's custom JSON field, or add blocks manually and paste the text content.
          Audio must still be generated separately via ElevenLabs (existing flow).
          Image placeholders must be replaced with real image URLs.
        </p>
      </div>
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────────────────────── */

function AiStatusBanner({ status, error }) {
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-red-400/25 bg-red-900/15 px-3 py-2"
           data-testid="ai-status-error">
        <AlertTriangle className="h-3.5 w-3.5 text-red-300 shrink-0" />
        <p className="text-[11px] text-red-200">Server unreachable: {error}</p>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-white/8 px-3 py-2">
        <Loader2 className="h-3.5 w-3.5 text-faded animate-spin" />
        <p className="text-[11px] text-faded">Checking AI Scene Builder availability…</p>
      </div>
    );
  }
  if (!status.enabled) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-900/15 px-3 py-2.5"
           data-testid="ai-status-disabled">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-300 shrink-0 mt-0.5" />
        <div>
          <p className="text-[11px] text-amber-200 font-semibold">AI Scene Builder not configured</p>
          <p className="text-[10px] text-amber-300/70 mt-0.5 leading-relaxed">
            Add <code className="text-amber-200">GEMINI_API_KEY</code> to your Render environment
            variables. Get a free key at{" "}
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer"
               className="underline text-amber-200">aistudio.google.com/apikey</a>.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-900/10 px-3 py-1.5"
         data-testid="ai-status-enabled">
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
      <p className="text-[11px] text-emerald-300">
        Gemini ready · model: <code>{status.model}</code>
      </p>
    </div>
  );
}

function ScenePreview({
  result, includeKhmer, khmerExpanded, onToggleKhmer,
  copiedBlockIdx, copiedSceneId, onCopyBlock, onCopyAll,
  onRegenerate, generating,
}) {
  const { geminiRaw, previewBlocks, warnings, sceneId, generatedAt } = result;

  return (
    <div className="space-y-4" data-testid="ai-scene-preview">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[12px] font-semibold text-parchment">
            Scene Preview · <span className="text-faded font-mono text-[10px]">{sceneId}</span>
          </p>
          <p className="text-[10px] text-faded">
            Generated {new Date(generatedAt).toLocaleString()} ·{" "}
            {previewBlocks.length} blocks
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onCopyAll} data-testid="ai-copy-all-btn"
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-walnut/60 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold transition-all">
            <Copy className="h-3 w-3" />
            {copiedSceneId === sceneId ? "Copied!" : "Copy All Blocks"}
          </button>
          <button onClick={onRegenerate} disabled={generating}
                  data-testid="ai-retry-btn"
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-walnut/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-faded hover:border-white/25 hover:text-parchment transition-all disabled:opacity-40">
            <RefreshCw className={`h-3 w-3 ${generating ? "animate-spin" : ""}`} />
            Retry
          </button>
        </div>
      </div>

      {/* Warnings */}
      {warnings?.length > 0 && (
        <div className="rounded-xl border border-amber-400/20 bg-amber-900/10 px-3 py-2 space-y-0.5">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-center gap-2">
              <AlertTriangle className="h-3 w-3 text-amber-300 shrink-0" />
              <p className="text-[10px] text-amber-200">{w}</p>
            </div>
          ))}
        </div>
      )}

      {/* English-first raw output */}
      <div className="rounded-2xl border border-white/8 p-4 space-y-3"
           style={{ background: "rgba(20,14,32,0.55)" }}>
        <SceneRawSection geminiRaw={geminiRaw} />

        {/* Khmer helper — collapsed by default */}
        {includeKhmer && geminiRaw?.optionalKhmerHelp && (
          <div className="rounded-xl border border-white/6"
               style={{ background: "rgba(255,255,255,0.02)" }}>
            <button onClick={onToggleKhmer}
                    data-testid="ai-khmer-toggle"
                    className="w-full flex items-center justify-between px-3 py-2 text-[10px] text-faded hover:text-parchment transition-colors">
              <span className="uppercase tracking-widest">Khmer Support (hidden metadata)</span>
              {khmerExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
            {khmerExpanded && (
              <p className="px-3 pb-3 text-[12px] text-parchment/70 leading-relaxed font-khmer">
                {geminiRaw.optionalKhmerHelp}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Block list */}
      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-widest text-faded px-1">
          Preview Blocks (copy individually or use "Copy All Blocks")
        </p>
        {previewBlocks.map((block, idx) => (
          <BlockCard
            key={idx}
            block={block}
            idx={idx}
            copied={copiedBlockIdx === idx}
            onCopy={onCopyBlock}
          />
        ))}
      </div>

      {/* Apply instructions */}
      <div className="rounded-xl border border-gold/15 bg-gold/5 px-4 py-3">
        <p className="text-[11px] text-parchment/80 font-semibold mb-1">How to apply these blocks</p>
        <ol className="text-[10px] text-faded space-y-1 leading-relaxed list-decimal list-inside">
          <li>Click <strong className="text-parchment/70">Copy All Blocks</strong> above.</li>
          <li>Switch to the <strong className="text-parchment/70">Editor</strong> tab and open the target chapter.</li>
          <li>Add blocks manually (paragraph, quote, MCQ…) and paste the English text content.</li>
          <li>Replace <strong className="text-parchment/70">[Audio script]</strong> placeholders by generating audio via ElevenLabs (existing flow).</li>
          <li>Replace <strong className="text-parchment/70">[Image prompt]</strong> placeholders with real image URLs after sourcing the image.</li>
          <li>Save the chapter. The existing 3D reader will render everything normally.</li>
        </ol>
      </div>
    </div>
  );
}

function SceneRawSection({ geminiRaw }) {
  if (!geminiRaw) return null;
  return (
    <div className="space-y-3">
      {/* Title */}
      {geminiRaw.title && (
        <div>
          <p className="text-[9px] uppercase tracking-widest text-faded mb-1 flex items-center gap-1">
            <BookOpen className="h-2.5 w-2.5" /> Scene Title
          </p>
          <p className="text-[14px] font-display text-parchment">{geminiRaw.title}</p>
        </div>
      )}

      {/* English text — ALWAYS primary */}
      {geminiRaw.englishText && (
        <div>
          <p className="text-[9px] uppercase tracking-widest text-faded mb-1 flex items-center gap-1">
            <Mic className="h-2.5 w-2.5" /> English Story (Primary Speaking Content)
          </p>
          <p className="text-[13px] text-parchment/90 leading-relaxed">{geminiRaw.englishText}</p>
        </div>
      )}

      {/* Speaking prompt */}
      {geminiRaw.speakingPrompt && (
        <div>
          <p className="text-[9px] uppercase tracking-widest text-faded mb-1 flex items-center gap-1">
            <Mic className="h-2.5 w-2.5" /> Speaking Challenge
          </p>
          <p className="text-[12px] text-gold/80 italic">{geminiRaw.speakingPrompt}</p>
        </div>
      )}

      {/* Vocabulary */}
      {geminiRaw.vocabulary?.length > 0 && (
        <div>
          <p className="text-[9px] uppercase tracking-widest text-faded mb-1 flex items-center gap-1">
            <BookMarked className="h-2.5 w-2.5" /> Vocabulary
          </p>
          <div className="flex flex-wrap gap-1.5">
            {geminiRaw.vocabulary.map((item, i) => (
              <span key={i} className="rounded-lg border border-white/8 bg-walnut/40 px-2 py-0.5 text-[10px] text-parchment">
                <strong>{item.word}</strong>
                <span className="text-faded"> — {item.meaning}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* MCQ */}
      {geminiRaw.comprehensionQuestion?.question && (
        <div>
          <p className="text-[9px] uppercase tracking-widest text-faded mb-1 flex items-center gap-1">
            <ListChecks className="h-2.5 w-2.5" /> Comprehension Question
          </p>
          <p className="text-[12px] text-parchment/90 mb-1">
            {geminiRaw.comprehensionQuestion.question}
          </p>
          <div className="flex flex-wrap gap-1">
            {geminiRaw.comprehensionQuestion.choices?.map((c, i) => (
              <span key={i}
                    className={`rounded-lg border px-2 py-0.5 text-[10px] ${
                      c === geminiRaw.comprehensionQuestion.answer
                        ? "border-emerald-400/40 bg-emerald-900/20 text-emerald-300"
                        : "border-white/8 bg-walnut/30 text-parchment/70"
                    }`}>
                {c}{c === geminiRaw.comprehensionQuestion.answer && " ✓"}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Audio script */}
      {geminiRaw.audioScript && (
        <div>
          <p className="text-[9px] uppercase tracking-widest text-faded mb-1 flex items-center gap-1">
            <Volume2 className="h-2.5 w-2.5" /> Audio Script (for ElevenLabs)
          </p>
          <p className="text-[11px] text-parchment/60 leading-relaxed italic">
            {geminiRaw.audioScript}
          </p>
        </div>
      )}

      {/* Image prompt */}
      {geminiRaw.imagePrompt && (
        <div>
          <p className="text-[9px] uppercase tracking-widest text-faded mb-1 flex items-center gap-1">
            <ImageIcon className="h-2.5 w-2.5" /> Image Prompt
          </p>
          <p className="text-[10px] text-parchment/50 leading-relaxed">
            {geminiRaw.imagePrompt}
          </p>
        </div>
      )}
    </div>
  );
}

function BlockCard({ block, idx, copied, onCopy }) {
  const type = block.type || "paragraph";
  const isPlaceholder = block._isAudioScriptPlaceholder || block._isImagePromptPlaceholder;

  const typeColors = {
    heading:   "border-gold/25 text-gold",
    paragraph: "border-white/10 text-parchment/80",
    quote:     "border-emerald-400/20 text-emerald-300",
    mcq:       "border-blue-400/20 text-blue-300",
  };

  const colorClass = typeColors[type] || "border-white/8 text-faded";

  // Produce a clean preview of the block text (truncated)
  const previewText = block.question  // mcq
    ? `Q: ${block.question}`
    : (block.text || "").slice(0, 120) + ((block.text?.length || 0) > 120 ? "…" : "");

  return (
    <div className={`relative rounded-xl border px-3 py-2.5 ${colorClass} ${isPlaceholder ? "opacity-60" : ""}`}
         style={{ background: "rgba(20,14,32,0.4)" }}
         data-testid={`ai-block-${idx}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[9px] uppercase tracking-widest text-faded mb-1">
            {type}{isPlaceholder ? " · placeholder" : ""}
            {block._learningFocus ? ` · ${block._learningFocus.replace("_", " ")}` : ""}
          </p>
          <p className="text-[11px] leading-relaxed truncate-multiline">{previewText}</p>
          {block._khmerHelp && (
            <p className="text-[9px] text-faded mt-1">
              [Khmer metadata hidden — will not appear in reader]
            </p>
          )}
        </div>
        <button
          onClick={() => onCopy(block, idx)}
          className="shrink-0 grid h-7 w-7 place-items-center rounded-lg border border-white/10 bg-walnut/40 text-faded hover:border-gold hover:text-gold transition-all"
          title="Copy block JSON"
          data-testid={`ai-copy-block-${idx}`}
        >
          {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

function FormRow({ label, hint, children }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <label className="text-[11px] font-semibold text-parchment/80">{label}</label>
        {hint && <span className="text-[10px] text-faded">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ label, icon, active, onChange, testId }) {
  return (
    <button
      onClick={() => onChange((v) => !v)}
      data-testid={testId}
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-all"
      style={active ? activePill : inactivePill}
    >
      {icon} {label}
    </button>
  );
}

/* ── Shared pill styles ─────────────────────────────────────────────────── */

const activePill = {
  background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
  color: "#1a1420",
  border: "1px solid rgba(255,225,154,0.6)",
  boxShadow: "0 4px 10px rgba(212,168,67,0.3)",
};

const inactivePill = {
  background: "rgba(45,31,62,0.65)",
  color: "#F4E5C1",
  border: "1px solid rgba(212,168,67,0.2)",
};
