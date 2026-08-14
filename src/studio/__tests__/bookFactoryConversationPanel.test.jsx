/**
 * bookFactoryConversationPanel.test.jsx — Phase E frontend: speaker mapping,
 * Auto voice-pack, one-click conversation-audio generation, resume, and
 * retry-failed-lines-only, all driven off the backend job document.
 */
import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

jest.mock("../bookFactory/bookFactoryApi", () => ({
  getJob: jest.fn(),
  saveDraft: jest.fn(),
  publishJob: jest.fn(),
  generateCover: jest.fn(),
  regenerateCover: jest.fn(),
  narrateChapter: jest.fn(),
  initConversationAudio: jest.fn(),
  generateConversationLine: jest.fn(),
  retryConversationLine: jest.fn(),
  assembleConversationAudio: jest.fn(),
}));
jest.mock("../api", () => ({ listVoices: jest.fn() }));

const api = require("../bookFactory/bookFactoryApi");
const { listVoices } = require("../api");
const BookFactoryPublishFlow = require("../bookFactory/BookFactoryPublishFlow").default;

const DIALOG_CHAPTER = {
  title: "Dialogue Chapter",
  blocks: [
    { type: "dialog", speaker: "Dara", text: "Good morning!" },
    { type: "dialog", speaker: "Maya", text: "Hello there!" },
  ],
};

const BASE_JOB = {
  jobId: "job1", chapterOrder: ["c1"], chapters: { c1: DIALOG_CHAPTER },
  cover: { state: "pending", coverImage: "" }, narration: {},
  conversationAudio: {}, savedBookSlug: "book-slug-1", savedBookRevision: 1, publishedAt: null,
};

const VOICES = [{ voice_id: "v1", name: "Voice One" }, { voice_id: "v2", name: "Voice Two" }];

beforeEach(() => {
  jest.clearAllMocks();
  listVoices.mockResolvedValue({ voices: VOICES, default_voice_id: "v1" });
  api.getJob.mockResolvedValue({ job: { ...BASE_JOB } });
});

async function renderFlow(jobOverride) {
  if (jobOverride) api.getJob.mockResolvedValue({ job: jobOverride });
  await act(async () => {
    render(<BookFactoryPublishFlow jobId="job1" coverEnabled={false} narrationEnabled={false} conversationAudioEnabled />);
  });
  await waitFor(() => expect(screen.getByTestId("bf-conversation-panel")).toBeInTheDocument());
}

test("panel is hidden when no chapter has dialog blocks", async () => {
  api.getJob.mockResolvedValue({ job: { ...BASE_JOB, chapters: { c1: { title: "Story", blocks: [{ type: "paragraph", text: "x" }] } } } });
  await act(async () => {
    render(<BookFactoryPublishFlow jobId="job1" coverEnabled={false} narrationEnabled={false} conversationAudioEnabled />);
  });
  await waitFor(() => expect(screen.getByTestId("bf-publish-flow")).toBeInTheDocument());
  expect(screen.queryByTestId("bf-conversation-panel")).toBeNull();
});

test("requires a saved slug before showing per-chapter panels", async () => {
  await renderFlow({ ...BASE_JOB, savedBookSlug: null });
  expect(screen.getByTestId("bf-conversation-panel").textContent).toMatch(/Save to Library as Draft first/i);
  expect(screen.queryByTestId("bf-conversation-chapter-c1")).toBeNull();
});

// ── speaker mapping + auto voice-pack ──────────────────────────────────────
test("renders one voice dropdown per detected speaker, round-robin assigned by default", async () => {
  await renderFlow();
  expect(screen.getByTestId("bf-conversation-voice-c1-Dara").value).toBe("v1");
  expect(screen.getByTestId("bf-conversation-voice-c1-Maya").value).toBe("v2");
});

test("Auto voice pack resets manual overrides back to round-robin", async () => {
  await renderFlow();
  fireEvent.change(screen.getByTestId("bf-conversation-voice-c1-Dara"), { target: { value: "v2" } });
  expect(screen.getByTestId("bf-conversation-voice-c1-Dara").value).toBe("v2");
  fireEvent.click(screen.getByTestId("bf-auto-voice-pack-c1"));
  expect(screen.getByTestId("bf-conversation-voice-c1-Dara").value).toBe("v1");
});

// ── one-click generation: init -> lines -> assemble ────────────────────────
test("one click drives init, generates every line, then assembles", async () => {
  await renderFlow();
  api.initConversationAudio.mockResolvedValue({ success: true });
  const afterInit = {
    ...BASE_JOB,
    conversationAudio: { c1: { lineOrder: ["ln0", "ln1"], lines: {
      ln0: { state: "pending", speaker: "Dara", text: "Good morning!" },
      ln1: { state: "pending", speaker: "Maya", text: "Hello there!" },
    }, assembly: { state: "pending" } } },
  };
  const afterLine0 = JSON.parse(JSON.stringify(afterInit));
  afterLine0.conversationAudio.c1.lines.ln0.state = "completed";
  const afterLine1 = JSON.parse(JSON.stringify(afterLine0));
  afterLine1.conversationAudio.c1.lines.ln1.state = "completed";
  const afterAssemble = JSON.parse(JSON.stringify(afterLine1));
  afterAssemble.conversationAudio.c1.assembly = { state: "completed", audioUrl: "https://x/a.mp3" };

  api.getJob
    .mockResolvedValueOnce({ job: afterInit })   // after init
    .mockResolvedValueOnce({ job: afterLine0 })  // after generating ln0
    .mockResolvedValueOnce({ job: afterLine1 })  // after generating ln1
    .mockResolvedValueOnce({ job: afterAssemble }); // after assemble

  await act(async () => { fireEvent.click(screen.getByTestId("bf-generate-conversation-c1")); });

  await waitFor(() => expect(screen.getByTestId("bf-conversation-assembled-c1")).toBeInTheDocument());
  expect(api.initConversationAudio).toHaveBeenCalledWith("job1", "c1", { voiceAssignments: { Dara: "v1", Maya: "v2" } });
  expect(api.generateConversationLine).toHaveBeenCalledTimes(2);
  expect(api.generateConversationLine).toHaveBeenNthCalledWith(1, "job1", "c1", "ln0");
  expect(api.generateConversationLine).toHaveBeenNthCalledWith(2, "job1", "c1", "ln1");
  expect(api.assembleConversationAudio).toHaveBeenCalledWith("job1", "c1");
});

test("blocks generation and shows an error when a speaker has no voice assigned", async () => {
  await renderFlow();
  fireEvent.change(screen.getByTestId("bf-conversation-voice-c1-Dara"), { target: { value: "" } });
  await act(async () => { fireEvent.click(screen.getByTestId("bf-generate-conversation-c1")); });
  expect(api.initConversationAudio).not.toHaveBeenCalled();
  expect(screen.getByTestId("bf-publish-flow-error").textContent).toMatch(/Assign a voice to every speaker/i);
});

// ── resume: never re-pays for a completed line ─────────────────────────────
test("resume skips lines already completed — no duplicate paid call", async () => {
  const alreadyPartlyDone = {
    ...BASE_JOB,
    conversationAudio: { c1: { lineOrder: ["ln0", "ln1"], lines: {
      ln0: { state: "completed", speaker: "Dara", text: "Good morning!" },
      ln1: { state: "pending", speaker: "Maya", text: "Hello there!" },
    }, assembly: { state: "pending" } } },
  };
  await renderFlow(alreadyPartlyDone);

  const afterLine1 = JSON.parse(JSON.stringify(alreadyPartlyDone));
  afterLine1.conversationAudio.c1.lines.ln1.state = "completed";
  const afterAssemble = JSON.parse(JSON.stringify(afterLine1));
  afterAssemble.conversationAudio.c1.assembly = { state: "completed", audioUrl: "https://x/a.mp3" };

  api.getJob
    .mockResolvedValueOnce({ job: alreadyPartlyDone }) // after init (no-op resave)
    .mockResolvedValueOnce({ job: afterLine1 })
    .mockResolvedValueOnce({ job: afterAssemble });

  await act(async () => { fireEvent.click(screen.getByTestId("bf-generate-conversation-c1")); });
  await waitFor(() => expect(screen.getByTestId("bf-conversation-assembled-c1")).toBeInTheDocument());

  expect(api.generateConversationLine).toHaveBeenCalledTimes(1); // ONLY ln1 — ln0 was already completed
  expect(api.generateConversationLine).toHaveBeenCalledWith("job1", "c1", "ln1");
});

// ── retry-failed-lines-only ────────────────────────────────────────────────
test("retry failed lines only touches failed lines, never completed or pending ones", async () => {
  const mixedState = {
    ...BASE_JOB,
    conversationAudio: { c1: { lineOrder: ["ln0", "ln1", "ln2"], lines: {
      ln0: { state: "completed", speaker: "Dara", text: "a" },
      ln1: { state: "failed_retryable", speaker: "Maya", text: "b" },
      ln2: { state: "pending", speaker: "Dara", text: "c" },
    }, assembly: { state: "pending" } } },
  };
  await renderFlow(mixedState);
  expect(screen.getByTestId("bf-retry-failed-lines-c1")).toBeInTheDocument();

  api.getJob.mockResolvedValue({ job: mixedState });
  await act(async () => { fireEvent.click(screen.getByTestId("bf-retry-failed-lines-c1")); });

  expect(api.retryConversationLine).toHaveBeenCalledTimes(1);
  expect(api.retryConversationLine).toHaveBeenCalledWith("job1", "c1", "ln1");
  expect(api.generateConversationLine).toHaveBeenCalledTimes(1);
  expect(api.generateConversationLine).toHaveBeenCalledWith("job1", "c1", "ln1");
});

test("retry-failed-lines-only button does not appear when there are no failed lines", async () => {
  const allGood = {
    ...BASE_JOB,
    conversationAudio: { c1: { lineOrder: ["ln0"], lines: {
      ln0: { state: "completed", speaker: "Dara", text: "a" },
    }, assembly: { state: "completed", audioUrl: "https://x/a.mp3" } } },
  };
  await renderFlow(allGood);
  expect(screen.queryByTestId("bf-retry-failed-lines-c1")).toBeNull();
});
