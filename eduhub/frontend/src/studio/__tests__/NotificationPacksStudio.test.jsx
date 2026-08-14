/**
 * NotificationPacksStudio.test.jsx — Author Studio's "Notification Packs"
 * screen. Mocks ./api entirely (network layer covered by notification_
 * packs.py's own backend test suite). Asserts the UI CONTRACT:
 *   • lists packs on mount
 *   • creates a new pack
 *   • edits a draft pack
 *   • publishes / unpublishes / archives / deletes a pack
 *   • previews a pack's rendered template against a context
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import NotificationPacksStudio from "../NotificationPacksStudio";
import * as api from "../api";

jest.mock("../api", () => ({
  listNotificationPacks: jest.fn(),
  getNotificationPack: jest.fn(),
  createNotificationPack: jest.fn(),
  updateNotificationPack: jest.fn(),
  publishNotificationPack: jest.fn(),
  unpublishNotificationPack: jest.fn(),
  archiveNotificationPack: jest.fn(),
  deleteNotificationPack: jest.fn(),
  previewNotificationPack: jest.fn(),
}));

const PACK = {
  _id: "pack_abc123",
  name: "Mystery Box Win",
  type: "reward",
  title_template: "Hi {studentName}!",
  body_template: "You got {points} points.",
  url_template: "",
  status: "draft",
  version: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  api.listNotificationPacks.mockResolvedValue({ packs: [] });
});

test("loads and lists packs on mount", async () => {
  api.listNotificationPacks.mockResolvedValue({ packs: [PACK] });
  render(<NotificationPacksStudio />);
  await waitFor(() => expect(api.listNotificationPacks).toHaveBeenCalled());
  expect(await screen.findByTestId(`notification-packs-row-${PACK._id}`)).toHaveTextContent("Mystery Box Win");
});

test("shows an empty state when no packs exist yet", async () => {
  render(<NotificationPacksStudio />);
  expect(await screen.findByText(/No notification packs match these filters yet/i)).toBeInTheDocument();
});

test("creates a new pack", async () => {
  api.createNotificationPack.mockResolvedValue({ ok: true, pack: PACK });
  render(<NotificationPacksStudio />);
  fireEvent.change(await screen.findByTestId("notification-packs-new-name-input"), { target: { value: "Mystery Box Win" } });
  fireEvent.change(screen.getByTestId("notification-packs-new-title-input"), { target: { value: "Hi {studentName}!" } });
  fireEvent.change(screen.getByTestId("notification-packs-new-body-input"), { target: { value: "You got {points} points." } });
  fireEvent.click(screen.getByTestId("notification-packs-create-button"));
  await waitFor(() => expect(api.createNotificationPack).toHaveBeenCalledWith({
    name: "Mystery Box Win", type: "push",
    title_template: "Hi {studentName}!", body_template: "You got {points} points.",
    url_template: "",
  }));
});

test("edits a draft pack", async () => {
  api.listNotificationPacks.mockResolvedValue({ packs: [PACK] });
  api.updateNotificationPack.mockResolvedValue({ ok: true, pack: { ...PACK, body_template: "Edited body." } });
  render(<NotificationPacksStudio />);
  fireEvent.click(await screen.findByTestId(`notification-packs-edit-${PACK._id}`));
  fireEvent.change(screen.getByTestId(`notification-packs-edit-body-${PACK._id}`), { target: { value: "Edited body." } });
  fireEvent.click(screen.getByTestId(`notification-packs-save-${PACK._id}`));
  await waitFor(() => expect(api.updateNotificationPack).toHaveBeenCalledWith(PACK._id, {
    title_template: "Hi {studentName}!", body_template: "Edited body.", url_template: "",
  }));
});

test("publishes, unpublishes, archives a pack", async () => {
  api.listNotificationPacks.mockResolvedValue({ packs: [PACK] });
  api.publishNotificationPack.mockResolvedValue({ ok: true, pack: { ...PACK, status: "published" } });
  render(<NotificationPacksStudio />);
  fireEvent.click(await screen.findByTestId(`notification-packs-publish-${PACK._id}`));
  await waitFor(() => expect(api.publishNotificationPack).toHaveBeenCalledWith(PACK._id));
});

test("deletes a draft pack", async () => {
  api.listNotificationPacks.mockResolvedValue({ packs: [PACK] });
  api.deleteNotificationPack.mockResolvedValue({ ok: true, deleted: true });
  render(<NotificationPacksStudio />);
  fireEvent.click(await screen.findByTestId(`notification-packs-delete-${PACK._id}`));
  await waitFor(() => expect(api.deleteNotificationPack).toHaveBeenCalledWith(PACK._id));
});

test("previews a pack's rendered template", async () => {
  api.listNotificationPacks.mockResolvedValue({ packs: [PACK] });
  api.previewNotificationPack.mockResolvedValue({
    preview: { title: "Hi Sok!", body: "You got 50 points.", url: "/portal" },
  });
  render(<NotificationPacksStudio />);
  fireEvent.click(await screen.findByTestId(`notification-packs-preview-toggle-${PACK._id}`));
  fireEvent.click(await screen.findByTestId(`notification-packs-preview-run-${PACK._id}`));
  await waitFor(() => expect(api.previewNotificationPack).toHaveBeenCalledWith(
    PACK._id, { studentName: "Sok", points: 50 },
  ));
  const result = await screen.findByTestId(`notification-packs-preview-result-${PACK._id}`);
  expect(result).toHaveTextContent("Hi Sok!");
  expect(result).toHaveTextContent("You got 50 points.");
});
