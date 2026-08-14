import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "markdown-to-jsx";
import { AlertTriangle, Headphones, Heart, Pause, Play, Sparkles } from "lucide-react";
import { SpeedPill, useBookAudio } from "./AudioPlayerContext";
import DialogTurn from "./DialogTurn";
import ExerciseBlock from "./ExerciseBlock";
// Phase 1 premium AI tools — Khmer Decoder + Executive Upgrade.
// Mounted as a sibling under each eligible text block (paragraph, quote,
// transcript, dialog). Renders nothing when no student is signed in or
// when block text is empty. Safe to ship without these new props
// (defaults below preserve the existing rendering byte-for-byte).
import PremiumAiAction from "./PremiumAiAction";
// Coach Pack v3 — Save Sentence pill. Additive, fails silently. Renders
// nothing when the student is unauthenticated or the block text is empty.
// Does NOT modify PremiumAiAction layout or behaviour.
import CoachPackBlockPills from "./coachPack/CoachPackBlockPills";
// v9.4 — URL helpers extracted to media-urls.js so they can be unit-tested
// in isolation without pulling in <Markdown> + lucide-react. Re-exported
// below to preserve every existing import path (`normalizeMediaUrl`,
// `toEmbedUrl`, `isR2PublicHost`, `isDirectAudioUrl`).
import {
  normalizeMediaUrl,
  toEmbedUrl,
  isR2PublicHost,
  isDirectAudioUrl,
  isIframeHost,
} from "./media-urls";
export { normalizeMediaUrl, toEmbedUrl, isR2PublicHost, isDirectAudioUrl };

/**
 * Render a chapter's blocks. A block is either:
 *   { type: 'markdown',   text }                    — full markdown string
 *   { type: 'heading',    text }                    — H3 inside chapter
 *   { type: 'paragraph',  text }                    — plain paragraph
 *   { type: 'quote',      text }                    — blockquote
 *   { type: 'example',    text }                    — monospace example
 *   { type: 'image',      text }                    — URL
 *   { type: 'audio',      text, heading?, scrollHint? }
 *                                                   — direct audio URL
 *                                                     (mp3/m4a/ogg/wav)
 *   { type: 'video',      text, heading?, poster? } — direct video URL
 *   { type: 'embed',      text, heading? }          — YouTube/Vimeo/Loom URL
 *   { type: 'transcript', text, start, end, audio? }
 *                                                   — paragraph that
 *                                                     auto-highlights word-
 *                                                     by-word as the matching
 *                                                     audio plays (linear
 *                                                     interpolation between
 *                                                     start/end seconds).
 *
 * Audio is owned by the BookAudioProvider so it KEEPS PLAYING when the
 * student turns the page. AudioBlock is a "remote control" that registers
 * the source on the shared engine and renders custom controls.
 */
export default function ChapterBlocks({ blocks, bookSlug = "", bookTier = "", chapterIdx = -1 }) {
  // Detect whether THIS page contains an audio block, and which audio src
  // is the "primary" one for transcript paragraphs that don't specify their
  // own. We also nudge the persistent player to load the right track.
  const primaryAudio = useMemo(() => {
    if (!blocks || blocks.length === 0) return null;
    const a = blocks.find((b) => (b?.type || "").toLowerCase() === "audio");
    if (!a) return null;
    return {
      src: normalizeMediaUrl(a.text),
      title: a.heading || a.title || "Audio narration",
    };
  }, [blocks]);

  // v9.6 — Premium UI cleanup: progressive disclosure for PremiumAiAction.
  // Instead of rendering the Khmer Mindset / Executive Tone toolbar under
  // EVERY paragraph / quote / transcript / dialog block (which made the
  // Reader feel crowded — especially on mobile), we now keep a single
  // `selectedBlockKey`. The compact inline AI toolbar is rendered only for
  // the currently-selected block. Tap/click anywhere else (outside any
  // selectable block AND outside an open .premium-ai-action modal) clears
  // the selection.
  //
  // Behaviour & safety:
  //   - PremiumAiAction props and API calls are byte-for-byte unchanged.
  //   - Selection state is local to ChapterBlocks. ChapterBlocks remounts
  //     on every page flip (ReaderPage keys it by page), so selection
  //     naturally resets when the student turns the page.
  //   - Clicking a pill button inside .premium-ai-action does NOT toggle
  //     selection off (SelectableBlock guards with closest('.premium-ai-action')).
  //   - The Modal renders inside .premium-ai-action so its clicks are
  //     similarly excluded from the document-level deselect handler.
  const [selectedKey, setSelectedKey] = useState(null);

  useEffect(() => {
    if (selectedKey == null) return;
    const handler = (e) => {
      const t = e.target;
      if (!t || typeof t.closest !== "function") return;
      // Click inside any selectable block or any open premium AI surface
      // (pills, modal, result card) must NOT collapse the toolbar.
      if (t.closest("[data-selectable-block]")) return;
      if (t.closest(".premium-ai-action")) return;
      if (t.closest('[data-testid="premium-ai-modal"]')) return;
      setSelectedKey(null);
    };
    document.addEventListener("mousedown", handler, true);
    document.addEventListener("touchstart", handler, true);
    return () => {
      document.removeEventListener("mousedown", handler, true);
      document.removeEventListener("touchstart", handler, true);
    };
  }, [selectedKey]);

  if (!blocks || blocks.length === 0) return null;

  return (
    <>
      {primaryAudio ? <AudioPageBadge title={primaryAudio.title} /> : null}
      {blocks.map((b, i) => {
        const type = (b.type || "paragraph").toLowerCase();
        if (type === "markdown") {
          return (
            <Markdown
              key={i}
              options={{
                forceBlock: true,
                overrides: {
                  h1: { props: { style: { display: "none" } } },
                  audio: { component: AudioBlock, props: { src: "" } },
                  video: { component: VideoBlock, props: { src: "" } },
                },
              }}
            >
              {b.text}
            </Markdown>
          );
        }
        if (type === "heading") {
          return <h3 key={i}>{b.text}</h3>;
        }
        if (type === "quote") {
          const key = `b-${i}`;
          const isSelected = selectedKey === key;
          return (
            <SelectableBlock
              key={i}
              blockKey={key}
              selected={isSelected}
              onSelect={setSelectedKey}
            >
              <FavouriteQuote text={b.text} />
              {isSelected && (
                <>
                  <PremiumAiAction blockText={b.text} bookSlug={bookSlug} bookTier={bookTier} />
                  <CoachPackBlockPills blockText={b.text} bookSlug={bookSlug} bookTier={bookTier} chapterIdx={chapterIdx} />
                </>
              )}
            </SelectableBlock>
          );
        }
        if (type === "example") {
          return (
            <div className="block-example" key={i}>
              {b.text}
            </div>
          );
        }
        if (type === "image" && b.text) {
          return (
            <img
              key={i}
              src={b.text}
              alt=""
              style={{
                maxWidth: "100%",
                borderRadius: 8,
                margin: "1.2em auto",
                display: "block",
              }}
            />
          );
        }
        if (type === "audio" && b.text) {
          return (
            <AudioBlock
              key={i}
              src={normalizeMediaUrl(b.text)}
              label={b.heading || b.title || "Narration"}
            />
          );
        }
        if (type === "video" && b.text) {
          return (
            <VideoBlock
              key={i}
              src={normalizeMediaUrl(b.text)}
              label={b.heading || b.title}
              poster={b.poster}
            />
          );
        }
        if (type === "embed" && b.text) {
          return (
            <EmbedBlock
              key={i}
              src={toEmbedUrl(b.text)}
              label={b.heading || b.title}
            />
          );
        }
        if (type === "transcript" && b.text) {
          const key = `b-${i}`;
          const isSelected = selectedKey === key;
          return (
            <SelectableBlock
              key={i}
              blockKey={key}
              selected={isSelected}
              onSelect={setSelectedKey}
            >
              <TranscriptParagraph
                text={b.text}
                start={Number(b.start)}
                end={Number(b.end)}
                wordTimestamps={b.wordTimestamps || null}
              />
              {isSelected && (
                <>
                  <PremiumAiAction blockText={b.text} bookSlug={bookSlug} bookTier={bookTier} />
                  <CoachPackBlockPills blockText={b.text} bookSlug={bookSlug} bookTier={bookTier} chapterIdx={chapterIdx} />
                </>
              )}
            </SelectableBlock>
          );
        }
        if (type === "dialog" && b.text) {
          const key = `b-${i}`;
          const isSelected = selectedKey === key;
          return (
            <SelectableBlock
              key={i}
              blockKey={key}
              selected={isSelected}
              onSelect={setSelectedKey}
            >
              <DialogTurn
                speaker={b.speaker || b.name || ""}
                text={b.text}
                audio={b.audio}
              />
              {isSelected && (
                <>
                  <PremiumAiAction blockText={b.text} bookSlug={bookSlug} bookTier={bookTier} />
                  <CoachPackBlockPills blockText={b.text} bookSlug={bookSlug} bookTier={bookTier} chapterIdx={chapterIdx} />
                </>
              )}
            </SelectableBlock>
          );
        }
        if ((type === "mcq" || type === "fillblank") && b.text) {
          return <ExerciseBlock key={i} block={b} />;
        }
        // v8 — explicit `paragraph` / `paragraphs` / `text` handler. Previous
        // code let these fall through to <Markdown> which stripped bullets
        // and inlined hard line breaks. We now render them as clean paragraphs
        // while still parsing inline markdown (bold, italic, links).
        if (type === "paragraph" || type === "paragraphs" || type === "text") {
          // Preserve double-newline paragraph breaks → multiple <p>s
          const parts = String(b.text || "")
            .split(/\n{2,}/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (parts.length === 0) return null;
          const key = `b-${i}`;
          const isSelected = selectedKey === key;
          return (
            <SelectableBlock
              key={i}
              blockKey={key}
              selected={isSelected}
              onSelect={setSelectedKey}
            >
              {parts.map((pt, j) => (
                <Markdown
                  key={j}
                  options={{
                    forceBlock: false,
                    wrapper: "p",
                    forceWrapper: true,
                  }}
                >
                  {pt}
                </Markdown>
              ))}
              {isSelected && (
                <>
                  <PremiumAiAction blockText={b.text} bookSlug={bookSlug} bookTier={bookTier} />
                  <CoachPackBlockPills blockText={b.text} bookSlug={bookSlug} bookTier={bookTier} chapterIdx={chapterIdx} />
                </>
              )}
            </SelectableBlock>
          );
        }
        return (
          <Markdown
            key={i}
            options={{ forceBlock: false, wrapper: "p", forceWrapper: true }}
          >
            {b.text}
          </Markdown>
        );
      })}
    </>
  );
}

/* ---------------------------------------------------------------- */
/*  "Audio is on this page" pulsing affordance + auto-load           */
/* ---------------------------------------------------------------- */

function AudioPageBadge({ title }) {
  const audio = useBookAudio();
  if (!audio) return null;
  const isLoaded = audio.src;
  const isPlaying = audio.playing && isLoaded;

  return (
    <div
      className="audio-page-badge"
      data-active={isPlaying ? "true" : "false"}
      data-testid="audio-page-badge"
    >
      <span className="audio-page-badge__pulse" aria-hidden />
      <Sparkles className="h-3.5 w-3.5" aria-hidden />
      <span className="audio-page-badge__label">
        {isPlaying
          ? `Playing — ${title}`
          : `Audio on this page · tap ▶ on the player below to listen`}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/*  Media block components                                           */
/* ---------------------------------------------------------------- */

function AudioBlock({ src, label }) {
  const audio = useBookAudio();
  const url = normalizeMediaUrl(src);
  const isThisTrack = audio?.src === url;
  const playing = isThisTrack && audio?.playing;

  // v7.7: register this audio with the global engine ONLY when the engine
  // is idle (nothing loaded yet, or currently paused and not this URL).
  // This way, if the student has started audio X and flips to a page that
  // declares a different audio Y, X keeps playing uninterrupted. Y will
  // be activated the moment the student taps its play button.
  useEffect(() => {
    if (!audio || !url) return;
    if (audio.src && audio.src !== url) return;   // another track is loaded
    if (audio.playing) return;                    // never interrupt playback
    audio.setSrc(url, { title: label || "Audio narration" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, label, audio?.src, audio?.playing]);

  if (!src) return null;

  // If we're not in a Provider, fall back to a plain native <audio>.
  if (!audio) {
    return (
      <figure className="block-media block-audio" data-testid="reader-audio-block">
        {label ? <figcaption className="block-media__label">{label}</figcaption> : null}
        <audio
          controls
          preload="none"
          playsInline
          className="block-media__player"
          src={url}
          data-testid="reader-audio-el"
        />
      </figure>
    );
  }

  const fmt = (s) => {
    if (!Number.isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, "0")}`;
  };
  const ct = isThisTrack ? audio.currentTime : 0;
  const dur = isThisTrack ? audio.duration : 0;
  const pct = dur > 0 ? Math.min(100, (ct / dur) * 100) : 0;
  const buffering = isThisTrack && audio.buffering;
  const hasError = isThisTrack && audio.error;

  // Priority: error > buffering > play/pause
  const renderBtnIcon = () => {
    if (hasError) return <AlertTriangle className="h-4 w-4" />;
    if (buffering && !playing) return <span className="audio-spinner" aria-hidden />;
    return playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />;
  };

  return (
    <figure
      className="block-media block-audio block-audio--enhanced"
      data-active={playing ? "true" : "false"}
      data-testid="reader-audio-block"
    >
      {label ? (
        <figcaption className="block-media__label">
          <Headphones className="inline-block h-3 w-3 -mt-0.5 mr-1.5" aria-hidden />
          {label}
        </figcaption>
      ) : null}
      <div className="block-audio__row">
        <button
          type="button"
          className="block-audio__btn"
          onClick={async () => {
            if (hasError) return audio.retry();
            // If a different track is currently loaded, switch + play.
            if (audio.src && audio.src !== url) {
              audio.setSrc(url, { title: label || "Audio narration" });
              // small tick to let the src settle before play
              setTimeout(() => audio.play(), 0);
              return;
            }
            if (!audio.src) {
              audio.setSrc(url, { title: label || "Audio narration" });
              setTimeout(() => audio.play(), 0);
              return;
            }
            audio.toggle();
          }}
          aria-label={
            hasError ? "Retry audio" :
            buffering ? "Buffering…" :
            playing ? "Pause narration" : "Play narration"
          }
          data-testid="reader-audio-toggle"
        >
          {renderBtnIcon()}
        </button>
        <div className="block-audio__time" data-testid="reader-audio-time">
          {fmt(ct)} / {fmt(dur)}
        </div>
        {/* v7.6 — speed pill beside the play button in the in-chapter block */}
        <SpeedPill testid="reader-audio-speed" />
        {hasError ? (
          <div className="audio-error" data-testid="reader-audio-error">
            <AlertTriangle className="h-3.5 w-3.5" />
            <button
              type="button"
              className="audio-error__retry"
              onClick={() => audio.retry()}
              data-testid="reader-audio-retry"
            >
              Retry
            </button>
          </div>
        ) : (
          <input
            type="range"
            min={0}
            max={Math.max(dur, 0.001)}
            step={0.1}
            value={Math.min(ct, dur || 0)}
            onChange={(e) => audio.seek(Number(e.target.value))}
            className="block-audio__scrub"
            style={{ "--p": `${pct}%` }}
            aria-label="Scrub audio"
            data-testid="reader-audio-scrub"
          />
        )}
      </div>
      <p className="block-audio__hint" data-testid="reader-audio-hint">
        Keeps playing as you flip pages — follow the highlighted transcript on
        the next pages.
      </p>
    </figure>
  );
}

function VideoBlock({ src, label, poster }) {
  if (!src) return null;
  // v7.9.2 — If the URL is an iframe-only host (YouTube, Vimeo, Loom,
  // Dailymotion, Facebook), render it through EmbedBlock. Raw <video>
  // cannot play those hosts.
  if (isIframeHost(src)) {
    return <EmbedBlock src={toEmbedUrl(src)} label={label} />;
  }
  const url = normalizeMediaUrl(src);
  return (
    <figure className="block-media block-video" data-testid="reader-video-block">
      {label ? <figcaption className="block-media__label">{label}</figcaption> : null}
      <video
        controls
        preload="none"
        playsInline
        poster={poster || undefined}
        className="block-media__player"
        src={url}
        data-testid="reader-video-el"
      >
        Your browser does not support the video element.{" "}
        <a href={url} target="_blank" rel="noopener noreferrer">Open the video</a>.
      </video>
    </figure>
  );
}

function EmbedBlock({ src, label }) {
  if (!src) return null;
  return (
    <figure className="block-media block-embed" data-testid="reader-embed-block">
      {label ? <figcaption className="block-media__label">{label}</figcaption> : null}
      <div className="block-embed__frame">
        <iframe
          src={src}
          title={label || "Embedded media"}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          referrerPolicy="no-referrer"
          loading="lazy"
        />
      </div>
    </figure>
  );
}

/* ---------------------------------------------------------------- */
/*  Transcript paragraph with word-level auto-highlighting           */
/* ---------------------------------------------------------------- */

// Issue 5 fix — pure functions extracted from TranscriptParagraph's two
// highlight effects (weighted-estimation and ElevenLabs-exact-timestamp).
// Used both by the effects themselves AND by the component's lazy
// `useState` initializer, so the very first paint after every remount
// (e.g. a page turn, since audio keeps playing across it) already shows
// the correct highlighted word instead of flashing "none" for one frame.
// Exported (same pattern as media-urls.js) so they can be unit-tested in
// isolation without mounting the full block renderer.
export function computeWeightedActiveWord({ audio, start, end, wordsLength, cumulativeWeights, totalWeight }) {
  if (!audio) return -1;
  const t = audio.currentTime;
  const s = Number.isFinite(start) ? start : 0;
  const e = Number.isFinite(end) ? end : 0;
  if (!audio.playing && t === 0) return -1;
  if (e <= s) return -1;
  if (t < s - 0.05) return -1;
  if (t >= e) return wordsLength - 1;
  if (totalWeight <= 0) {
    // Degenerate paragraph (empty / whitespace) — fall back gracefully.
    const span = e - s;
    const frac = (t - s) / span;
    return Math.max(0, Math.min(wordsLength - 1, Math.floor(frac * wordsLength)));
  }
  const frac = (t - s) / (e - s);
  const target = frac * totalWeight;
  // Binary search for the first cumulative weight >= target. cumulative
  // is monotonically non-decreasing so this is exact.
  let lo = 0, hi = cumulativeWeights.length - 1, idx = hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cumulativeWeights[mid] >= target) {
      idx = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return idx;
}

export function computeTimestampActiveWord({ audio, wordTimestamps }) {
  if (!wordTimestamps || wordTimestamps.length === 0 || !audio) return -1;
  const t = audio.currentTime;
  // v9.5 — Replay reset. Companion fix in AudioPlayerContext.onEnded
  // guarantees React currentTime is 0 once a finished track has settled.
  // The `t === 0` half is retained so pause-mid-paragraph keeps the
  // current word highlighted (good UX — students see where they paused).
  if (!audio.playing && t === 0) return -1;
  // Before the first word — reset.
  if (t < wordTimestamps[0].start) return -1;
  // At or past the end of the last word. Pin to the final word so it
  // stays highlighted through the audio tail.
  const lastWord = wordTimestamps[wordTimestamps.length - 1];
  if (t >= lastWord.end) return wordTimestamps.length - 1;
  // Binary search with 0.01s tolerance for floating-point boundaries.
  const TOL = 0.01;
  let lo = 0, hi = wordTimestamps.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = wordTimestamps[mid];
    if (t >= w.start - TOL && t <= w.end + TOL) { found = mid; break; }
    else if (t < w.start) hi = mid - 1;
    else lo = mid + 1;
  }
  // If between words, highlight the most recently-finished word.
  if (found === -1) {
    for (let i = wordTimestamps.length - 1; i >= 0; i--) {
      if (wordTimestamps[i].end <= t) { found = i; break; }
    }
  }
  return found >= 0 ? found : -1;
}

function TranscriptParagraph({ text, start, end, wordTimestamps }) {
  const audio = useBookAudio();
  const wordsRef = useRef([]);
  const containerRef = useRef(null);

  const words = useMemo(() => splitWordsKeepingPunct(text), [text]);

  // v9.5 — Truncate wordsRef whenever the words list shrinks. Previously the
  // ref array kept references to spans from prior renders (longer text), and
  // the scrollIntoView effect could target a detached DOM node — a subtle
  // contributor to the "freeze / wrong-word" behaviour on replay after a
  // page-switch + return cycle.
  if (wordsRef.current.length > words.length) {
    wordsRef.current.length = words.length;
  }

  // v8.5 — Weighted-cumulative active-word model. The previous version
  // assumed every word lasted the same duration (`floor(frac * count)`),
  // which made the highlight drift on long words and ignore punctuation
  // pauses entirely. This model treats each word's duration as roughly
  // proportional to its character count, plus a pause-after weight when
  // it ends with punctuation (period, comma, etc.). The cumulative sum
  // is then mapped to the playback fraction, so the highlight slows on
  // long words and lingers at punctuation — matching how a human
  // narrator actually paces a sentence. No per-word timestamps from
  // the backend required; same start/end interface; same DOM/CSS.
  const wordWeights = useMemo(() => {
    // Pause cost is expressed in "character-equivalents" so it can be
    // summed with character counts. Tuned to feel right for English
    // narration at typical reading speeds.
    const PAUSE_CHARS = { sentence: 4, comma: 2, soft: 1.6 };
    const out = new Array(words.length);
    for (let i = 0; i < words.length; i++) {
      const w = String(words[i] || "");
      const trimmed = w.replace(/\s+$/, "");
      // Effective duration ∝ syllable-equivalent. We use chars (≥ 2) as a
      // cheap stand-in — works well enough for English without a syllable
      // dictionary.
      let weight = Math.max(2, trimmed.replace(/[^A-Za-z\u00C0-\u024F]/g, "").length || trimmed.length);
      const last = trimmed.charAt(trimmed.length - 1);
      if (/[.!?]/.test(last))      weight += PAUSE_CHARS.sentence;
      else if (/[,;]/.test(last))  weight += PAUSE_CHARS.comma;
      else if (/[:—–]/.test(last)) weight += PAUSE_CHARS.soft;
      out[i] = weight;
    }
    return out;
  }, [words]);

  const cumulativeWeights = useMemo(() => {
    const out = new Array(wordWeights.length);
    let sum = 0;
    for (let i = 0; i < wordWeights.length; i++) {
      sum += wordWeights[i];
      out[i] = sum;
    }
    return out;
  }, [wordWeights]);

  const totalWeight = cumulativeWeights.length
    ? cumulativeWeights[cumulativeWeights.length - 1]
    : 0;

  // Issue 5 fix — compute the CORRECT initial highlight synchronously at
  // mount, using the exact same formula the effect below uses, instead of
  // always starting at -1 and waiting for the effect to correct it one
  // paint later. Every page turn remounts this component fresh while
  // audio keeps playing (protected — "Audio continues while page
  // changes"), so without this the highlight visibly flashed "nothing
  // highlighted" for one frame on every page turn. `computeWeightedActiveWord`
  // is the same pure function the effect calls on every subsequent tick —
  // no behaviour change, just no longer skipping it for the first paint.
  const [active, setActive] = useState(() =>
    wordTimestamps && wordTimestamps.length > 0
      ? computeTimestampActiveWord({ audio, wordTimestamps })
      : computeWeightedActiveWord({
          audio, start, end, wordsLength: words.length, cumulativeWeights, totalWeight,
        })
  );

  useEffect(() => {
    // When ElevenLabs word timestamps exist, the override useEffect below
    // owns setActive() exclusively. Skip the weighted estimation entirely
    // so there is no double-write race during replay.
    if (wordTimestamps && wordTimestamps.length > 0) return;
    setActive(computeWeightedActiveWord({
      audio, start, end, wordsLength: words.length, cumulativeWeights, totalWeight,
    }));
  }, [audio, audio?.currentTime, audio?.playing, start, end, words.length, cumulativeWeights, totalWeight]); // eslint-disable-line react-hooks/exhaustive-deps

  // ElevenLabs word-timestamp override.
  // When wordTimestamps exist on the block, use exact timing instead of
  // the weighted estimation model. Falls back silently when absent.
  useEffect(() => {
    if (!wordTimestamps || wordTimestamps.length === 0 || !audio) return;
    setActive(computeTimestampActiveWord({ audio, wordTimestamps }));
  }, [audio, audio?.currentTime, audio?.playing, wordTimestamps]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the active paragraph is the one playing, gently scroll its container
  // into view (only when audio is playing and on this page).
  useEffect(() => {
    if (active < 0) return;
    if (!audio?.playing) return;
    const el = wordsRef.current[active];
    if (!el || !el.scrollIntoView) return;
    // Issue 6 fix — gate on an actual visibility check before scrolling.
    // This effect re-runs on EVERY word change (every ~0.2-0.5s while
    // playing); relying solely on `block: "nearest"`'s internal
    // already-visible check still issued a fresh scrollIntoView call each
    // time, and back-to-back smooth-scroll calls can restart/cancel a
    // still-in-flight one on some browsers, reading as jumpy. Same
    // getBoundingClientRect gate DialogTurn's own line-level scroll-follow
    // already uses — only actually scrolls when genuinely off-screen.
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || 800;
    if (r.top >= 0 && r.bottom <= vh) return;
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [active, audio?.playing]);

  const isActiveParagraph = active >= 0 && audio && audio.playing;

  return (
    <p
      ref={containerRef}
      className="transcript-para"
      data-active={isActiveParagraph ? "true" : "false"}
      data-testid="transcript-para"
    >
      {words.map((w, i) => (
        <span
          key={i}
          ref={(el) => (wordsRef.current[i] = el)}
          className="transcript-word"
          data-state={
            i < active ? "past" : i === active ? "now" : "future"
          }
        >
          {w}
        </span>
      ))}
    </p>
  );
}

function splitWordsKeepingPunct(text) {
  // Split into tokens preserving spacing/punctuation chunks.
  const out = [];
  const re = /\S+\s*/g;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    out.push(m[0]);
  }
  return out;
}

/* ---------------------------------------------------------------- */
/*  FavouriteQuote — click/tap heart to save locally + premium UX    */
/* ---------------------------------------------------------------- */

const FAV_KEY = "eduhub_fav_quotes_v1";

function readFavSet() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function FavouriteQuote({ text }) {
  const id = useMemo(() => hashText(text), [text]);
  const [saved, setSaved] = useState(() => readFavSet().has(id));
  const [pop, setPop] = useState(false);
  const [toast, setToast] = useState(false);

  const toggle = (e) => {
    e.stopPropagation();
    try {
      const set = readFavSet();
      if (set.has(id)) {
        set.delete(id);
        setSaved(false);
      } else {
        set.add(id);
        setSaved(true);
        setToast(true);
        setTimeout(() => setToast(false), 1600);
      }
      localStorage.setItem(FAV_KEY, JSON.stringify(Array.from(set)));
    } catch {
      /* ignore */
    }
    setPop(true);
    setTimeout(() => setPop(false), 450);
  };

  return (
    <>
      <blockquote
        className="fav-quote"
        data-testid="reader-fav-quote"
        onClick={toggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle(e);
          }
        }}
        aria-label={saved ? "Remove from favourites" : "Save to favourites"}
      >
        {text}
        <span
          className="fav-quote__heart"
          data-saved={saved ? "true" : "false"}
          data-pop={pop ? "true" : "false"}
          aria-hidden
        >
          <Heart
            className="h-3.5 w-3.5"
            strokeWidth={2.2}
            fill={saved ? "currentColor" : "none"}
          />
        </span>
      </blockquote>
      {toast && (
        <div className="fav-toast" data-testid="fav-toast">
          <Heart className="h-3.5 w-3.5" fill="currentColor" strokeWidth={2} />
          <span>Saved to favourites</span>
        </div>
      )}
    </>
  );
}

function hashText(t) {
  const s = String(t || "").trim();
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return `q_${Math.abs(h).toString(36)}`;
}

/* ---------------------------------------------------------------- */
/*  SelectableBlock — wraps a content block so the student can tap   */
/*  to reveal the inline PremiumAiAction toolbar. v9.6 premium       */
/*  cleanup: progressive disclosure of Khmer Mindset / Executive     */
/*  Tone. Visual state only — no business logic changes.             */
/* ---------------------------------------------------------------- */

function SelectableBlock({ blockKey, selected, onSelect, children }) {
  const handleClick = (e) => {
    // Never toggle when interacting with the AI toolbar or its modal,
    // and never toggle when the click is on an inherently interactive
    // child (heart on FavouriteQuote, audio controls inside dialog
    // turns, links, buttons, inputs, etc.).
    const t = e.target;
    if (t && typeof t.closest === "function") {
      if (t.closest(".premium-ai-action")) return;
      if (t.closest('[data-testid="premium-ai-modal"]')) return;
      if (
        t.closest(
          'button, a, input, textarea, select, [role="button"], [contenteditable="true"]'
        )
      ) {
        return;
      }
    }
    onSelect((cur) => (cur === blockKey ? null : blockKey));
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      // Only react when the focus is on the wrapper itself, not on a
      // nested interactive element (which has its own keyboard handler).
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      onSelect((cur) => (cur === blockKey ? null : blockKey));
    } else if (e.key === "Escape" && selected) {
      onSelect(null);
    }
  };

  return (
    <div
      data-selectable-block={blockKey}
      data-selected={selected ? "true" : "false"}
      data-testid={`selectable-block-${blockKey}`}
      role="group"
      tabIndex={0}
      aria-pressed={selected}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      style={{
        position: "relative",
        cursor: "pointer",
        borderRadius: selected ? "14px" : "10px",
        padding: selected ? "10px 12px" : "2px 0",
        margin: selected ? "10px -12px" : "0",
        background: selected
          ? "linear-gradient(180deg, rgba(155,125,240,0.07) 0%, rgba(212,168,67,0.045) 100%)"
          : "transparent",
        boxShadow: selected
          ? "0 0 0 1px rgba(212,168,67,0.32), 0 8px 28px -14px rgba(155,125,240,0.35)"
          : "none",
        outline: "none",
        transition:
          "background 220ms ease, box-shadow 220ms ease, padding 180ms ease, margin 180ms ease",
      }}
    >
      {children}
    </div>
  );
}
