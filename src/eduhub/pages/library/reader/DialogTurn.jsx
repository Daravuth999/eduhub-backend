/**
 * DialogTurn.jsx — Premium Mobile Chat Reader v7.0
 *
 * Surgical redesign focused on readability + premium polish.
 * NO API / NO hook contract changes — same props, same exports,
 * same useBookAudio() consumption, same word-sync logic, same testids.
 *
 * v7 fixes over v6 (purely visual):
 *   • Text is now FULLY READABLE (high-contrast ink instead of faded beige)
 *   • Idle bubbles dim background, NOT text — every word stays legible
 *   • Bubbles now have real surface, soft shadow + tail (chat metaphor)
 *   • Active line lifts with colored ring + glow, animated waveform
 *   • Word-sync highlight uses solid pill, never fades the underlying word
 *   • Avatar refined: gradient ring, monogram, micro-shadow
 *   • Mobile-first spacing, safe-area-aware bottom clearance
 *   • Honors prefers-reduced-motion + dark / sepia themes
 *
 * PROTECTED (untouched): AudioPlayerContext API, ChapterBlocks export,
 * timestamps, push notifications, studio, auth, reader navigation.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useBookAudio } from "./AudioPlayerContext";
import { normalizeMediaUrl } from "./ChapterBlocks";
import "./conversation-premium-v7.css";

/* ─── Stable speaker color assignment ───────────────────────────────────── */
const SPEAKER_ACCENTS = [
  { dot: "#C8902E", name: "#7A5414", word: "rgba(200,144,46,0.32)"  }, // amber
  { dot: "#1F8F5F", name: "#0F5639", word: "rgba(31,143,95,0.30)"   }, // emerald
  { dot: "#3F73D6", name: "#1E4596", word: "rgba(63,115,214,0.28)"  }, // blue
  { dot: "#C84874", name: "#8A2348", word: "rgba(200,72,116,0.28)"  }, // rose
  { dot: "#8453D6", name: "#4F2598", word: "rgba(132,83,214,0.28)"  }, // violet
];
const _accentMap = {};
const _sideMap = {};
let _accentIdx = 0;
let _sideIdx = 0;
function getAccent(name) {
  if (!_accentMap[name]) {
    _accentMap[name] = SPEAKER_ACCENTS[_accentIdx % SPEAKER_ACCENTS.length];
    _accentIdx++;
  }
  return _accentMap[name];
}
function getSide(name) {
  if (!_sideMap[name]) {
    _sideMap[name] = _sideIdx % 2 === 0 ? "left" : "right";
    _sideIdx++;
  }
  return _sideMap[name];
}

function initials(label) {
  const c = String(label || "").replace(/[^A-Za-z0-9 ]/g, "").trim();
  if (!c) return "?";
  const p = c.split(/\s+/);
  return p.length === 1 ? p[0][0].toUpperCase() : (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

/* ═══════════════════════════════════════════════════════════════════════════ */
const DialogTurn = memo(function DialogTurn({
  speaker, text, audio,
  emotion, start, end, wordTimestamps, speakerConfig,
}) {
  const label     = String(speaker || "").trim() || "Narrator";
  const accent    = getAccent(label);
  const side      = getSide(label);
  const audioUrl  = audio ? normalizeMediaUrl(audio) : "";
  const bookAudio = useBookAudio();
  const rootRef   = useRef(null);

  const hasTS    = typeof start === "number" && typeof end === "number";
  const isActive = useIsActive(bookAudio, start, end, hasTS);

  /* Smart scroll-follow: only when activation flips on, only if off-screen */
  const wasActive = useRef(false);
  useEffect(() => {
    if (!isActive || !rootRef.current) return;
    if (wasActive.current) return;
    wasActive.current = true;
    if (!bookAudio?.playing) return;
    const el = rootRef.current;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || 800;
    const margin = vh * 0.18;
    const offScreen = r.top < margin || r.bottom > vh - margin;
    if (!offScreen) return;
    const t = setTimeout(() => {
      try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch {}
    }, 50);
    return () => clearTimeout(t);
  }, [isActive, bookAudio?.playing]);
  useEffect(() => { if (!isActive) wasActive.current = false; }, [isActive]);

  const dotColor  = speakerConfig?.color || accent.dot;
  const nameColor = speakerConfig?.color || accent.name;

  return (
    <div
      ref={rootRef}
      className={`sp-line sp-line--${side} ${isActive ? "sp-line--active" : "sp-line--idle"}`}
      data-speaker={label}
      data-side={side}
      data-active={isActive ? "true" : "false"}
      data-testid="dialog-turn-sp"
      style={{
        "--sp-dot":   dotColor,
        "--sp-name":  nameColor,
        "--sp-word":  accent.word,
      }}
    >
      {/* Avatar */}
      <div className="sp-avatar" aria-hidden="true">
        <span className="sp-avatar__initials">{initials(label)}</span>
        {isActive && (
          <span className="sp-wave" aria-hidden="true">
            <i /><i /><i /><i />
          </span>
        )}
      </div>

      {/* Bubble */}
      <div className="sp-bubble">
        <div className="sp-speaker">
          <span className="sp-name">{label}</span>
          {isActive && <span className="sp-now" aria-label="now speaking">●</span>}
        </div>

        {hasTS && Array.isArray(wordTimestamps) && wordTimestamps.length > 0 && bookAudio ? (
          <WordSync
            text={text}
            wordTimestamps={wordTimestamps}
            currentTime={bookAudio.currentTime}
            playing={bookAudio.playing}
            playToken={bookAudio.playToken}
            src={bookAudio.src}
            start={start}
            end={end}
          />
        ) : (
          <p className="sp-text">{text}</p>
        )}

        {audioUrl && <LegacyAudioBtn src={audioUrl} label={label} />}
      </div>
    </div>
  );
});

export default DialogTurn;

/* ─── Active detection ───────────────────────────────────────────────────── */
function useIsActive(bookAudio, start, end, hasTS) {
  if (!bookAudio || !hasTS) return false;
  const t = bookAudio.currentTime;
  if (!bookAudio.playing && t === 0) return false;
  return t >= start - 0.08 && t <= end + 0.08;
}

/* ─── Word sync (unchanged logic) ────────────────────────────────────────── */
// Issue 5 fix — the linear-scan index computation, extracted so a lazy
// useState initializer can reuse it. Every page turn remounts DialogTurn
// fresh while audio keeps playing across the transition (protected), so
// without this the highlight flashed "nothing highlighted" for one frame
// on every page turn — same bug as ChapterBlocks' TranscriptParagraph
// (see computeWeightedActiveWord/computeTimestampActiveWord there).
// The effect below is left untouched: its epRef/srRef change-detection
// bookkeeping only matters across subsequent renders, not for the very
// first paint, and refactoring it carried more risk than this small
// duplication for a protected component.
export function computeWordSyncActiveWord({ currentTime, playing, start, end, wordTimestamps, wordsLength }) {
  if (!playing && currentTime === 0) return -1;
  const s = Number.isFinite(start) ? start : 0;
  const e = Number.isFinite(end)   ? end   : 0;
  if (currentTime < s - 0.08) return -1;
  if (currentTime >= e) return wordsLength - 1;
  let idx = -1;
  for (let i = 0; i < wordTimestamps.length; i++) {
    const ws = Number(wordTimestamps[i].start), we = Number(wordTimestamps[i].end);
    if (Number.isFinite(ws) && Number.isFinite(we) && currentTime >= ws && currentTime <= we) { idx = i; break; }
    if (Number.isFinite(we) && we < currentTime) idx = i;
    if (Number.isFinite(ws) && ws > currentTime) break;
  }
  return Math.max(-1, Math.min(wordsLength - 1, idx));
}

function WordSync({ text, wordTimestamps, currentTime, playing, playToken, src, start, end }) {
  const refs = useRef([]);

  const words = useMemo(() => {
    const out = []; const re = /\S+\s*/g; let m;
    while ((m = re.exec(String(text || ""))) !== null) out.push(m[0]);
    return out;
  }, [text]);

  const [active, set] = useState(() =>
    computeWordSyncActiveWord({
      currentTime, playing, start, end, wordTimestamps, wordsLength: words.length,
    })
  );
  const aRef  = useRef(active);
  const epRef = useRef(playToken || 0);
  const srRef = useRef(src);

  if (refs.current.length > words.length) refs.current.length = words.length;

  useEffect(() => {
    const commit = (i) => { if (aRef.current !== i) { aRef.current = i; set(i); } };
    const ep = playToken || 0;
    if (ep !== epRef.current) { epRef.current = ep; commit(-1); }
    if (src !== srRef.current) { srRef.current = src; commit(-1); }
    if (!playing && currentTime === 0) { commit(-1); return; }
    const s = Number.isFinite(start) ? start : 0;
    const e = Number.isFinite(end)   ? end   : 0;
    if (currentTime < s - 0.08) { commit(-1); return; }
    if (currentTime >= e) { commit(words.length - 1); return; }
    let idx = -1;
    for (let i = 0; i < wordTimestamps.length; i++) {
      const ws = Number(wordTimestamps[i].start), we = Number(wordTimestamps[i].end);
      if (Number.isFinite(ws) && Number.isFinite(we) && currentTime >= ws && currentTime <= we) { idx = i; break; }
      if (Number.isFinite(we) && we < currentTime) idx = i;
      if (Number.isFinite(ws) && ws > currentTime) break;
    }
    commit(Math.max(-1, Math.min(words.length - 1, idx)));
  }, [currentTime, playing, playToken, src, start, end, wordTimestamps, words.length]);

  return (
    <p className="sp-text" data-synced="true">
      {words.map((w, i) => (
        <span key={i} ref={el => refs.current[i] = el}
          className="sp-word"
          data-state={i < active ? "past" : i === active ? "now" : "future"}>
          {w}
        </span>
      ))}
    </p>
  );
}

/* ─── Legacy per-line audio button ───────────────────────────────────────── */
function LegacyAudioBtn({ src, label }) {
  const audio = useBookAudio();
  if (!audio) return null;
  const playing = audio.src === src && audio.playing;
  return (
    <button type="button" className="sp-legacy-audio"
      data-active={playing ? "true" : "false"}
      aria-label={playing ? "Pause" : "Play"}
      data-testid="dialog-turn-audio"
      onClick={() => {
        if (!src) return;
        if (audio.src !== src) { audio.setSrc(src, { title: label }); setTimeout(() => audio.play(), 0); }
        else audio.toggle();
      }}>
      <span>{playing ? "⏸" : "▶"} {playing ? "Playing" : "Listen"}</span>
    </button>
  );
}
