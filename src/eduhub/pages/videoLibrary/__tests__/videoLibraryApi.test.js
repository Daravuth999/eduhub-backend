import { resolveMediaSrc, listLessons } from "../videoLibraryApi";

// Regression guard for the production 401 bug: every student `/api/video/*`
// call was cookie-only (credentials: "include") with no Bearer fallback,
// while every other working student route (achievementApi.js, attendance/
// api.js, voice-treasure/api.js, studentAuthService.js's own
// _bearerHeaders()) sends `Authorization: Bearer <student_session_token>`
// as a mobile Safari ITP fallback. Same test shape as
// voice-treasure/__tests__/voiceTreasureApi.test.jsx.
function makeFetch(captured) {
  return (url, opts) => {
    captured.url = url;
    captured.opts = opts;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ lessons: [] }) });
  };
}

describe("videoLibraryApi request() auth headers (Bug 1 regression)", () => {
  let cap;
  beforeEach(() => {
    cap = {};
    global.fetch = makeFetch(cap);
    global.localStorage = {
      _v: {},
      getItem(k) { return this._v[k] || null; },
      setItem(k, v) { this._v[k] = String(v); },
      removeItem(k) { delete this._v[k]; },
    };
  });

  test("sends credentials include and no Bearer when no token is cached", async () => {
    await listLessons();
    expect(cap.opts.credentials).toBe("include");
    expect(cap.opts.headers.Authorization).toBeUndefined();
  });

  test("attaches Authorization: Bearer <student_session_token> when present", async () => {
    global.localStorage.setItem("student_session_token", "tok123");
    await listLessons();
    expect(cap.opts.headers.Authorization).toBe("Bearer tok123");
  });
});

describe("resolveMediaSrc", () => {
  it("passes a direct R2 URL through unchanged", () => {
    expect(resolveMediaSrc("https://pub-xyz.r2.dev/sync-media/vid_1/a.mp4")).toBe(
      "https://pub-xyz.r2.dev/sync-media/vid_1/a.mp4",
    );
  });

  it("resolves a gridfs:// mediaRef into the real streaming route", () => {
    const result = resolveMediaSrc("gridfs://sync_media/abc123.mp4");
    expect(result).toContain("/api/sync/media/abc123.mp4");
  });

  it("returns empty string for a missing mediaRef", () => {
    expect(resolveMediaSrc(null)).toBe("");
    expect(resolveMediaSrc(undefined)).toBe("");
    expect(resolveMediaSrc("")).toBe("");
  });

  it("url-encodes special characters in a gridfs filename", () => {
    const result = resolveMediaSrc("gridfs://sync_media/a b.mp4");
    expect(result).toContain("/api/sync/media/a%20b.mp4");
  });
});
