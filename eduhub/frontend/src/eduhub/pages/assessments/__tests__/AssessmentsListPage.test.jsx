/**
 * AssessmentsListPage.test.jsx — the student landing page. Status pills
 * must reflect exactly what the backend's `mySubmission` field says, never
 * a client-computed guess.
 */
jest.mock("../assessmentApi", () => ({ listAssessments: jest.fn(), submitAssessment: jest.fn() }));

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import AssessmentsListPage from "../AssessmentsListPage";
import { listAssessments } from "../assessmentApi";

beforeEach(() => jest.clearAllMocks());

test("shows a loading state, then the fetched assessments", async () => {
  listAssessments.mockResolvedValue([
    { assessmentId: "a1", title: "Long & Short Sound Listening Challenge", subject: "Phonics", totalPoints: 15, mySubmission: null },
  ]);
  render(<AssessmentsListPage />);
  expect(screen.getByTestId("assessments-loading")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByTestId("assessments-loading")).not.toBeInTheDocument());
  expect(screen.getByText("Long & Short Sound Listening Challenge")).toBeInTheDocument();
  expect(screen.getByTestId("assessment-status-pill")).toHaveTextContent("Not submitted");
});

test("renders an awarded submission's real score, not a fabricated one, under the Results tab", async () => {
  listAssessments.mockResolvedValue([
    {
      assessmentId: "a1", title: "Listening Challenge", subject: "Phonics", totalPoints: 15,
      mySubmission: { submissionId: "s1", status: "awarded", score: { correct: 30, total: 30, scorePct: 100, pointsEarned: 15 } },
    },
  ]);
  render(<AssessmentsListPage />);
  await waitFor(() => expect(screen.getByTestId("assessments-tab-results")).toHaveTextContent("Results · 1"));
  // An awarded submission is not "Assigned" — the default tab shows the honest empty state.
  expect(screen.getByTestId("assessments-tab-empty")).toBeInTheDocument();

  fireEvent.click(screen.getByTestId("assessments-tab-results"));
  expect(await screen.findByTestId("assessment-status-pill")).toHaveTextContent("Points awarded");
  expect(screen.getByTestId("assessment-status-pill")).toHaveTextContent("100%");
  // Score and "points awarded" are two different backend facts — both must
  // be visible, and for an awarded submission they agree (15 pts each).
  expect(screen.getByTestId("assessment-status-pill-points")).toHaveTextContent("Score: 15/15 pts");
  expect(screen.getByTestId("assessment-status-pill-points")).toHaveTextContent("Points awarded: 15");
});

test("a scored-but-not-yet-awarded submission shows a real score with points awarded still at 0", async () => {
  listAssessments.mockResolvedValue([
    {
      assessmentId: "a1", title: "Listening Challenge", subject: "Phonics", totalPoints: 15,
      mySubmission: { submissionId: "s1", status: "scored", score: { correct: 15, total: 30, scorePct: 50, pointsEarned: 7.5 } },
    },
  ]);
  render(<AssessmentsListPage />);
  await waitFor(() => expect(screen.getByTestId("assessments-tab-results")).toHaveTextContent("Results · 1"));
  fireEvent.click(screen.getByTestId("assessments-tab-results"));

  const pill = await screen.findByTestId("assessment-status-pill");
  expect(pill).toHaveTextContent("15/30 correct");
  const points = screen.getByTestId("assessment-status-pill-points");
  expect(points).toHaveTextContent("Score: 7.5/15 pts");
  expect(points).toHaveTextContent("Points awarded: 0");
  expect(points).toHaveTextContent("pending teacher approval");
});

test("buckets each real backend status into the correct tab, never a guessed one", async () => {
  listAssessments.mockResolvedValue([
    { assessmentId: "a1", title: "Not yet started", totalPoints: 15, mySubmission: null },
    { assessmentId: "a2", title: "Retry needed", totalPoints: 15, mySubmission: { status: "failed" } },
    { assessmentId: "a3", title: "Uploading", totalPoints: 15, mySubmission: { status: "processing" } },
    { assessmentId: "a4", title: "Under review", totalPoints: 15, mySubmission: { status: "needs_review" } },
    { assessmentId: "a5", title: "Freshly scored", totalPoints: 15, mySubmission: { status: "scored", score: { correct: 27, total: 30, scorePct: 90, pointsEarned: 13.5 } } },
  ]);
  render(<AssessmentsListPage />);
  await waitFor(() => expect(screen.getByTestId("assessments-tab-assigned")).toHaveTextContent("Assigned · 2"));
  expect(screen.getByTestId("assessments-tab-in_progress")).toHaveTextContent("In Progress · 1");
  expect(screen.getByTestId("assessments-tab-submitted")).toHaveTextContent("Submitted · 1");
  expect(screen.getByTestId("assessments-tab-results")).toHaveTextContent("Results · 1");
});

test("shows an empty state when nothing is open", async () => {
  listAssessments.mockResolvedValue([]);
  render(<AssessmentsListPage />);
  await waitFor(() => expect(screen.getByTestId("assessments-empty")).toBeInTheDocument());
});

test("surfaces a load error honestly", async () => {
  listAssessments.mockRejectedValue(new Error("network down"));
  render(<AssessmentsListPage />);
  await waitFor(() => expect(screen.getByTestId("assessments-error")).toHaveTextContent("network down"));
});
