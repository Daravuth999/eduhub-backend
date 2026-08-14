import { registerActiveSession, unregisterActiveSession, hasActiveSession } from "../activeSessionRegistry";

describe("activeSessionRegistry", () => {
  afterEach(() => {
    // Best-effort drain in case a test forgets to unregister — keeps tests isolated.
    unregisterActiveSession("s1");
    unregisterActiveSession("s2");
  });

  test("hasActiveSession is false with nothing registered", () => {
    expect(hasActiveSession()).toBe(false);
  });

  test("registering a session makes hasActiveSession true", () => {
    registerActiveSession("s1");
    expect(hasActiveSession()).toBe(true);
    unregisterActiveSession("s1");
    expect(hasActiveSession()).toBe(false);
  });

  test("multiple sessions: only false once ALL are unregistered", () => {
    registerActiveSession("s1");
    registerActiveSession("s2");
    expect(hasActiveSession()).toBe(true);
    unregisterActiveSession("s1");
    expect(hasActiveSession()).toBe(true); // s2 still active
    unregisterActiveSession("s2");
    expect(hasActiveSession()).toBe(false);
  });

  test("register is idempotent for the same key", () => {
    registerActiveSession("s1");
    registerActiveSession("s1");
    expect(hasActiveSession()).toBe(true);
    unregisterActiveSession("s1");
    expect(hasActiveSession()).toBe(false);
  });

  test("unregister on a never-registered or already-cleared key never throws", () => {
    expect(() => unregisterActiveSession("never-registered")).not.toThrow();
    registerActiveSession("s1");
    unregisterActiveSession("s1");
    expect(() => unregisterActiveSession("s1")).not.toThrow();
  });

  test("null/undefined/empty keys are safely ignored", () => {
    expect(() => registerActiveSession(null)).not.toThrow();
    expect(() => registerActiveSession(undefined)).not.toThrow();
    expect(() => registerActiveSession("")).not.toThrow();
    expect(hasActiveSession()).toBe(false);
    expect(() => unregisterActiveSession(null)).not.toThrow();
  });
});
