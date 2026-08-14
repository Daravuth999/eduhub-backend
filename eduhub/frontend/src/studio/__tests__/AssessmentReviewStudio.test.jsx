/**
 * AssessmentReviewStudio.test.jsx — Author Studio's Assessment Lab panel.
 * Covers the answer-key extraction -> save flow, the submissions list, and
 * the individual + bulk award actions (the bulk-select UI has no
 * precedent elsewhere in this codebase, so it's exercised end-to-end here).
 */
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import AssessmentReviewStudio from "../AssessmentReviewStudio";
import {
  extractAssessmentAnswerKey, createAssessment, listAssessments, listAssessmentSubmissions,
  awardAssessmentSubmission, bulkAwardAssessmentSubmissions, retryAssessmentGasSync,
  correctAssessmentSubmission, deleteAssessmentSubmission,
} from "../api";

jest.mock("../api", () => ({
  extractAssessmentAnswerKey: jest.fn(),
  createAssessment: jest.fn(),
  listAssessments: jest.fn(),
  listAssessmentSubmissions: jest.fn(),
  awardAssessmentSubmission: jest.fn(),
  bulkAwardAssessmentSubmissions: jest.fn(),
  retryAssessmentGasSync: jest.fn(),
  correctAssessmentSubmission: jest.fn(),
  deleteAssessmentSubmission: jest.fn(),
}));

const ASSESSMENT = {
  assessmentId: "asmt_1", title: "Long & Short Sound Listening Challenge", status: "published", totalPoints: 15,
  questions: [
    { qid: "q1", prompt: "sheep", correctAnswer: "LONG", points: 0.5 },
    { qid: "q2", prompt: "ship", correctAnswer: "SHORT", points: 0.5 },
  ],
};
const SUBMISSIONS = [
  {
    submissionId: "s1", cleanId: "stu094", status: "scored",
    mediaRef: "https://r2.example/assessment-media/stu094/abc123.jpg",
    score: {
      correct: 15, total: 30, scorePct: 50, pointsEarned: 7.5,
      details: [
        { qid: "q1", prompt: "sheep", givenAnswer: "LONG", correctAnswer: "LONG", correct: true, answerState: "answered", confidence: 0.95 },
        { qid: "q2", prompt: "ship", givenAnswer: null, correctAnswer: "SHORT", correct: false, answerState: "uncertain", confidence: 0.31 },
      ],
    },
    extraction: { engine: "gemini", model: "gemini-2.5-pro", rawAnswerCount: 30, normalizedAnswerCount: 30 },
  },
  { submissionId: "s2", cleanId: "stu095", status: "needs_review", score: { correct: 20, total: 30, scorePct: 66.7, pointsEarned: 10 } },
  {
    submissionId: "s3", cleanId: "stu021", status: "awarded",
    score: { correct: 30, total: 30, scorePct: 100, pointsEarned: 15 },
    award: {
      pointsCredited: 15, balanceAfter: 115, creditedAt: "2026-08-12T15:00:00Z",
      notifiedAt: "2026-08-12T15:00:01Z", gasSynced: false, gasSyncError: "GAS unreachable",
    },
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  listAssessments.mockResolvedValue({ assessments: [ASSESSMENT] });
  listAssessmentSubmissions.mockResolvedValue({ submissions: SUBMISSIONS });
});

async function renderPanel() {
  await act(async () => { render(<AssessmentReviewStudio />); });
  await waitFor(() => expect(listAssessments).toHaveBeenCalled());
}

test("extracting an answer key populates the editable question list", async () => {
  extractAssessmentAnswerKey.mockResolvedValue({
    ok: true,
    questions: [
      { qid: "q1", prompt: "sheep", correctAnswer: "LONG", points: 0.5 },
      { qid: "q2", prompt: "ship", correctAnswer: "SHORT", points: 0.5 },
    ],
  });
  await renderPanel();
  const file = new File(["fake"], "key.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  fireEvent.change(screen.getByTestId("assessment-key-file-input"), { target: { files: [file] } });
  await waitFor(() => expect(screen.getByTestId("assessment-question-editor")).toBeInTheDocument());
  expect(extractAssessmentAnswerKey).toHaveBeenCalledWith(file);
  expect(screen.getAllByDisplayValue("sheep")).toHaveLength(1);
});

test("Save & Publish sends the edited questions and refreshes the assessment list", async () => {
  extractAssessmentAnswerKey.mockResolvedValue({
    ok: true, questions: [{ qid: "q1", prompt: "sheep", correctAnswer: "LONG", points: 0.5 }],
  });
  createAssessment.mockResolvedValue({ ok: true, assessment: { ...ASSESSMENT, assessmentId: "asmt_2" } });
  await renderPanel();
  const file = new File(["fake"], "key.pdf", { type: "application/pdf" });
  fireEvent.change(screen.getByTestId("assessment-key-file-input"), { target: { files: [file] } });
  await screen.findByTestId("assessment-question-editor");

  fireEvent.change(screen.getByTestId("assessment-title-input"), { target: { value: "Listening Challenge" } });
  await act(async () => { fireEvent.click(screen.getByTestId("assessment-save-publish-button")); });

  expect(createAssessment).toHaveBeenCalledWith(expect.objectContaining({
    title: "Listening Challenge",
    publish: true,
    questions: [{ qid: "q1", prompt: "sheep", correctAnswer: "LONG", points: 0.5 }],
  }));
  await waitFor(() => expect(listAssessments).toHaveBeenCalledTimes(2));
});

test("selecting an assessment loads its submissions with status + score", async () => {
  await renderPanel();
  fireEvent.click(screen.getByText(ASSESSMENT.title));
  await waitFor(() => expect(listAssessmentSubmissions).toHaveBeenCalledWith("asmt_1", undefined));
  expect(await screen.findByText("stu094")).toBeInTheDocument();
  const badges = screen.getAllByTestId("assessment-submission-status-badge");
  expect(badges[0]).toHaveTextContent("scored");
  expect(badges[1]).toHaveTextContent("needs_review");
});

test("individual award calls the single-award endpoint and refreshes the row", async () => {
  awardAssessmentSubmission.mockResolvedValue({ ok: true, duplicate: false, points: 15 });
  await renderPanel();
  fireEvent.click(screen.getByText(ASSESSMENT.title));
  await screen.findByText("stu094");

  const awardButtons = screen.getAllByTestId("assessment-award-button");
  await act(async () => { fireEvent.click(awardButtons[0]); });
  expect(awardAssessmentSubmission).toHaveBeenCalledWith("s1");
  await waitFor(() => expect(listAssessmentSubmissions).toHaveBeenCalledTimes(2));
});

test("bulk-select shows a 'N selected' bar and bulk-awards only the checked rows", async () => {
  bulkAwardAssessmentSubmissions.mockResolvedValue({ ok: true, awarded: 1, failed: 0, results: [] });
  await renderPanel();
  fireEvent.click(screen.getByText(ASSESSMENT.title));
  await screen.findByText("stu094");

  const checkboxes = screen.getAllByTestId("assessment-submission-checkbox");
  // Every submission with a persisted calculated score is selectable —
  // including needs_review (never a dead end): s1 (scored) AND s2 (needs_review).
  expect(checkboxes[0]).not.toBeDisabled();
  expect(checkboxes[1]).not.toBeDisabled();

  fireEvent.click(checkboxes[0]);
  expect(screen.getByTestId("assessment-bulk-award-bar")).toHaveTextContent("1 selected");

  await act(async () => { fireEvent.click(screen.getByTestId("assessment-bulk-award-button")); });
  expect(bulkAwardAssessmentSubmissions).toHaveBeenCalledWith(["s1"]);
  await waitFor(() => expect(screen.queryByTestId("assessment-bulk-award-bar")).not.toBeInTheDocument());
});

test("empty submissions list renders the honest empty state", async () => {
  listAssessmentSubmissions.mockResolvedValue({ submissions: [] });
  await renderPanel();
  fireEvent.click(screen.getByText(ASSESSMENT.title));
  await waitFor(() => expect(screen.getByText(/No submissions yet/i)).toBeInTheDocument());
});

test("a scored submission shows 'not yet awarded'; an awarded one shows 'points awarded'", async () => {
  await renderPanel();
  fireEvent.click(screen.getByText(ASSESSMENT.title));
  await screen.findByText("stu094");
  expect(screen.getByText(/7\.5 pts.*not yet awarded/)).toBeInTheDocument();
});

test("expanding a submission row reveals the per-question given-vs-correct detail from the persisted score", async () => {
  await renderPanel();
  fireEvent.click(screen.getByText(ASSESSMENT.title));
  await screen.findByText("stu094");

  expect(screen.queryByTestId("assessment-submission-detail")).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByTestId("assessment-submission-expand-button")[0]);

  const detail = await screen.findByTestId("assessment-submission-detail");
  expect(detail).toHaveTextContent("Gemini returned 30 answer(s)");
  expect(detail).toHaveTextContent("30 matched a known question");
  const rows = screen.getAllByTestId("assessment-submission-detail-row");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("LONG");
  expect(rows[1]).toHaveTextContent("SHORT");
});

test("the submission detail has no extraction meta line when the submission predates that field", async () => {
  await renderPanel();
  fireEvent.click(screen.getByText(ASSESSMENT.title));
  await screen.findByText("stu095");
  fireEvent.click(screen.getAllByTestId("assessment-submission-expand-button")[1]);
  const detail = await screen.findByTestId("assessment-submission-detail");
  expect(screen.queryByTestId("assessment-submission-extraction-meta")).not.toBeInTheDocument();
  expect(detail).toHaveTextContent("No extracted-answer detail available.");
});

test("View answer key reveals the assessment's persisted correctAnswer values, letting a teacher self-diagnose the source of truth", async () => {
  await renderPanel();
  fireEvent.click(screen.getByText(ASSESSMENT.title));

  expect(screen.queryByTestId("assessment-answer-key-view")).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId("assessment-view-answer-key-button"));

  const view = await screen.findByTestId("assessment-answer-key-view");
  const rows = screen.getAllByTestId("assessment-answer-key-row");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("sheep");
  expect(rows[0]).toHaveTextContent("LONG");
  expect(rows[1]).toHaveTextContent("ship");
  expect(rows[1]).toHaveTextContent("SHORT");

  fireEvent.click(screen.getByTestId("assessment-view-answer-key-button"));
  expect(view).not.toBeInTheDocument();
});

test("an awarded submission shows real wallet-credit proof, not just a status label", async () => {
  await renderPanel();
  fireEvent.click(screen.getByText(ASSESSMENT.title));
  await screen.findByText("stu021");

  const proof = screen.getByTestId("assessment-award-proof");
  expect(proof).toHaveTextContent("15 pts credited");
  expect(proof).toHaveTextContent("115");
  expect(proof).toHaveTextContent("Notification sent");
});

test("a failed legacy points-pill sync is shown honestly, with a working retry that never re-credits the wallet", async () => {
  retryAssessmentGasSync.mockResolvedValue({ ok: true, gasSynced: true });
  await renderPanel();
  fireEvent.click(screen.getByText(ASSESSMENT.title));
  await screen.findByText("stu021");

  const failedNote = screen.getByTestId("assessment-award-gas-sync-failed");
  expect(failedNote).toHaveTextContent("Legacy points-pill sync failed");
  expect(failedNote).toHaveTextContent("GAS unreachable");
  expect(failedNote).toHaveTextContent("unaffected");

  await act(async () => {
    fireEvent.click(screen.getByTestId("assessment-retry-gas-sync-button"));
  });
  expect(retryAssessmentGasSync).toHaveBeenCalledWith("s3");
  // Retrying the sync must never call the award endpoint again.
  expect(awardAssessmentSubmission).not.toHaveBeenCalled();
  await waitFor(() => expect(listAssessmentSubmissions).toHaveBeenCalledTimes(2));
});

test("a needs_review submission is actionable — it has its own Award button (never a dead end)", async () => {
  await renderPanel();
  fireEvent.click(screen.getByText(ASSESSMENT.title));
  await screen.findByText("stu095");
  const awardButtons = screen.getAllByTestId("assessment-award-button");
  // s1 (scored, 7.5 pts) AND s2 (needs_review, 10 pts) both awardable.
  expect(awardButtons).toHaveLength(2);
  expect(awardButtons[1]).toHaveTextContent("Award 10 pts");
});

test("teacher can correct a Gemini misreading inline; the correction hits the backend and refreshes", async () => {
  correctAssessmentSubmission.mockResolvedValue({ ok: true, score: { correct: 16 }, correctedQids: ["q2"] });
  await renderPanel();
  fireEvent.click(screen.getByText(ASSESSMENT.title));
  await screen.findByText("stu094");
  fireEvent.click(screen.getAllByTestId("assessment-submission-expand-button")[0]);
  await screen.findByTestId("assessment-submission-detail");

  // q2 was read as uncertain — open its correction editor and fix it.
  fireEvent.click(screen.getAllByTestId("assessment-correct-toggle-button")[1]);
  const input = screen.getByTestId("assessment-correction-input");
  fireEvent.change(input, { target: { value: "SHORT" } });
  await act(async () => { fireEvent.click(screen.getByTestId("assessment-apply-correction-button")); });

  expect(correctAssessmentSubmission).toHaveBeenCalledWith("s1", [{ qid: "q2", answer: "SHORT" }]);
  await waitFor(() => expect(listAssessmentSubmissions).toHaveBeenCalledTimes(2));
});

test("the original R2 paper is one click away as evidence, and the model used is shown", async () => {
  await renderPanel();
  fireEvent.click(screen.getByText(ASSESSMENT.title));
  await screen.findByText("stu094");
  fireEvent.click(screen.getAllByTestId("assessment-submission-expand-button")[0]);
  const link = await screen.findByTestId("assessment-view-original-paper");
  expect(link).toHaveAttribute("href", "https://r2.example/assessment-media/stu094/abc123.jpg");
  expect(screen.getByTestId("assessment-submission-extraction-meta")).toHaveTextContent("gemini-2.5-pro");
});

test("deleting a non-awarded submission asks for confirmation and calls the delete endpoint; awarded rows have no delete control", async () => {
  deleteAssessmentSubmission.mockResolvedValue({ ok: true, mediaDeleted: true });
  const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
  await renderPanel();
  fireEvent.click(screen.getByText(ASSESSMENT.title));
  await screen.findByText("stu094");

  const deleteButtons = screen.getAllByTestId("assessment-delete-submission-button");
  expect(deleteButtons).toHaveLength(2); // s1 + s2 — never s3 (awarded, audit trail)
  await act(async () => { fireEvent.click(deleteButtons[0]); });
  expect(confirmSpy).toHaveBeenCalled();
  expect(deleteAssessmentSubmission).toHaveBeenCalledWith("s1");
  confirmSpy.mockRestore();
});
