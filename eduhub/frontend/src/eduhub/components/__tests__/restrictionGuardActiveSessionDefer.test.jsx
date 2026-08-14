/**
 * restrictionGuardActiveSessionDefer.test.jsx — Issue 4 fix coverage.
 *
 * Proves RestrictionGuard's 3s auto-sign-out countdown holds at 1s (never
 * reaching 0) while a premium session (e.g. Live Voice Coach) is
 * registered as active, and resumes counting down normally the instant
 * the session ends. Also proves the pre-existing, protected behavior (no
 * active session → countdown reaches 0 and logs out on schedule) is
 * unchanged, and that "Sign out now" always works immediately regardless
 * of session state.
 *
 * jest.mock() factories are hoisted by Babel above ALL other top-level
 * code in the file, including const declarations textually above them —
 * so the mock's mutable state must be created INSIDE the factory (only
 * jest.fn()/jest-global references are safe to close over at hoist time),
 * then retrieved afterwards via a plain require() of the mocked module.
 */
import React from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { registerActiveSession, unregisterActiveSession } from "../../lib/activeSessionRegistry";

jest.mock("../../context/AuthContext", () => {
  const state = { isRestricted: false, restrictionMsg: "Test restriction.", logout: jest.fn() };
  return {
    __authState: state,
    useAuth: () => state,
  };
});

const authState = require("../../context/AuthContext").__authState;
const mockLogout = authState.logout;
const RestrictionGuard = require("../RestrictionGuard").default;

beforeEach(() => {
  jest.useFakeTimers();
  mockLogout.mockClear();
  authState.isRestricted = false;
  authState.restrictionMsg = "Test restriction.";
});

afterEach(() => {
  jest.useRealTimers();
  unregisterActiveSession("live-1");
});

test("no active session — countdown reaches 0 and auto-signs-out after 3s (protected, unchanged)", () => {
  authState.isRestricted = true;
  const { rerender } = render(<RestrictionGuard />);
  rerender(<RestrictionGuard />);

  act(() => { jest.advanceTimersByTime(3_000); });
  // The final interval tick schedules a setTimeout(fn, 0) — flush it.
  act(() => { jest.runOnlyPendingTimers(); });

  expect(mockLogout).toHaveBeenCalledTimes(1);
});

test("active session — countdown holds at 1s and never auto-signs-out", () => {
  registerActiveSession("live-1");
  authState.isRestricted = true;
  const { rerender } = render(<RestrictionGuard />);
  rerender(<RestrictionGuard />);

  act(() => { jest.advanceTimersByTime(10_000); });

  expect(screen.getByTestId("restriction-guard-countdown")).toHaveTextContent("SIGNING OUT IN 1s");
  expect(mockLogout).not.toHaveBeenCalled();
});

test("active session ends mid-countdown — resumes and reaches 0 on the next tick", () => {
  registerActiveSession("live-1");
  authState.isRestricted = true;
  const { rerender } = render(<RestrictionGuard />);
  rerender(<RestrictionGuard />);

  act(() => { jest.advanceTimersByTime(5_000); });
  expect(mockLogout).not.toHaveBeenCalled();

  unregisterActiveSession("live-1");
  act(() => { jest.advanceTimersByTime(1_000); });
  // The final interval tick schedules a setTimeout(fn, 0) — flush it.
  act(() => { jest.runOnlyPendingTimers(); });

  expect(mockLogout).toHaveBeenCalledTimes(1);
});

test("active session — Sign out now button still works immediately", () => {
  registerActiveSession("live-1");
  authState.isRestricted = true;
  const { rerender } = render(<RestrictionGuard />);
  rerender(<RestrictionGuard />);

  act(() => { jest.advanceTimersByTime(2_000); });
  expect(mockLogout).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId("restriction-guard-logout"));

  expect(mockLogout).toHaveBeenCalledTimes(1);
});
