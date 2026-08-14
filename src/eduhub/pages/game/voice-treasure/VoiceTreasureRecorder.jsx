import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Mic, Square, RefreshCw, Send, AlertCircle } from "lucide-react";
import useVoiceRecorder from "./hooks/useVoiceRecorder";
import {
  REC_IDLE, REC_REQUESTING, REC_PERMISSION_DENIED, REC_RECORDING, REC_RECORDED, REC_ERROR,
  canSubmit,
} from "./recorderLogic";
import { resolveBundledImage } from "./sceneAssets";
import { useVoiceTreasureTitle, VoiceTreasureIdentity } from "./useVoiceTreasureIdentity";
import VTStage from "./VTStage";
import * as api from "./api";
import "./VoiceTreasure.css";

/**
 * Pass B.2.1 — Recorder phase truth corrections.
 *
 * The B.2 source documented two phases (`previewing`, `interrupted`) that
 * were not genuinely emitted by the implementation. Corrected here:
 *
 *   • `previewing` is now a REAL state, driven by the <audio> element's
 *     onPlay / onPause / onEnded events. While the preview is playing,
 *     data-phase becomes "previewing"; pause and end return to
 *     "recorded".
 *   • `interrupted` is REMOVED from the documented contract because the
 *     existing recorder hook does not reliably emit an interruption
 *     branch. Documenting it falsely would be misleading. If a future
 *     pass adds a real interruption signal it can be re-introduced.
 *
 * Preserves the existing recording hook (`useVoiceRecorder`) and all of
 * its cleanup, duration-limit, and duplicate-submit contracts:
 *
 *   • paid entry id survives a refresh / direct link (router state →
 *     URL param → backend GET /today recovery; localStorage is never
 *     used as the source of truth).
 *   • media-track cleanup, timer cleanup, object-URL cleanup, max-
 *     duration auto-stop, and ALL state transitions live in the hook.
 *   • the visible state machine maps 1:1 onto hook state:
 *       ready          ← REC_IDLE
 *       requesting     ← REC_REQUESTING
 *       recording      ← REC_RECORDING
 *       recorded       ← REC_RECORDED (idle preview + submit)
 *       previewing     ← REC_RECORDED while the preview <audio> is
 *                        actively playing.
 *       submitting     ← submitting flag in this component
 *       failed         ← REC_ERROR + permission_denied + submit error.
 *
 * Submit goes ONCE and is hard-gated by `canSubmit` + a sync
 * `submittingRef` so the recorder cannot double-charge or
 * double-evaluate. Recovery navigates back to the recorder route on
 * failure.
 */
export default function VoiceTreasureRecorder() {
  useVoiceTreasureTitle("Recording");
  const nav = useNavigate();
  const loc = useLocation();
  const params = useParams();
  const initialEntryId = loc.state?.entryId || params?.entryId || null;
  const [entryId, setEntryId] = useState(initialEntryId);
  const [recovering, setRecovering] = useState(!initialEntryId);
  const [recoveryError, setRecoveryError] = useState("");
  const rec = useVoiceRecorder({ minSeconds: 5, maxSeconds: 60 });
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false); // sync duplicate-submit guard
  const [error, setError] = useState("");
  const [previewFailed, setPreviewFailed] = useState(false);
  // Pass B.2.1 — real previewing phase driven by <audio> onPlay/onPause/onEnded.
  const [previewing, setPreviewing] = useState(false);

  // Mission image — passed from Mission page via state, re-fetched on recovery.
  const [missionImg, setMissionImg] = useState({
    src: loc.state?.imgSrc || null,
    alt: loc.state?.imgAlt || "Mission image",
  });

  useEffect(() => { setPreviewFailed(false); setPreviewing(false); }, [rec.audioUrl]);

  useEffect(() => {
    if (entryId) return;
    let alive = true;
    (async () => {
      try {
        const t = await api.getToday();
        if (!alive) return;
        if (!t.available) { setRecoveryError("unavailable"); return; }
        if (!t.existing_entry?.paid) {
          nav("/game/voice-treasure/confirm", { replace: true });
          return;
        }
        setEntryId(t.existing_entry.entry_id);
        try {
          const img = await api.getMissionImage(t.mission.mission_id);
          if (!alive) return;
          const kind = img.image_kind;
          const src = kind === "generated"
            ? (img.image_url
                ? (img.image_url.startsWith("http")
                    ? img.image_url
                    : `${(process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "")}${img.image_url}`)
                : null)
            : resolveBundledImage({ imageRef: img.image_ref, sceneId: img.scene_id });
          if (src) setMissionImg({ src, alt: img.alt || "Mission image" });
        } catch { /* image is best-effort; recording still works without it */ }
      } catch (e) {
        if (alive) setRecoveryError(e?.message || "Could not recover today's mission.");
      } finally {
        if (alive) setRecovering(false);
      }
    })();
    return () => { alive = false; };
  }, [entryId, nav]);

  const onSubmit = async () => {
    if (submittingRef.current) return;          // sync duplicate-submit guard
    if (!canSubmit({ status: rec.status, submitting })) return;
    const blob = rec.getBlob();
    if (!blob || !entryId) { setError("Please record before submitting."); return; }
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      const res = await api.submitAttempt({ entryId, audioBlob: blob });
      const aid = res?.attempt?.attempt_id;
      if (aid) nav(`/game/voice-treasure/evaluation/${encodeURIComponent(aid)}`);
      else setError("Could not submit. Please try again.");
    } catch (e) {
      setError(e?.message || "Submission failed. Please try again.");
      submittingRef.current = false;            // allow retry on failure
    } finally {
      setSubmitting(false);
    }
  };

  // ── Recovery shells ────────────────────────────────────────────────
  if (recovering) {
    return (
      <VTStage>
        <VoiceTreasureIdentity subtitle="Recording" />
        <div className="vt-panel" data-testid="vt-recorder-recovering">
          <div className="vt-h1">Recovering today's mission…</div>
          <p className="vt-sub">We're checking your paid entry. You won't be charged again.</p>
        </div>
      </VTStage>
    );
  }
  if (recoveryError) {
    return (
      <VTStage>
        <VoiceTreasureIdentity subtitle="Recording" />
        <div className="vt-panel" data-testid="vt-recorder-recovery-error">
          <div className="vt-h1">We couldn't recover your mission</div>
          <p className="vt-error">{recoveryError === "unavailable"
            ? "Voice Treasure isn't available right now."
            : recoveryError}</p>
          <button className="vt-btn" data-testid="vt-recorder-back" onClick={() => nav("/game/voice-treasure")}>
            Back
          </button>
        </div>
      </VTStage>
    );
  }

  // ── Derived presentation state ────────────────────────────────────
  // Map the hook status + local submitting/previewing flag into a single
  // observable phase used by the UI + tests. `previewing` is genuine
  // (driven by <audio> events). `interrupted` is intentionally NOT a
  // claimed phase here — the recorder hook does not reliably emit one
  // and we will not fabricate it.
  const phase = (() => {
    if (submitting) return "submitting";
    if (error) return "failed";
    if (rec.status === REC_REQUESTING) return "requesting_permission";
    if (rec.status === REC_PERMISSION_DENIED) return "failed";
    if (rec.status === REC_RECORDING) return "recording";
    if (rec.status === REC_RECORDED) return previewing ? "previewing" : "recorded";
    if (rec.status === REC_ERROR) return "failed";
    return "ready";
  })();

  return (
    <VTStage sceneImage={missionImg.src} sceneAlt={missionImg.alt}>
      <VoiceTreasureIdentity subtitle="Recording" />
      <div
        className="vt-panel vt-card-glow vt-recorder"
        data-testid="vt-recorder"
        data-phase={phase}
      >
        {/* Compact mission strip so students can describe it while recording */}
        {missionImg.src && (
          <div className="vt-mission-frame vt-mission-frame--compact" data-testid="vt-recorder-img">
            <img
              className="vt-mission-img"
              src={missionImg.src}
              alt={missionImg.alt}
              draggable="false"
            />
          </div>
        )}

        <div className="vt-h1" data-testid="vt-recorder-title">
          {phase === "recording" ? "Listening…" : phase === "previewing" ? "Previewing…" : phase === "recorded" ? "Ready to send" : "Speak now"}
        </div>
        <p className="vt-sub" data-testid="vt-recorder-sub">
          Describe the picture. {rec.minSeconds}–{rec.maxSeconds} seconds.
        </p>

        {/* Premium microphone control + waveform/level visualization */}
        <RecorderConsole
          phase={phase}
          elapsed={rec.elapsed}
          durationLabel={rec.durationLabel}
          minSeconds={rec.minSeconds}
          maxSeconds={rec.maxSeconds}
        />

        {phase === "requesting_permission" && (
          <p className="vt-dim" data-testid="vt-rec-requesting">Waiting for microphone permission…</p>
        )}
        {rec.status === REC_PERMISSION_DENIED && (
          <p className="vt-error" data-testid="vt-perm-denied">
            <AlertCircle size={14} aria-hidden="true" />{" "}
            Microphone access was blocked. Enable it in your browser settings, then try again.
          </p>
        )}
        {error && <p className="vt-error" data-testid="vt-rec-error">{error}</p>}

        {rec.audioUrl && rec.status === REC_RECORDED && (
          previewFailed ? (
            <p className="vt-sub" style={{ marginTop: 10 }} data-testid="vt-preview-unavailable">
              Recording captured ({rec.elapsed}s) — preview unavailable on this browser. Your recording is ready to submit.
            </p>
          ) : (
            <audio
              data-testid="vt-preview"
              src={rec.audioUrl}
              controls
              style={{ width: "100%", marginTop: 10 }}
              onPlay={() => setPreviewing(true)}
              onPause={() => setPreviewing(false)}
              onEnded={() => setPreviewing(false)}
              onError={() => { setPreviewFailed(true); setPreviewing(false); }}
            />
          )
        )}

        <div className="vt-recorder-actions" data-testid="vt-recorder-actions">
          {(rec.status === REC_IDLE || rec.status === REC_PERMISSION_DENIED) && (
            <button
              className="vt-btn vt-btn-gold vt-btn-cta"
              data-testid="vt-rec-start"
              onClick={rec.start}
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              <Mic size={16} aria-hidden="true" />
              Start recording
            </button>
          )}
          {rec.status === REC_REQUESTING && (
            <button className="vt-btn" disabled data-testid="vt-rec-requesting-btn">Requesting mic…</button>
          )}
          {rec.status === REC_RECORDING && (
            <button
              className="vt-btn vt-btn-stop"
              data-testid="vt-rec-stop"
              disabled={!rec.canStop}
              onClick={rec.stop}
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              <Square size={14} aria-hidden="true" />
              {rec.canStop ? "Stop" : `Keep going (${rec.minSeconds}s min)`}
            </button>
          )}
          {rec.status === REC_RECORDED && (
            <>
              <button
                className="vt-btn vt-btn-ghost"
                data-testid="vt-rec-retry"
                onClick={rec.reset}
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                <RefreshCw size={14} aria-hidden="true" />
                Retry
              </button>
              <button
                className="vt-btn vt-btn-gold"
                data-testid="vt-rec-submit"
                disabled={submitting}
                onClick={onSubmit}
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                <Send size={14} aria-hidden="true" />
                {submitting ? "Submitting…" : "Submit"}
              </button>
            </>
          )}
        </div>
      </div>
    </VTStage>
  );
}

/**
 * RecorderConsole — premium microphone control + animated level
 * visualization. The bars are CSS-driven (one keyframe per bar, staggered
 * delays) so we never depend on a Web Audio API analyzer that some test
 * environments don't provide. Reduced motion users see static bars.
 */
function RecorderConsole({ phase, elapsed, durationLabel, minSeconds, maxSeconds }) {
  const bars = useMemo(() => Array.from({ length: 18 }, (_, i) => i), []);
  const recording = phase === "recording";
  const reduced = useReduced();
  const progress = Math.min(1, elapsed / Math.max(1, maxSeconds));

  return (
    <div className="vt-rec-console" data-testid="vt-rec-console" data-phase={phase}>
      <div className={`vt-rec-orb${recording ? " vt-rec-orb-on" : ""}`} aria-hidden="true" data-testid="vt-rec-orb">
        <svg width="80" height="80" viewBox="0 0 80 80" role="img" aria-hidden="true">
          <defs>
            <radialGradient id="vt-rec-orb-grad" cx="50%" cy="40%" r="60%">
              <stop offset="0%" stopColor="#ffe19a" stopOpacity="0.95" />
              <stop offset="55%" stopColor="#ff9c5e" stopOpacity="0.85" />
              <stop offset="100%" stopColor="#6a4cff" stopOpacity="0.9" />
            </radialGradient>
          </defs>
          <circle cx="40" cy="40" r="34" fill="url(#vt-rec-orb-grad)" />
          {/* original mic glyph inside the orb */}
          <g transform="translate(31 22)" fill="#fff" opacity="0.95">
            <rect x="3" y="0" width="12" height="18" rx="6" />
            <path d="M0 14 a9 9 0 0 0 18 0" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
            <line x1="9" y1="24" x2="9" y2="30" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
            <line x1="4" y1="30" x2="14" y2="30" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
          </g>
        </svg>
      </div>

      <div
        className={`vt-rec-wave${recording && !reduced ? " vt-rec-wave-on" : ""}`}
        data-testid="vt-rec-wave"
        aria-hidden="true"
      >
        {bars.map((i) => (
          <span
            key={i}
            className="vt-rec-bar"
            style={{ animationDelay: `${(i % 9) * 80}ms` }}
          />
        ))}
      </div>

      <div className="vt-rec-meter" data-testid="vt-rec-meter">
        <div className="vt-rec-meter-track">
          <div
            className="vt-rec-meter-fill"
            style={{ width: `${Math.round(progress * 100)}%` }}
            data-testid="vt-rec-meter-fill"
          />
          <div
            className="vt-rec-meter-min"
            style={{ left: `${Math.round((minSeconds / Math.max(1, maxSeconds)) * 100)}%` }}
            aria-hidden="true"
            title={`Minimum ${minSeconds}s`}
          />
        </div>
        <div className="vt-rec-timer" data-testid="vt-timer">
          {recording && <span className="vt-rec-dot" aria-hidden="true">●</span>}
          <span>{durationLabel}</span>
          <span className="vt-dim" style={{ marginLeft: 6 }}>/ {pad(maxSeconds)}</span>
        </div>
      </div>
    </div>
  );
}

function pad(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function useReduced() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(!!mq.matches);
    apply();
    try { mq.addEventListener("change", apply); } catch { mq.addListener(apply); }
    return () => {
      try { mq.removeEventListener("change", apply); } catch { mq.removeListener(apply); }
    };
  }, []);
  return reduced;
}

// kept for tests that import these names alongside the component file
export { useReduced as _vtUseReduced };

// The recorder hook also publishes a ref to prove we did not change
// REC_* tokens used by the hook contract.
// eslint-disable-next-line no-unused-vars
const _stableTokens = { REC_IDLE };
