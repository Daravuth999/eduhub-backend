/**
 * voiceTreasureApi.test.jsx — verifies the api client contract:
 * credentials include, Bearer only when token present, JSON vs FormData
 * (no manual Content-Type for FormData), correct preview vs commit bodies,
 * and that the password is only ever in the request body (never a header/url).
 * Uses a stub fetch; runnable under `craco test`.
 */
import * as api from "../api";

function makeFetch(captured) {
  return (url, opts) => {
    captured.url = url;
    captured.opts = opts;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
  };
}

describe("voice treasure api client", () => {
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

  test("GET sends credentials include and no Bearer when no token", async () => {
    await api.getToday();
    expect(cap.opts.credentials).toBe("include");
    expect(cap.opts.headers.Authorization).toBeUndefined();
  });

  test("Bearer header added only when token present", async () => {
    global.localStorage.setItem("student_session_token", "tok123");
    await api.getToday();
    expect(cap.opts.headers.Authorization).toBe("Bearer tok123");
  });

  test("preview body has no confirm flag (read-only)", async () => {
    await api.entryPreview({ password: "pw" });
    const body = JSON.parse(cap.opts.body);
    expect(body.password).toBe("pw");
    expect(body.confirm).toBeUndefined();
  });

  test("commit body sets confirm true + echoes offer", async () => {
    await api.entryConfirm({ password: "pw", missionId: "m-1", expectedCost: 10 });
    const body = JSON.parse(cap.opts.body);
    expect(body.confirm).toBe(true);
    expect(body.mission_id).toBe("m-1");
    expect(body.expected_cost).toBe(10);
  });

  test("password never appears in URL or headers", async () => {
    await api.entryConfirm({ password: "SECRET", missionId: "m-1", expectedCost: 10 });
    expect(String(cap.url)).not.toContain("SECRET");
    expect(JSON.stringify(cap.opts.headers)).not.toContain("SECRET");
  });

  test("submitAttempt uses FormData without manual Content-Type", async () => {
    // minimal FormData/Blob stubs
    const appended = [];
    global.FormData = class { append(k, v) { appended.push([k, v]); } };
    const blob = { type: "audio/webm", size: 10 };
    await api.submitAttempt({ entryId: "e1", audioBlob: blob, filename: "a.webm" });
    expect(cap.opts.headers["Content-Type"]).toBeUndefined();
    expect(cap.opts.credentials).toBe("include");
    expect(appended.find((p) => p[0] === "entry_id")[1]).toBe("e1");
    expect(appended.find((p) => p[0] === "audio")).toBeTruthy();
  });

  test("non-2xx throws with status", async () => {
    global.fetch = () => Promise.resolve({ ok: false, status: 402, json: () => Promise.resolve({ detail: "insufficient_balance" }) });
    let err;
    try { await api.entryConfirm({ password: "pw", missionId: "m", expectedCost: 1 }); }
    catch (e) { err = e; }
    expect(err.status).toBe(402);
    expect(err.data.detail).toBe("insufficient_balance");
  });
});
