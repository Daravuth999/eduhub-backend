/**
 * VoiceProductionPanel.test.jsx — RTL tests over the real rendered panel.
 * Mocks ../../videoLibraryApi entirely, same convention as
 * VideoFactoryStudio.test.jsx / PipelinePanel's sibling tests.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import VoiceProductionPanel from "../VoiceProductionPanel";

jest.mock("../../videoLibraryApi", () => ({
  getNarration: jest.fn(),
  runStoryAnalysis: jest.fn(),
  runScriptBlueprint: jest.fn(),
  editScriptBlueprint: jest.fn(),
  setVoiceAssignments: jest.fn(),
  generateLineVoice: jest.fn(),
  resetLineVoice: jest.fn(),
  assembleNarration: jest.fn(),
  renderNarrationMaster: jest.fn(),
  setSourceAudioTreatment: jest.fn(),
  generateSceneSfx: jest.fn(),
  getNarrationTimeline: jest.fn(),
  publishNarration: jest.fn(),
  unpublishNarration: jest.fn(),
  listVoices: jest.fn(),
  resolveMediaSrc: (ref) => (ref ? `https://resolved/${ref}` : ""),
}));

import {
  getNarration, runStoryAnalysis, runScriptBlueprint, setVoiceAssignments,
  generateLineVoice, resetLineVoice, assembleNarration, renderNarrationMaster,
  setSourceAudioTreatment, generateSceneSfx, getNarrationTimeline,
  publishNarration, unpublishNarration, listVoices,
} from "../../videoLibraryApi";

const LESSON = { lessonId: "vid_1", title: "Ordering Coffee", mediaRef: "https://pub-x.r2.dev/vid.mp4" };

const NEW_STAGE = { state: "pending", attemptId: null, attemptCount: 0, generationVersion: 0, result: null, lastError: null };

function emptyJob(overrides = {}) {
  return {
    lessonId: "vid_1",
    storyAnalysis: { ...NEW_STAGE },
    scriptBlueprint: { ...NEW_STAGE },
    voiceAssignments: {},
    voiceProduction: {},
    assembly: { ...NEW_STAGE },
    render: { ...NEW_STAGE },
    sourceAudioTreatment: "mute",
    sfx: {},
    published: false,
    ...overrides,
  };
}

const STORY_RESULT = {
  summary: "A short story about ordering coffee.",
  characters: [{ name: "Emma", description: "the customer" }],
  scenes: [{ sceneId: "sc_1", title: "Greeting", narrativeRole: "setup" }],
};

const SCRIPT_RESULT = {
  scenes: [{
    sceneId: "sc_1",
    lines: [{ lineId: "ln_1", speaker: "Narrator", text: "Once upon a time.", emotion: "" }],
  }],
};

beforeEach(() => {
  jest.clearAllMocks();
  listVoices.mockResolvedValue([{ voice_id: "v1", name: "Rachel", gender: "female", accent: "American" }]);
  getNarrationTimeline.mockResolvedValue({ tracks: [], totalDurationSec: null, sourceAudio: { treatment: "mute", provenance: "original" } });
});

test("shows an honest no-media message when the lesson has no uploaded media", async () => {
  getNarration.mockResolvedValue(emptyJob());
  render(<VoiceProductionPanel lesson={{ lessonId: "vid_1" }} onChanged={() => {}} />);
  expect(await screen.findByTestId("voice-no-media")).toBeInTheDocument();
  expect(getNarration).not.toHaveBeenCalled();
});

test("shows the 'not started' badge and an Analyze story button when pending", async () => {
  getNarration.mockResolvedValue(emptyJob());
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  expect(await screen.findByTestId("voice-story-badge")).toHaveTextContent(/not started/i);
  expect(screen.getByTestId("voice-run-story-analysis")).toHaveTextContent(/analyze story/i);
});

test("clicking Analyze story calls runStoryAnalysis and renders the returned summary + scene timeline", async () => {
  getNarration.mockResolvedValue(emptyJob());
  runStoryAnalysis.mockResolvedValue(emptyJob({ storyAnalysis: { ...NEW_STAGE, state: "completed", result: STORY_RESULT } }));
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  fireEvent.click(await screen.findByTestId("voice-run-story-analysis"));
  await waitFor(() => expect(runStoryAnalysis).toHaveBeenCalledWith("vid_1"));
  expect(await screen.findByText("A short story about ordering coffee.")).toBeInTheDocument();
  expect(screen.getByTestId("voice-scene-sc_1")).toBeInTheDocument();
});

test("script draft button appears only once story analysis is completed", async () => {
  getNarration.mockResolvedValue(emptyJob());
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  await screen.findByTestId("voice-story-badge");
  expect(screen.queryByTestId("voice-run-script-blueprint")).not.toBeInTheDocument();
});

test("script editor renders lines with speaker/text once the blueprint is complete", async () => {
  getNarration.mockResolvedValue(emptyJob({
    storyAnalysis: { ...NEW_STAGE, state: "completed", result: STORY_RESULT },
    scriptBlueprint: { ...NEW_STAGE, state: "completed", result: SCRIPT_RESULT },
  }));
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  const editor = await screen.findByTestId("voice-script-editor");
  expect(editor).toHaveTextContent("Narrator");
  expect(editor).toHaveTextContent("Once upon a time.");
  expect(screen.getByTestId("voice-generate-ln_1")).toBeInTheDocument();
});

test("clicking Generate calls generateLineVoice with the right scene/line ids", async () => {
  const job = emptyJob({
    storyAnalysis: { ...NEW_STAGE, state: "completed", result: STORY_RESULT },
    scriptBlueprint: { ...NEW_STAGE, state: "completed", result: SCRIPT_RESULT },
  });
  getNarration.mockResolvedValue(job);
  generateLineVoice.mockResolvedValue({
    ...job,
    voiceProduction: { sc_1: { lines: { ln_1: { state: "completed", result: { mediaRef: "gridfs://sync_media/x.mp3", voiceStale: false } } } } },
  });
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  fireEvent.click(await screen.findByTestId("voice-generate-ln_1"));
  await waitFor(() => expect(generateLineVoice).toHaveBeenCalledWith("vid_1", "sc_1", "ln_1"));
  expect(await screen.findByTestId("voice-line-audio-ln_1")).toBeInTheDocument();
});

test("a stale completed line shows Regenerate, which resets then regenerates", async () => {
  const job = emptyJob({
    storyAnalysis: { ...NEW_STAGE, state: "completed", result: STORY_RESULT },
    scriptBlueprint: { ...NEW_STAGE, state: "completed", result: SCRIPT_RESULT },
    voiceProduction: { sc_1: { lines: { ln_1: { state: "completed", result: { voiceStale: true, mediaRef: "x" } } } } },
  });
  getNarration.mockResolvedValue(job);
  resetLineVoice.mockResolvedValue(job);
  generateLineVoice.mockResolvedValue(job);
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  const btn = await screen.findByTestId("voice-regenerate-ln_1");
  expect(btn).toBeInTheDocument();
  fireEvent.click(btn);
  await waitFor(() => expect(resetLineVoice).toHaveBeenCalledWith("vid_1", "sc_1", "ln_1"));
  await waitFor(() => expect(generateLineVoice).toHaveBeenCalledWith("vid_1", "sc_1", "ln_1"));
});

test("changing a voice assignment select calls setVoiceAssignments with the merged map", async () => {
  const job = emptyJob({
    storyAnalysis: { ...NEW_STAGE, state: "completed", result: STORY_RESULT },
    scriptBlueprint: { ...NEW_STAGE, state: "completed", result: SCRIPT_RESULT },
    voiceAssignments: {},
  });
  getNarration.mockResolvedValue(job);
  setVoiceAssignments.mockResolvedValue({ ...job, voiceAssignments: { Narrator: "v1" } });
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  const select = await screen.findByTestId("voice-select-Narrator");
  fireEvent.change(select, { target: { value: "v1" } });
  await waitFor(() => expect(setVoiceAssignments).toHaveBeenCalledWith("vid_1", { Narrator: "v1" }));
});

test("Assemble is disabled until every line is completed, then enabled", async () => {
  const jobIncomplete = emptyJob({
    storyAnalysis: { ...NEW_STAGE, state: "completed", result: STORY_RESULT },
    scriptBlueprint: { ...NEW_STAGE, state: "completed", result: SCRIPT_RESULT },
  });
  getNarration.mockResolvedValue(jobIncomplete);
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  expect(await screen.findByTestId("voice-assemble-button")).toBeDisabled();
});

test("Assemble becomes enabled and clicking it calls assembleNarration once every line is complete", async () => {
  const jobComplete = emptyJob({
    storyAnalysis: { ...NEW_STAGE, state: "completed", result: STORY_RESULT },
    scriptBlueprint: { ...NEW_STAGE, state: "completed", result: SCRIPT_RESULT },
    voiceProduction: { sc_1: { lines: { ln_1: { state: "completed", result: { mediaRef: "x" } } } } },
  });
  getNarration.mockResolvedValue(jobComplete);
  assembleNarration.mockResolvedValue({ ...jobComplete, assembly: { ...NEW_STAGE, state: "completed", result: { mediaRef: "gridfs://sync_media/full.mp3" } } });
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  const btn = await screen.findByTestId("voice-assemble-button");
  expect(btn).not.toBeDisabled();
  fireEvent.click(btn);
  await waitFor(() => expect(assembleNarration).toHaveBeenCalledWith("vid_1"));
  expect(await screen.findByTestId("voice-assembled-preview")).toBeInTheDocument();
  expect(screen.getByTestId("voice-publish-button")).toBeInTheDocument();
});

test("publish and unpublish call the right endpoints and toggle the button shown", async () => {
  const assembled = emptyJob({
    storyAnalysis: { ...NEW_STAGE, state: "completed", result: STORY_RESULT },
    scriptBlueprint: { ...NEW_STAGE, state: "completed", result: SCRIPT_RESULT },
    voiceProduction: { sc_1: { lines: { ln_1: { state: "completed", result: { mediaRef: "x" } } } } },
    assembly: { ...NEW_STAGE, state: "completed", result: { mediaRef: "gridfs://sync_media/full.mp3" } },
  });
  getNarration.mockResolvedValue(assembled);
  publishNarration.mockResolvedValue({ ...assembled, published: true });
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  const publishBtn = await screen.findByTestId("voice-publish-button");
  fireEvent.click(publishBtn);
  await waitFor(() => expect(publishNarration).toHaveBeenCalledWith("vid_1"));
  const unpublishBtn = await screen.findByTestId("voice-unpublish-button");

  unpublishNarration.mockResolvedValue({ ...assembled, published: false });
  fireEvent.click(unpublishBtn);
  await waitFor(() => expect(unpublishNarration).toHaveBeenCalledWith("vid_1"));
});

test("shows an honest disabled state and never fetches when enabled=false", async () => {
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} enabled={false} />);
  expect(await screen.findByTestId("voice-disabled")).toBeInTheDocument();
  expect(getNarration).not.toHaveBeenCalled();
  expect(listVoices).not.toHaveBeenCalled();
});

// ── Final render (physically embedded audio via server-side ffmpeg) ──────
const ASSEMBLED_JOB = emptyJob({
  storyAnalysis: { ...NEW_STAGE, state: "completed", result: STORY_RESULT },
  scriptBlueprint: { ...NEW_STAGE, state: "completed", result: SCRIPT_RESULT },
  voiceProduction: { sc_1: { lines: { ln_1: { state: "completed", result: { mediaRef: "x" } } } } },
  assembly: { ...NEW_STAGE, state: "completed", result: { mediaRef: "gridfs://sync_media/full.mp3" } },
});

test("shows an honest SFX mix summary when the assembly mixed or skipped SFX assets", async () => {
  getNarration.mockResolvedValue({
    ...ASSEMBLED_JOB,
    assembly: {
      ...NEW_STAGE, state: "completed",
      result: {
        mediaRef: "gridfs://sync_media/full.mp3",
        sfxMixed: ["sc_1"],
        sfxSkipped: [{ sceneId: "sc_2", reason: "scene has no narration line to anchor timing to" }],
      },
    },
  });
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  const summary = await screen.findByTestId("voice-sfx-mix-summary");
  expect(summary).toHaveTextContent("1 scene(s)");
  expect(summary).toHaveTextContent("scene has no narration line to anchor timing to");
});

test("no SFX mix summary appears when nothing was mixed or skipped", async () => {
  getNarration.mockResolvedValue(ASSEMBLED_JOB);
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  await screen.findByTestId("voice-assembled-preview");
  expect(screen.queryByTestId("voice-sfx-mix-summary")).not.toBeInTheDocument();
});

test("render section appears once assembly is complete, publish defaults to the additive-track label", async () => {
  getNarration.mockResolvedValue(ASSEMBLED_JOB);
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  expect(await screen.findByTestId("voice-render-button")).toBeInTheDocument();
  expect(screen.getByTestId("voice-publish-button")).toHaveTextContent(/additive audio track/i);
});

test("clicking Render final master calls renderNarrationMaster and shows the preview", async () => {
  getNarration.mockResolvedValue(ASSEMBLED_JOB);
  renderNarrationMaster.mockResolvedValue({
    ...ASSEMBLED_JOB,
    render: { ...NEW_STAGE, state: "completed", result: { mediaRef: "gridfs://sync_media/master.mp4", mode: "replace" } },
  });
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  fireEvent.click(await screen.findByTestId("voice-render-button"));
  await waitFor(() => expect(renderNarrationMaster).toHaveBeenCalledWith("vid_1"));
  expect(await screen.findByTestId("voice-render-preview")).toBeInTheDocument();
  expect(screen.getByTestId("voice-publish-button")).toHaveTextContent(/embedded-audio master/i);
});

test("a real ffmpeg-unavailable error is surfaced as an honest, non-alarming message", async () => {
  getNarration.mockResolvedValue(ASSEMBLED_JOB);
  renderNarrationMaster.mockResolvedValue({
    ...ASSEMBLED_JOB,
    render: { ...NEW_STAGE, state: "failed_terminal", lastError: "Server-side video rendering is unavailable in this environment (ffmpeg not found)." },
  });
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  fireEvent.click(await screen.findByTestId("voice-render-button"));
  expect(await screen.findByTestId("voice-render-error")).toHaveTextContent(/publishing still works with the audio-only track/i);
});

test("source audio treatment control defaults to mute and calls setSourceAudioTreatment on change", async () => {
  getNarration.mockResolvedValue(ASSEMBLED_JOB);
  setSourceAudioTreatment.mockResolvedValue({ ...ASSEMBLED_JOB, sourceAudioTreatment: "duck" });
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  await screen.findByTestId("voice-source-audio-treatment");
  fireEvent.click(screen.getByTestId("voice-treatment-duck"));
  await waitFor(() => expect(setSourceAudioTreatment).toHaveBeenCalledWith("vid_1", "duck"));
});

test("a note appears when a master is already rendered, warning treatment changes need a new render", async () => {
  getNarration.mockResolvedValue({
    ...ASSEMBLED_JOB,
    render: { ...NEW_STAGE, state: "completed", result: { mediaRef: "gridfs://sync_media/master.mp4", mode: "replace" } },
  });
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  expect(await screen.findByText(/takes effect on the next render/i)).toBeInTheDocument();
});

test("scene audio observations from Gemini are displayed when present", async () => {
  getNarration.mockResolvedValue(emptyJob());
  runStoryAnalysis.mockResolvedValue(emptyJob({
    storyAnalysis: {
      ...NEW_STAGE, state: "completed",
      result: {
        ...STORY_RESULT,
        scenes: [{
          sceneId: "sc_1", title: "Greeting", narrativeRole: "setup",
          audioObservations: { dialogue: "two people greeting", music: "", ambience: "café ambience", sfx: "" },
        }],
      },
    },
  }));
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  fireEvent.click(await screen.findByTestId("voice-run-story-analysis"));
  const box = await screen.findByTestId("voice-scene-audio-observations");
  expect(box).toHaveTextContent("two people greeting");
  expect(box).toHaveTextContent("café ambience");
});

test("a music/SFX-unsupported note appears only when Gemini actually observed music or sfx", async () => {
  getNarration.mockResolvedValue(emptyJob());
  runStoryAnalysis.mockResolvedValue(emptyJob({
    storyAnalysis: {
      ...NEW_STAGE, state: "completed",
      result: {
        ...STORY_RESULT,
        scenes: [{
          sceneId: "sc_1", title: "Greeting", narrativeRole: "setup",
          audioObservations: { dialogue: "", music: "soft background music", ambience: "", sfx: "" },
        }],
      },
    },
  }));
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  fireEvent.click(await screen.findByTestId("voice-run-story-analysis"));
  expect(await screen.findByTestId("voice-music-sfx-unsupported")).toBeInTheDocument();
});

test("no music/SFX note appears when no scene reports music or sfx", async () => {
  getNarration.mockResolvedValue(emptyJob());
  runStoryAnalysis.mockResolvedValue(emptyJob({ storyAnalysis: { ...NEW_STAGE, state: "completed", result: STORY_RESULT } }));
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  fireEvent.click(await screen.findByTestId("voice-run-story-analysis"));
  await screen.findByTestId("voice-scene-sc_1");
  expect(screen.queryByTestId("voice-music-sfx-unsupported")).not.toBeInTheDocument();
});

test("a rich multi-word performance direction is shown as a full Performance line, not a parenthetical", async () => {
  const job = emptyJob({
    storyAnalysis: { ...NEW_STAGE, state: "completed", result: STORY_RESULT },
    scriptBlueprint: {
      ...NEW_STAGE, state: "completed",
      result: { scenes: [{ sceneId: "sc_1", lines: [{
        lineId: "ln_1", speaker: "Narrator", text: "Are you okay?",
        emotion: "Gentle concern, natural conversational pace, a slight hesitation before asking.",
      }] }] },
    },
  });
  getNarration.mockResolvedValue(job);
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  const perf = await screen.findByTestId("voice-line-performance-ln_1");
  expect(perf).toHaveTextContent("Gentle concern, natural conversational pace, a slight hesitation before asking.");
});

// ── Music & SFX section ────────────────────────────────────────────────
const STORY_WITH_SFX = {
  ...STORY_RESULT,
  scenes: [{
    sceneId: "sc_1", title: "Greeting", narrativeRole: "setup",
    audioObservations: { dialogue: "", music: "", ambience: "", sfx: "a door creaks open" },
  }],
};

test("Music & SFX section shows an honest pending badge and reason when music generation is unsupported", async () => {
  getNarration.mockResolvedValue(emptyJob({ storyAnalysis: { ...NEW_STAGE, state: "completed", result: STORY_RESULT } }));
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}}
                                musicStatus={{ supported: false, reason: "No verified endpoint." }} />);
  const section = await screen.findByTestId("voice-music-sfx-section");
  expect(section).toHaveTextContent(/pending/i);
  expect(section).toHaveTextContent("No verified endpoint.");
});

test("Music & SFX section shows an honest empty state when Gemini reported no sound effects", async () => {
  getNarration.mockResolvedValue(emptyJob({ storyAnalysis: { ...NEW_STAGE, state: "completed", result: STORY_RESULT } }));
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  const section = await screen.findByTestId("voice-music-sfx-section");
  expect(section).toHaveTextContent(/hasn't reported any sound effects/i);
});

test("Music & SFX section lists a detected SFX scene and Generate SFX calls the API", async () => {
  const job = emptyJob({ storyAnalysis: { ...NEW_STAGE, state: "completed", result: STORY_WITH_SFX } });
  getNarration.mockResolvedValue(job);
  generateSceneSfx.mockResolvedValue({
    ...job, sfx: { sc_1: { state: "completed", result: { mediaRef: "gridfs://sync_media/sfx.mp3" } } },
  });
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} sfxStatus={{ supported: true }} />);
  const sceneCard = await screen.findByTestId("voice-sfx-sc_1");
  expect(sceneCard).toHaveTextContent("a door creaks open");
  fireEvent.click(screen.getByTestId("voice-generate-sfx-sc_1"));
  await waitFor(() => expect(generateSceneSfx).toHaveBeenCalledWith("vid_1", "sc_1"));
  expect(await screen.findByTestId("voice-sfx-audio-sc_1")).toBeInTheDocument();
});

test("Generate SFX button is absent when the platform reports sfx unsupported", async () => {
  getNarration.mockResolvedValue(emptyJob({ storyAnalysis: { ...NEW_STAGE, state: "completed", result: STORY_WITH_SFX } }));
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} sfxStatus={{ supported: false }} />);
  await screen.findByTestId("voice-sfx-sc_1");
  expect(screen.queryByTestId("voice-generate-sfx-sc_1")).not.toBeInTheDocument();
});

// ── Audio timeline (read-only) ────────────────────────────────────────────
test("audio timeline renders real tracks with generation status, and stays absent when empty", async () => {
  getNarration.mockResolvedValue(emptyJob({
    storyAnalysis: { ...NEW_STAGE, state: "completed", result: STORY_RESULT },
    scriptBlueprint: { ...NEW_STAGE, state: "completed", result: SCRIPT_RESULT },
  }));
  getNarrationTimeline.mockResolvedValue({
    tracks: [{
      sceneId: "sc_1", lineId: "ln_1", role: "narrator", type: "narration", speaker: "Narrator",
      start: 0, duration: 3.2, end: 3.2, generationStatus: "completed",
      provider: "elevenlabs", providerAssetId: "gridfs://x.mp3", volume: 1, treatment: "add", provenance: "ai",
    }],
    totalDurationSec: 3.2, sourceAudio: { treatment: "mute", provenance: "original" },
  });
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  const timelineEl = await screen.findByTestId("voice-audio-timeline");
  expect(timelineEl).toHaveTextContent(/mute/i);
  expect(screen.getByTestId("timeline-track-0")).toBeInTheDocument();
});

test("audio timeline section is absent before any script exists", async () => {
  getNarration.mockResolvedValue(emptyJob());
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  await screen.findByTestId("voice-production-panel");
  expect(getNarrationTimeline).not.toHaveBeenCalled();
  expect(screen.queryByTestId("voice-audio-timeline")).not.toBeInTheDocument();
});

test("a real backend error message is surfaced, not swallowed", async () => {
  getNarration.mockResolvedValue(emptyJob());
  runStoryAnalysis.mockRejectedValue(new Error("GEMINI_API_KEY is not configured"));
  render(<VoiceProductionPanel lesson={LESSON} onChanged={() => {}} />);
  fireEvent.click(await screen.findByTestId("voice-run-story-analysis"));
  expect(await screen.findByTestId("voice-error")).toHaveTextContent("GEMINI_API_KEY is not configured");
});
