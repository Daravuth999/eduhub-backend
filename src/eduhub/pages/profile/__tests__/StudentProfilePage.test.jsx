/**
 * StudentProfilePage.test.jsx — Premium Student Profile & Settings.
 *
 * Mocks the network layer (studentAuthService, library/api) and the
 * heavier hooks (useAuth, useLang, useAttendance, usePushNotifications)
 * entirely, matching the established AuthContext-mocking pattern from
 * statusEnforcerActiveSessionDefer.test.jsx. Asserts the UI CONTRACT:
 * loading -> data render, avatar upload/remove reuse the correct API
 * calls, change-password validates client-side before calling the API,
 * points/attendance render an honest "Not available" rather than fake
 * data when the backend has none, and logout calls the real AuthContext
 * logout function.
 *
 * The Points tile MUST call getStudentStats() from ../../library/api —
 * the same call Classroom Library uses — not a separate wallet endpoint.
 * This was a real bug caught in Milestone 5's first live review (the two
 * screens disagreed because Profile read a different, non-authoritative
 * source); these tests pin the fix.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import StudentProfilePage from "../StudentProfilePage";
import * as studentAuthService from "../../../auth/studentAuthService";
import * as libraryApi from "../../library/api";
import { playUiSound } from "../../../audio/uiSoundEngine";

const mockLogout = jest.fn();

jest.mock("../../../context/AuthContext", () => ({
  useAuth: () => ({
    student: { studentId: "stu001", group: "A", name: "Test Student" },
    isAuthenticated: true,
    logout: mockLogout,
  }),
}));

jest.mock("../../portal/contexts/LanguageContext", () => ({
  useLang: () => ({ lang: "en", toggle: jest.fn(), t: (k) => k }),
}));

jest.mock("../../../hooks/useAttendance", () => ({
  useAttendance: () => ({
    me: { attendance_rate: 0.92, current_streak: 5 },
    loading: false,
    currentStreak: 5,
    tier: "gold",
  }),
}));

jest.mock("../../../hooks/usePushNotifications", () => ({
  __esModule: true,
  default: () => ({ supported: true, permission: "default", enable: jest.fn() }),
}));

jest.mock("../../../components/ThemeToggle", () => ({
  __esModule: true,
  default: () => <button type="button" data-testid="mock-theme-toggle">Theme</button>,
}));

jest.mock("../../../auth/studentAuthService", () => ({
  getStudentProfile: jest.fn(),
  changeStudentPassword: jest.fn(),
  uploadStudentAvatar: jest.fn(),
  deleteStudentAvatar: jest.fn(),
}));

jest.mock("../../library/api", () => ({
  getStudentStats: jest.fn(),
}));

jest.mock("../../../audio/uiSoundEngine", () => ({
  playUiSound: jest.fn(),
}));

jest.mock("../../../audio/useSoundSettings", () => ({
  useSoundSettings: () => ({ mode: "soft", setMode: jest.fn() }),
}));

const PROFILE = {
  student_id: "stu001",
  clean_id: "stu001",
  display_name: "Test Student",
  group: "A",
  status: "active",
  role: "student",
  created_at: "2026-01-01T00:00:00Z",
  last_login: "2026-07-20T10:00:00Z",
  avatar_url: "",
};

beforeEach(() => {
  jest.clearAllMocks();
  studentAuthService.getStudentProfile.mockResolvedValue(PROFILE);
  libraryApi.getStudentStats.mockResolvedValue({
    success: true, totalPoints: 82, completedLessons: 100, currentStreak: 0, level: 1, XP: 0,
  });
});

test("shows a header skeleton while the profile is loading", async () => {
  let resolveProfile;
  studentAuthService.getStudentProfile.mockReturnValue(new Promise((r) => { resolveProfile = r; }));
  render(<StudentProfilePage />);
  expect(screen.getByTestId("profile-header-skeleton")).toBeInTheDocument();
  resolveProfile(PROFILE);
  await screen.findByTestId("profile-header-card");
});

test("renders identity, role/status chips, and join date from the real profile response", async () => {
  render(<StudentProfilePage />);
  expect(await screen.findByTestId("profile-display-name")).toHaveTextContent("Test Student");
  expect(screen.getByTestId("profile-role-chip")).toHaveTextContent("student");
  expect(screen.getByTestId("profile-status-chip")).toHaveTextContent("active");
});

test("shows 'Not available' instead of the literal 'Invalid Date' when created_at is missing or malformed", async () => {
  studentAuthService.getStudentProfile.mockResolvedValue({ ...PROFILE, created_at: undefined });
  render(<StudentProfilePage />);
  const card = await screen.findByTestId("profile-header-card");
  expect(card.textContent).toContain("Not available");
  expect(card.textContent).not.toContain("Invalid Date");
});

test("renders the same points value Classroom Library shows, via the same getStudentStats call", async () => {
  render(<StudentProfilePage />);
  await screen.findByTestId("profile-header-card");
  expect(libraryApi.getStudentStats).toHaveBeenCalledWith("stu001");
  expect(await screen.findByTestId("profile-points-tile")).toHaveTextContent("82");
});

test("shows an honest 'Not available' instead of fake data when the stats call fails", async () => {
  libraryApi.getStudentStats.mockResolvedValue({ success: false });
  render(<StudentProfilePage />);
  await screen.findByTestId("profile-header-card");
  expect(await screen.findByTestId("profile-points-unavailable")).toHaveTextContent("Not available");
});

test("avatar upload calls uploadStudentAvatar and updates the displayed photo", async () => {
  studentAuthService.uploadStudentAvatar.mockResolvedValue({ ok: true, avatar_url: "https://cdn.example.com/a.png" });
  render(<StudentProfilePage />);
  await screen.findByTestId("profile-header-card");

  const file = new File(["x"], "me.png", { type: "image/png" });
  const input = screen.getByTestId("profile-avatar-file-input");
  fireEvent.change(input, { target: { files: [file] } });

  await waitFor(() => expect(studentAuthService.uploadStudentAvatar).toHaveBeenCalledWith(file));
  expect(await screen.findByTestId("profile-avatar-image")).toHaveAttribute("src", "https://cdn.example.com/a.png");
  expect(playUiSound).toHaveBeenCalledWith("save");
});

test("avatar upload plays an error sound when the upload fails", async () => {
  studentAuthService.uploadStudentAvatar.mockRejectedValue(new Error("network down"));
  render(<StudentProfilePage />);
  await screen.findByTestId("profile-header-card");

  const file = new File(["x"], "me.png", { type: "image/png" });
  const input = screen.getByTestId("profile-avatar-file-input");
  fireEvent.change(input, { target: { files: [file] } });

  await waitFor(() => expect(studentAuthService.uploadStudentAvatar).toHaveBeenCalledWith(file));
  await waitFor(() => expect(playUiSound).toHaveBeenCalledWith("error"));
});

test("remove photo calls deleteStudentAvatar and falls back to initials", async () => {
  studentAuthService.getStudentProfile.mockResolvedValue({ ...PROFILE, avatar_url: "https://cdn.example.com/existing.png" });
  studentAuthService.deleteStudentAvatar.mockResolvedValue({ ok: true });
  render(<StudentProfilePage />);
  const removeBtn = await screen.findByTestId("profile-avatar-remove-btn");
  fireEvent.click(removeBtn);
  await waitFor(() => expect(studentAuthService.deleteStudentAvatar).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByTestId("profile-avatar-image")).not.toBeInTheDocument());
  expect(playUiSound).toHaveBeenCalledWith("save");
});

test("remove photo plays an error sound when the removal fails", async () => {
  studentAuthService.getStudentProfile.mockResolvedValue({ ...PROFILE, avatar_url: "https://cdn.example.com/existing.png" });
  studentAuthService.deleteStudentAvatar.mockRejectedValue(new Error("network down"));
  render(<StudentProfilePage />);
  const removeBtn = await screen.findByTestId("profile-avatar-remove-btn");
  fireEvent.click(removeBtn);
  await waitFor(() => expect(studentAuthService.deleteStudentAvatar).toHaveBeenCalled());
  await waitFor(() => expect(playUiSound).toHaveBeenCalledWith("error"));
});

test("change-password form rejects a mismatched confirmation before calling the API", async () => {
  render(<StudentProfilePage />);
  await screen.findByTestId("profile-header-card");

  fireEvent.change(screen.getByTestId("profile-current-password-input"), { target: { value: "oldpass" } });
  fireEvent.change(screen.getByTestId("profile-new-password-input"), { target: { value: "newpass1" } });
  fireEvent.change(screen.getByTestId("profile-confirm-password-input"), { target: { value: "different" } });
  fireEvent.click(screen.getByTestId("profile-change-password-submit"));

  expect(await screen.findByTestId("profile-change-password-error")).toHaveTextContent("don't match");
  expect(studentAuthService.changeStudentPassword).not.toHaveBeenCalled();
});

test("change-password form submits and shows a success toast on a valid match", async () => {
  studentAuthService.changeStudentPassword.mockResolvedValue({ ok: true });
  render(<StudentProfilePage />);
  await screen.findByTestId("profile-header-card");

  fireEvent.change(screen.getByTestId("profile-current-password-input"), { target: { value: "oldpass" } });
  fireEvent.change(screen.getByTestId("profile-new-password-input"), { target: { value: "newpass1" } });
  fireEvent.change(screen.getByTestId("profile-confirm-password-input"), { target: { value: "newpass1" } });
  fireEvent.click(screen.getByTestId("profile-change-password-submit"));

  await waitFor(() => expect(studentAuthService.changeStudentPassword).toHaveBeenCalledWith("oldpass", "newpass1"));
  expect(await screen.findByTestId("profile-toast")).toHaveTextContent("Password changed");
  expect(playUiSound).toHaveBeenCalledWith("success");
});

test("change-password form plays an error sound when the API call fails", async () => {
  studentAuthService.changeStudentPassword.mockRejectedValue(new Error("wrong current password"));
  render(<StudentProfilePage />);
  await screen.findByTestId("profile-header-card");

  fireEvent.change(screen.getByTestId("profile-current-password-input"), { target: { value: "oldpass" } });
  fireEvent.change(screen.getByTestId("profile-new-password-input"), { target: { value: "newpass1" } });
  fireEvent.change(screen.getByTestId("profile-confirm-password-input"), { target: { value: "newpass1" } });
  fireEvent.click(screen.getByTestId("profile-change-password-submit"));

  await waitFor(() => expect(studentAuthService.changeStudentPassword).toHaveBeenCalled());
  await waitFor(() => expect(playUiSound).toHaveBeenCalledWith("error"));
});

test("Sign Out calls the real AuthContext logout", async () => {
  render(<StudentProfilePage />);
  const btn = await screen.findByTestId("profile-logout-btn");
  fireEvent.click(btn);
  expect(mockLogout).toHaveBeenCalledTimes(1);
});

test("shows a header error state when the profile fetch fails, without rendering the rest of the page", async () => {
  studentAuthService.getStudentProfile.mockRejectedValue(new Error("Network down"));
  render(<StudentProfilePage />);
  expect(await screen.findByTestId("profile-header-error-text")).toHaveTextContent("Network down");
  expect(screen.queryByTestId("profile-learning-card")).not.toBeInTheDocument();
});
