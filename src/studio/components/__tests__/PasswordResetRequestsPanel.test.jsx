/**
 * PasswordResetRequestsPanel.test.jsx — Milestone 4 (Authentication
 * Completion, Phase 1). Mocks studentAuthService entirely (network layer
 * already covered by the backend's own password_reset_requests tests) and
 * asserts the UI CONTRACT: renders nothing when the queue is empty, lists
 * pending requests, and "Reset & Resolve" calls resetStudentPassword THEN
 * dismissPasswordResetRequest, in that order, reusing the existing reset
 * flow rather than duplicating it.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import PasswordResetRequestsPanel from "../PasswordResetRequestsPanel";
import * as studentAuthService from "../../../eduhub/auth/studentAuthService";

jest.mock("../../../eduhub/auth/studentAuthService", () => ({
  listPasswordResetRequests: jest.fn(),
  dismissPasswordResetRequest: jest.fn(),
  resetStudentPassword: jest.fn(),
}));

const REQUEST = {
  request_id: "prr_1",
  student_id: "stu001",
  clean_id: "stu001",
  display_name: "Test Student",
  group: "A",
  status: "pending",
};

beforeEach(() => {
  jest.clearAllMocks();
});

test("renders nothing while the queue is empty", async () => {
  studentAuthService.listPasswordResetRequests.mockResolvedValue([]);
  const { container } = render(<PasswordResetRequestsPanel />);
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});

test("lists pending requests with the student's name and clean_id", async () => {
  studentAuthService.listPasswordResetRequests.mockResolvedValue([REQUEST]);
  render(<PasswordResetRequestsPanel />);
  const row = await screen.findByTestId("password-reset-request-row");
  expect(row).toHaveTextContent("Test Student");
  expect(row).toHaveTextContent("stu001");
});

test("Reset & Resolve reuses resetStudentPassword, then dismisses, then calls onCredential", async () => {
  studentAuthService.listPasswordResetRequests
    .mockResolvedValueOnce([REQUEST])
    .mockResolvedValueOnce([]); // queue is empty after refresh
  const credential = { clean_id: "stu001", display_name: "Test Student", password: "new-pass" };
  studentAuthService.resetStudentPassword.mockResolvedValue(credential);
  studentAuthService.dismissPasswordResetRequest.mockResolvedValue({ ok: true });
  const onCredential = jest.fn();

  render(<PasswordResetRequestsPanel onCredential={onCredential} />);
  const btn = await screen.findByTestId("password-reset-request-resolve-btn");
  fireEvent.click(btn);

  await waitFor(() => expect(studentAuthService.resetStudentPassword).toHaveBeenCalledWith("stu001"));
  await waitFor(() => expect(studentAuthService.dismissPasswordResetRequest).toHaveBeenCalledWith("prr_1"));
  await waitFor(() => expect(onCredential).toHaveBeenCalledWith(credential));

  // Order matters: must reuse the existing reset call before dismissing —
  // never dismiss a request without actually having reset the password.
  const resetOrder = studentAuthService.resetStudentPassword.mock.invocationCallOrder[0];
  const dismissOrder = studentAuthService.dismissPasswordResetRequest.mock.invocationCallOrder[0];
  expect(resetOrder).toBeLessThan(dismissOrder);
});

test("shows an inline error and does not crash if resetStudentPassword fails", async () => {
  studentAuthService.listPasswordResetRequests.mockResolvedValue([REQUEST]);
  studentAuthService.resetStudentPassword.mockRejectedValue(new Error("Student not found"));

  render(<PasswordResetRequestsPanel />);
  const btn = await screen.findByTestId("password-reset-request-resolve-btn");
  fireEvent.click(btn);

  expect(await screen.findByText("Student not found")).toBeInTheDocument();
  expect(studentAuthService.dismissPasswordResetRequest).not.toHaveBeenCalled();
});
