import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Sparkles, AlertTriangle, RefreshCw, ArrowLeft } from "lucide-react";
import { useVoiceTreasureTitle, VoiceTreasureIdentity } from "./useVoiceTreasureIdentity";
import VTStage from "./VTStage";
import * as api from "./api";
import "./VoiceTreasure.css";

/** Pass B.2 — Evaluation visual reconstruction.
 *
 *  Sits on top of VTStage. Visually a transition/recovery screen — the
 *  current evaluation backend request is SYNCHRONOUS, so this page is
 *  actually mounted ONLY after submit returns. It then polls the
 *  authoritative attempt and forwards to /result when ready.
 *
 *  Contract (unchanged from Pass A):
 *    • READ-ONLY. Never submits audio. Never re-evaluates. Never charges.
 *    • Polls GET /api/voice-treasure/attempt/:id every 2s up to MAX_POLLS.
 *    • `evaluated` ⇒ navigates to /result/:attemptId.
 *    • `evaluation_unavailable` / `evaluation_failed` ⇒ surface the
 *      safe-retry contract (back to /record). Backend preserves the
 *      paid entry; student is never charged a second time.
 *    • Direct-link / refresh works (re-reads the same attempt).
 *    • 404 ⇒ home.
 *    • Reduced motion ⇒ animated stage label freezes on the first stage.
 *    • No fake percentage. No second submit. No second evaluation.
 *    • Real async architecture deferred to a later pass.
 */
const STAGES = [
  "Analyzing the scene",
  "Understanding your response",
  "Checking visible details",
  "Preparing your coaching",
  "Finalizing your result",
];

const POLL_MS = 2000;
const MAX_POLLS = 60;

export default function VoiceTreasureEvaluation() {
  useVoiceTreasureTitle("Evaluating");
  const { attemptId } = useParams();
  const nav = useNavigate();
  const [stage, setStage] = useState(0);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const pollCountRef = useRef(0);
  const aliveRef = useRef(true);
  // Hard-gate: submit / re-evaluate must never be possible from this screen.
  const submittedRef = useRef(false);

  // Stage label cue (reduced motion ⇒ static first stage).
  useEffect(() => {
    if (typeof window !== "undefined" &&
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return undefined;
    }
    const t = setInterval(() => {
      setStage((s) => (s + 1) % STAGES.length);
    }, 1400);
    return () => clearInterval(t);
  }, []);

  // Authoritative attempt polling — read-only.
  useEffect(() => {
    aliveRef.current = true;
    if (!attemptId) { setError("Missing attempt reference."); return undefined; }

    let timer = null;
    const tick = async () => {
      pollCountRef.current += 1;
      try {
        const res = await api.getAttempt(attemptId);
        const a = res?.attempt || {};
        const st = a.state;
        if (!aliveRef.current) return;
        if (st === "evaluated") {
          nav(`/game/voice-treasure/result/${encodeURIComponent(attemptId)}`, { replace: true });
          return;
        }
        if (st === "evaluation_unavailable" || st === "evaluation_failed") {
          setUnavailable(true);
          return;
        }
        if (pollCountRef.current >= MAX_POLLS) {
          setTimedOut(true);
          return;
        }
        timer = setTimeout(tick, POLL_MS);
      } catch (e) {
        if (!aliveRef.current) return;
        if (e?.status === 404) {
          nav("/game/voice-treasure", { replace: true });
          return;
        }
        if (pollCountRef.current >= MAX_POLLS) {
          setError(e?.message || "Could not read evaluation status.");
          return;
        }
        timer = setTimeout(tick, POLL_MS);
      }
    };

    tick();
    return () => {
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [attemptId, nav]);

  // Failure / timeout: present the safe retry path. Recorder owns retry
  // (using the SAME paid entry id) — Evaluation never resubmits.
  if (unavailable || timedOut || error) {
    return (
      <VTStage>
        <VoiceTreasureIdentity subtitle="Evaluation" />
        <div className="vt-panel vt-card-glow" role="alert" data-testid="vt-evaluation-failed">
          <div className="vt-h1" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <AlertTriangle size={18} aria-hidden="true" />
            Evaluation needs another try
          </div>
          <p className="vt-sub" data-testid="vt-eval-fail-reason">
            {unavailable
              ? "Evaluation is temporarily unavailable. Your entry is preserved — you can record again without being charged."
              : timedOut
                ? "This is taking longer than expected. Your entry is preserved — you can try recording again."
                : (error || "Something went wrong reading the result.")}
          </p>
          <div className="vt-eval-actions">
            <button
              className="vt-btn vt-btn-gold"
              data-testid="vt-eval-retry"
              onClick={() => {
                if (submittedRef.current) return; // hard-gate
                submittedRef.current = true;
                nav("/game/voice-treasure/record", { replace: true });
              }}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <RefreshCw size={14} aria-hidden="true" />
              Try recording again
            </button>
            <button
              className="vt-btn vt-btn-ghost"
              data-testid="vt-eval-home"
              onClick={() => nav("/game/voice-treasure", { replace: true })}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <ArrowLeft size={14} aria-hidden="true" />
              Back
            </button>
          </div>
        </div>
      </VTStage>
    );
  }

  return (
    <VTStage>
      <VoiceTreasureIdentity subtitle="Evaluating" />
      <div
        className="vt-panel vt-card-glow vt-eval-panel"
        data-testid="vt-evaluation"
        role="status"
        aria-live="polite"
        style={{ textAlign: "center" }}
      >
        <div className="vt-eval-orb" aria-hidden="true" data-testid="vt-eval-orb" />
        <div className="vt-h1" style={{ display: "inline-flex", alignItems: "center", gap: 8, justifyContent: "center" }}>
          <Sparkles size={18} aria-hidden="true" />
          Listening to your answer…
        </div>
        <p className="vt-sub" data-testid="vt-eval-stage">{STAGES[stage]}</p>
        <ul className="vt-eval-checklist" aria-hidden="true">
          {STAGES.map((label, i) => (
            <li
              key={label}
              className={i <= stage ? "vt-eval-step vt-eval-step-on" : "vt-eval-step"}
              data-testid={`vt-eval-step-${i}`}
            >
              <span>{label}</span>
            </li>
          ))}
        </ul>
        <p className="vt-dim" style={{ fontSize: 11, marginTop: 10 }} data-testid="vt-eval-readonly-note">
          Read-only — your recording was submitted once. We will not charge you again.
        </p>
      </div>
    </VTStage>
  );
}
