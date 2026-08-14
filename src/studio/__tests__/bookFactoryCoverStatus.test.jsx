/**
 * bookFactoryCoverStatus.test.jsx — Part H/I teacher-facing cover messages.
 */
import React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";

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
const BookFactoryPublishFlow = require("../bookFactory/BookFactoryPublishFlow").default;

const BASE_JOB = {
  jobId: "job1", chapterOrder: ["c1"], chapters: { c1: { title: "Ch1", blocks: [] } },
  narration: {}, conversationAudio: {}, savedBookSlug: "s1", savedBookRevision: 1, publishedAt: null,
};

beforeEach(() => jest.clearAllMocks());

async function renderWithCoverStatus(coverTeacherStatus, cover = {}) {
  api.getJob.mockResolvedValue({ job: { ...BASE_JOB, cover, coverTeacherStatus } });
  await act(async () => {
    render(<BookFactoryPublishFlow jobId="job1" coverEnabled narrationEnabled={false} />);
  });
  await waitFor(() => expect(screen.getByTestId("bf-cover-panel")).toBeInTheDocument());
}

test("featureDisabled message shown and Generate button disabled", async () => {
  await renderWithCoverStatus({ state: "featureDisabled", message: "AI cover generation is not enabled.", usingFallback: "stylized" });
  expect(screen.getByTestId("bf-cover-status-message").textContent).toMatch(/not enabled/i);
  expect(screen.getByTestId("bf-generate-cover-btn")).toBeDisabled();
  expect(screen.getByTestId("bf-cover-fallback-note").textContent).toMatch(/stylized fallback/i);
});

test("keyUnavailable message shown", async () => {
  await renderWithCoverStatus({ state: "keyUnavailable", message: "Gemini image service is unavailable.", usingFallback: "stylized" });
  expect(screen.getByTestId("bf-cover-status-message").textContent).toMatch(/Gemini image service/i);
  expect(screen.getByTestId("bf-generate-cover-btn")).toBeDisabled();
});

test("storageUnavailable message shown", async () => {
  await renderWithCoverStatus({ state: "storageUnavailable", message: "Cover storage is not configured — cover was generated but could not be stored.", usingFallback: "stylized" });
  expect(screen.getByTestId("bf-cover-status-message").textContent).toMatch(/could not be stored/i);
});

test("completed state shows no fallback note and enables Regenerate", async () => {
  await renderWithCoverStatus(
    { state: "completed", message: "AI cover generated.", usingFallback: null },
    { coverImage: "https://x/cover.png" },
  );
  expect(screen.getByTestId("bf-cover-preview")).toBeInTheDocument();
  expect(screen.queryByTestId("bf-cover-fallback-note")).toBeNull();
  expect(screen.getByTestId("bf-generate-cover-btn")).not.toBeDisabled();
  expect(screen.getByTestId("bf-generate-cover-btn").textContent).toMatch(/Regenerate Cover/i);
});

test("manual URL fallback note shown when teacher provided one", async () => {
  await renderWithCoverStatus({ state: "pending", message: "Cover has not been generated yet.", usingFallback: "manual_url" });
  expect(screen.getByTestId("bf-cover-fallback-note").textContent).toMatch(/manual Cover Image URL/i);
});

test("terminal failure message shown with amber styling and button re-enabled for retry", async () => {
  await renderWithCoverStatus({ state: "terminalFailure", message: "Cover generation failed and will not retry automatically.", usingFallback: "stylized" });
  const msg = screen.getByTestId("bf-cover-status-message");
  expect(msg.textContent).toMatch(/will not retry automatically/i);
  expect(screen.getByTestId("bf-generate-cover-btn")).not.toBeDisabled();
});
