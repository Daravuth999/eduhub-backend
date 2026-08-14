/**
 * studentAuthService.passwordReset.test.js — Milestone 4 (Authentication
 * Completion, Phase 1). Mocks global fetch and asserts the request
 * shape/URL/method for the 3 new functions this milestone adds. The
 * rest of studentAuthService.js has no pre-existing test file — these
 * new functions mirror the exact fetch-wrapper shape of the untested
 * sibling functions (createStudent/deactivateStudent/resetStudentPassword),
 * so this file focuses only on what Milestone 4 actually added.
 */
import {
  requestPasswordReset,
  listPasswordResetRequests,
  dismissPasswordResetRequest,
} from "../studentAuthService";

function mockFetchOnce(status, body) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

afterEach(() => {
  jest.resetAllMocks();
  localStorage.clear();
});

test("requestPasswordReset posts clean_id + turnstile_token with no credentials/admin headers", async () => {
  mockFetchOnce(200, { ok: true, message: "sent" });
  const result = await requestPasswordReset("stu001", "ts-token");

  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [url, opts] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/api\/auth\/student\/forgot-password$/);
  expect(opts.method).toBe("POST");
  expect(opts.credentials).toBeUndefined(); // unauthenticated endpoint — no session needed
  expect(JSON.parse(opts.body)).toEqual({ clean_id: "stu001", turnstile_token: "ts-token" });
  expect(result).toEqual({ ok: true, message: "sent" });
});

test("requestPasswordReset throws with the backend's detail message on failure", async () => {
  mockFetchOnce(400, { detail: "clean_id is required" });
  await expect(requestPasswordReset("", "")).rejects.toThrow("clean_id is required");
});

test("listPasswordResetRequests GETs the teacher endpoint and unwraps { requests }", async () => {
  mockFetchOnce(200, { requests: [{ request_id: "prr_1" }] });
  const result = await listPasswordResetRequests();

  const [url, opts] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/api\/teacher\/password-reset-requests$/);
  expect(opts.credentials).toBe("include");
  expect(result).toEqual([{ request_id: "prr_1" }]);
});

test("listPasswordResetRequests returns [] when the response has no requests key", async () => {
  mockFetchOnce(200, {});
  const result = await listPasswordResetRequests();
  expect(result).toEqual([]);
});

test("dismissPasswordResetRequest POSTs to the correct request_id-scoped URL", async () => {
  mockFetchOnce(200, { ok: true });
  await dismissPasswordResetRequest("prr_1");

  const [url, opts] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/api\/teacher\/password-reset-requests\/prr_1\/dismiss$/);
  expect(opts.method).toBe("POST");
  expect(opts.credentials).toBe("include");
});

test("dismissPasswordResetRequest throws on a 404", async () => {
  mockFetchOnce(404, { detail: "Request not found" });
  await expect(dismissPasswordResetRequest("nope")).rejects.toThrow("Request not found");
});
