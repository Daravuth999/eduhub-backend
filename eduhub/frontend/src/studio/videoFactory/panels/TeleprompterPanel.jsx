/**
 * TeleprompterPanel.jsx — Teleprompter Configuration stage. The author
 * tunes the exact settings students receive (saved onto the lesson as
 * teleprompterConfig) with a LIVE preview driven by the real media and the
 * real synchronization document — the same shared Teleprompter component
 * students use, so preview is genuinely what ships.
 */
import { useEffect, useRef, useState } from "react";
import { Save, Loader2, MonitorPlay, AlertTriangle } from "lucide-react";
import { updateLesson, getSyncAdmin, resolveMediaSrc } from "../videoLibraryApi";
import Teleprompter from "../../../eduhub/components/teleprompter/Teleprompter";
import TeleprompterSettings from "../../../eduhub/components/teleprompter/TeleprompterSettings";
import { mergeTeleprompterConfig } from "../../../eduhub/components/teleprompter/teleprompterConfig";
import { describeMediaError, STALL_THRESHOLD_MS } from "../../../eduhub/lib/mediaDiagnostics";

export default function TeleprompterPanel({ lesson, onChanged }) {
  const mediaRef = useRef(null);
  const [config, setConfig] = useState(() => mergeTeleprompterConfig(lesson.teleprompterConfig));
  const [sync, setSync] = useState(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [err, setErr] = useState(null);
  // Honest playback diagnostics for the preview media — never a fake
  // "ready" state while the browser is actually stuck. `mediaIssue` is
  // null (healthy), {kind:"error", message} for a real MediaError, or
  // {kind:"stall", message} once "waiting" has persisted past
  // STALL_THRESHOLD_MS without a canplay/playing event (root-caused: an
  // MP4 without -movflags +faststart forces the browser to fetch the
  // whole file before duration/seek metadata resolves, which reads to the
  // admin as an indefinite loading spinner with zero explanation).
  const [mediaIssue, setMediaIssue] = useState(null);
  const stallTimerRef = useRef(null);

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
  const handleMediaWaiting = () => {
    clearStallTimer();
    stallTimerRef.current = setTimeout(() => {
      setMediaIssue({
        kind: "stall",
        message: "This media is taking unusually long to buffer. This can happen with large "
          + "video files — try reloading, or check that the file finished uploading.",
      });
    }, STALL_THRESHOLD_MS);
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
  // A fresh upload/mediaRef should never inherit a stale diagnostic from
  // whatever was previously loaded in this same preview element.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { handleMediaLoadStart(); }, [lesson.mediaRef]);

  useEffect(() => {
    let alive = true;
    if (lesson.syncId) {
      getSyncAdmin(lesson.syncId).then((doc) => { if (alive) setSync(doc); }).catch(() => {});
    }
    return () => { alive = false; };
  }, [lesson.syncId]);

  // The preview keeps native <video controls> (the author wants a familiar
  // scrub bar while tuning teleprompter settings), but the native fullscreen
  // affordance inside those controls previously let the video escape into
  // an OS-level fullscreen presentation, hiding the transcript/settings the
  // author needs to watch simultaneously. `playsInline` + `controlsList`
  // suppress the affordance itself; this listener is a cross-browser
  // backstop that immediately exits if any vendor path (Safari's
  // webkitbeginfullscreen, a keyboard shortcut, etc.) still triggers it —
  // scoped to this one preview element, not a global fullscreen ban.
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return undefined;
    const forceExit = () => {
      if (document.fullscreenElement === el) document.exitFullscreen?.().catch(() => {});
      if (el.webkitDisplayingFullscreen) el.webkitExitFullscreen?.();
    };
    document.addEventListener("fullscreenchange", forceExit);
    el.addEventListener("webkitbeginfullscreen", forceExit);
    return () => {
      document.removeEventListener("fullscreenchange", forceExit);
      el.removeEventListener("webkitbeginfullscreen", forceExit);
    };
  }, [lesson.mediaRef]);

  const handleSave = async () => {
    setErr(null);
    setSaving(true);
    try {
      await updateLesson(lesson.lessonId, { teleprompterConfig: config });
      setSavedAt(Date.now());
      onChanged();
    } catch (e) {
      setErr(e.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const isVideo = (lesson.contentType || "").startsWith("video/");

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4" data-testid="production-teleprompter-panel">
      <div className="space-y-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-faded flex items-center gap-1.5">
          <MonitorPlay size={11} className="text-amber-300" /> Student experience defaults
        </div>
        <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-white">
          <TeleprompterSettings config={config} onChange={setConfig}
                                onReset={(d) => setConfig(d)} showModeControls />
        </div>
        <button onClick={handleSave} disabled={saving}
                data-testid="teleprompter-save-button"
                className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-500/90 hover:bg-amber-500 text-black text-sm font-semibold px-4 py-2 disabled:opacity-50">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save teleprompter settings
        </button>
        {savedAt && !saving && <div className="text-[11px] text-emerald-300 text-center">Saved — students now receive these defaults ✓</div>}
        {err && <div className="text-xs text-red-400" data-testid="teleprompter-error">{err}</div>}
        <p className="text-[10.5px] text-faded leading-relaxed">
          Students may still adjust personal reading preferences (font size, spacing, scroll) locally on their own devices.
        </p>
      </div>

      {/* Root cause of the reported "video moves while reading" bug: this
          card previously had only a min-height (a floor, not a ceiling), so
          .tp-viewport's overflow-y-auto never had anything to actually
          overflow — the whole panel (and the ProductionStudio stage-content
          area above it) grew instead, dragging the video out of view when
          the admin scrolled to keep up with the transcript. The max-height
          here reuses the exact vh/calc(100vh-Npx) ceiling pattern already
          proven correct in VideoLessonPlayer.jsx's side panel, so
          useAutoFollow.js's existing internal-scroll math (unchanged) has a
          real clientHeight/scrollHeight gap to work with. */}
      <div className="rounded-xl border border-white/10 bg-black/40 overflow-hidden flex flex-col min-h-[380px] max-h-[65vh] lg:max-h-[calc(100vh-160px)]">
        {lesson.mediaRef ? (
          <>
            <div className="flex-shrink-0 bg-black">
              {isVideo ? (
                <video ref={mediaRef} src={resolveMediaSrc(lesson.mediaRef)} controls
                       playsInline
                       webkit-playsinline="true"
                       controlsList="nofullscreen noremoteplayback"
                       disablePictureInPicture
                       className="w-full max-h-[220px]"
                       onTimeUpdate={() => setCurrentTime(mediaRef.current?.currentTime || 0)}
                       onLoadStart={handleMediaLoadStart}
                       onWaiting={handleMediaWaiting}
                       onCanPlay={handleMediaRecovered}
                       onPlaying={handleMediaRecovered}
                       onError={handleMediaError}
                       data-testid="teleprompter-preview-media" />
              ) : (
                <audio ref={mediaRef} src={resolveMediaSrc(lesson.mediaRef)} controls className="w-full px-3 py-3"
                       onTimeUpdate={() => setCurrentTime(mediaRef.current?.currentTime || 0)}
                       onLoadStart={handleMediaLoadStart}
                       onWaiting={handleMediaWaiting}
                       onCanPlay={handleMediaRecovered}
                       onPlaying={handleMediaRecovered}
                       onError={handleMediaError}
                       data-testid="teleprompter-preview-media" />
              )}
              {mediaIssue && (
                <div className={`flex items-start gap-1.5 px-3 py-2 text-[11px] ${mediaIssue.kind === "error" ? "bg-red-500/10 text-red-300" : "bg-amber-500/10 text-amber-200"}`}
                     data-testid="teleprompter-media-issue">
                  <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                  <span>{mediaIssue.message}</span>
                </div>
              )}
            </div>
            {/* Second, deeper part of the same containment bug, found via
                real-browser verification (not visible in jsdom): a flex
                container sized only by min/max-height (no explicit height —
                exactly the card above) does not propagate a "definite"
                height through a `height: 100%` child two levels down in
                Chromium, even though the intermediate flex item's own
                rendered box is correctly clamped. `className="h-full"`
                therefore silently resolved to the CONTENT height (thousands
                of px for a long transcript), so .tp-viewport never had a
                clientHeight/scrollHeight gap to scroll within — the exact
                same symptom as the missing max-height, one layer deeper.
                Fixed by giving Teleprompter's root a real flex-item size
                (`flex-1 min-h-0`, verified in a live Chromium harness to
                propagate correctly) instead of a percentage height, and
                making this wrapper `flex flex-col` so that sizing has a
                flex context to resolve against — the exact same pattern
                VideoLessonPlayer.jsx's side panel already uses correctly. */}
            <div className="flex-1 min-h-0 flex flex-col text-white" data-testid="teleprompter-live-preview">
              <Teleprompter sync={sync} currentTime={currentTime} config={config}
                            onSeek={(t) => { if (mediaRef.current) mediaRef.current.currentTime = t; }}
                            className="flex-1 min-h-0" />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-[12px] text-faded p-8 text-center">
            Upload media and run Gemini processing first — the live preview uses the real synchronized transcript.
          </div>
        )}
      </div>
    </div>
  );
}
