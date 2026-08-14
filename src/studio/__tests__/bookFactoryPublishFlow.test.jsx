/**
 * bookFactoryPublishFlow.test.jsx — BookFactoryPublishFlow state machine.
 *
 * §AMENDMENT 6/10: the component must treat the backend job document as the
 * ONLY source of truth. These tests assert every action re-fetches the job
 * afterward, that a mount always re-fetches (no localStorage shortcut for
 * "already done"), and that optional-stage failures never block the primary
 * save/publish actions.
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
}));
jest.mock("../api", () => ({ listVoices: jest.fn() }));

const api = require("../bookFactory/bookFactoryApi");
const { listVoices } = require("../api");
const BookFactoryPublishFlow = require("../bookFactory/BookFactoryPublishFlow").default;

const EMPTY_JOB = {
  jobId: "job1", chapterOrder: ["c1", "c2"],
  chapters: { c1: { title: "Chapter One" }, c2: { title: "Chapter Two" } },
  cover: { state: "pending", coverImage: "" },
  narration: {},
  savedBookSlug: null, savedBookRevision: null, publishedAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  listVoices.mockResolvedValue({ voices: [{ voice_id: "v1", name: "Voice One" }], default_voice_id: "v1" });
  api.getJob.mockResolvedValue({ job: { ...EMPTY_JOB } });
});

test("mounting always re-fetches job state from the backend (never trusts stale props)", async () => {
  await act(async () => {
    render(<BookFactoryPublishFlow jobId="job1" coverEnabled={false} narrationEnabled={false} />);
  });
  await waitFor(() => expect(api.getJob).toHaveBeenCalledWith("job1"));
});

test("Publish is disabled until a slug is bound by Save Draft", async () => {
  await act(async () => {
    render(<BookFactoryPublishFlow jobId="job1" coverEnabled={false} narrationEnabled={false} />);
  });
  await waitFor(() => expect(screen.getByTestId("bf-publish-btn")).toBeDisabled());
});

test("Save Draft success refreshes job state and enables Publish", async () => {
  api.saveDraft.mockResolvedValue({ slug: "my-book-bf-abc", revision: 1 });
  api.getJob
    .mockResolvedValueOnce({ job: { ...EMPTY_JOB } })
    .mockResolvedValueOnce({ job: { ...EMPTY_JOB, savedBookSlug: "my-book-bf-abc", savedBookRevision: 1 } });

  await act(async () => {
    render(<BookFactoryPublishFlow jobId="job1" coverEnabled={false} narrationEnabled={false} />);
  });
  await act(async () => { fireEvent.click(screen.getByTestId("bf-save-draft-btn")); });
  await waitFor(() => expect(screen.getByTestId("bf-publish-btn")).not.toBeDisabled());
  expect(screen.getByTestId("bf-saved-slug").textContent).toMatch(/my-book-bf-abc/);
});

test("Publish requires explicit confirmation before calling the API", async () => {
  api.getJob.mockResolvedValue({ job: { ...EMPTY_JOB, savedBookSlug: "s1", savedBookRevision: 1 } });
  await act(async () => {
    render(<BookFactoryPublishFlow jobId="job1" coverEnabled={false} narrationEnabled={false} />);
  });
  await waitFor(() => expect(screen.getByTestId("bf-publish-btn")).not.toBeDisabled());
  await act(async () => { fireEvent.click(screen.getByTestId("bf-publish-btn")); });
  expect(api.publishJob).not.toHaveBeenCalled(); // first click only opens confirmation
  expect(screen.getByTestId("bf-publish-confirm")).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByTestId("bf-publish-confirm-yes")); });
  await waitFor(() => expect(api.publishJob).toHaveBeenCalledWith("job1"));
});

test("cover panel: generate button triggers generateCover then refreshes job", async () => {
  api.generateCover.mockResolvedValue({ result: { status: "completed" } });
  api.getJob
    .mockResolvedValueOnce({ job: { ...EMPTY_JOB } })
    .mockResolvedValueOnce({ job: { ...EMPTY_JOB, cover: { state: "completed", coverImage: "https://x/y.png" } } });

  await act(async () => {
    render(<BookFactoryPublishFlow jobId="job1" coverEnabled narrationEnabled={false} />);
  });
  await act(async () => { fireEvent.click(screen.getByTestId("bf-generate-cover-btn")); });
  await waitFor(() => expect(api.generateCover).toHaveBeenCalledWith("job1"));
  expect(screen.getByTestId("bf-cover-preview")).toHaveAttribute("src", "https://x/y.png");
});

test("cover failure is surfaced but never disables Save Draft / Publish actions", async () => {
  api.generateCover.mockRejectedValue(new Error("cover provider unavailable"));
  await act(async () => {
    render(<BookFactoryPublishFlow jobId="job1" coverEnabled narrationEnabled={false} />);
  });
  await act(async () => { fireEvent.click(screen.getByTestId("bf-generate-cover-btn")); });
  await waitFor(() => expect(screen.getByTestId("bf-publish-flow-error")).toBeInTheDocument());
  expect(screen.getByTestId("bf-save-draft-btn")).not.toBeDisabled();
});

test("narration panel requires a saved slug before narrating", async () => {
  await act(async () => {
    render(<BookFactoryPublishFlow jobId="job1" coverEnabled={false} narrationEnabled />);
  });
  expect(screen.getByTestId("bf-narration-panel").textContent).toMatch(/Save to Library as Draft first/i);
});

test("narrate-all skips chapters already completed (server-authoritative, not re-run)", async () => {
  api.getJob.mockResolvedValue({
    job: {
      ...EMPTY_JOB, savedBookSlug: "s1", savedBookRevision: 2,
      narration: { c1: { state: "completed" }, c2: { state: "pending" } },
    },
  });
  api.narrateChapter.mockResolvedValue({ result: { status: "completed" } });

  await act(async () => {
    render(<BookFactoryPublishFlow jobId="job1" coverEnabled={false} narrationEnabled />);
  });
  await waitFor(() => expect(screen.getByTestId("bf-narrate-all-btn")).toBeInTheDocument());
  await act(async () => { fireEvent.click(screen.getByTestId("bf-narrate-all-btn")); });
  await waitFor(() => expect(api.narrateChapter).toHaveBeenCalledTimes(1));
  expect(api.narrateChapter).toHaveBeenCalledWith("job1", "c2", expect.objectContaining({}));
});

test("a per-chapter narration failure does not block other chapters", async () => {
  let call = 0;
  api.getJob.mockResolvedValue({
    job: { ...EMPTY_JOB, savedBookSlug: "s1", savedBookRevision: 2, narration: {} },
  });
  api.narrateChapter.mockImplementation(() => {
    call += 1;
    if (call === 1) return Promise.reject(new Error("chapter 1 failed"));
    return Promise.resolve({ result: { status: "completed" } });
  });

  await act(async () => {
    render(<BookFactoryPublishFlow jobId="job1" coverEnabled={false} narrationEnabled />);
  });
  await waitFor(() => expect(screen.getByTestId("bf-narrate-all-btn")).toBeInTheDocument());
  await act(async () => { fireEvent.click(screen.getByTestId("bf-narrate-all-btn")); });
  await waitFor(() => expect(api.narrateChapter).toHaveBeenCalledTimes(2));
});
