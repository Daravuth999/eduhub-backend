/**
 * SidebarAssessments.test.jsx — the Assessment Lab's student
 * discoverability fix: a first-class "Assessments" row in the Sidebar's
 * Main section, with a real (never fabricated) pending-count badge.
 * Mirrors SidebarSounds.test.jsx's established react-router-dom virtual
 * mock (no ESM resolution needed for a route-less render).
 */
import { render, screen } from "@testing-library/react";

let mockPathname = "/";
jest.mock("react-router-dom", () => {
  // eslint-disable-next-line global-require
  const R = require("react");
  function Link({ to, children, onClick, ...rest }) {
    return R.createElement("a", { href: to, onClick, ...rest }, children);
  }
  function useLocation() { return { pathname: mockPathname }; }
  return { __esModule: true, Link, useLocation };
}, { virtual: true });

jest.mock("../../audio/uiSoundEngine", () => ({ playUiSound: jest.fn() }));

jest.mock("../../context/AuthContext", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    student: { studentId: "stu001", name: "Test Student" },
    logout: jest.fn(),
  }),
}));

jest.mock("../../hooks/useUnifiedBadges", () => ({
  useUnifiedBadges: () => ({ byModule: {} }),
}));

jest.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: jest.fn(() => false),
}));

let mockPendingCount = 0;
jest.mock("../../pages/assessments/useAssessmentBadge", () => ({
  __esModule: true,
  default: () => ({ pendingCount: mockPendingCount, pendingAssessment: null, loading: false }),
}));

// eslint-disable-next-line import/first
import Sidebar from "../Sidebar";

beforeEach(() => {
  mockPathname = "/";
  mockPendingCount = 0;
});

test("Assessments is a first-class row in the Main nav, pointing at /assessments", () => {
  render(<Sidebar open onClose={() => {}} />);
  const link = screen.getByTestId("sidebar-nav-assessments");
  expect(link).toBeInTheDocument();
  expect(link).toHaveAttribute("href", "/assessments");
});

test("shows no badge when there is nothing pending — never a fake zero-count pill", () => {
  mockPendingCount = 0;
  render(<Sidebar open onClose={() => {}} />);
  expect(screen.queryByTestId("sidebar-badge-assessments")).not.toBeInTheDocument();
});

test("shows the real pending count as a badge on the Assessments row", () => {
  mockPendingCount = 1;
  render(<Sidebar open onClose={() => {}} />);
  expect(screen.getByTestId("sidebar-badge-assessments")).toHaveTextContent("1");
});

test("does not leak the assessment badge onto unrelated nav rows", () => {
  mockPendingCount = 3;
  render(<Sidebar open onClose={() => {}} />);
  expect(screen.queryByTestId("sidebar-badge-dashboard")).not.toBeInTheDocument();
  expect(screen.queryByTestId("sidebar-badge-lucky-spin")).not.toBeInTheDocument();
});
