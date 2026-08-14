import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "markdown-to-jsx";
import { AlertTriangle, Headphones, Pause, Play, Sparkles } from "lucide-react";
import { SpeedPill, useBookAudio } from "./AudioPlayerContext";
import DialogTurn from "./DialogTurn";
import ExerciseBlock from "./ExerciseBlock";

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
export default function ChapterBlocks({ blocks, speakerConfig }) {
  const speakerConfigMap = speakerConfig || {};
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
          return <blockquote key={i}>{b.text}</blockquote>;
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
          const isConversationAudio = !!b._conversation_audio;
          return (
            <AudioBlock
              key={i}
              src={normalizeMediaUrl(b.text)}
              label={isConversationAudio ? null : (b.heading || b.title || "Narration")}
              isConversation={isConversationAudio}
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
          return (
            <TranscriptParagraph
              key={i}
              text={b.text}
              start={Number(b.start)}
              end={Number(b.end)}
              wordTimestamps={Array.isArray(b.wordTimestamps) ? b.wordTimestamps : null}
            />
          );
        }
        if (type === "dialog" && b.text) {
          return (
            <DialogTurn
              key={i}
              speaker={b.speaker || b.name || ""}
              text={b.text}
              audio={b.audio}
              emotion={b.emotion || undefined}
              start={b.start != null ? Number(b.start) : undefined}
              end={b.end != null ? Number(b.end) : undefined}
              wordTimestamps={Array.isArray(b.wordTimestamps) ? b.wordTimestamps : null}
              speakerConfig={speakerConfigMap[b.speaker] || speakerConfigMap[b.name] || undefined}
            />
          );
        }
        if ((type === "mcq" || type === "fillblank") && b.text) {
          return <ExerciseBlock key={i} block={b} />;
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

function AudioBlock({ src, label, isConversation }) {
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
    audio.setSrc(url, { title: isConversation ? "Now Playing" : (label || "Audio narration") });
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
      {label && !isConversation ? (
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
              audio.setSrc(url, { title: isConversation ? "Now Playing" : (label || "Audio narration") });
              // small tick to let the src settle before play
              setTimeout(() => audio.play(), 0);
              return;
            }
            if (!audio.src) {
              audio.setSrc(url, { title: isConversation ? "Now Playing" : (label || "Audio narration") });
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

function isIframeHost(raw) {
  try {
    const h = new URL(raw).hostname.toLowerCase();
    return (
      /youtube\.com$/.test(h) ||
      h === "youtu.be" ||
      /vimeo\.com$/.test(h) ||
      /loom\.com$/.test(h) ||
      /dailymotion\.com$/.test(h) ||
      /facebook\.com$/.test(h)
    );
  } catch {
    return false;
  }
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

function TranscriptParagraph({ text, start, end, wordTimestamps }) {
  const audio = useBookAudio();
  const wordsRef = useRef([]);
  const containerRef = useRef(null);
  const [active, setActive] = useState(-1); // index of highlighted word
  // v9.5 FIX C — remember the last seen play epoch. On a fresh play
  // (replay after `ended`, or first-time play), the epoch bumps and we
  // hard-reset to -1 so downstream blocks don't show "all-past" lingering
  // highlight while the playhead is still in an earlier block.
  const lastEpochRef = useRef(-1);
  // v9.6 FIX F — also remember the last seen audio src. Opening a new
  // chapter loads a new track; without this guard, a transcript paragraph
  // whose [start, end] window lies near zero saw the OLD track's
  // currentTime (which could be 180s into chapter 1) and immediately
  // flipped to "all past". Resetting on src-change clears that.
  const lastSrcRef = useRef(null);
  // v9.6 PERF — hold the current `active` in a ref so the effect can
  // gate state writes. setActive(sameValue) is cheap individually but
  // adds up across 30+ paragraphs × ~4 timeupdate events/sec over a
  // long chapter; gating eliminates ~99% of those calls.
  const activeRef = useRef(-1);
  // Keep ref synced with state so other effects (and re-mounts) read
  // the right thing.
  activeRef.current = active;

  const words = useMemo(() => splitWordsKeepingPunct(text), [text]);

  // v9.5 — Stale-ref cleanup: when `words` shrinks (text edit / re-render
  // with shorter content), trim wordsRef so the scrollIntoView effect can
  // never target an unmounted <span>. (Documented in v9.5 changelog but
  // the implementation lived in the changelog only — adding it here.)
  if (wordsRef.current.length > words.length) {
    wordsRef.current.length = words.length;
  }

  // v9.5 FIX B — use backend-provided per-word timestamps when present
  // (ElevenLabs character-level alignment → word-level via server.py).
  // Falls back to linear interpolation between [start, end] when the
  // chapter was authored without TTS (legacy / manual transcripts).
  // We align timestamps to our displayed word tokens by index. Backend
  // strips punctuation off `word` (server.py L329), so we tolerate
  // length mismatches by clamping rather than misaligning.
  const wt = useMemo(() => {
    if (!Array.isArray(wordTimestamps) || wordTimestamps.length === 0) return null;
    return wordTimestamps;
  }, [wordTimestamps]);

  // Compute active word using exact wordTimestamps when available,
  // otherwise linear interpolation. Resets on every fresh play epoch
  // (replay) AND on every src change (chapter switch) so the highlight
  // never carries stale state across track or chapter boundaries.
  useEffect(() => {
    if (!audio) {
      if (activeRef.current !== -1) setActive(-1);
      return;
    }

    // v9.6 — perf-gated setActive: only commit when index actually changes.
    const commit = (idx) => {
      if (activeRef.current !== idx) setActive(idx);
    };

    // v9.5 FIX C — detect fresh playback session (replay / first play).
    const epoch = audio.playToken || 0;
    const isNewEpoch = epoch !== lastEpochRef.current;
    if (isNewEpoch) {
      lastEpochRef.current = epoch;
      commit(-1);
    }
    // v9.6 FIX F — detect chapter / track change (different src).
    const curSrc = audio.src || null;
    const isNewSrc = curSrc !== lastSrcRef.current;
    if (isNewSrc) {
      lastSrcRef.current = curSrc;
      commit(-1);
      // Don't return — fall through and re-evaluate against current t,
      // so if the NEW track's currentTime already lies inside this
      // paragraph's window (rare but possible on resume), the highlight
      // is still correct on the next tick.
    }

    const t = audio.currentTime;
    const s = Number.isFinite(start) ? start : 0;
    const e = Number.isFinite(end) ? end : 0;

    // Idle state: nothing loaded, never played, scrubbed to 0 → future.
    if (!audio.playing && t === 0) {
      commit(-1);
      return;
    }
    if (e <= s && !wt) { commit(-1); return; }
    if (t < s - 0.05) { commit(-1); return; }
    if (t >= e) { commit(words.length - 1); return; }

    // --- Exact per-word path (preferred) ----------------------------------
    if (wt && wt.length > 0) {
      // Find the word whose [start, end] window contains t.
      // Linear scan is fine (~30–80 words/block); binary search not needed.
      let idx = -1;
      for (let i = 0; i < wt.length; i++) {
        const ws = Number(wt[i].start);
        const we = Number(wt[i].end);
        if (Number.isFinite(ws) && Number.isFinite(we) && t >= ws && t <= we) {
          idx = i;
          break;
        }
        // Between gaps (silence between words) → carry the last finished word
        if (Number.isFinite(we) && we < t) idx = i;
        if (Number.isFinite(ws) && ws > t) break;
      }
      // Clamp to displayed token count (backend strips punctuation so
      // wt.length may differ from words.length by ±a few).
      const clamped = Math.max(-1, Math.min(words.length - 1, idx));
      commit(clamped);
      return;
    }

    // --- Linear-interpolation fallback (legacy / non-TTS transcripts) -----
    const span = e - s;
    const frac = (t - s) / span;
    const idx = Math.max(0, Math.min(words.length - 1, Math.floor(frac * words.length)));
    commit(idx);
  }, [
    audio,
    audio?.currentTime,
    audio?.playing,
    audio?.playToken,
    audio?.src,
    start,
    end,
    words.length,
    wt,
  ]);

  // When the active paragraph is the one playing, gently scroll its container
  // into view (only when audio is playing and on this page).
  useEffect(() => {
    if (active < 0) return;
    if (!audio?.playing) return;
    const el = wordsRef.current[active];
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    }
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
/*  URL helpers                                                       */
/* ---------------------------------------------------------------- */

export function normalizeMediaUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  const u = raw.trim();
  try {
    const url = new URL(u);
    if (/(^|\.)dropbox\.com$/i.test(url.hostname)) {
      url.hostname = "dl.dropboxusercontent.com";
      url.searchParams.delete("dl");
      if (!url.searchParams.has("raw")) url.searchParams.set("raw", "1");
      return url.toString();
    }
    if (/(^|\.)drive\.google\.com$/i.test(url.hostname)) {
      let id = "";
      const m = url.pathname.match(/\/file\/d\/([^/]+)/);
      if (m) id = m[1];
      if (!id && url.searchParams.get("id")) id = url.searchParams.get("id");
      if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
    }
    return u;
  } catch {
    return u;
  }
}

export function toEmbedUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  const u = raw.trim();
  try {
    const url = new URL(u);
    if (/youtube\.com$/i.test(url.hostname) || url.hostname === "youtu.be") {
      let id = "";
      if (url.hostname === "youtu.be") id = url.pathname.replace(/^\//, "");
      else if (url.pathname.startsWith("/watch")) id = url.searchParams.get("v") || "";
      else if (url.pathname.startsWith("/shorts/")) id = url.pathname.replace("/shorts/", "");
      else if (url.pathname.startsWith("/embed/")) return u;
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
    if (/vimeo\.com$/i.test(url.hostname) && !url.hostname.startsWith("player.")) {
      const id = url.pathname.replace(/^\//, "").split("/")[0];
      if (/^\d+$/.test(id)) return `https://player.vimeo.com/video/${id}`;
    }
    if (/loom\.com$/i.test(url.hostname) && url.pathname.startsWith("/share/")) {
      return u.replace("/share/", "/embed/");
    }
    return u;
  } catch {
    return u;
  }
}
