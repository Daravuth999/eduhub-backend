/**
 * useAssessmentBadge.test.js — the real, server-backed "do I have
 * something to do" signal shared by Sidebar's badge and Dashboard's
 * pending-assessment card. Never fabricates a count.
 */
jest.mock("../assessmentApi", () => ({ listAssessments: jest.fn() }));

let mockAuth = { isAuthenticated: false };
jest.mock("../../../context/AuthContext", () => ({
  useAuth: () => mockAuth,
}));

import { renderHook, waitFor } from "@testing-library/react";
import useAssessmentBadge from "../useAssessmentBadge";
import { listAssessments } from "../assessmentApi";

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = { isAuthenticated: false };
});

test("a guest (not authenticated) never triggers a fetch and reports zero", () => {
  const { result } = renderHook(() => useAssessmentBadge());
  expect(listAssessments).not.toHaveBeenCalled();
  expect(result.current.pendingCount).toBe(0);
  expect(result.current.pendingAssessment).toBeNull();
});

test("counts only assessments with no submission or a failed one as pending", async () => {
  mockAuth = { isAuthenticated: true };
  listAssessments.mockResolvedValue([
    { assessmentId: "a1", title: "Never submitted", mySubmission: null },
    { assessmentId: "a2", title: "Failed upload", mySubmission: { status: "failed" } },
    { assessmentId: "a3", title: "Already scored", mySubmission: { status: "scored" } },
    { assessmentId: "a4", title: "Awarded", mySubmission: { status: "awarded" } },
  ]);
  const { result } = renderHook(() => useAssessmentBadge());
  await waitFor(() => expect(result.current.pendingCount).toBe(2));
  expect(result.current.pendingAssessment.title).toBe("Never submitted");
});

test("a processing/needs_review submission is NOT counted as pending — the student already acted", async () => {
  mockAuth = { isAuthenticated: true };
  listAssessments.mockResolvedValue([
    { assessmentId: "a1", title: "Processing", mySubmission: { status: "processing" } },
    { assessmentId: "a2", title: "Needs review", mySubmission: { status: "needs_review" } },
  ]);
  const { result } = renderHook(() => useAssessmentBadge());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.pendingCount).toBe(0);
});

test("a network failure fails silently — never surfaces or crashes, count stays honest at 0", async () => {
  mockAuth = { isAuthenticated: true };
  listAssessments.mockRejectedValue(new Error("network down"));
  const { result } = renderHook(() => useAssessmentBadge());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.pendingCount).toBe(0);
});
