/**
 * SidebarSounds.test.jsx — Premium UI Sound System wiring in Sidebar.jsx.
 * Mocks the audio engine entirely (playback itself is covered by
 * uiSoundEngine.test.js) and asserts the UI CONTRACT: nav clicks fire
 * "click", the profile link fires "profile_open", and the mobile drawer
 * fires "drawer_open"/"drawer_close" on genuine open<->close transitions
 * only — never on initial mount, never on desktop.
 *
 * react-router-dom@7 ships an ESM-only `exports` map that this project's
 * Jest/CRA harness can't resolve directly — see the established virtual
 * jest.mock() workaround in voiceTreasure_passA1.mounted.test.jsx, which
 * this file mirrors (simplified to only what Sidebar.jsx actually uses:
 * Link + useLocation — no route matching needed).
 */
import { render, fireEvent, screen } from "@testing-library/react";

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

jest.mock("../../audio/uiSoundEngine", () => ({
  playUiSound: jest.fn(),
}));

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

jest.mock("../../pages/assessments/useAssessmentBadge", () => ({
  __esModule: true,
  default: () => ({ pendingCount: 0, pendingAssessment: null, loading: false }),
}));

jest.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: jest.fn(() => false), // mobile by default
}));

// eslint-disable-next-line import/first
import Sidebar from "../Sidebar";
// eslint-disable-next-line import/first
import { playUiSound } from "../../audio/uiSoundEngine";
// eslint-disable-next-line import/first
import { useMediaQuery } from "../../hooks/useMediaQuery";

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname = "/";
});

test("clicking a nav link plays 'click'", () => {
  render(<Sidebar open={false} onClose={() => {}} />);
  fireEvent.click(screen.getByTestId("sidebar-nav-dashboard"));
  expect(playUiSound).toHaveBeenCalledWith("click");
});

test("clicking the profile link plays 'profile_open'", () => {
  render(<Sidebar open={false} onClose={() => {}} />);
  fireEvent.click(screen.getByTestId("sidebar-profile-link"));
  expect(playUiSound).toHaveBeenCalledWith("profile_open");
});

test("does not play a drawer sound on initial mount", () => {
  render(<Sidebar open={false} onClose={() => {}} />);
  expect(playUiSound).not.toHaveBeenCalledWith("drawer_open");
  expect(playUiSound).not.toHaveBeenCalledWith("drawer_close");
});

test("opening the mobile drawer (open: false -> true) plays 'drawer_open'", () => {
  const { rerender } = render(<Sidebar open={false} onClose={() => {}} />);
  jest.clearAllMocks();
  rerender(<Sidebar open={true} onClose={() => {}} />);
  expect(playUiSound).toHaveBeenCalledWith("drawer_open");
});

test("closing the mobile drawer (open: true -> false) plays 'drawer_close'", () => {
  const { rerender } = render(<Sidebar open={true} onClose={() => {}} />);
  jest.clearAllMocks();
  rerender(<Sidebar open={false} onClose={() => {}} />);
  expect(playUiSound).toHaveBeenCalledWith("drawer_close");
});

test("no drawer sound fires on desktop even when 'open' toggles", () => {
  useMediaQuery.mockReturnValue(true); // desktop
  const { rerender } = render(<Sidebar open={false} onClose={() => {}} />);
  jest.clearAllMocks();
  rerender(<Sidebar open={true} onClose={() => {}} />);
  expect(playUiSound).not.toHaveBeenCalledWith("drawer_open");
  expect(playUiSound).not.toHaveBeenCalledWith("drawer_close");
});
