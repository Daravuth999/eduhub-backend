/**
 * VoiceProductionPanel.jsx — the AI Narration production stage: Gemini
 * whole-story analysis → Gemini script blueprint draft (grounded in the
 * whole story, never scene-by-scene in isolation) → admin voice assignment
 * → per-line ElevenLabs generation with real per-character alignment →
 * assembly into one additive narration track → explicit publish gate.
 *
 * Gemini is the director, ElevenLabs is the voice performer, the admin is
 * the final creative authority — nothing here is ever auto-published.
 * Every stage's status comes straight from the backend's real job-stage
 * state (video_narration_jobs.py) — never fabricated progress.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles, Wand2, Mic2, Loader2, RotateCcw, Rocket, Film, Volume2, Music, AudioWaveform,
} from "lucide-react";
import {
  getNarration, runStoryAnalysis, runScriptBlueprint, setVoiceAssignments,
  generateLineVoice, resetLineVoice, assembleNarration, renderNarrationMaster,
  setSourceAudioTreatment, generateSceneSfx, getNarrationTimeline,
  publishNarration, unpublishNarration, listVoices, resolveMediaSrc,
} from "../videoLibraryApi";

const GOLD = "#D4A843";

const AUDIO_OBSERVATION_LABELS = { dialogue: "Dialogue", music: "Music", ambience: "Ambience", sfx: "SFX" };

const TREATMENT_OPTIONS = [
  { value: "mute", label: "Replace original audio", hint: "Original muted — only AI narration plays" },
  { value: "duck", label: "Duck original audio", hint: "Original kept faint under the narration" },
  { value: "preserve", label: "Preserve original audio", hint: "Original kept near-full alongside the narration" },
];

const RETRYABLE_STATES = ["pending", "failed_retryable", "failed_terminal", "unknown_outcome"];

const STAGE_BADGES = {
  completed: { label: "Complete", color: "#6ee7b7", bg: "rgba(52,211,153,0.1)", border: "rgba(52,211,153,0.4)" },
  provider_pending: { label: "Processing", color: "#FFE19A", bg: "rgba(212,168,67,0.1)", border: "rgba(212,168,67,0.4)" },
  claimed: { label: "Starting", color: "#FFE19A", bg: "rgba(212,168,67,0.1)", border: "rgba(212,168,67,0.4)" },
  failed_retryable: { label: "Failed — retry", color: "#fbbf24", bg: "rgba(245,158,11,0.1)", border: "rgba(245,158,11,0.4)" },
  failed_terminal: { label: "Failed", color: "#f87171", bg: "rgba(248,113,113,0.1)", border: "rgba(248,113,113,0.4)" },
  unknown_outcome: { label: "Unknown — check first", color: "#f87171", bg: "rgba(248,113,113,0.1)", border: "rgba(248,113,113,0.4)" },
  pending: { label: "Not started", color: "#9ca3af", bg: "rgba(255,255,255,0.05)", border: "rgba(255,255,255,0.15)" },
};

function StageBadge({ state, testId }) {
  const s = STAGE_BADGES[state] || STAGE_BADGES.pending;
  return (
    <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border flex-shrink-0"
          data-testid={testId} style={{ color: s.color, background: s.bg, borderColor: s.border }}>
      {s.label}
    </span>
  );
}

export default function VoiceProductionPanel({
  lesson, onChanged, enabled = true,
  musicStatus = { supported: false, reason: "" },
  sfxStatus = { supported: false },
}) {
  const [job, setJob] = useState(null);
  const [voices, setVoices] = useState([]);
  const [selectedScene, setSelectedScene] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const pollRef = useRef(null);

  const load = async () => {
    try { setJob(await getNarration(lesson.lessonId)); } catch { /* transient */ }
  };

  useEffect(() => {
    if (!enabled || !lesson.mediaRef) return; // disabled, or nothing to produce narration for yet
    load();
    listVoices().then(setVoices).catch(() => setVoices([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson.lessonId, lesson.mediaRef, enabled]);

  useEffect(() => {
    const anyRunning = job && ["storyAnalysis", "scriptBlueprint"].some(
      (k) => ["claimed", "provider_pending"].includes(job[k]?.state),
    );
    if (anyRunning && !pollRef.current) pollRef.current = setInterval(load, 2500);
    if (!anyRunning && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.storyAnalysis?.state, job?.scriptBlueprint?.state]);

  useEffect(() => {
    if (job?.scriptBlueprint?.state !== "completed") return;
    getNarrationTimeline(lesson.lessonId).then(setTimeline).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson.lessonId, job]);

  const runAction = async (key, fn) => {
    setErr(null);
    setBusy(key);
    try {
      const data = await fn();
      setJob(data);
      onChanged?.();
    } catch (e) {
      setErr(e.message || "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  const scenes = job?.storyAnalysis?.result?.scenes || [];
  const scriptScenes = useMemo(
    () => job?.scriptBlueprint?.result?.scenes || [],
    [job?.scriptBlueprint?.result?.scenes],
  );
  const activeSceneId = selectedScene || scenes[0]?.sceneId || scriptScenes[0]?.sceneId || null;
  const activeScriptScene = scriptScenes.find((s) => s.sceneId === activeSceneId);
  const activeStoryScene = scenes.find((s) => s.sceneId === activeSceneId);
  const activeAudioObservations = activeStoryScene?.audioObservations || {};
  const hasAudioObservations = Object.values(activeAudioObservations).some((v) => v);
  const anySceneReportsMusicOrSfx = scenes.some((s) => s.audioObservations?.music || s.audioObservations?.sfx);
  const sfxCandidateScenes = scenes.filter((s) => s.audioObservations?.sfx);

  const speakers = useMemo(() => {
    const set = new Set();
    scriptScenes.forEach((s) => (s.lines || []).forEach((l) => l.speaker && set.add(l.speaker)));
    return Array.from(set);
  }, [scriptScenes]);

  const allLinesComplete = scriptScenes.length > 0 && scriptScenes.every((s) =>
    (s.lines || []).every((l) => job?.voiceProduction?.[s.sceneId]?.lines?.[l.lineId]?.state === "completed"),
  );

  if (!enabled) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-[12px] text-faded"
           data-testid="voice-disabled">
        AI Narration production is currently disabled by the platform.
      </div>
    );
  }
  if (!lesson.mediaRef) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-[12px] text-faded"
           data-testid="voice-no-media">
        Upload this lesson's media first.
      </div>
    );
  }
  if (!job) {
    return (
      <div className="p-8 text-center text-faded text-[12px]">
        <Loader2 className="animate-spin mx-auto mb-2" size={18} /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="voice-production-panel">
      <div className="flex items-center gap-2 flex-wrap">
        <Mic2 size={14} className="text-amber-300" />
        <span className="text-[13px] font-semibold text-parchment">AI Narration Production</span>
        <span className="text-[10px] text-faded ml-1">Gemini drafts the script · you approve · ElevenLabs performs it</span>
      </div>

      {/* 1 — whole-story analysis */}
      <div className="rounded-xl border border-white/10 bg-black/20 p-3.5 space-y-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-bold text-parchment flex-1">01 · Story Analysis</span>
          <StageBadge state={job.storyAnalysis?.state} testId="voice-story-badge" />
          {RETRYABLE_STATES.includes(job.storyAnalysis?.state) && (
            <button onClick={() => runAction("story", () => runStoryAnalysis(lesson.lessonId))}
                    disabled={busy === "story"} data-testid="voice-run-story-analysis"
                    className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-amber-400/40 text-amber-300 disabled:opacity-40">
              {busy === "story" ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
              {job.storyAnalysis?.state === "pending" ? "Analyze story" : "Retry"}
            </button>
          )}
        </div>
        {job.storyAnalysis?.state === "completed" && (
          <>
            <p className="text-[12px] text-white/70 leading-relaxed">{job.storyAnalysis.result.summary}</p>
            {job.storyAnalysis.result.characters?.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {job.storyAnalysis.result.characters.map((c) => (
                  <span key={c.name} className="text-[10.5px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/70">
                    {c.name}
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-1.5 overflow-x-auto pb-1" data-testid="voice-scene-timeline">
              {scenes.map((s) => (
                <button key={s.sceneId} onClick={() => setSelectedScene(s.sceneId)}
                        data-testid={`voice-scene-${s.sceneId}`}
                        className="flex-shrink-0 rounded-lg border px-2.5 py-1.5 text-left"
                        style={activeSceneId === s.sceneId
                          ? { borderColor: "rgba(212,168,67,0.5)", background: "rgba(212,168,67,0.1)" }
                          : { borderColor: "rgba(255,255,255,0.1)" }}>
                  <div className="text-[10px] font-bold text-white/80 truncate max-w-[140px]">{s.title || s.sceneId}</div>
                  <div className="text-[9px] text-faded uppercase">{s.narrativeRole}</div>
                </button>
              ))}
            </div>
            {hasAudioObservations && (
              <div className="rounded-lg bg-white/[0.03] border border-white/10 p-2.5 space-y-1"
                   data-testid="voice-scene-audio-observations">
                <span className="text-[9.5px] font-bold uppercase tracking-wide text-faded">
                  What Gemini heard in the original audio
                </span>
                {Object.entries(AUDIO_OBSERVATION_LABELS).map(([key, label]) => (
                  activeAudioObservations[key] ? (
                    <p key={key} className="text-[11px] text-white/70">
                      <span className="font-semibold text-white/85">{label}: </span>
                      {activeAudioObservations[key]}
                    </p>
                  ) : null
                ))}
              </div>
            )}
            {anySceneReportsMusicOrSfx && (
              <p className="text-[10px] text-faded italic" data-testid="voice-music-sfx-unsupported">
                Music/SFX generation isn't supported yet — only narration/dialogue voice lines can be generated below.
                Detected music/sound effects above are descriptive only.
              </p>
            )}
          </>
        )}
        {job.storyAnalysis?.lastError && (
          <div className="text-[11px] text-red-400" data-testid="voice-story-error">{job.storyAnalysis.lastError}</div>
        )}
      </div>

      {/* 2 — script blueprint + editor */}
      {job.storyAnalysis?.state === "completed" && (
        <div className="rounded-xl border border-white/10 bg-black/20 p-3.5 space-y-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-bold text-parchment flex-1">02 · Voice Script (performance direction)</span>
            <StageBadge state={job.scriptBlueprint?.state} testId="voice-script-badge" />
            {RETRYABLE_STATES.includes(job.scriptBlueprint?.state) && (
              <button onClick={() => runAction("script", () => runScriptBlueprint(lesson.lessonId))}
                      disabled={busy === "script"} data-testid="voice-run-script-blueprint"
                      className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-amber-400/40 text-amber-300 disabled:opacity-40">
                {busy === "script" ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
                {job.scriptBlueprint?.state === "pending" ? "Draft script" : "Retry"}
              </button>
            )}
          </div>

          {job.scriptBlueprint?.state === "completed" && activeScriptScene && (
            <div className="space-y-2" data-testid="voice-script-editor">
              {(activeScriptScene.lines || []).map((line) => {
                const stage = job.voiceProduction?.[activeSceneId]?.lines?.[line.lineId];
                const lineState = stage?.state || "pending";
                const stale = stage?.result?.voiceStale;
                return (
                  <div key={line.lineId} className="rounded-lg bg-white/[0.03] border border-white/10 p-2.5 space-y-1.5"
                       data-testid={`voice-line-${line.lineId}`}>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: GOLD }}>{line.speaker}</span>
                      <div className="ml-auto flex items-center gap-1.5">
                        <StageBadge state={lineState} testId={`voice-line-badge-${line.lineId}`} />
                        {stale && <span className="text-[9px] text-amber-300">voice changed — needs regen</span>}
                      </div>
                    </div>
                    <p className="text-[12.5px] text-white/80">{line.text}</p>
                    {line.emotion && (
                      <p className="text-[10.5px] text-faded italic" data-testid={`voice-line-performance-${line.lineId}`}>
                        <span className="font-semibold not-italic text-white/60">Performance: </span>{line.emotion}
                      </p>
                    )}
                    <div className="flex items-center gap-2 flex-wrap">
                      {lineState === "completed" && !stale && stage?.result?.mediaRef && (
                        <audio controls src={resolveMediaSrc(stage.result.mediaRef)} className="h-7"
                               style={{ maxWidth: 220 }} data-testid={`voice-line-audio-${line.lineId}`} />
                      )}
                      {RETRYABLE_STATES.includes(lineState) && (
                        <button onClick={() => runAction(`line-${line.lineId}`,
                                  () => generateLineVoice(lesson.lessonId, activeSceneId, line.lineId))}
                                disabled={busy === `line-${line.lineId}`}
                                data-testid={`voice-generate-${line.lineId}`}
                                className="text-[10.5px] font-semibold px-2 py-1 rounded-lg border border-amber-400/40 text-amber-300 disabled:opacity-40">
                          {busy === `line-${line.lineId}` ? "Generating…" : "Generate"}
                        </button>
                      )}
                      {lineState === "completed" && stale && (
                        <button onClick={() => runAction(`reset-${line.lineId}`, async () => {
                                  await resetLineVoice(lesson.lessonId, activeSceneId, line.lineId);
                                  return generateLineVoice(lesson.lessonId, activeSceneId, line.lineId);
                                })}
                                disabled={busy === `reset-${line.lineId}`}
                                data-testid={`voice-regenerate-${line.lineId}`}
                                className="inline-flex items-center gap-1 text-[10.5px] font-semibold px-2 py-1 rounded-lg border border-amber-400/40 text-amber-300 disabled:opacity-40">
                          <RotateCcw size={10} /> Regenerate
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 3 — voice assignment, role consistency preserved server-side */}
      {speakers.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-black/20 p-3.5 space-y-2.5">
          <span className="text-[12px] font-bold text-parchment">03 · Voice Assignment</span>
          <div className="space-y-2">
            {speakers.map((role) => (
              <div key={role} className="flex items-center gap-2.5" data-testid={`voice-role-${role}`}>
                <span className="text-[11.5px] text-white/75 w-24 truncate flex-shrink-0">{role}</span>
                <select value={job.voiceAssignments?.[role] || ""} data-testid={`voice-select-${role}`}
                        onChange={(e) => runAction("assign", () => setVoiceAssignments(
                          lesson.lessonId, { ...job.voiceAssignments, [role]: e.target.value },
                        ))}
                        className="flex-1 bg-black/30 border border-white/10 rounded-lg text-[11.5px] text-white px-2 py-1">
                  <option value="">— choose a voice —</option>
                  {voices.map((v) => (
                    <option key={v.voice_id} value={v.voice_id}>
                      {v.name} ({v.gender || "?"} · {v.accent || "?"})
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 04 — Music & SFX: SFX is real (ElevenLabs Sound Effects API), sourced
          only from scenes Gemini actually reported a sound in — never an
          invented cue. Music has no verified generation endpoint in this
          stack and is shown as unsupported, not silently omitted. */}
      {job.storyAnalysis?.state === "completed" && (
        <div className="rounded-xl border border-white/10 bg-black/20 p-3.5 space-y-2.5" data-testid="voice-music-sfx-section">
          <div className="flex items-center gap-2">
            <AudioWaveform size={13} className="text-amber-300" />
            <span className="text-[12px] font-bold text-parchment flex-1">04 · Music &amp; SFX</span>
          </div>

          <div className="flex items-center gap-2 rounded-lg bg-white/[0.03] border border-white/10 p-2.5">
            <Music size={12} className="text-faded flex-shrink-0" />
            <span className="text-[11px] text-white/70 flex-1">Music generation</span>
            <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border flex-shrink-0"
                  data-testid="voice-music-status"
                  style={{ color: "#9ca3af", background: "rgba(255,255,255,0.05)", borderColor: "rgba(255,255,255,0.15)" }}>
              {musicStatus.supported ? "Supported" : "Pending"}
            </span>
          </div>
          {!musicStatus.supported && musicStatus.reason && (
            <p className="text-[10px] text-faded italic">{musicStatus.reason}</p>
          )}

          {sfxCandidateScenes.length === 0 ? (
            <p className="text-[10.5px] text-faded">Gemini hasn't reported any sound effects in this video yet.</p>
          ) : (
            <div className="space-y-1.5">
              {sfxCandidateScenes.map((s) => {
                const stage = job.sfx?.[s.sceneId];
                const state = stage?.state || "pending";
                return (
                  <div key={s.sceneId} className="rounded-lg bg-white/[0.03] border border-white/10 p-2.5 space-y-1.5"
                       data-testid={`voice-sfx-${s.sceneId}`}>
                    <div className="flex items-center gap-2">
                      <span className="text-[10.5px] font-semibold text-white/80 flex-1 truncate">{s.title || s.sceneId}</span>
                      <StageBadge state={state} testId={`voice-sfx-badge-${s.sceneId}`} />
                    </div>
                    <p className="text-[10.5px] text-white/60 italic">"{s.audioObservations.sfx}"</p>
                    <div className="flex items-center gap-2">
                      {state === "completed" && stage?.result?.mediaRef && (
                        <audio controls src={resolveMediaSrc(stage.result.mediaRef)} className="h-7"
                               style={{ maxWidth: 220 }} data-testid={`voice-sfx-audio-${s.sceneId}`} />
                      )}
                      {RETRYABLE_STATES.includes(state) && sfxStatus.supported && (
                        <button onClick={() => runAction(`sfx-${s.sceneId}`, () => generateSceneSfx(lesson.lessonId, s.sceneId))}
                                disabled={busy === `sfx-${s.sceneId}`}
                                data-testid={`voice-generate-sfx-${s.sceneId}`}
                                className="text-[10.5px] font-semibold px-2 py-1 rounded-lg border border-amber-400/40 text-amber-300 disabled:opacity-40">
                          {busy === `sfx-${s.sceneId}` ? "Generating…" : "Generate SFX"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 05 — Audio timeline: read-only inspection of the production
          layout, not an editor. Offsets are only shown once real, i.e.
          once ElevenLabs has actually generated the line — never guessed. */}
      {timeline && timeline.tracks.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-black/20 p-3.5 space-y-2" data-testid="voice-audio-timeline">
          <span className="text-[12px] font-bold text-parchment">05 · Audio Timeline</span>
          <div className="space-y-1.5">
            {timeline.tracks.map((t, i) => (
              <div key={`${t.sceneId}-${t.lineId || t.role}-${i}`}
                   className="flex items-center gap-2 text-[10.5px]" data-testid={`timeline-track-${i}`}>
                <span className="w-20 flex-shrink-0 truncate text-white/60 uppercase text-[9px] font-bold">
                  {t.role === "sfx" ? "SFX" : (t.speaker || t.role)}
                </span>
                <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden relative">
                  {t.start !== null && timeline.totalDurationSec ? (
                    <div className="absolute h-full rounded-full"
                         style={{
                           left: `${(t.start / timeline.totalDurationSec) * 100}%`,
                           width: `${Math.max(2, (t.duration / timeline.totalDurationSec) * 100)}%`,
                           background: t.role === "sfx" ? "rgba(96,165,250,0.6)" : GOLD,
                         }} />
                  ) : null}
                </div>
                <StageBadge state={t.generationStatus} testId={`timeline-track-badge-${i}`} />
              </div>
            ))}
          </div>
          <p className="text-[10px] text-faded">
            Original audio: <span className="font-semibold text-white/70">{timeline.sourceAudio.treatment}</span>
          </p>
        </div>
      )}

      {/* 06 — assemble + explicit publish gate */}
      {job.scriptBlueprint?.state === "completed" && (
        <div className="rounded-xl border border-white/10 bg-black/20 p-3.5 space-y-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-bold text-parchment flex-1">06 · Mix &amp; Assemble, Publish</span>
            <StageBadge state={job.assembly?.state} testId="voice-assembly-badge" />
          </div>
          <button onClick={() => runAction("assemble", () => assembleNarration(lesson.lessonId))}
                  disabled={busy === "assemble" || !allLinesComplete}
                  data-testid="voice-assemble-button"
                  className="text-[11.5px] font-semibold px-3 py-1.5 rounded-lg border border-amber-400/40 text-amber-300 disabled:opacity-40">
            {busy === "assemble" ? "Assembling…" : "Assemble narration track"}
          </button>
          {!allLinesComplete && (
            <p className="text-[10.5px] text-faded">Generate every line's voice above first.</p>
          )}

          {job.assembly?.state === "completed" && (
            <div className="space-y-2 pt-1">
              <audio controls src={resolveMediaSrc(job.assembly.result.mediaRef)} className="w-full"
                     data-testid="voice-assembled-preview" />

              {(job.assembly.result.sfxMixed?.length > 0 || job.assembly.result.sfxSkipped?.length > 0) && (
                <div className="text-[10px] text-faded space-y-0.5" data-testid="voice-sfx-mix-summary">
                  {job.assembly.result.sfxMixed?.length > 0 && (
                    <p>SFX mixed into this track: {job.assembly.result.sfxMixed.length} scene(s).</p>
                  )}
                  {job.assembly.result.sfxSkipped?.length > 0 && (
                    <p className="text-amber-300/80">
                      SFX not mixed for {job.assembly.result.sfxSkipped.length} scene(s):{" "}
                      {job.assembly.result.sfxSkipped.map((s) => s.reason).join("; ")}
                    </p>
                  )}
                </div>
              )}

              {job.published ? (
                <button onClick={() => runAction("unpublish", () => unpublishNarration(lesson.lessonId))}
                        disabled={busy === "unpublish"} data-testid="voice-unpublish-button"
                        className="text-[11.5px] font-semibold px-3 py-1.5 rounded-lg border border-white/15 text-white/70">
                  Unpublish (hide from students)
                </button>
              ) : (
                <button onClick={() => runAction("publish", () => publishNarration(lesson.lessonId))}
                        disabled={busy === "publish"} data-testid="voice-publish-button"
                        className="inline-flex items-center gap-1.5 text-[11.5px] font-bold px-3 py-1.5 rounded-lg bg-amber-500/90 text-black disabled:opacity-40">
                  <Rocket size={12} />
                  {job.render?.state === "completed" ? "Publish embedded-audio master" : "Publish (additive audio track)"}
                </button>
              )}
              {job.render?.state !== "completed" && (
                <p className="text-[10.5px] text-faded">
                  Optional: render a final master below first so students get one normal video file with the
                  narration physically embedded, instead of a separate audio track.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* 5 — optional final render: physically embeds the approved audio
          into the original video (server-side ffmpeg). Never required to
          publish — a lesson can ship with just the additive track above. */}
      {job.assembly?.state === "completed" && (
        <div className="rounded-xl border border-white/10 bg-black/20 p-3.5 space-y-2.5">
          <div className="flex items-center gap-2">
            <Film size={13} className="text-amber-300" />
            <span className="text-[12px] font-bold text-parchment flex-1">07 · Final Render (embed audio into video)</span>
            <StageBadge state={job.render?.state} testId="voice-render-badge" />
          </div>

          <div className="space-y-1.5" data-testid="voice-source-audio-treatment">
            <div className="flex items-center gap-1.5">
              <Volume2 size={11} className="text-faded" />
              <span className="text-[10px] font-bold uppercase tracking-wide text-faded">Original video audio</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {TREATMENT_OPTIONS.map((opt) => {
                const active = (job.sourceAudioTreatment || "mute") === opt.value;
                return (
                  <button key={opt.value} title={opt.hint}
                          onClick={() => runAction("treatment", () => setSourceAudioTreatment(lesson.lessonId, opt.value))}
                          disabled={busy === "treatment"}
                          data-testid={`voice-treatment-${opt.value}`}
                          className="text-[10.5px] font-semibold px-2.5 py-1 rounded-lg border disabled:opacity-40"
                          style={active
                            ? { borderColor: "rgba(212,168,67,0.5)", background: "rgba(212,168,67,0.12)", color: GOLD }
                            : { borderColor: "rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.65)" }}>
                    {opt.label}
                  </button>
                );
              })}
            </div>
            {job.render?.state === "completed" && (
              <p className="text-[10px] text-faded italic">Changing this takes effect on the next render, not the one above.</p>
            )}
          </div>

          {job.render?.state === "completed" ? (
            <div className="space-y-2">
              <video controls src={resolveMediaSrc(job.render.result.mediaRef)} className="w-full rounded-lg"
                     data-testid="voice-render-preview" />
              <p className="text-[10.5px] text-faded">
                Real embedded audio — this file plays correctly on any device, even downloaded, with no separate track.
              </p>
            </div>
          ) : (
            <>
              <button onClick={() => runAction("render", () => renderNarrationMaster(lesson.lessonId))}
                      disabled={busy === "render"}
                      data-testid="voice-render-button"
                      className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold px-3 py-1.5 rounded-lg border border-amber-400/40 text-amber-300 disabled:opacity-40">
                {busy === "render" ? <Loader2 size={11} className="animate-spin" /> : <Film size={11} />}
                {busy === "render" ? "Rendering…" : "Render final master"}
              </button>
              {job.render?.lastError && (
                <p className="text-[10.5px] text-red-400" data-testid="voice-render-error">
                  {job.render.lastError.toLowerCase().includes("ffmpeg not found") || job.render.lastError.toLowerCase().includes("unavailable")
                    ? "Server-side rendering isn't configured in this environment yet — publishing still works with the audio-only track above."
                    : job.render.lastError}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {err && <div className="text-[11.5px] text-red-400" data-testid="voice-error">{err}</div>}
    </div>
  );
}
