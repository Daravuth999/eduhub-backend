/**
 * AnnouncementsStudio.test.jsx — Author Studio's "Announcements" screen
 * (Dashboard Showcases, architecture continuation). Mocks ./api entirely
 * (network layer already covered by the backend's own experience_config
 * admin CRUD tests) and asserts the UI CONTRACT: it lists configs scoped
 * to experienceType="announcement", creates/edits a plain message list,
 * and drives publish/unpublish/delete through the real API functions.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AnnouncementsStudio from "../AnnouncementsStudio";
import * as api from "../api";

jest.mock("../api", () => ({
  listExperienceConfigs: jest.fn(),
  createExperienceConfig: jest.fn(),
  updateExperienceConfig: jest.fn(),
  publishExperienceConfig: jest.fn(),
  unpublishExperienceConfig: jest.fn(),
  deleteExperienceConfig: jest.fn(),
}));

const DRAFT_CONFIG = {
  id: "cfg-1",
  experienceType: "announcement",
  key: "default",
  status: "draft",
  updatedAt: "2026-01-01T00:00:00Z",
  content: { announcementMessages: ["Class starts at 5pm"], visible: true },
};

const PUBLISHED_CONFIG = { ...DRAFT_CONFIG, id: "cfg-2", key: "seasonal", status: "published" };

beforeEach(() => {
  jest.clearAllMocks();
  api.listExperienceConfigs.mockResolvedValue({ configs: [] });
});

test("loads and lists configs scoped to announcement on mount", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [DRAFT_CONFIG] });
  render(<AnnouncementsStudio />);
  await waitFor(() => expect(api.listExperienceConfigs).toHaveBeenCalledWith("announcement"));
  expect(await screen.findByTestId(`announcements-row-${DRAFT_CONFIG.id}`)).toHaveTextContent("Class starts at 5pm");
});

test("shows an empty state and explains the legacy GAS fallback when no configs exist", async () => {
  render(<AnnouncementsStudio />);
  expect(await screen.findByTestId("announcements-empty")).toHaveTextContent(/legacy Google Apps Script/i);
});

test("creates a new config with one message", async () => {
  api.createExperienceConfig.mockResolvedValue({ id: "cfg-new" });
  render(<AnnouncementsStudio />);
  fireEvent.click(await screen.findByTestId("announcements-new"));
  fireEvent.change(screen.getByTestId("announcements-message-input-0"), { target: { value: "New books added" } });
  fireEvent.click(screen.getByTestId("announcements-save"));
  await waitFor(() => expect(api.createExperienceConfig).toHaveBeenCalledWith({
    experienceType: "announcement", key: "default",
    content: { announcementMessages: ["New books added"], visible: true },
  }));
});

test("adds and removes message rows in the form", async () => {
  render(<AnnouncementsStudio />);
  fireEvent.click(await screen.findByTestId("announcements-new"));
  fireEvent.click(screen.getByTestId("announcements-add-message"));
  expect(screen.getByTestId("announcements-message-input-1")).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("announcements-remove-message-1"));
  expect(screen.queryByTestId("announcements-message-input-1")).not.toBeInTheDocument();
});

test("rejects saving with no non-empty messages", async () => {
  render(<AnnouncementsStudio />);
  fireEvent.click(await screen.findByTestId("announcements-new"));
  fireEvent.click(screen.getByTestId("announcements-save"));
  expect(await screen.findByTestId("announcements-form-error")).toHaveTextContent(/at least one/i);
  expect(api.createExperienceConfig).not.toHaveBeenCalled();
});

test("edits an existing config's messages", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [DRAFT_CONFIG] });
  api.updateExperienceConfig.mockResolvedValue({ ok: true });
  render(<AnnouncementsStudio />);
  fireEvent.click(await screen.findByTestId(`announcements-edit-${DRAFT_CONFIG.id}`));
  fireEvent.change(screen.getByTestId("announcements-message-input-0"), { target: { value: "Updated message" } });
  fireEvent.click(screen.getByTestId("announcements-save"));
  await waitFor(() => expect(api.updateExperienceConfig).toHaveBeenCalledWith(DRAFT_CONFIG.id, {
    content: { announcementMessages: ["Updated message"], visible: true },
  }));
});

test("publishes and unpublishes a config", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [DRAFT_CONFIG] });
  api.publishExperienceConfig.mockResolvedValue({ ok: true });
  render(<AnnouncementsStudio />);
  fireEvent.click(await screen.findByTestId(`announcements-publish-${DRAFT_CONFIG.id}`));
  await waitFor(() => expect(api.publishExperienceConfig).toHaveBeenCalledWith(DRAFT_CONFIG.id));
});

test("deletes a config after confirming", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [DRAFT_CONFIG] });
  api.deleteExperienceConfig.mockResolvedValue({ ok: true });
  render(<AnnouncementsStudio />);
  fireEvent.click(await screen.findByTestId(`announcements-delete-${DRAFT_CONFIG.id}`));
  fireEvent.click(await screen.findByTestId(`announcements-delete-confirm-${DRAFT_CONFIG.id}`));
  await waitFor(() => expect(api.deleteExperienceConfig).toHaveBeenCalledWith(DRAFT_CONFIG.id, { force: false }));
});

test("force-deletes a published config", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [PUBLISHED_CONFIG] });
  api.deleteExperienceConfig.mockResolvedValue({ ok: true });
  render(<AnnouncementsStudio />);
  fireEvent.click(await screen.findByTestId(`announcements-delete-${PUBLISHED_CONFIG.id}`));
  fireEvent.click(await screen.findByTestId(`announcements-delete-confirm-${PUBLISHED_CONFIG.id}`));
  await waitFor(() => expect(api.deleteExperienceConfig).toHaveBeenCalledWith(PUBLISHED_CONFIG.id, { force: true }));
});
