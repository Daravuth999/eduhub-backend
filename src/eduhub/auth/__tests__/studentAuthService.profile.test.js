/**
 * studentAuthService.profile.test.js — Premium Student Profile & Settings.
 * Mocks global fetch and asserts request shape/URL/method for the 4 new
 * functions this milestone adds to studentAuthService.js.
 */
import {
  getStudentProfile,
  changeStudentPassword,
  uploadStudentAvatar,
  deleteStudentAvatar,
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

test("getStudentProfile GETs /auth/student/me with credentials included", async () => {
  mockFetchOnce(200, { student_id: "stu001", status: "active", role: "student" });
  const result = await getStudentProfile();
  const [url, opts] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/api\/auth\/student\/me$/);
  expect(opts.credentials).toBe("include");
  expect(result.status).toBe("active");
});

test("changeStudentPassword posts current_password/new_password as JSON", async () => {
  mockFetchOnce(200, { ok: true });
  await changeStudentPassword("old1", "new1");
  const [url, opts] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/api\/auth\/student\/change-password$/);
  expect(opts.method).toBe("POST");
  expect(JSON.parse(opts.body)).toEqual({ current_password: "old1", new_password: "new1" });
});

test("changeStudentPassword throws the backend's detail message on failure", async () => {
  mockFetchOnce(401, { detail: "Current password is incorrect" });
  await expect(changeStudentPassword("wrong", "new1")).rejects.toThrow("Current password is incorrect");
});

test("uploadStudentAvatar POSTs multipart form data without a manual Content-Type header", async () => {
  mockFetchOnce(200, { ok: true, avatar_url: "https://cdn.example.com/a.png" });
  const file = new File(["x"], "me.png", { type: "image/png" });
  const result = await uploadStudentAvatar(file);

  const [url, opts] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/api\/auth\/student\/avatar$/);
  expect(opts.method).toBe("POST");
  expect(opts.body).toBeInstanceOf(FormData);
  expect(opts.headers["Content-Type"]).toBeUndefined();
  expect(result.avatar_url).toBe("https://cdn.example.com/a.png");
});

test("deleteStudentAvatar DELETEs /auth/student/avatar", async () => {
  mockFetchOnce(200, { ok: true });
  await deleteStudentAvatar();
  const [url, opts] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/api\/auth\/student\/avatar$/);
  expect(opts.method).toBe("DELETE");
});

test("uploadStudentAvatar surfaces a clear timeout message instead of spinning forever on an abort", async () => {
  global.fetch = jest.fn().mockImplementation(() => {
    const err = new Error("aborted");
    err.name = "AbortError";
    return Promise.reject(err);
  });
  const file = new File(["x"], "me.png", { type: "image/png" });
  await expect(uploadStudentAvatar(file)).rejects.toThrow(
    "Upload timed out. Check your connection and try again.",
  );
});

test("deleteStudentAvatar surfaces a clear timeout message on an abort", async () => {
  global.fetch = jest.fn().mockImplementation(() => {
    const err = new Error("aborted");
    err.name = "AbortError";
    return Promise.reject(err);
  });
  await expect(deleteStudentAvatar()).rejects.toThrow(
    "Request timed out. Check your connection and try again.",
  );
});
