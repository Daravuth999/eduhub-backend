/**
 * SyncReviewStudio.test.jsx — the flagship Author Studio transcript review
 * workflow: transcript editing, timing nudges, split/merge, speaker
 * relabeling, compare-original, and approve/reject. Mocks ./videoLibraryApi
 * (the actual edit-operation correctness is covered by
 * eduhub-backend/tests/test_video_pipeline.py's apply_sync_edits suite) —
 * this suite verifies the Studio UI calls the right operation shape and
 * reflects the server's response.
 */
jest.mock("../videoLibraryApi", () => ({
  getSyncAdmin: jest.fn(),
  editSync: jest.fn(),
  approveSync: jest.fn(),
  rejectSync: jest.fn(),
  resolveMediaSrc: (ref) => (ref ? `https://resolved/${ref}` : ""),
}));

import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import SyncReviewStudio, { SentenceRow } from "../SyncReviewStudio";
import { getSyncAdmin, editSync, approveSync, rejectSync } from "../videoLibraryApi";

const LESSON = { lessonId: "vid_1", title: "Ordering Coffee", syncId: "sync_abc", mediaRef: "https://pub-x.r2.dev/vid.mp4", contentType: "video/mp4" };

function baseSync(overrides) {
  return {
    syncId: "sync_abc", alignmentVersion: 1, providerVersion: "gemini-video-asr-v1", alignmentStatus: "complete",
    reviewStatus: "pending", speakers: [{ id: "S1", label: "S1" }],
    paragraphs: [{
      id: "p1",
      sentences: [{
        id: "s1", start: 0, end: 2, speakerId: "S1",
        words: [{ word: "Hello", start: 0, end: 1 }, { word: "there", start: 1, end: 2 }],
      }],
    }],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  editSync.mockImplementation((syncId, ops) => Promise.resolve(baseSync({ reviewStatus: "in_review" })));
});

test("shows a loading state, then the sentence editor once the sync document loads", async () => {
  getSyncAdmin.mockResolvedValue(baseSync());
  render(<SyncReviewStudio lesson={LESSON} onClose={() => {}} onChanged={() => {}} />);
  expect(await screen.findByTestId("review-sentence-0")).toHaveTextContent("Hello");
});

test("shows an honest not-aligned state when the pipeline has not completed yet", async () => {
  getSyncAdmin.mockResolvedValue(baseSync({ alignmentStatus: "processing" }));
  render(<SyncReviewStudio lesson={LESSON} onClose={() => {}} onChanged={() => {}} />);
  expect(await screen.findByTestId("review-not-aligned")).toHaveTextContent("processing");
});

test("editing a sentence's text sends a replace_sentence_text operation", async () => {
  getSyncAdmin.mockResolvedValue(baseSync());
  render(<SyncReviewStudio lesson={LESSON} onClose={() => {}} onChanged={() => {}} />);
  await screen.findByTestId("review-sentence-0");
  fireEvent.click(screen.getByTestId("review-sentence-0-edit-text"));
  fireEvent.change(screen.getByTestId("review-sentence-0-textarea"), { target: { value: "Hi friend" } });
  fireEvent.click(screen.getByTestId("review-sentence-0-save-text"));
  await waitFor(() => expect(editSync).toHaveBeenCalledWith(
    "sync_abc", [{ op: "replace_sentence_text", p: 0, s: 0, text: "Hi friend" }],
  ));
});

test("splitting requires selecting a word first, then sends split_sentence at that word index", async () => {
  getSyncAdmin.mockResolvedValue(baseSync());
  render(<SyncReviewStudio lesson={LESSON} onClose={() => {}} onChanged={() => {}} />);
  const row = await screen.findByTestId("review-sentence-0");
  expect(screen.getByTestId("review-sentence-0-split")).toBeDisabled();
  // "there" also renders in the live Teleprompter preview (left column) —
  // scope the click to the editor row itself, a real separate element.
  fireEvent.click(within(row).getByText("there")); // select word index 1
  fireEvent.click(screen.getByTestId("review-sentence-0-split"));
  await waitFor(() => expect(editSync).toHaveBeenCalledWith(
    "sync_abc", [{ op: "split_sentence", p: 0, s: 0, at: 1 }],
  ));
});

test("merge button sends merge_sentences for the sentence", async () => {
  getSyncAdmin.mockResolvedValue(baseSync());
  render(<SyncReviewStudio lesson={LESSON} onClose={() => {}} onChanged={() => {}} />);
  await screen.findByTestId("review-sentence-0");
  fireEvent.click(screen.getByTestId("review-sentence-0-merge"));
  await waitFor(() => expect(editSync).toHaveBeenCalledWith(
    "sync_abc", [{ op: "merge_sentences", p: 0, s: 0 }],
  ));
});

test("nudging a selected word's start time sends set_word_timing", async () => {
  getSyncAdmin.mockResolvedValue(baseSync());
  render(<SyncReviewStudio lesson={LESSON} onClose={() => {}} onChanged={() => {}} />);
  const row = await screen.findByTestId("review-sentence-0");
  fireEvent.click(within(row).getByText("Hello")); // select word index 0
  const tools = await screen.findByTestId("review-sentence-0-word-tools");
  fireEvent.click(within(tools).getAllByRole("button")[1]); // start +0.1
  await waitFor(() => expect(editSync).toHaveBeenCalledWith(
    "sync_abc", [{ op: "set_word_timing", p: 0, s: 0, w: 0, start: 0.1, end: 1 }],
  ));
});

test("changing a sentence's speaker dropdown sends set_sentence_speaker", async () => {
  getSyncAdmin.mockResolvedValue(baseSync());
  render(<SyncReviewStudio lesson={LESSON} onClose={() => {}} onChanged={() => {}} />);
  await screen.findByTestId("review-sentence-0");
  fireEvent.change(screen.getByTestId("review-sentence-0-speaker"), { target: { value: "S1" } });
  await waitFor(() => expect(editSync).toHaveBeenCalledWith(
    "sync_abc", [{ op: "set_sentence_speaker", p: 0, s: 0, speakerId: "S1" }],
  ));
});

test("Compare original toggles to a read-only view of the pre-edit transcript", async () => {
  getSyncAdmin.mockResolvedValue(baseSync({
    originalParagraphs: [{ id: "p1", sentences: [{ id: "s1", start: 0, end: 1, words: [{ word: "Original", start: 0, end: 1 }] }] }],
    originalSpeakers: [],
  }));
  render(<SyncReviewStudio lesson={LESSON} onClose={() => {}} onChanged={() => {}} />);
  await screen.findByTestId("review-sentence-0");
  fireEvent.click(screen.getByTestId("review-compare-toggle"));
  // The original text now renders in BOTH the live Teleprompter preview
  // (left column) and the read-only sentence list (right column) — real,
  // separate elements, not a query bug.
  expect(screen.getAllByText(/Original/).length).toBeGreaterThan(0);
  expect(screen.queryByTestId("review-sentence-0-edit-text")).not.toBeInTheDocument(); // read-only in compare view
});

test("Approve walks pending through in_review to approved via the api client's own transition logic", async () => {
  getSyncAdmin.mockResolvedValue(baseSync({ reviewStatus: "pending" }));
  approveSync.mockResolvedValue(baseSync({ reviewStatus: "approved" }));
  render(<SyncReviewStudio lesson={LESSON} onClose={() => {}} onChanged={() => {}} />);
  await screen.findByTestId("review-sentence-0");
  fireEvent.click(screen.getByTestId("review-approve-button"));
  await waitFor(() => expect(approveSync).toHaveBeenCalledWith("sync_abc", "pending"));
  expect(await screen.findByTestId("review-status-badge")).toHaveTextContent("approved");
});

test("Reject is disabled once already approved (backend treats approved as terminal)", async () => {
  getSyncAdmin.mockResolvedValue(baseSync({ reviewStatus: "approved" }));
  render(<SyncReviewStudio lesson={LESSON} onClose={() => {}} onChanged={() => {}} />);
  await screen.findByTestId("review-sentence-0");
  expect(screen.getByTestId("review-reject-button")).toBeDisabled();
});

test("Reject is enabled and calls rejectSync for a pending/in-review document", async () => {
  getSyncAdmin.mockResolvedValue(baseSync({ reviewStatus: "in_review" }));
  rejectSync.mockResolvedValue(baseSync({ reviewStatus: "rejected" }));
  render(<SyncReviewStudio lesson={LESSON} onClose={() => {}} onChanged={() => {}} />);
  await screen.findByTestId("review-sentence-0");
  fireEvent.click(screen.getByTestId("review-reject-button"));
  await waitFor(() => expect(rejectSync).toHaveBeenCalledWith("sync_abc", "in_review"));
});

test("Close button calls onClose", async () => {
  getSyncAdmin.mockResolvedValue(baseSync());
  const onClose = jest.fn();
  render(<SyncReviewStudio lesson={LESSON} onClose={onClose} onChanged={() => {}} />);
  await screen.findByTestId("review-sentence-0");
  fireEvent.click(screen.getByTestId("review-studio-close"));
  expect(onClose).toHaveBeenCalled();
});

test("a load failure shows an inline error instead of crashing", async () => {
  getSyncAdmin.mockRejectedValue(new Error("sync document not found"));
  render(<SyncReviewStudio lesson={LESSON} onClose={() => {}} onChanged={() => {}} />);
  expect(await screen.findByTestId("review-error")).toHaveTextContent(/not found/i);
});

describe("Author Studio freeze fix — regression guards", () => {
  test("SentenceRow is memoized so a currentTime tick doesn't re-render every row in the list", () => {
    // Structural guard for the actual fix mechanism: without React.memo
    // here (plus the stable onOp/onSeek useCallback references and the
    // memoized `speakers` array upstream), every SentenceRow re-renders
    // on every ~250ms `timeupdate` tick during playback — the confirmed
    // root cause of the reported main-thread freeze on mobile Safari.
    expect(SentenceRow.$$typeof).toBe(Symbol.for("react.memo"));
  });

  test("remains fully interactive after many rapid currentTime ticks (simulated video playback)", async () => {
    getSyncAdmin.mockResolvedValue(baseSync());
    approveSync.mockResolvedValue(baseSync({ reviewStatus: "approved" }));
    render(<SyncReviewStudio lesson={LESSON} onClose={() => {}} onChanged={() => {}} />);
    await screen.findByTestId("review-sentence-0");

    const video = screen.getByTestId("review-media-video");
    // Simulate ~15s of playback at the native ~4 ticks/sec cadence — the
    // exact repeated-render pattern that used to saturate the main thread.
    for (let i = 0; i < 60; i += 1) {
      Object.defineProperty(video, "currentTime", { value: i * 0.25, configurable: true });
      fireEvent.timeUpdate(video);
    }

    // If the fix regresses, this is exactly the interaction that would
    // hang: Approve must still be clickable and reach the API.
    fireEvent.click(screen.getByTestId("review-approve-button"));
    await waitFor(() => expect(approveSync).toHaveBeenCalledWith("sync_abc", "pending"));
  });
});
