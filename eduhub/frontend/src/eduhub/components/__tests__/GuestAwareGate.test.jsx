import { render, screen } from "@testing-library/react";
import GuestAwareGate from "../GuestAwareGate";
import { useAuth } from "../../context/AuthContext";

jest.mock("../../context/AuthContext", () => ({
  useAuth: jest.fn(),
}));

// Isolated unit test — ProtectedRoute/RequireBellRing have their own real
// dependencies (react-router-dom's useLocation, the bell-ring permission
// hook); mocking them here keeps this test scoped to GuestAwareGate's own
// branching logic, not their internals (which are untouched by this patch).
jest.mock("../ProtectedRoute", () => ({ children }) => (
  <div data-testid="protected-route">{children}</div>
));
jest.mock("../bellring/RequireBellRing", () => ({ children }) => (
  <div data-testid="require-bell-ring">{children}</div>
));

function setAuth({ isAuthenticated = false, isLoading = false, isBootstrapping = false } = {}) {
  useAuth.mockReturnValue({ isAuthenticated, isLoading, isBootstrapping });
}

test("guest (unauthenticated, bootstrap already settled): renders children directly, no ProtectedRoute/RequireBellRing", () => {
  setAuth({ isAuthenticated: false });
  render(
    <GuestAwareGate>
      <div data-testid="page">Library</div>
    </GuestAwareGate>,
  );
  expect(screen.getByTestId("page")).toHaveTextContent("Library");
  expect(screen.queryByTestId("protected-route")).not.toBeInTheDocument();
  expect(screen.queryByTestId("require-bell-ring")).not.toBeInTheDocument();
});

test("authenticated student (bootstrap already settled): exact today's nesting — ProtectedRoute wrapping RequireBellRing wrapping children", () => {
  setAuth({ isAuthenticated: true });
  render(
    <GuestAwareGate>
      <div data-testid="page">Library</div>
    </GuestAwareGate>,
  );
  const protectedRoute = screen.getByTestId("protected-route");
  const requireBellRing = screen.getByTestId("require-bell-ring");
  const page = screen.getByTestId("page");
  expect(protectedRoute).toContainElement(requireBellRing);
  expect(requireBellRing).toContainElement(page);
});

/* ═══════════════════════════════════════════════════════════════════════
   Hotfix — bootstrap-window regression (Aug 2026)

   Root cause (confirmed via git-diff audit, not guessed): the original
   GuestAwareGate read `isAuthenticated` immediately, which is `false` for
   EVERY caller — guest and already-logged-in student alike — until
   AuthContext's session-restore round-trip resolves. A real student's
   children (ReaderPage/LibraryPage) mounted unwrapped first, then got
   torn down and remounted inside <ProtectedRoute> the instant bootstrap
   resolved — a full remount discarding in-flight fetch state, reading
   position, WelcomeOverlay, pagination. These tests pin the fix: the tree
   shape must be decided exactly once, AFTER bootstrap settles, mirroring
   ProtectedRoute.jsx's own established bootstrap-holding convention.
   ═══════════════════════════════════════════════════════════════════════ */
describe("Bootstrap-window hold (prevents the remount regression)", () => {
  test("while isBootstrapping is true, renders the loading skeleton — NOT children, NOT ProtectedRoute", () => {
    setAuth({ isAuthenticated: false, isBootstrapping: true });
    render(
      <GuestAwareGate>
        <div data-testid="page">Reader</div>
      </GuestAwareGate>,
    );
    expect(screen.getByTestId("auth-loading-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("page")).not.toBeInTheDocument();
    expect(screen.queryByTestId("protected-route")).not.toBeInTheDocument();
  });

  test("while isLoading is true (login-form spinner state), also holds on the skeleton", () => {
    setAuth({ isAuthenticated: false, isLoading: true });
    render(
      <GuestAwareGate>
        <div data-testid="page">Reader</div>
      </GuestAwareGate>,
    );
    expect(screen.getByTestId("auth-loading-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("page")).not.toBeInTheDocument();
  });

  test("an ALREADY-authenticated student never renders the unwrapped guest shape, even for one frame — no remount is possible", () => {
    // Simulates the exact regression: isAuthenticated is true (real
    // student) but bootstrap hasn't confirmed it locally yet. The old code
    // would render children directly here (guest shape); the fix must
    // hold on the skeleton instead, so ProtectedRoute mounts ONCE, already
    // in its final wrapped position — never remounted later.
    setAuth({ isAuthenticated: true, isBootstrapping: true });
    render(
      <GuestAwareGate>
        <div data-testid="page">Reader</div>
      </GuestAwareGate>,
    );
    expect(screen.getByTestId("auth-loading-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("page")).not.toBeInTheDocument();
    expect(screen.queryByTestId("protected-route")).not.toBeInTheDocument();
  });

  test("transitioning from bootstrapping to settled-authenticated does not remount children — same DOM node preserved", () => {
    setAuth({ isAuthenticated: true, isBootstrapping: true });
    const { rerender } = render(
      <GuestAwareGate>
        <div data-testid="page">Reader</div>
      </GuestAwareGate>,
    );
    expect(screen.queryByTestId("page")).not.toBeInTheDocument();

    setAuth({ isAuthenticated: true, isBootstrapping: false });
    rerender(
      <GuestAwareGate>
        <div data-testid="page">Reader</div>
      </GuestAwareGate>,
    );
    // The page now mounts for the FIRST time, already inside its final
    // ProtectedRoute-wrapped shape — this is the one-and-only mount, not a
    // second mount replacing an earlier unwrapped one.
    const protectedRoute = screen.getByTestId("protected-route");
    const page = screen.getByTestId("page");
    expect(protectedRoute).toContainElement(page);
  });
});
