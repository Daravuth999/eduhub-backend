import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  Pause,
  Play,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

/**
 * BookAudioContext — exposes a single, page-survival audio element to the
 * whole reader. Only ONE audio element exists for the entire session,
 * mounted at the reader root, so chapter navigation never interrupts
 * playback. Chapter blocks register/control playback through this hook
 * instead of mounting their own <audio>.
 *
 * v7.6 additions:
 *   • Playback speed control (0.75x / 1x / 1.25x / 1.5x) — persisted in
 *     localStorage under "eduhub_reader_speed".
 *   • Volume control (0.0–1.0) with mute toggle — persisted in
 *     localStorage under "eduhub_reader_volume".
 *   • Buffering (waiting / canplay) + error states surfaced through
 *     context so both the mini player and in-chapter blocks can show
 *     a spinner or retry button.
 */
const BookAudioContext = createContext(null);

export const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5];
const SPEED_KEY = "eduhub_reader_speed";
const VOLUME_KEY = "eduhub_reader_volume";
// v7.7: per-track resume position ({ [url]: { t: seconds, ts: epochMs } }).
// Kept small by trimming to the most recent 30 tracks.
const PROGRESS_KEY = "eduhub_reader_audio_progress";
const PROGRESS_MAX = 30;

function loadProgressMap() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveProgressEntry(url, t) {
  if (!url || !Number.isFinite(t) || t < 1) return;
  try {
    const map = loadProgressMap();
    map[url] = { t, ts: Date.now() };
    // Trim to the most-recent PROGRESS_MAX tracks.
    const entries = Object.entries(map)
      .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))
      .slice(0, PROGRESS_MAX);
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* ignore quota */
  }
}

function readProgress(url) {
  if (!url) return 0;
  const map = loadProgressMap();
  const v = map[url];
  const t = Number(v?.t);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

function loadSpeed() {
  try {
    const raw = localStorage.getItem(SPEED_KEY);
    const n = Number(raw);
    if (SPEED_OPTIONS.includes(n)) return n;
  } catch {
    /* ignore */
  }
  return 1;
}

function loadVolume() {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw == null) return 0.9;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  } catch {
    /* ignore */
  }
  return 0.9;
}

export function useBookAudio() {
  const ctx = useContext(BookAudioContext);
  if (!ctx) {
    // Soft-fall-through so blocks render even outside a provider (no audio).
    return null;
  }
  return ctx;
}

export function BookAudioProvider({ children }) {
  const audioRef = useRef(null);
  const [src, setSrcState] = useState(null);          // currently loaded URL
  const [meta, setMeta] = useState(null);             // {title, source-block info}
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(null);
  const [buffering, setBuffering] = useState(false);
  const [speed, setSpeedState] = useState(() => loadSpeed());
  const [volume, setVolumeState] = useState(() => loadVolume());
  // v9.5 — Monotonic epoch that bumps on every fresh playback start
  // (play from t≈0, including replay after `ended`). TranscriptParagraph
  // uses this to hard-reset its highlight on every replay so blocks
  // downstream of the playhead don't linger on "all-past" highlight.
  const [playToken, setPlayToken] = useState(0);
  // `lastVolume` remembers the volume before a mute so unmute can restore it.
  const lastVolumeRef = useRef(loadVolume() || 0.9);
  // v9.6 FIX A — track in-flight seeks so the timeupdate stream cannot
  // overwrite the user's just-issued seek before the browser confirms it.
  // While `seekingRef.current` is true, we IGNORE timeupdate events. This
  // is what makes "swipe to end → audio jumps back to start" go away.
  const seekingRef = useRef(false);
  // v9.6 FIX A — also track the most recent userissued seek target so we
  // can echo it into React state immediately (UI never lags the gesture)
  // and so the `seeked` handler can confirm we landed where requested.
  const pendingSeekRef = useRef(null);
  // v9.6 FIX D — remember the chapter/track URL the user just opened. On
  // chapter change we reset `playToken` so TranscriptParagraph hard-resets
  // its highlight against the NEW transcript window even when the same
  // physical audio keeps playing.
  // (Set externally via setSrc — internal-only ref kept for parity.)

  /** Lazily attach a hidden <audio> element on mount. */
  useEffect(() => {
    const el = document.createElement("audio");
    el.preload = "metadata";
    // v9.6 FIX E — DO NOT set crossOrigin="anonymous" on the persistent
    // engine. Many CDNs the reader pulls from (Dropbox, Google Drive,
    // backend-signed R2 URLs) do not return permissive CORS headers, and
    // setting crossOrigin on the audio element silently aborts the load
    // → duration never arrives → slider stuck at 0.001 → seek is broken.
    // We never read pixel data or feed the element into WebAudio with a
    // ScriptProcessor / analyser node, so we don't need CORS-tainted
    // streaming. Leaving crossOrigin unset uses the browser's normal
    // media-fetch path (Range requests, progressive download), which is
    // exactly what we want for long AI-narration chapters.
    el.setAttribute("data-testid", "book-audio-engine");
    // v9.6 — playsInline matters for iOS Safari / iPhone PWA so the OS
    // doesn't pull a full-screen native player over the reader.
    el.setAttribute("playsinline", "");
    el.setAttribute("webkit-playsinline", "");
    el.style.display = "none";
    document.body.appendChild(el);
    audioRef.current = el;

    // Apply initial speed & volume immediately.
    try {
      el.playbackRate = loadSpeed();
      const v0 = loadVolume();
      el.volume = v0;
      // v9.6 FIX C — set `muted` too (iOS Safari ignores `.volume`).
      el.muted = v0 === 0;
    } catch {
      /* ignore */
    }

    // v7.7 — persist audio progress every ~3s so the student can resume
    // where they left off the next time they open the same track.
    let lastSavedAt = 0;
    const onTime = () => {
      // v9.6 FIX A — while a user-issued seek is in flight, the browser
      // still emits one or two trailing `timeupdate` events from the OLD
      // playhead before it lands at the new target. Honoring those events
      // is exactly what made the slider snap back to the start after a
      // swipe-to-end. Suppress until `seeked` fires.
      if (seekingRef.current) return;
      setCurrentTime(el.currentTime || 0);
      const now = Date.now();
      if (now - lastSavedAt > 3000 && el.src) {
        lastSavedAt = now;
        saveProgressEntry(el.src, el.currentTime);
      }
    };
    // When metadata loads for a freshly-assigned src, seek to the saved
    // position (if any) so playback resumes where the student left off.
    const onMeta = () => {
      const d = Number.isFinite(el.duration) ? el.duration : 0;
      // v9.6 FIX B — only commit duration when it's a real positive number.
      // iOS Safari briefly reports `Infinity` for streamed/Range-served
      // audio before the final byte-range lands; honoring that polluted
      // React state with NaN/Infinity, which is what made the mini-player
      // show "2:51 / 0:00" or worse.
      if (d > 0 && Number.isFinite(d)) setDuration(d);
      const saved = readProgress(el.src);
      // Only restore when we're near the start (don't override user seeks).
      if (saved > 1 && el.currentTime < 0.5 && d > 0 && saved < d - 2) {
        try { el.currentTime = saved; } catch { /* ignore */ }
      }
    };
    const onPlay = () => {
      setPlaying(true);
      setBuffering(false);
      // v9.5 FIX A — sync state currentTime from el IMMEDIATELY. After
      // `ended` + replay, the browser auto-rewinds el.currentTime to 0
      // inside play() but the next `timeupdate` event can lag 50–250 ms
      // on iOS PWA. Reading it here closes the gap so TranscriptParagraph
      // never sees the stale "duration" value at the moment `playing`
      // flips true → no freeze on last word.
      const t = el.currentTime || 0;
      setCurrentTime(t);
      // v9.5 FIX C — bump play epoch on a fresh-from-start play (incl.
      // replay after `ended`). Transcript blocks reset on this signal.
      if (t < 0.5) {
        setPlayToken((n) => n + 1);
      }
    };
    const onPause = () => {
      setPlaying(false);
      // Save on pause too, not just on the 3s tick.
      if (el.src) saveProgressEntry(el.src, el.currentTime);
    };
    const onEnded = () => setPlaying(false);
    const onError = () => {
      setError(el.error?.code || "load failed");
      setBuffering(false);
    };
    const onWaiting = () => setBuffering(true);
    const onPlaying = () => {
      setBuffering(false);
      setPlaying(true);
      // Mirror onPlay sync — `playing` event fires after buffering on
      // some browsers without `play` re-firing, so keep state honest.
      setCurrentTime(el.currentTime || 0);
    };
    const onCanPlay = () => setBuffering(false);
    const onLoadStart = () => setError(null);
    // v9.6 FIX A — `seeking` fires when the browser begins moving the
    // playhead in response to a `currentTime` assignment. Set the gate
    // here so the next few `timeupdate` events (which still carry the
    // OLD playhead position on some engines) are ignored.
    const onSeeking = () => {
      seekingRef.current = true;
      // Optimistically reflect the requested target in React state so the
      // slider doesn't snap backwards for one frame.
      if (pendingSeekRef.current != null) {
        setCurrentTime(pendingSeekRef.current);
      }
    };
    // v9.5 FIX E — `seeked` (and `seeking`) flush state so scrubbing
    // or programmatic seek doesn't leave transcript briefly desynced.
    // v9.6 — also clear the in-flight gate so normal timeupdate resumes.
    const onSeeked = () => {
      seekingRef.current = false;
      pendingSeekRef.current = null;
      setCurrentTime(el.currentTime || 0);
    };

    // v9.6 FIX B — `durationchange` is the most reliable signal across
    // browsers for finalising duration on streamed audio. iOS Safari can
    // emit it AFTER `loadedmetadata` once the full Content-Length lands.
    const onDurationChange = () => {
      const d = Number.isFinite(el.duration) ? el.duration : 0;
      if (d > 0) setDuration(d);
    };

    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("durationchange", onDurationChange);
    el.addEventListener("play", onPlay);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("seeking", onSeeking);
    el.addEventListener("seeked", onSeeked);
    el.addEventListener("error", onError);
    el.addEventListener("waiting", onWaiting);
    el.addEventListener("canplay", onCanPlay);
    el.addEventListener("loadstart", onLoadStart);

    return () => {
      el.pause();
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("durationchange", onDurationChange);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("seeking", onSeeking);
      el.removeEventListener("seeked", onSeeked);
      el.removeEventListener("error", onError);
      el.removeEventListener("waiting", onWaiting);
      el.removeEventListener("canplay", onCanPlay);
      el.removeEventListener("loadstart", onLoadStart);
      el.remove();
      audioRef.current = null;
    };
  }, []);

  /** Keep playbackRate in sync with state + persist. */
  useEffect(() => {
    const el = audioRef.current;
    if (el) {
      try { el.playbackRate = speed; } catch { /* ignore */ }
    }
    try { localStorage.setItem(SPEED_KEY, String(speed)); } catch { /* ignore */ }
  }, [speed]);

  /** Keep volume in sync with state + persist. */
  useEffect(() => {
    const el = audioRef.current;
    if (el) {
      try {
        // v9.6 FIX C — On iOS Safari (Mobile Safari + iPhone PWA), the
        // `volume` property is read-only — assigning to it is a silent
        // no-op. The ONLY way to mute on iOS is `audio.muted = true`.
        // Setting both works everywhere: desktop honors `.volume`, iOS
        // honors `.muted`, and the two together also give the correct
        // behaviour on Android Chrome (which honors both).
        el.volume = volume;
        el.muted = volume === 0;
      } catch { /* ignore */ }
    }
    try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* ignore */ }
  }, [volume]);

  /** Set the source. No-op if same URL — preserves playback across pages. */
  const setSrc = useCallback((url, m) => {
    if (!url) return;
    const el = audioRef.current;
    if (!el) return;
    if (el.src === url) {
      // Same track — leave playback untouched, just refresh meta label.
      if (m) setMeta(m);
      return;
    }
    setError(null);
    // v9.6 FIX D — bump playToken on track change so TranscriptParagraph
    // hard-resets its highlight when a new chapter introduces a new audio
    // source. (The replay-after-ended path already bumps; this covers
    // chapter-switch.) Reset the seek gate too in case a seek was mid-
    // flight against the old track.
    seekingRef.current = false;
    pendingSeekRef.current = null;
    el.src = url;
    setSrcState(url);
    setMeta(m || null);
    setDuration(0);
    setCurrentTime(0);
    setPlayToken((n) => n + 1);
  }, []);

  const play = useCallback(async () => {
    const el = audioRef.current;
    if (!el || !el.src) return;
    // v9.5 FIX B — hard-rewind after `ended`. Browsers SHOULD auto-rewind
    // inside play() when currentTime >= duration, but iOS Safari (the PWA
    // target) occasionally keeps currentTime pinned at duration for a few
    // event-loop ticks, which is exactly what made transcript freeze on
    // replay. Setting currentTime=0 synchronously + flushing state here
    // eliminates that race for every browser.
    if (el.ended || (el.duration > 0 && el.currentTime >= el.duration - 0.05)) {
      try { el.currentTime = 0; } catch { /* ignore */ }
      setCurrentTime(0);
    }
    try { await el.play(); } catch { /* user-gesture required */ }
  }, []);

  const pause = useCallback(() => {
    const el = audioRef.current;
    if (el) el.pause();
  }, []);

  const toggle = useCallback(async () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      // v9.5 FIX B — same hard-rewind as play() (covers the very common
      // case where the user taps the mini-player toggle to replay).
      if (el.ended || (el.duration > 0 && el.currentTime >= el.duration - 0.05)) {
        try { el.currentTime = 0; } catch { /* ignore */ }
        setCurrentTime(0);
      }
      try { await el.play(); } catch { /* user-gesture required */ }
    } else {
      el.pause();
    }
  }, []);

  const seek = useCallback((t) => {
    const el = audioRef.current;
    if (!el) return;
    if (typeof t !== "number" || !Number.isFinite(t)) return;
    // v9.6 FIX A — clamp ONLY against a real, finite duration. The old
    // `Math.min(el.duration || t, t)` clamped against `t` itself when
    // duration was 0, which technically returned `t` — but when duration
    // was a stale small value (e.g. duration briefly reset to 0 then
    // re-read at the wrong moment), the clamp silently snapped seek
    // targets near the end of the track to small values. Result: swipe
    // to end → audio jumps to ~0.
    const d = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
    let target = Math.max(0, t);
    if (d != null) target = Math.min(d - 0.05, target);
    // v9.6 FIX A — mark a seek in-flight BEFORE assigning currentTime so
    // the very next timeupdate (which can still carry the pre-seek value
    // on iOS) is suppressed. Optimistically reflect the new playhead in
    // React state so the slider thumb tracks the user's finger, not the
    // browser's old timeupdate position.
    seekingRef.current = true;
    pendingSeekRef.current = target;
    setCurrentTime(target);
    try {
      el.currentTime = target;
    } catch {
      // Some browsers throw INVALID_STATE_ERR before metadata is loaded.
      // Clear the gate so we don't permanently silence timeupdate.
      seekingRef.current = false;
      pendingSeekRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    el.pause();
    el.src = "";
    el.removeAttribute("src");
    el.load();
    setSrcState(null);
    setMeta(null);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setBuffering(false);
    setError(null);
  }, []);

  const cycleSpeed = useCallback(() => {
    setSpeedState((prev) => {
      const i = SPEED_OPTIONS.indexOf(prev);
      const next = SPEED_OPTIONS[(i + 1) % SPEED_OPTIONS.length];
      return next;
    });
  }, []);

  const setSpeed = useCallback((v) => {
    if (SPEED_OPTIONS.includes(v)) setSpeedState(v);
  }, []);

  const setVolume = useCallback((v) => {
    const clamped = Math.max(0, Math.min(1, Number(v) || 0));
    if (clamped > 0) lastVolumeRef.current = clamped;
    setVolumeState(clamped);
  }, []);

  const toggleMute = useCallback(() => {
    setVolumeState((prev) => {
      if (prev > 0) {
        lastVolumeRef.current = prev;
        return 0;
      }
      return lastVolumeRef.current || 0.9;
    });
  }, []);

  const retry = useCallback(async () => {
    const el = audioRef.current;
    if (!el) return;
    setError(null);
    try {
      el.load();
      await el.play();
    } catch {
      /* user-gesture/network — error event will re-populate error state */
    }
  }, []);

  const value = useMemo(
    () => ({
      src,
      meta,
      playing,
      currentTime,
      duration,
      error,
      buffering,
      speed,
      speedOptions: SPEED_OPTIONS,
      volume,
      muted: volume === 0,
      playToken,
      setSrc,
      play,
      pause,
      toggle,
      seek,
      stop,
      cycleSpeed,
      setSpeed,
      setVolume,
      toggleMute,
      retry,
    }),
    [
      src, meta, playing, currentTime, duration, error, buffering,
      speed, volume, playToken,
      setSrc, play, pause, toggle, seek, stop,
      cycleSpeed, setSpeed, setVolume, toggleMute, retry,
    ]
  );

  return (
    <BookAudioContext.Provider value={value}>
      {children}
    </BookAudioContext.Provider>
  );
}

/* ---------------------------------------------------------------- */
/*  Shared pill: cycles playback speed on click                      */
/* ---------------------------------------------------------------- */

export function SpeedPill({ className, testid = "audio-speed-pill" }) {
  const audio = useBookAudio();
  if (!audio) return null;
  const { speed, cycleSpeed } = audio;
  // Display: 1 → "1×", 1.25 → "1.25×", 0.75 → "0.75×"
  const label = `${String(speed).replace(/\.0$/, "")}×`;
  return (
    <button
      type="button"
      className={`audio-speed-pill ${className || ""}`.trim()}
      onClick={cycleSpeed}
      data-testid={testid}
      aria-label={`Playback speed ${label} — tap to change`}
      title={`Playback speed: ${label}`}
    >
      {label}
    </button>
  );
}

/* ---------------------------------------------------------------- */
/*  Persistent floating mini-player — appears whenever any audio is  */
/*  loaded; survives every chapter / page transition.                */
/* ---------------------------------------------------------------- */
export function PersistentMiniPlayer() {
  const ctx = useBookAudio();
  if (!ctx || !ctx.src) return null;
  const {
    meta, playing, currentTime, duration, toggle, seek, stop,
    buffering, error, retry,
    volume, toggleMute, setVolume,
  } = ctx;

  const fmt = (s) => {
    if (!Number.isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, "0")}`;
  };
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const vpct = Math.round((volume || 0) * 100);

  // Priority: error > buffering > play/pause
  const renderIcon = () => {
    if (error) return <AlertTriangle className="h-4 w-4" />;
    if (buffering && !playing) return <span className="audio-spinner" aria-hidden />;
    return playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />;
  };

  return (
    <AnimatePresence>
      <motion.div
        key="mini-player"
        initial={{ y: 80, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 80, opacity: 0 }}
        transition={{ type: "spring", stiffness: 320, damping: 30 }}
        className="book-mini-player"
        data-testid="book-mini-player"
        role="region"
        aria-label="Now playing"
      >
        <button
          type="button"
          className="book-mini-player__btn"
          onClick={error ? retry : toggle}
          data-testid="mini-player-toggle"
          aria-label={
            error ? "Retry loading audio" :
            buffering ? "Buffering…" :
            playing ? "Pause narration" : "Play narration"
          }
        >
          {renderIcon()}
        </button>
        <div className="book-mini-player__body">
          <div className="book-mini-player__meta">
            <span
              className="book-mini-player__live"
              data-active={playing ? "true" : "false"}
            />
            <span className="book-mini-player__title">
              {error ? "Audio failed to load" : (meta?.title || "Audio narration")}
            </span>
            <span className="book-mini-player__time" data-testid="mini-player-time">
              {fmt(currentTime)} / {fmt(duration)}
            </span>
          </div>
          {error ? (
            <div className="audio-error" data-testid="mini-player-error">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>Network error</span>
              <button
                type="button"
                className="audio-error__retry"
                onClick={retry}
                data-testid="mini-player-retry"
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {/* Speed pill — placed to the LEFT of the scrub bar */}
              <SpeedPill testid="mini-player-speed" />
              {/* Volume control — placed right of speed pill, left of scrub */}
              <div className="book-mini-player__volume" data-testid="mini-player-volume">
                <button
                  type="button"
                  className="book-mini-player__volume-btn"
                  onClick={toggleMute}
                  aria-label={volume === 0 ? "Unmute audio" : "Mute audio"}
                  data-testid="mini-player-volume-toggle"
                  title={volume === 0 ? "Unmute" : "Mute"}
                >
                  {volume === 0 ? (
                    <VolumeX className="h-3.5 w-3.5" />
                  ) : (
                    <Volume2 className="h-3.5 w-3.5" />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                  className="book-mini-player__volume-slider"
                  style={{ "--vp": `${vpct}%` }}
                  aria-label="Audio volume"
                  data-testid="mini-player-volume-slider"
                />
              </div>
              <input
                type="range"
                min={0}
                max={Math.max(duration, 0.001)}
                step={0.1}
                value={Math.min(currentTime, duration || 0)}
                onChange={(e) => seek(Number(e.target.value))}
                className="book-mini-player__scrub"
                style={{ "--p": `${pct}%`, flex: "1 1 auto" }}
                aria-label="Scrub audio"
                data-testid="mini-player-scrub"
              />
            </div>
          )}
        </div>
        <button
          type="button"
          className="book-mini-player__close"
          onClick={stop}
          data-testid="mini-player-close"
          aria-label="Stop and close player"
          title="Stop"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </motion.div>
    </AnimatePresence>
  );
}
