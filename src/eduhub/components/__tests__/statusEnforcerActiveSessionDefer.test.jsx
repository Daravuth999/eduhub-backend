/**
 * statusEnforcerActiveSessionDefer.test.jsx — Issue 4 fix coverage.
 *
 * Proves StatusEnforcer's hard-logout backstop defers (never drops) while
 * a premium session (e.g. Live Voice Coach) is registered as active, and
 * that the deferred logout still fires reliably once the session ends —
 * the "nothing changed" version fast-path must never silently swallow a
 * deferred hard-logout. Also proves the pre-existing, protected behavior
 * (no active session → hard logout fires on schedule, exactly as before)
 * is unchanged.
 *
 * API_BASE is captured at module-load time in StatusEnforcer.jsx, so
 * REACT_APP_BACKEND_URL must be set BEFORE the module is required. We use
 * a single plain require() (not `import`, which Babel hoists above any
 * code) so the module — and therefore React itself — is only ever loaded
 * once per test file. jest.resetModules() is deliberately NOT used here:
 * it would hand the freshly-required component a second, disconnected
 * copy of `react` from the one @testing-library/react's statically
 * imported `render` is bound to, breaking the hooks dispatcher.
 */
import React from "react";
import { render, act } from "@testing-library/react";
import { registerActiveSession, unregisterActiveSession } from "../../lib/activeSessionRegistry";

const mockLogout = jest.fn();
jest.mock("../../context/AuthContext", () => ({
  useAuth: () => ({
    student: { studentId: "stu777" },
    isAuthenticated: true,
    logout: mockLogout,
  }),
}));

process.env.REACT_APP_BACKEND_URL = "https://backend.example.test";
const StatusEnforcer = require("../StatusEnforcer").default;

function mockFetchOnce(status, statusVersion) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status, statusVersion, liftAt: null }),
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockLogout.mockClear();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  unregisterActiveSession("live-1");
});

test("no active session — suspended status still hard-logs-out after the grace period (protected, unchanged)", async () => {
  mockFetchOnce("suspended", 1);
  render(<StatusEnforcer />);

  await act(async () => { await Promise.resolve(); });
  await act(async () => { jest.advanceTimersByTime(6_000); await Promise.resolve(); });

  expect(mockLogout).toHaveBeenCalledTimes(1);
});

test("active session — suspended status does NOT hard-log-out while the session is live", async () => {
  registerActiveSession("live-1");
  mockFetchOnce("suspended", 1);
  render(<StatusEnforcer />);

  await act(async () => { await Promise.resolve(); });
  await act(async () => { jest.advanceTimersByTime(6_000); await Promise.resolve(); });

  expect(mockLogout).not.toHaveBeenCalled();
});

test("deferred logout is never dropped — fires on the next poll tick once the session ends", async () => {
  registerActiveSession("live-1");
  mockFetchOnce("suspended", 1); // same statusVersion on every poll — server state hasn't changed
  render(<StatusEnforcer />);

  await act(async () => { await Promise.resolve(); });
  await act(async () => { jest.advanceTimersByTime(6_000); await Promise.resolve(); });
  expect(mockLogout).not.toHaveBeenCalled();

  // Session ends mid-restriction — same statusVersion, nothing changed server-side.
  unregisterActiveSession("live-1");

  // Next 10s poll tick re-evaluates from scratch (lastSeenVersionRef was
  // deliberately never advanced while deferred) and arms the timer.
  await act(async () => { jest.advanceTimersByTime(10_000); await Promise.resolve(); });
  await act(async () => { jest.advanceTimersByTime(6_000); await Promise.resolve(); });

  expect(mockLogout).toHaveBeenCalledTimes(1);
});

test("active session — a non-hard-logout status (e.g. restricted) is unaffected by the defer", async () => {
  registerActiveSession("live-1");
  mockFetchOnce("restricted", 1);
  render(<StatusEnforcer />);

  await act(async () => { await Promise.resolve(); });
  await act(async () => { jest.advanceTimersByTime(20_000); await Promise.resolve(); });

  // "restricted" is a SOFT_LOCK_STATUS, never a HARD_LOGOUT_STATUS — logout
  // is never armed for it regardless of session state, with or without the fix.
  expect(mockLogout).not.toHaveBeenCalled();
});

test("a session starting DURING the grace window is re-checked at fire time — timer armed before the session existed still does not log out", async () => {
  // Re-audit fix: the earlier "active session" test above starts the
  // session BEFORE the timer is ever armed, which the tick-time check
  // already covered. This test proves the fire-time re-check (added on
  // top of that) protects the harder case: the timer is armed while NO
  // session exists, and the session only starts mid-grace, after arming
  // but before the 6s elapses — the callback itself must re-check, since
  // nothing at arm time could have known a session was coming.
  mockFetchOnce("suspended", 1);
  render(<StatusEnforcer />);

  await act(async () => { await Promise.resolve(); }); // tick fires, no active session yet, timer arms
  expect(mockLogout).not.toHaveBeenCalled();

  await act(async () => { jest.advanceTimersByTime(3_000); }); // mid-grace
  registerActiveSession("live-1"); // session starts DURING the grace window

  await act(async () => { jest.advanceTimersByTime(3_000); await Promise.resolve(); }); // timer fires at 6s total

  expect(mockLogout).not.toHaveBeenCalled();
});

test("active session ends, then status recovers to active before the next tick — no logout, no stale timer", async () => {
  registerActiveSession("live-1");
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "suspended", statusVersion: 1, liftAt: null }) })
    .mockResolvedValue({ ok: true, json: async () => ({ status: "active", statusVersion: 2, liftAt: null }) });
  render(<StatusEnforcer />);

  await act(async () => { await Promise.resolve(); });
  unregisterActiveSession("live-1");
  await act(async () => { jest.advanceTimersByTime(10_000); await Promise.resolve(); });
  await act(async () => { jest.advanceTimersByTime(10_000); await Promise.resolve(); });

  expect(mockLogout).not.toHaveBeenCalled();
});
