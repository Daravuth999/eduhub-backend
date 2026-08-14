/**
 * useVoiceRecorder.js — microphone recording hook with strict cleanup.
 *
 * Responsibilities: permission handling, start/stop, duration timer,
 * min/max enforcement, retry/reset, audio preview (object URL), duplicate-
 * submit prevention, and cleanup of media tracks + timers + object URLs on
 * stop, reset, unmount, and background interruption (visibilitychange).
 *
 * Never stores audio or any credential in localStorage. The recorded Blob
 * lives only in memory and is handed to the caller for upload.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  REC_IDLE, REC_REQUESTING, REC_PERMISSION_DENIED, REC_RECORDING,
  REC_RECORDED, REC_ERROR, formatDuration, canStop, mustAutoStop,
  cleanupResources,
} from "../recorderLogic";

export default function useVoiceRecorder({ minSeconds = 5, maxSeconds = 60 } = {}) {
  const [status, setStatus] = useState(REC_IDLE);
  const [elapsed, setElapsed] = useState(0);
  const [audioUrl, setAudioUrl] = useState(null);
  const [error, setError] = useState("");

  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const urlRef = useRef(null);
  const blobRef = useRef(null);

  const _stopTracks = (stream) => {
    try { stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
  };
  const _clearTimer = (id) => { try { clearInterval(id); } catch { /* noop */ } };
  const _revoke = (url) => { try { URL.revokeObjectURL(url); } catch { /* noop */ } };

  const _cleanup = useCallback(() => {
    cleanupResources(
      { stream: streamRef.current, timerId: timerRef.current, objectUrl: urlRef.current },
      { stopTracks: _stopTracks, clearTimer: _clearTimer, revokeUrl: _revoke },
    );
    streamRef.current = null;
    timerRef.current = null;
  }, []);

  // Cleanup on unmount.
  useEffect(() => () => {
    _cleanup();
    if (urlRef.current) { _revoke(urlRef.current); urlRef.current = null; }
  }, [_cleanup]);

  // Background interruption: stop recording if the tab is hidden.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && recorderRef.current
          && recorderRef.current.state === "recording") {
        try { recorderRef.current.stop(); } catch { /* noop */ }
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  const stop = useCallback(() => {
    const mr = recorderRef.current;
    if (mr && mr.state === "recording") {
      try { mr.stop(); } catch { /* noop */ }
    }
    if (timerRef.current) { _clearTimer(timerRef.current); timerRef.current = null; }
    if (streamRef.current) { _stopTracks(streamRef.current); streamRef.current = null; }
  }, []);

  const start = useCallback(async () => {
    setError("");
    // revoke any previous preview before a fresh take
    if (urlRef.current) { _revoke(urlRef.current); urlRef.current = null; setAudioUrl(null); }
    blobRef.current = null;
    chunksRef.current = [];
    setElapsed(0);
    setStatus(REC_REQUESTING);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream);
      recorderRef.current = mr;
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        blobRef.current = blob;
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setAudioUrl(url);
        setStatus(REC_RECORDED);
      };
      mr.start();
      setStatus(REC_RECORDING);
      const startedAt = Date.now();
      timerRef.current = setInterval(() => {
        const sec = Math.floor((Date.now() - startedAt) / 1000);
        setElapsed(sec);
        if (mustAutoStop(sec, maxSeconds)) stop();
      }, 250);
    } catch (e) {
      if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
        setStatus(REC_PERMISSION_DENIED);
      } else {
        setError("Could not start recording.");
        setStatus(REC_ERROR);
      }
      _cleanup();
    }
  }, [maxSeconds, stop, _cleanup]);

  const reset = useCallback(() => {
    stop();
    if (urlRef.current) { _revoke(urlRef.current); urlRef.current = null; }
    blobRef.current = null;
    chunksRef.current = [];
    setAudioUrl(null);
    setElapsed(0);
    setError("");
    setStatus(REC_IDLE);
  }, [stop]);

  const getBlob = useCallback(() => blobRef.current, []);

  return {
    status, elapsed, audioUrl, error,
    durationLabel: formatDuration(elapsed),
    canStop: canStop(elapsed, minSeconds),
    minSeconds, maxSeconds,
    start, stop, reset, getBlob,
  };
}
