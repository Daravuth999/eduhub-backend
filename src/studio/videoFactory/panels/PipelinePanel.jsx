/**
 * PipelinePanel.jsx — the Gemini AI Processing dashboard: the flagship
 * visual pipeline. The backend runs six real steps (video_pipeline_tools
 * .py's PIPELINE_STEPS); this dashboard presents them as the full
 * educational production storyline with per-substep status, a live
 * processing log, and retry. Display substeps map 1:1 onto their owning
 * backend step's real status — never fabricated as independent progress.
 * When several display rows share one backend step and it fails, only
 * the first row shows the raw provider error; later rows render a calm
 * "Blocked — X failed" instead of repeating the identical error under an
 * unrelated label (see the `rows` useMemo below).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, XCircle, Loader2, Circle, MinusCircle, RefreshCw, Wand2, ScrollText } from "lucide-react";
import { getPipeline, runPipeline } from "../videoLibraryApi";

const GOLD = "#D4A843";

/** Display storyline → owning backend step. */
const DISPLAY_STEPS = [
  { label: "Media validation", backend: "media_check" },
  { label: "Audio extraction", backend: "audio_extraction" },
  { label: "Gemini speech recognition", backend: "speech_recognition" },
  { label: "Speaker detection", backend: "speech_recognition" },
  { label: "Sentence segmentation", backend: "synchronization" },
  { label: "Synchronization generation", backend: "synchronization" },
  { label: "Educational analysis", backend: "educational_analysis" },
  { label: "Vocabulary extraction", backend: "educational_analysis" },
  { label: "Grammar notes", backend: "educational_analysis" },
  { label: "CEFR classification", backend: "educational_analysis" },
  { label: "Review ready", backend: "review_ready" },
];

function StepIcon({ status }) {
  if (status === "complete") return <CheckCircle2 size={14} className="text-emerald-300" />;
  if (status === "failed") return <XCircle size={14} className="text-red-400" />;
  if (status === "blocked") return <XCircle size={14} className="text-white/25" />;
  // "skipped" is a genuinely fine outcome (e.g. a silent video has nothing
  // to transcribe) — a dash, never the red/failed X, so it never reads as
  // something having gone wrong.
  if (status === "skipped") return <MinusCircle size={14} className="text-sky-300/70" />;
  if (status === "running") return <Loader2 size={14} className="animate-spin" style={{ color: GOLD }} />;
  return <Circle size={13} className="text-white/20" />;
}

export default function PipelinePanel({ lesson, onChanged }) {
  const [pipeline, setPipeline] = useState(lesson.pipeline || null);
  const [showLog, setShowLog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => setPipeline(lesson.pipeline || null), [lesson]);

  useEffect(() => {
    const poll = async () => {
      try {
        const data = await getPipeline(lesson.lessonId);
        setPipeline(data.pipeline || null);
        if (data.pipeline && data.pipeline.state !== "running") {
          clearInterval(pollRef.current);
          pollRef.current = null;
          onChanged();
        }
      } catch { /* transient */ }
    };
    if (pipeline?.state === "running" && !pollRef.current) {
      pollRef.current = setInterval(poll, 2500);
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [pipeline?.state, lesson.lessonId, onChanged]);

  const handleRun = async () => {
    setErr(null);
    setBusy(true);
    try {
      await runPipeline(lesson.lessonId);
      setPipeline({ ...(pipeline || {}), state: "running", steps: pipeline?.steps || {} });
    } catch (e) {
      setErr(e.message || "Could not start the pipeline.");
    } finally {
      setBusy(false);
    }
  };

  const rows = useMemo(() => {
    const steps = pipeline?.steps || {};
    const seenBackend = new Set();
    return DISPLAY_STEPS.map((d, i) => {
      const backend = steps[d.backend] || { status: "pending" };
      const isPrimary = !seenBackend.has(d.backend);
      seenBackend.add(d.backend);
      // Several display rows can share one real backend step (see the
      // header comment). Only the FIRST row for a given backend step
      // should show its raw provider error — every later row sharing that
      // same failed step never actually ran independently, so repeating
      // the identical error under an unrelated label ("Speaker detection:
      // Gemini returned no parsable segments") falsely implies a second,
      // distinct defect. Those rows show a calm "Blocked" state instead.
      if (!isPrimary && backend.status === "failed") {
        const primaryLabel = DISPLAY_STEPS.find((x) => x.backend === d.backend)?.label || d.backend;
        return { ...d, i, status: "blocked", error: `Blocked — ${primaryLabel} failed` };
      }
      return { ...d, i, status: backend.status || "pending", error: backend.error };
    });
  }, [pipeline?.steps]);

  const running = pipeline?.state === "running";
  const failed = pipeline?.state === "failed";
  const complete = pipeline?.state === "complete";
  // "skipped" is a resolved, honest terminal state (e.g. nothing to
  // transcribe on a silent video) — it must count toward progress the
  // same as "complete", or the meter would look permanently stuck short
  // of 100% on a pipeline that has genuinely finished.
  const doneCount = rows.filter((r) => r.status === "complete" || r.status === "skipped").length;

  if (!lesson.mediaRef) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-[12px] text-faded"
           data-testid="pipeline-no-media">
        Upload this lesson's media first — Gemini processing starts automatically the moment the upload lands.
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="production-pipeline-panel">
      <div className="flex items-center gap-2 flex-wrap">
        <Wand2 size={14} className="text-amber-300" />
        <span className="text-[13px] font-semibold text-parchment">Gemini processing</span>
        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border"
              data-testid="pipeline-state-badge"
              style={complete ? { color: "#6ee7b7", borderColor: "rgba(52,211,153,0.4)", background: "rgba(52,211,153,0.1)" }
                : failed ? { color: "#f87171", borderColor: "rgba(248,113,113,0.4)", background: "rgba(248,113,113,0.1)" }
                  : running ? { color: "#FFE19A", borderColor: "rgba(212,168,67,0.4)", background: "rgba(212,168,67,0.1)" }
                    : { color: "#9ca3af", borderColor: "rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.05)" }}>
          {running ? "Processing" : failed ? "Failed" : complete ? "Complete" : "Idle"}
        </span>
        {pipeline?.provider && <span className="text-[10px] text-faded">{pipeline.provider}</span>}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setShowLog(!showLog)}
                  data-testid="pipeline-log-toggle"
                  className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border border-white/10 text-faded hover:text-parchment">
            <ScrollText size={11} /> {showLog ? "Hide log" : "Processing log"}
          </button>
          {!running && (
            <button onClick={handleRun} disabled={busy}
                    data-testid="pipeline-run-button"
                    className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-amber-400/40 text-amber-300 disabled:opacity-40">
              <RefreshCw size={11} /> {failed ? "Retry processing" : complete ? "Re-process" : "Process with Gemini"}
            </button>
          )}
        </div>
      </div>

      {/* Progress meter */}
      <div className="h-1.5 rounded-full bg-black/40 overflow-hidden">
        <div className="h-full rounded-full transition-[width] duration-500" data-testid="pipeline-progress-meter"
             style={{ width: `${(doneCount / rows.length) * 100}%`, background: failed ? "#f87171" : GOLD }} />
      </div>

      {/* Step storyline */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5" data-testid="pipeline-steps">
        {rows.map((r) => (
          <div key={r.i} className="flex items-center gap-2.5 py-1" data-testid={`pipeline-step-${r.i}`}>
            <StepIcon status={r.status} />
            <span className="text-[12px]" style={{
              color: r.status === "complete" ? "rgba(255,255,255,0.85)"
                : r.status === "running" ? "#FFE19A"
                  : r.status === "failed" ? "#f87171"
                    : r.status === "skipped" ? "rgba(125,211,252,0.85)" : "rgba(255,255,255,0.35)",
            }}>
              {r.label}
            </span>
            {r.status === "failed" && r.error && (
              <span className="text-[10px] text-red-400/70 truncate">{r.error}</span>
            )}
            {r.status === "blocked" && r.error && (
              <span className="text-[10px] text-white/40 truncate">{r.error}</span>
            )}
            {r.status === "skipped" && r.error && (
              <span className="text-[10px] text-sky-300/60 truncate">{r.error}</span>
            )}
          </div>
        ))}
      </div>

      {pipeline?.error && (
        <div className="text-[11.5px] text-red-400 rounded-lg bg-red-500/5 border border-red-500/20 p-2.5"
             data-testid="pipeline-error">
          {pipeline.error}
        </div>
      )}

      {/* Processing log */}
      {showLog && (
        <div className="rounded-lg bg-black/40 border border-white/10 p-3 max-h-56 overflow-y-auto font-mono text-[10.5px] space-y-1"
             data-testid="pipeline-log">
          {(pipeline?.log || []).length === 0 ? (
            <div className="text-white/35">No log entries yet.</div>
          ) : (pipeline.log || []).map((e, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-white/30 flex-shrink-0">{(e.at || "").slice(11, 19)}</span>
              <span style={{ color: e.status === "failed" ? "#f87171" : e.status === "complete" ? "#6ee7b7" : "rgba(255,255,255,0.6)" }}>
                [{e.step}] {e.message}
              </span>
            </div>
          ))}
        </div>
      )}

      {err && <div className="text-xs text-red-400" data-testid="pipeline-run-error">{err}</div>}
    </div>
  );
}
