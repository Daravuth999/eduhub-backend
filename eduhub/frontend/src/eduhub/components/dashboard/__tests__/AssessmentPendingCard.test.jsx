/**
 * AssessmentPendingCard.test.jsx — Dashboard's contextual shortcut into
 * the Assessment Lab. Must render NOTHING when there's no pending
 * assessment (no advertisement for an empty feature) and must render
 * only the real backend-reported assessment when there is one.
 */
let mockPathname = "/";
jest.mock("react-router-dom", () => {
  // eslint-disable-next-line global-require
  const R = require("react");
  function Link({ to, children, ...rest }) {
    return R.createElement("a", { href: to, ...rest }, children);
  }
  return { __esModule: true, Link };
}, { virtual: true });

let mockBadge = { pendingAssessment: null, pendingCount: 0, loading: false };
jest.mock("../../../pages/assessments/useAssessmentBadge", () => ({
  __esModule: true,
  default: () => mockBadge,
}));

import { render, screen } from "@testing-library/react";
import AssessmentPendingCard from "../AssessmentPendingCard";

beforeEach(() => {
  mockBadge = { pendingAssessment: null, pendingCount: 0, loading: false };
});

test("renders nothing while loading", () => {
  mockBadge = { pendingAssessment: null, pendingCount: 0, loading: true };
  const { container } = render(<AssessmentPendingCard />);
  expect(container).toBeEmptyDOMElement();
});

test("renders nothing when there is no pending assessment — no empty-state advertisement", () => {
  const { container } = render(<AssessmentPendingCard />);
  expect(container).toBeEmptyDOMElement();
});

test("renders the real pending assessment's title and a Ready to submit call to action", () => {
  mockBadge = {
    pendingAssessment: { assessmentId: "a1", title: "Long & Short Sound Listening Challenge" },
    pendingCount: 1,
    loading: false,
  };
  render(<AssessmentPendingCard />);
  expect(screen.getByTestId("assessment-pending-card-title")).toHaveTextContent(
    "Long & Short Sound Listening Challenge",
  );
  expect(screen.getByText(/Ready to submit/i)).toBeInTheDocument();
  expect(screen.getByTestId("assessment-pending-card-link")).toHaveAttribute("href", "/assessments");
});

test("shows a resubmit message for a previously failed submission, not a fabricated 'ready' state", () => {
  mockBadge = {
    pendingAssessment: {
      assessmentId: "a1", title: "Listening Challenge",
      mySubmission: { status: "failed" },
    },
    pendingCount: 1,
    loading: false,
  };
  render(<AssessmentPendingCard />);
  expect(screen.getByText(/Couldn't process/i)).toBeInTheDocument();
});

test("shows the real pending count when more than one assessment is pending", () => {
  mockBadge = {
    pendingAssessment: { assessmentId: "a1", title: "Listening Challenge" },
    pendingCount: 3,
    loading: false,
  };
  render(<AssessmentPendingCard />);
  expect(screen.getByText(/Assessment · 3/)).toBeInTheDocument();
});
