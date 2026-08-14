import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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

function saveProgressEntry(url, t, duration) {
  if (!url || !Number.isFinite(t) || t < 1) return;
  try {
    const map = loadProgressMap();
    // v9.7 — persist the track's real duration alongside elapsed time so
    // consumers (Dashboard's Continue Learning shelf) can show a genuine
    // "% listened" instead of just elapsed seconds. Omitted when the
    // element hasn't resolved a finite duration yet — never guessed.
    map[url] = Number.isFinite(duration) && duration > 0
      ? { t, duration, ts: Date.now() }
      : { t, ts: Date.now() };
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
  // `lastVolume` remembers the volume before a mute so unmute can restore it.
  const lastVolumeRef = useRef(loadVolume() || 0.9);

  /** Lazily attach a hidden <audio> element on mount. */
  useEffect(() => {
    const el = document.createElement("audio");
    el.preload = "auto";  // v9.7: "auto" prevents iOS 50s drop on long MP3s
    // v9.4 (R2 audio support patch) — Do NOT set `crossOrigin="anonymous"`.
    //
    // Setting `crossOrigin` forces the browser to perform a CORS-mode fetch
    // for the audio resource. Cloudflare R2 public buckets (pub-*.r2.dev)
    // do not return `Access-Control-Allow-Origin` headers unless explicitly
    // configured on the bucket, so a CORS-mode <audio> request fails with
    // a network error on Chrome, Firefox, Safari and every iOS/Android PWA.
    //
    // Plain <audio> playback for cross-origin streams does NOT require
    // `crossOrigin`; only Web Audio API graphs (`createMediaElementSource`),
    // `<canvas>` draws of <video> frames, or `captureStream()` need the
    // attribute. This engine performs none of those operations, so the
    // attribute is unnecessary and only harms compatibility with R2 (and
    // any other origin that doesn't ship CORS headers).
    //
    // After this change, Dropbox / YouTube / direct video URLs continue to
    // work exactly as before, AND Cloudflare R2 public `.mp3` / `.wav`
    // URLs now stream successfully on every supported platform.
    el.setAttribute("data-testid", "book-audio-engine");
    el.style.display = "none";
    document.body.appendChild(el);
    audioRef.current = el;

    // Apply initial speed & volume immediately.
    try {
      el.playbackRate = loadSpeed();
      el.volume = loadVolume();
    } catch {
      /* ignore */
    }

    // v7.7 — persist audio progress every ~3s so the student can resume
    // where they left off the next time they open the same track.
    let lastSavedAt = 0;
    const onTime = () => {
      setCurrentTime(el.currentTime || 0);
      const now = Date.now();
      if (now - lastSavedAt > 3000 && el.src) {
        lastSavedAt = now;
        saveProgressEntry(el.src, el.currentTime, el.duration);
      }
    };
    // When metadata loads for a freshly-assigned src, seek to the saved
    // position (if any) so playback resumes where the student left off.
    const onMeta = () => {
      const d = el.duration || 0;
      // Guard against Infinity (iOS Safari streaming) — only set finite durations
      setDuration(Number.isFinite(d) && d > 0 ? d : 0);
      const saved = readProgress(el.src);
      // Only restore when we're near the start (don't override user seeks).
      if (saved > 1 && el.currentTime < 0.5 && d > 0 && saved < d - 2) {
        try { el.currentTime = saved; } catch { /* ignore */ }
      }
    };
    const onPlay = () => { setPlaying(true); setBuffering(false); };
    const onPause = () => {
      setPlaying(false);
      // Save on pause too, not just on the 3s tick.
      if (el.src) saveProgressEntry(el.src, el.currentTime, el.duration);
    };
    // v9.5 — Transcript replay-sync fix.
    //
    // Previously this handler set React `currentTime` to 0 with the (wrong)
    // comment "sync React state to the 0 the element will seek to on replay".
    // HTML5 <audio> does NOT auto-rewind on the `ended` event — only `loop`
    // does. The element's currentTime stays pinned at `duration` until the
    // next `play()` call, at which point the browser implicitly rewinds. The
    // implicit rewind emits events in a racey order (a final `timeupdate`
    // can fire with t≈duration AFTER `play` but BEFORE `seeked` lands at 0),
    // and during that window the React `currentTime` flips back to ~duration
    // for one frame, which makes every transcript paragraph whose [start,end]
    // window lies before that t jump to `active = words.length - 1` (fully
    // highlighted) — i.e. the visible "flash / desync / mismatch" the
    // student sees on replay.
    //
    // Fix: explicitly seek the element to 0 here, so the DOM state and the
    // React state are coherent BEFORE any subsequent play() call. Any
    // resulting `seeked`/`timeupdate` emits cleanly with t=0, so transcript
    // paragraphs reset their `active` index correctly and the next playback
    // starts from a known-good origin.
    const onEnded = () => {
      try {
        // Seek the live element to 0 so DOM === React state. Guarded because
        // some browsers throw on currentTime writes when readyState is too
        // low; that's fine — the subsequent play() will still rewind.
        if (el && Number.isFinite(el.duration)) {
          el.currentTime = 0;
        }
      } catch {
        /* ignore — play() will rewind implicitly */
      }
      setPlaying(false);
      setCurrentTime(0);
      // Note: not calling saveProgressEntry(url, 0) here — the helper guards
      // values < 1 anyway, and any pre-existing near-end entry is harmless
      // because readProgress() refuses to resume within 2s of duration.
    };
    const onError = () => {
      setError(el.error?.code || "load failed");
      setBuffering(false);
    };
    const onWaiting = () => setBuffering(true);
    const onPlaying = () => { setBuffering(false); setPlaying(true); };
    const onCanPlay = () => setBuffering(false);
    const onLoadStart = () => setError(null);

    // v9.7: iOS PWA audio session recovery.
    // iOS suspends audio output after ~50s on long tracks when the PWA
    // loses foreground focus or the screen dims. onSuspend fires when the
    // browser stops delivering audio data. We attempt a silent play()
    // recovery — if it succeeds, playback continues from where it paused;
    // if it fails (user-gesture required), the UI shows the paused state.
    const onSuspend = () => {
      if (el.paused) return; // user-paused: don't auto-resume
      if (!el.src) return;
      setTimeout(async () => {
        if (el.paused && el.src && !el.ended) {
          try { await el.play(); } catch { /* needs user gesture */ }
        }
      }, 300);
    };
    el.addEventListener("suspend", onSuspend);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("durationchange", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    el.addEventListener("waiting", onWaiting);
    el.addEventListener("canplay", onCanPlay);
    el.addEventListener("loadstart", onLoadStart);

    return () => {
      el.pause();
      el.removeEventListener("suspend", onSuspend);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("durationchange", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
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
      try { el.volume = volume; } catch { /* ignore */ }
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
    el.src = url;
    setSrcState(url);
    setMeta(m || null);
    setDuration(0);
    setCurrentTime(0);
  }, []);

  const play = useCallback(async () => {
    const el = audioRef.current;
    if (!el || !el.src) return;
    // v9.5 — Replay-sync hardening. If the element finished a prior playback,
    // explicitly rewind before play(). Spec says play() on an ended element
    // implicitly seeks to 0, but the event ordering around that implicit
    // seek (timeupdate / play / seeking / seeked) is browser-dependent and
    // causes transcript desync on the first frame of replay. Forcing the
    // seek here makes the very first `timeupdate` after play() land at t≈0,
    // which is what the TranscriptParagraph effect expects.
    try {
      const dur = Number.isFinite(el.duration) ? el.duration : 0;
      if (dur > 0 && el.currentTime >= dur - 0.05) {
        el.currentTime = 0;
        setCurrentTime(0);
      }
    } catch { /* ignore — fall back to implicit rewind */ }
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
      // v9.5 — same explicit-rewind hardening as play(). Most replay paths
      // come through here (mini-player button, in-chapter AudioBlock button)
      // so this is the critical site for the transcript replay sync fix.
      try {
        const dur = Number.isFinite(el.duration) ? el.duration : 0;
        if (dur > 0 && el.currentTime >= dur - 0.05) {
          el.currentTime = 0;
          setCurrentTime(0);
        }
      } catch { /* ignore */ }
      try { await el.play(); } catch { /* user-gesture required */ }
    } else {
      el.pause();
    }
  }, []);

  const seek = useCallback((t) => {
    const el = audioRef.current;
    if (!el) return;
    if (typeof t === "number" && Number.isFinite(t)) {
      el.currentTime = Math.max(0, Math.min(el.duration || t, t));
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
      // v9.5 — after load(), currentTime is 0 by spec, so no extra rewind
      // is required here. Reset React state to match in case any stale
      // timeupdate fired with the pre-error timestamp.
      setCurrentTime(0);
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
      speed, volume,
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
