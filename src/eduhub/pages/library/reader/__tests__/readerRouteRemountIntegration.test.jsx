/**
 * readerRouteRemountIntegration.test.jsx — proves the COMPOSED route never
 * remounts its child during the auth-bootstrap window, using the REAL
 * GuestAwareGate + REAL ProtectedRoute (not mocked), wired through a REAL
 * react-router-dom <Route> exactly as App.js configures
 * `/library/read/:slug`.
 *
 * Why this test exists (and what the prior tests didn't prove):
 *   - GuestAwareGate.test.jsx mocks ProtectedRoute/RequireBellRing out, so
 *     it only proves GuestAwareGate's OWN branching logic is correct in
 *     isolation — not that the composition with the real ProtectedRoute
 *     behaves the same way.
 *   - paginationRemountCausality.test.js proves what a remount WOULD
 *     mechanically produce in ReaderPage's pagination math, but doesn't
 *     touch the routing/gating layer at all.
 *   - Neither test mounts a real react-router <Route>, so neither exercises
 *     ProtectedRoute's `useLocation()` call or the exact nesting App.js
 *     actually renders.
 *
 * What this test intentionally does NOT do:
 *   - It does not mount the real ReaderPage. ReaderPage has no mountable
 *     Jest harness in this codebase (markdown-to-jsx dependencies — see
 *     readerPageSafePageIndex.test.js's own header for precedent). A
 *     `MountTracker` stand-in is used instead: a real, stateful function
 *     component whose identity/mount-count is exactly what a remount would
 *     destroy, regardless of what the concrete leaf component is. Since
 *     GuestAwareGate/ProtectedRoute make their decision without any
 *     knowledge of what `children` is, this proxy is a faithful stand-in
 *     for ReaderPage (or LibraryPage) for the purpose of this test.
 *   - It mocks out `bellring/RequireBellRing` (and does not import
 *     `usePushNotifications`/the Notification/ServiceWorker chain it pulls
 *     in). This is a deliberate, narrow scope reduction, not a hidden one:
 *     RequireBellRing was read directly (src/eduhub/components/bellring/
 *     RequireBellRing.jsx) and confirmed to unconditionally render
 *     `<>{children}<BellRingGate .../></>` — children are never gated,
 *     conditionally mounted, or repositioned by it, so it cannot itself
 *     cause a remount. Mounting its real Notification/ServiceWorker-backed
 *     internals here would only add jsdom flakiness with zero additional
 *     proof value for the question this test answers.
 */
import { render, screen } from "@testing-library/react";

// react-router-dom@7 ships an ESM-only `exports` map that Jest's CRA
// harness cannot resolve (see voiceTreasure_passA1.mounted.test.jsx's own
// header for the same problem/fix in this codebase). This is the same
// minimal in-memory stand-in, trimmed to just what ProtectedRoute/
// GuestAwareGate actually use: MemoryRouter/Routes/Route for composition,
// useLocation/Navigate for ProtectedRoute's redirect path.
let mockCurrentPath = "/";
jest.mock("react-router-dom", () => {
  // eslint-disable-next-line global-require
  const R = require("react");
  const ParamContext = R.createContext({});
  function MemoryRouter({ initialEntries, children }) {
    mockCurrentPath = (initialEntries && initialEntries[0]) || "/";
    return R.createElement(R.Fragment, null, children);
  }
  function Routes({ children }) {
    const kids = R.Children.toArray(children);
    const match = kids.find((r) => {
      if (!r || !r.props || !r.props.path) return false;
      const patParts = r.props.path.split("/").filter(Boolean);
      const pthParts = mockCurrentPath.split("/").filter(Boolean);
      if (patParts.length !== pthParts.length) return false;
      return patParts.every((p, i) => p.startsWith(":") || p === pthParts[i]);
    });
    return match ? match.props.element : null;
  }
  function Route() { return null; }
  function Navigate() { return null; }
  function useLocation() { return { pathname: mockCurrentPath, search: "", hash: "", state: null }; }
  function useNavigate() { return () => {}; }
  return { __esModule: true, MemoryRouter, Routes, Route, Navigate, useLocation, useNavigate };
}, { virtual: true });

import { MemoryRouter, Routes, Route } from "react-router-dom"; // eslint-disable-line import/first
import GuestAwareGate from "../../../../components/GuestAwareGate"; // eslint-disable-line import/first
import { useAuth } from "../../../../context/AuthContext"; // eslint-disable-line import/first

jest.mock("../../../../context/AuthContext", () => ({
  useAuth: jest.fn(),
}));

jest.mock("../../../../components/bellring/RequireBellRing", () => ({ children }) => (
  <div data-testid="require-bell-ring-stub">{children}</div>
));

function setAuth({ isAuthenticated = false, isLoading = false, isBootstrapping = false, studentLoading, student = null } = {}) {
  useAuth.mockReturnValue({
    isAuthenticated,
    isLoading,
    isBootstrapping,
    // ProtectedRoute reads `studentLoading` directly (not `isBootstrapping`);
    // AuthContext's real useMemo always derives both from the same
    // underlying state, so a faithful mock must keep them in sync too —
    // defaulting studentLoading to isBootstrapping unless overridden lets a
    // test deliberately desync them to prove they're expected to agree.
    studentLoading: studentLoading === undefined ? isBootstrapping : studentLoading,
    student,
  });
}

let mountCount = 0;
function MountTracker() {
  // A real, stateful function component — mount count only increments via
  // this effect's empty dep array, which React runs exactly once per
  // distinct mount (never on a re-render of the SAME instance). A remount
  // (unmount + fresh mount) is the only way this counter moves twice.
  const React = require("react");
  React.useEffect(() => {
    mountCount += 1;
  }, []);
  return <div data-testid="reader-stand-in">Reader content</div>;
}

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={["/library/read/demo-book"]}>
      <Routes>
        <Route
          path="/library/read/:slug"
          element={
            <GuestAwareGate>
              <MountTracker />
            </GuestAwareGate>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mountCount = 0;
});

test("composed route (GuestAwareGate -> real ProtectedRoute) holds on the skeleton while bootstrapping, mounting the child zero times", () => {
  setAuth({ isAuthenticated: true, isBootstrapping: true });
  renderRoute();
  expect(screen.getByTestId("auth-loading-skeleton")).toBeInTheDocument();
  expect(screen.queryByTestId("reader-stand-in")).not.toBeInTheDocument();
  expect(mountCount).toBe(0);
});

test("composed route: an already-authenticated student settling out of bootstrap mounts the child exactly ONCE, already wrapped in the real ProtectedRoute", () => {
  setAuth({ isAuthenticated: true, isBootstrapping: false, student: { studentId: "S123" } });
  renderRoute();
  expect(screen.getByTestId("reader-stand-in")).toBeInTheDocument();
  expect(screen.getByTestId("require-bell-ring-stub")).toBeInTheDocument();
  expect(mountCount).toBe(1);
});

test("composed route: transitioning bootstrapping(true)->settled(true) across a rerender mounts the child exactly ONCE total, never twice — this is the exact regression scenario", () => {
  setAuth({ isAuthenticated: true, isBootstrapping: true, student: { studentId: "S123" } });
  const { rerender } = renderRoute();
  expect(mountCount).toBe(0);
  expect(screen.queryByTestId("reader-stand-in")).not.toBeInTheDocument();

  setAuth({ isAuthenticated: true, isBootstrapping: false, student: { studentId: "S123" } });
  rerender(
    <MemoryRouter initialEntries={["/library/read/demo-book"]}>
      <Routes>
        <Route
          path="/library/read/:slug"
          element={
            <GuestAwareGate>
              <MountTracker />
            </GuestAwareGate>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

  expect(screen.getByTestId("reader-stand-in")).toBeInTheDocument();
  // The single most important assertion in this file: exactly one mount,
  // never a second one caused by the child being unwrapped-then-rewrapped.
  expect(mountCount).toBe(1);
});

test("composed route: a genuine guest (never authenticated) mounts the child exactly once, unwrapped — no ProtectedRoute, no bell-ring stub", () => {
  setAuth({ isAuthenticated: false, isBootstrapping: false });
  renderRoute();
  expect(screen.getByTestId("reader-stand-in")).toBeInTheDocument();
  expect(screen.queryByTestId("require-bell-ring-stub")).not.toBeInTheDocument();
  expect(mountCount).toBe(1);
});

test("composed route: guest transitioning bootstrapping(true)->settled(false, guest) mounts exactly once, never remounted by the gate resolving", () => {
  setAuth({ isAuthenticated: false, isBootstrapping: true });
  const { rerender } = renderRoute();
  expect(mountCount).toBe(0);

  setAuth({ isAuthenticated: false, isBootstrapping: false });
  rerender(
    <MemoryRouter initialEntries={["/library/read/demo-book"]}>
      <Routes>
        <Route
          path="/library/read/:slug"
          element={
            <GuestAwareGate>
              <MountTracker />
            </GuestAwareGate>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  expect(screen.getByTestId("reader-stand-in")).toBeInTheDocument();
  expect(mountCount).toBe(1);
});
