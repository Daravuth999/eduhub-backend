/**
 * PipelinePanel.test.jsx — RTL tests over the real rendered panel, same
 * convention as VoiceProductionPanel.test.jsx: mocks ../../videoLibraryApi
 * entirely.
 *
 * Focus: the "blocked cascade" fix. Several display rows share one real
 * backend step (e.g. "Gemini speech recognition" and "Speaker detection"
 * both mirror the backend's "speech_recognition" step). Before this fix,
 * a failed backend step made every row sharing it show the SAME raw
 * provider error under a different, unrelated label — misleadingly
 * implying two independent defects. Only the first row for a failed
 * backend step should show the real error; later rows must show a calm
 * "Blocked — X failed" instead.
 */
import { render, screen } from "@testing-library/react";
import PipelinePanel from "../PipelinePanel";

jest.mock("../../videoLibraryApi", () => ({
  getPipeline: jest.fn(),
  runPipeline: jest.fn(),
}));

const LESSON = { lessonId: "vid_1", title: "Sealing the Deal", mediaRef: "https://pub-x.r2.dev/vid.mov" };

function stepsWith(overrides) {
  const base = {
    media_check: { status: "complete" },
    audio_extraction: { status: "complete" },
    speech_recognition: { status: "pending" },
    synchronization: { status: "pending" },
    educational_analysis: { status: "pending" },
    review_ready: { status: "pending" },
  };
  return { ...base, ...overrides };
}

test("a failed speech_recognition step shows the real error once, and Speaker detection as Blocked", () => {
  const pipeline = {
    state: "failed",
    steps: stepsWith({
      speech_recognition: { status: "failed", error: "VideoAiError: Gemini returned no parsable segments" },
    }),
  };
  render(<PipelinePanel lesson={{ ...LESSON, pipeline }} onChanged={() => {}} />);

  const geminiRow = screen.getByTestId("pipeline-step-2"); // "Gemini speech recognition"
  expect(geminiRow).toHaveTextContent("Gemini speech recognition");
  expect(geminiRow).toHaveTextContent("VideoAiError: Gemini returned no parsable segments");

  const speakerRow = screen.getByTestId("pipeline-step-3"); // "Speaker detection"
  expect(speakerRow).toHaveTextContent("Speaker detection");
  expect(speakerRow).toHaveTextContent("Blocked");
  expect(speakerRow).toHaveTextContent("Gemini speech recognition failed");
  // The raw provider error must never be duplicated under this row.
  expect(speakerRow).not.toHaveTextContent("Gemini returned no parsable segments");
});

test("the same cascade rule applies to every secondary row sharing a failed backend step", () => {
  const pipeline = {
    state: "failed",
    steps: stepsWith({
      media_check: { status: "complete" },
      audio_extraction: { status: "complete" },
      speech_recognition: { status: "complete" },
      synchronization: { status: "complete" },
      educational_analysis: { status: "failed", error: "AnalysisError: transcript too short" },
    }),
  };
  render(<PipelinePanel lesson={{ ...LESSON, pipeline }} onChanged={() => {}} />);

  const primary = screen.getByTestId("pipeline-step-6"); // "Educational analysis"
  expect(primary).toHaveTextContent("AnalysisError: transcript too short");

  for (const i of [7, 8, 9]) { // Vocabulary extraction, Grammar notes, CEFR classification
    const row = screen.getByTestId(`pipeline-step-${i}`);
    expect(row).toHaveTextContent("Blocked");
    expect(row).toHaveTextContent("Educational analysis failed");
    expect(row).not.toHaveTextContent("transcript too short");
  }
});

test("when nothing has failed, no row shows a Blocked state", () => {
  const pipeline = { state: "complete", steps: stepsWith({
    media_check: { status: "complete" }, audio_extraction: { status: "complete" },
    speech_recognition: { status: "complete" }, synchronization: { status: "complete" },
    educational_analysis: { status: "complete" }, review_ready: { status: "complete" },
  }) };
  render(<PipelinePanel lesson={{ ...LESSON, pipeline }} onChanged={() => {}} />);
  expect(screen.queryByText(/Blocked/)).not.toBeInTheDocument();
});

// ── Silent video: "skipped" is an honest, non-alarming terminal state ─────
test("a silent video's skipped steps show an honest reason, never a failure", () => {
  const pipeline = {
    state: "complete",
    steps: stepsWith({
      audio_extraction: { status: "complete", error: "no audio track detected — this video is silent" },
      speech_recognition: { status: "skipped", error: "no audio track — nothing to transcribe" },
      synchronization: { status: "skipped", error: "no transcript to synchronize — this video has no audio" },
      educational_analysis: {
        status: "skipped", error: "no transcript to analyze — run Story Analysis for visual understanding",
      },
      review_ready: { status: "complete" },
    }),
  };
  render(<PipelinePanel lesson={{ ...LESSON, pipeline }} onChanged={() => {}} />);

  expect(screen.getByTestId("pipeline-state-badge")).toHaveTextContent("Complete");
  expect(screen.queryByText(/Blocked/)).not.toBeInTheDocument();
  expect(screen.queryByText(/^Failed$/)).not.toBeInTheDocument();

  const speechRow = screen.getByTestId("pipeline-step-2"); // "Gemini speech recognition"
  expect(speechRow).toHaveTextContent("no audio track — nothing to transcribe");

  const speakerRow = screen.getByTestId("pipeline-step-3"); // "Speaker detection"
  expect(speakerRow).toHaveTextContent("no audio track — nothing to transcribe");

  const eduRow = screen.getByTestId("pipeline-step-6"); // "Educational analysis"
  expect(eduRow).toHaveTextContent("run Story Analysis for visual understanding");
});

test("skipped steps count toward the progress meter like completed ones", () => {
  const pipeline = {
    state: "complete",
    steps: stepsWith({
      speech_recognition: { status: "skipped" },
      synchronization: { status: "skipped" },
      educational_analysis: { status: "skipped" },
      review_ready: { status: "complete" },
    }),
  };
  render(<PipelinePanel lesson={{ ...LESSON, pipeline }} onChanged={() => {}} />);
  // 11 display rows, all resolved (complete or skipped) — meter reads 100%.
  expect(screen.getByTestId("pipeline-progress-meter")).toHaveStyle({ width: "100%" });
});
