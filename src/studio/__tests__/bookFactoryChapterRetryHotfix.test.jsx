/**
 * bookFactoryChapterRetryHotfix.test.jsx — EMERGENCY SURGICAL HOTFIX frontend
 * coverage: an explicit, confirmation-gated "Retry Chapter" action for
 * failed_terminal/unknown_outcome chapters, friendly (non-raw) status labels,
 * collapsible technical details, "Retry All Failed" with a call-count
 * estimate, and the Prepare Handoff incomplete-draft guard. No live network —
 * bookFactoryApi is mocked throughout.
 */
import React from "react";
import { render, fireEvent, waitFor, act, screen } from "@testing-library/react";

import BookFactoryChapterReview from "../bookFactory/BookFactoryChapterReview";

// ── BookFactoryChapterReview (pure component) ──────────────────────────────
function jobWith(chapters, order) {
  return { chapterOrder: order || Object.keys(chapters), chapters };
}

describe("BookFactoryChapterReview — failed-chapter recovery", () => {
  test("failed_terminal chapter shows a Retry Chapter action", () => {
    const job = jobWith({ c1: { title: "Ch1", state: "failed_terminal" } });
    render(<BookFactoryChapterReview job={job} onRetryFailed={jest.fn()} />);
    expect(screen.getByTestId("bf-retry-failed-c1")).toBeInTheDocument();
  });

  test("unknown_outcome chapter also shows a Retry Chapter action", () => {
    const job = jobWith({ c1: { title: "Ch1", state: "unknown_outcome" } });
    render(<BookFactoryChapterReview job={job} onRetryFailed={jest.fn()} />);
    expect(screen.getByTestId("bf-retry-failed-c1")).toBeInTheDocument();
  });

  test("retry requires an explicit confirmation before calling onRetryFailed", () => {
    const job = jobWith({ c1: { title: "Ch1", state: "failed_terminal" } });
    const onRetryFailed = jest.fn();
    render(<BookFactoryChapterReview job={job} onRetryFailed={onRetryFailed} />);
    fireEvent.click(screen.getByTestId("bf-retry-failed-c1"));
    expect(onRetryFailed).not.toHaveBeenCalled();
    expect(screen.getByTestId("bf-retry-failed-confirm-c1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("bf-retry-failed-confirm-go-c1"));
    expect(onRetryFailed).toHaveBeenCalledWith("c1");
    expect(onRetryFailed).toHaveBeenCalledTimes(1);
  });

  test("cancelling the confirmation never calls onRetryFailed", () => {
    const job = jobWith({ c1: { title: "Ch1", state: "failed_terminal" } });
    const onRetryFailed = jest.fn();
    render(<BookFactoryChapterReview job={job} onRetryFailed={onRetryFailed} />);
    fireEvent.click(screen.getByTestId("bf-retry-failed-c1"));
    fireEvent.click(screen.getByTestId("bf-retry-failed-cancel-c1"));
    expect(onRetryFailed).not.toHaveBeenCalled();
    expect(screen.queryByTestId("bf-retry-failed-confirm-c1")).toBeNull();
  });

  test("only the confirmed chapter retries — a sibling failed chapter is untouched", () => {
    const job = jobWith({
      c1: { title: "Ch1", state: "failed_terminal" },
      c2: { title: "Ch2", state: "failed_terminal" },
    });
    const onRetryFailed = jest.fn();
    render(<BookFactoryChapterReview job={job} onRetryFailed={onRetryFailed} />);
    fireEvent.click(screen.getByTestId("bf-retry-failed-c1"));
    fireEvent.click(screen.getByTestId("bf-retry-failed-confirm-go-c1"));
    expect(onRetryFailed).toHaveBeenCalledWith("c1");
    expect(onRetryFailed).not.toHaveBeenCalledWith("c2");
    expect(onRetryFailed).toHaveBeenCalledTimes(1);
  });

  test("a completed chapter never renders a Retry Chapter button (cannot accidentally retry)", () => {
    const job = jobWith({ c1: { title: "Ch1", state: "completed", warnings: [] } });
    render(<BookFactoryChapterReview job={job} onRetryFailed={jest.fn()} />);
    expect(screen.queryByTestId("bf-retry-failed-c1")).toBeNull();
  });

  test("completed chapter with warnings shows friendly 'Complete with review notes'", () => {
    const job = jobWith({
      c1: {
        title: "Ch1", state: "completed",
        warnings: [{ type: "vocab_issue", reason: "vocab_khmer_missing:test" }],
      },
    });
    render(<BookFactoryChapterReview job={job} onRetryFailed={jest.fn()} />);
    expect(screen.getByTestId("bf-friendly-status-c1").textContent).toMatch(/complete with review notes/i);
    // Raw warning codes are not part of the primary label.
    expect(screen.getByTestId("bf-friendly-status-c1").textContent).not.toMatch(/vocab_khmer_missing/);
  });

  test("completed chapter with no warnings shows plain 'Complete'", () => {
    const job = jobWith({ c1: { title: "Ch1", state: "completed", warnings: [] } });
    render(<BookFactoryChapterReview job={job} onRetryFailed={jest.fn()} />);
    expect(screen.getByTestId("bf-friendly-status-c1").textContent).toMatch(/^Complete$/i);
  });

  test("failed_terminal chapter never shows the raw state string in the primary label", () => {
    const job = jobWith({ c1: { title: "Ch1", state: "failed_terminal", lastError: "BFTerminalError: boom" } });
    render(<BookFactoryChapterReview job={job} onRetryFailed={jest.fn()} />);
    expect(screen.getByTestId("bf-friendly-status-c1").textContent).not.toMatch(/failed_terminal/);
    expect(screen.getByTestId("bf-friendly-status-c1").textContent).not.toMatch(/BFTerminalError/);
  });

  test("technical details (raw state, lastError, warning codes) are hidden until 'Details' is opened", () => {
    const job = jobWith({
      c1: {
        title: "Ch1", state: "completed",
        warnings: [{ type: "vocab_issue", reason: "vocab_ipa_rejected:test:ipa_unsupported_symbols" }],
      },
    });
    render(<BookFactoryChapterReview job={job} onRetryFailed={jest.fn()} />);
    expect(screen.queryByTestId("bf-details-c1")).toBeNull();
    fireEvent.click(screen.getByTestId("bf-toggle-details-c1"));
    expect(screen.getByTestId("bf-details-c1")).toBeInTheDocument();
    expect(screen.getByTestId("bf-details-c1").textContent).toMatch(/vocab_ipa_rejected/);
    fireEvent.click(screen.getByTestId("bf-toggle-details-c1"));
    expect(screen.queryByTestId("bf-details-c1")).toBeNull();
  });

  test("Retry All Failed shows the failed-chapter count and a max-call estimate before confirming", () => {
    const job = jobWith({
      c1: { title: "Ch1", state: "failed_terminal" },
      c2: { title: "Ch2", state: "unknown_outcome" },
      c3: { title: "Ch3", state: "completed", warnings: [] },
    });
    const onRetryFailed = jest.fn();
    render(<BookFactoryChapterReview job={job} onRetryFailed={onRetryFailed} />);
    expect(screen.getByTestId("bf-retry-all-failed").textContent).toMatch(/2/);
    fireEvent.click(screen.getByTestId("bf-retry-all-failed"));
    expect(screen.getByTestId("bf-retry-all-failed-confirm").textContent).toMatch(/4/); // 2 chapters * 2 calls
    expect(onRetryFailed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("bf-retry-all-failed-confirm-go"));
    expect(onRetryFailed).toHaveBeenCalledWith("c1");
    expect(onRetryFailed).toHaveBeenCalledWith("c2");
    expect(onRetryFailed).not.toHaveBeenCalledWith("c3");
    expect(onRetryFailed).toHaveBeenCalledTimes(2);
  });

  test("Retry All Failed panel is absent when there are no failed chapters", () => {
    const job = jobWith({ c1: { title: "Ch1", state: "completed", warnings: [] } });
    render(<BookFactoryChapterReview job={job} onRetryFailed={jest.fn()} />);
    expect(screen.queryByTestId("bf-retry-all-failed-panel")).toBeNull();
  });
});

// ── BookFactoryStudio integration: Prepare Handoff incomplete-draft guard ──
jest.mock("../StudioPreview", () => () => <div data-testid="mock-preview" />);
jest.mock("../bookFactory/bookFactoryApi", () => ({
  createJob: jest.fn(), stepJob: jest.fn(), approveJob: jest.fn(), getJob: jest.fn(),
  retryChapter: jest.fn(), retryFailedChapter: jest.fn(), regenerateChapter: jest.fn(),
  lockChapter: jest.fn(), unlockChapter: jest.fn(), cancelJob: jest.fn(), exportJob: jest.fn(),
  listJobs: jest.fn(), getStatus: jest.fn(),
}));
const api = require("../bookFactory/bookFactoryApi");
const BookFactoryStudio = require("../bookFactory/BookFactoryStudio").default;

describe("BookFactoryStudio — Prepare Handoff incomplete-draft guard", () => {
  beforeEach(() => { jest.clearAllMocks(); localStorage.clear(); });

  test("all chapters complete → Prepare handoff proceeds with a single click", async () => {
    api.getJob.mockResolvedValue({
      job: {
        jobId: "j1", state: "approved", blueprintApprovedAt: "t",
        chapterOrder: ["c1"], chapters: { c1: { state: "completed", title: "C", blocks: [] } },
      },
    });
    api.exportJob.mockImplementation(() => new Promise(() => {}));
    localStorage.setItem("bf_active_job_v1:admin-a@test", "j1");
    await act(async () => {
      render(<BookFactoryStudio enabled geminiEnabled adminIdentity="admin-a@test" onHandoff={jest.fn()} />);
    });
    await screen.findByTestId("bf-resume-banner");
    await act(async () => { fireEvent.click(screen.getByTestId("bf-resume-continue")); });
    await waitFor(() => expect(screen.getByTestId("bf-prepare-handoff")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("bf-prepare-handoff")); });
    expect(screen.queryByTestId("bf-prepare-handoff-confirm")).toBeNull();
    await waitFor(() => expect(api.exportJob).toHaveBeenCalled());
  });

  test("one failed chapter → Prepare handoff requires explicit confirmation naming the count", async () => {
    api.getJob.mockResolvedValue({
      job: {
        jobId: "j2", state: "approved", blueprintApprovedAt: "t",
        chapterOrder: ["c1", "c2"],
        chapters: {
          c1: { state: "completed", title: "C1", blocks: [] },
          c2: { state: "failed_terminal", title: "C2", blocks: [] },
        },
      },
    });
    api.exportJob.mockImplementation(() => new Promise(() => {}));
    localStorage.setItem("bf_active_job_v1:admin-a@test", "j2");
    await act(async () => {
      render(<BookFactoryStudio enabled geminiEnabled adminIdentity="admin-a@test" onHandoff={jest.fn()} />);
    });
    await screen.findByTestId("bf-resume-banner");
    await act(async () => { fireEvent.click(screen.getByTestId("bf-resume-continue")); });
    await waitFor(() => expect(screen.getByTestId("bf-prepare-handoff")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("bf-prepare-handoff")); });
    // First click only surfaces the confirmation — export must NOT have run yet.
    expect(api.exportJob).not.toHaveBeenCalled();
    expect(screen.getByTestId("bf-prepare-handoff-confirm").textContent).toMatch(/1 chapter/i);
    await act(async () => { fireEvent.click(screen.getByTestId("bf-prepare-handoff-confirm-go")); });
    await waitFor(() => expect(api.exportJob).toHaveBeenCalled());
  });

  test("resuming a job with a failed_terminal chapter never auto-retries it (no /step call for that chapter)", async () => {
    api.getJob.mockResolvedValue({
      job: {
        jobId: "j3", state: "approved", blueprintApprovedAt: "t",
        chapterOrder: ["c1"], chapters: { c1: { state: "failed_terminal", title: "C1", blocks: [] } },
      },
    });
    localStorage.setItem("bf_active_job_v1:admin-a@test", "j3");
    await act(async () => {
      render(<BookFactoryStudio enabled geminiEnabled adminIdentity="admin-a@test" onHandoff={jest.fn()} />);
    });
    await screen.findByTestId("bf-resume-banner");
    await act(async () => { fireEvent.click(screen.getByTestId("bf-resume-continue")); });
    await waitFor(() => expect(screen.getByTestId("bf-prepare-handoff")).toBeInTheDocument());
    expect(api.stepJob).not.toHaveBeenCalled();
  });
});
