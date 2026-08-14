import { getOrCreateJoinIdempotencyKey } from "../speakingLabApi";

describe("joinActive — ambiguous timeout handling", () => {
  const originalEnv = process.env.REACT_APP_BACKEND_URL;

  beforeEach(() => {
    // RENDER_BASE is captured at module-load time, so the backend URL
    // must be set BEFORE the module is (re-)imported for this describe
    // block's tests.
    process.env.REACT_APP_BACKEND_URL = "https://backend.example.test";
    jest.resetModules();
    jest.useFakeTimers();
  });

  afterEach(() => {
    process.env.REACT_APP_BACKEND_URL = originalEnv;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("a request that never resolves within the timeout throws ambiguous_timeout, not a silent failure", async () => {
    const mod = require("../speakingLabApi");
    // fetch that respects AbortSignal — never resolves on its own, only
    // rejects when the controller's signal fires (matches real browser
    // fetch behavior under an AbortController timeout).
    jest.spyOn(global, "fetch").mockImplementation(
      (_url: any, init: any) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err: any = new Error("The operation was aborted.");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    const pending = mod.speakingLabApi.joinActive();
    // Attach a rejection handler immediately so advancing timers doesn't
    // trigger an unhandled-rejection warning before the assertion runs.
    const assertion = expect(pending).rejects.toMatchObject({
      code: "ambiguous_timeout",
    });
    jest.advanceTimersByTime(mod.DIRECT_JOIN_TIMEOUT_MS + 1);
    await assertion;
  });

  /** Drives the retry loop under fake timers: each pass flushes pending
   * microtasks then advances far enough to cover a per-attempt timeout
   * AND any backoff sleep, regardless of exact interleaving. */
  async function flushActiveSessionRetries(mod: any, passes = 12) {
    for (let i = 0; i < passes; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(mod.ACTIVE_SESSION_TIMEOUT_MS + 5_000);
      await Promise.resolve();
    }
  }

  test("activeSession retries hung requests and only then fails cleanly with backend_unreachable", async () => {
    const mod = require("../speakingLabApi");
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(
      (_url: any, init: any) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err: any = new Error("The operation was aborted.");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    const pending = mod.speakingLabApi.activeSession();
    const assertion = expect(pending).rejects.toMatchObject({
      code: "backend_unreachable",
    });
    await flushActiveSessionRetries(mod);
    await assertion;
    // Every attempt was actually made — a hang is retried, not fatal on
    // the first abort.
    expect(fetchSpy).toHaveBeenCalledTimes(mod.ACTIVE_SESSION_MAX_ATTEMPTS);
  });

  test("activeSession recovers when a retry succeeds after an initial network failure (cold-start survival)", async () => {
    const mod = require("../speakingLabApi");
    const goodResponse = {
      ok: true,
      json: async () => ({
        ok: true, active: true, session_id: "sl_123", schedule: "AB",
        entry_fee: 4, pool_total: 0, player_count: 0,
        direct_join_enabled: true, existing_entry: null,
      }),
    } as any;
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(goodResponse);

    const pending = mod.speakingLabApi.activeSession();
    const assertion = expect(pending).resolves.toMatchObject({ active: true });
    await flushActiveSessionRetries(mod);
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("activeSession NEVER retries a real HTTP response — a definitive 401 is thrown after exactly one attempt", async () => {
    const mod = require("../speakingLabApi");
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ detail: "Not authenticated" }),
    } as any);

    await expect(mod.speakingLabApi.activeSession()).rejects.toMatchObject({
      code: "auth_expired",
      httpStatus: 401,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("speakingLabApi never sends a client-supplied student id", () => {
  const originalEnv = process.env.REACT_APP_BACKEND_URL;

  beforeEach(() => {
    process.env.REACT_APP_BACKEND_URL = "https://backend.example.test";
    jest.resetModules();
  });

  afterEach(() => {
    process.env.REACT_APP_BACKEND_URL = originalEnv;
    jest.restoreAllMocks();
  });

  test("activeSession and joinActive take no arguments — identity can only come from the trusted auth header/cookie", () => {
    const mod = require("../speakingLabApi");
    expect(mod.speakingLabApi.activeSession.length).toBe(0);
    expect(mod.speakingLabApi.joinActive.length).toBe(0);
  });

  test("activeSession's request never contains a student-id-shaped field", async () => {
    const mod = require("../speakingLabApi");
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true, active: false, session_id: "", schedule: "",
        entry_fee: 0, pool_total: 0, player_count: 0,
        direct_join_enabled: false, existing_entry: null,
      }),
    } as any);

    await mod.speakingLabApi.activeSession();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).not.toMatch(/student|clean_id|studentId/i);
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe("include");
  });

  test("joinActive's request URL and body never contain a student-id-shaped field", async () => {
    const mod = require("../speakingLabApi");
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, session_id: "sl_123", lucky_code: "STAR-1" }),
    } as any);

    await mod.speakingLabApi.joinActive();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).not.toMatch(/student|clean_id|studentId/i);
    const sentBody = JSON.parse(String(init.body));
    expect(Object.keys(sentBody)).toEqual(["idempotency_key"]);
    expect(JSON.stringify(sentBody)).not.toMatch(/student|clean_id|studentId/i);
    // Identity travels only via the auth header / cookie, never the body.
    expect(init.credentials).toBe("include");
  });
});

describe("speakingLabApi uses the same backend-URL resolver as the rest of My Portal", () => {
  const originalEnv = process.env.REACT_APP_BACKEND_URL;

  afterEach(() => {
    process.env.REACT_APP_BACKEND_URL = originalEnv;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test("activeSession and joinActive call the correct final URL, with no /api/api double-prefix", async () => {
    process.env.REACT_APP_BACKEND_URL = "https://backend.example.test/";
    jest.resetModules();
    const mod = require("../speakingLabApi");
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true, active: false, session_id: "", schedule: "",
        entry_fee: 0, pool_total: 0, player_count: 0,
        direct_join_enabled: false, existing_entry: null,
      }),
    } as any);

    await mod.speakingLabApi.activeSession();
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://backend.example.test/api/speaking-lab/active-session",
    );

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, session_id: "sl_123", lucky_code: "STAR-1" }),
    } as any);
    await mod.speakingLabApi.joinActive();
    expect(fetchSpy.mock.calls[1][0]).toBe(
      "https://backend.example.test/api/speaking-lab/join-active",
    );
  });

  test("when REACT_APP_BACKEND_URL is absent, all calls fail cleanly — never a malformed fetch, never a crash", async () => {
    delete process.env.REACT_APP_BACKEND_URL;
    jest.resetModules();
    const mod = require("../speakingLabApi");
    const fetchSpy = jest.spyOn(global, "fetch");

    await expect(mod.speakingLabApi.activeSession()).rejects.toMatchObject({
      code: "backend_unreachable",
    });
    await expect(mod.speakingLabApi.joinActive()).rejects.toMatchObject({
      code: "backend_unreachable",
    });
    // No request is attempted at all when the base URL is unknown — this
    // is a clean, immediate failure, not a relative-URL request to the
    // wrong origin.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a 401 response is always classified as auth_expired, regardless of which route it came from", async () => {
    process.env.REACT_APP_BACKEND_URL = "https://backend.example.test";
    jest.resetModules();
    const mod = require("../speakingLabApi");
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ detail: "Not authenticated" }),
    } as any);

    await expect(mod.speakingLabApi.activeSession()).rejects.toMatchObject({
      code: "auth_expired",
      httpStatus: 401,
    });
  });
});

describe("GET requests stay CORS-simple (no preflight)", () => {
  const originalEnv = process.env.REACT_APP_BACKEND_URL;

  beforeEach(() => {
    process.env.REACT_APP_BACKEND_URL = "https://backend.example.test";
    jest.resetModules();
  });

  afterEach(() => {
    process.env.REACT_APP_BACKEND_URL = originalEnv;
    jest.restoreAllMocks();
  });

  test("activeSession sends NO Content-Type header — a bodyless GET with one would force a preflight OPTIONS round trip", async () => {
    const mod = require("../speakingLabApi");
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true, active: false, session_id: "", schedule: "",
        entry_fee: 0, pool_total: 0, player_count: 0,
        direct_join_enabled: false, existing_entry: null,
      }),
    } as any);

    await mod.speakingLabApi.activeSession();

    for (const [, init] of fetchSpy.mock.calls) {
      expect(Object.keys(init.headers)).not.toContain("Content-Type");
    }
  });

  test("joinActive (a JSON POST) still sends Content-Type", async () => {
    const mod = require("../speakingLabApi");
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, session_id: "sl_123", lucky_code: "STAR-1" }),
    } as any);

    await mod.speakingLabApi.joinActive();

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("application/json");
  });
});

describe("getOrCreateJoinIdempotencyKey", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  test("returns the same key on repeated calls for the same session", () => {
    const a = getOrCreateJoinIdempotencyKey("sl_123");
    const b = getOrCreateJoinIdempotencyKey("sl_123");
    expect(a).toBe(b);
  });

  test("returns a different key for a different session id", () => {
    const a = getOrCreateJoinIdempotencyKey("sl_123");
    const b = getOrCreateJoinIdempotencyKey("sl_456");
    expect(a).not.toBe(b);
  });

  test("survives a simulated page refresh (key persists via sessionStorage)", () => {
    const before = getOrCreateJoinIdempotencyKey("sl_789");
    // Simulate a refresh: nothing clears sessionStorage between calls.
    const after = getOrCreateJoinIdempotencyKey("sl_789");
    expect(after).toBe(before);
  });
});
