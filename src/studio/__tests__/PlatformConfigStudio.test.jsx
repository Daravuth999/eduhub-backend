/**
 * PlatformConfigStudio.test.jsx — Author Studio's "Platform Configuration"
 * screen (architecture.md §4.4). Mocks ./api entirely (network layer
 * covered by eduhub_platform/config.py's own backend test suite). Asserts
 * the UI CONTRACT:
 *   • lists active overrides on mount
 *   • looks up any flag by name and shows all three tiers
 *   • sets a new override via the lookup panel's "Manage this override"
 *   • edits an existing override's value
 *   • clears an override
 *   • shows audit history for an override
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import PlatformConfigStudio from "../PlatformConfigStudio";
import * as api from "../api";

jest.mock("../api", () => ({
  listPlatformConfig: jest.fn(),
  getPlatformConfig: jest.fn(),
  setPlatformConfig: jest.fn(),
  clearPlatformConfig: jest.fn(),
  getPlatformConfigHistory: jest.fn(),
}));

const OVERRIDE = {
  _id: "USE_MONGO_POINTS_READ",
  value: "true",
  version: 2,
  updated_at: "2026-01-01T00:00:00Z",
  updated_by: "admin@test",
};

beforeEach(() => {
  jest.clearAllMocks();
  api.listPlatformConfig.mockResolvedValue({ overrides: [] });
});

test("loads and lists active overrides on mount", async () => {
  api.listPlatformConfig.mockResolvedValue({ overrides: [OVERRIDE] });
  render(<PlatformConfigStudio />);
  await waitFor(() => expect(api.listPlatformConfig).toHaveBeenCalled());
  expect(await screen.findByTestId(`platform-config-row-${OVERRIDE._id}`)).toHaveTextContent("USE_MONGO_POINTS_READ");
  expect(screen.getByTestId(`platform-config-row-${OVERRIDE._id}`)).toHaveTextContent("v2");
});

test("shows an empty state when no overrides exist yet", async () => {
  render(<PlatformConfigStudio />);
  expect(await screen.findByText(/No published overrides yet/i)).toBeInTheDocument();
});

test("looks up a flag and shows all three tiers", async () => {
  api.getPlatformConfig.mockResolvedValue({
    name: "MY_FLAG",
    effective_value: "from_env",
    source: "legacy",
    published_override: null,
    override_version: null,
    environment_fallback: "from_env",
    default_fallback: "fallback",
  });
  render(<PlatformConfigStudio />);
  fireEvent.change(await screen.findByTestId("platform-config-lookup-name-input"), { target: { value: "MY_FLAG" } });
  fireEvent.click(screen.getByTestId("platform-config-lookup-button"));
  await waitFor(() => expect(api.getPlatformConfig).toHaveBeenCalledWith("MY_FLAG", expect.any(Object)));
  const result = await screen.findByTestId("platform-config-lookup-result");
  expect(result).toHaveTextContent("from_env");
  expect(result).toHaveTextContent("Environment fallback");
});

test("sets a new override from the lookup panel", async () => {
  api.getPlatformConfig.mockResolvedValue({
    name: "MY_FLAG", effective_value: "fallback", source: "default",
    published_override: null, override_version: null,
    environment_fallback: null, default_fallback: "fallback",
  });
  api.setPlatformConfig.mockResolvedValue({ ok: true, override: { _id: "MY_FLAG", value: "on", version: 1 } });
  render(<PlatformConfigStudio />);
  fireEvent.change(await screen.findByTestId("platform-config-lookup-name-input"), { target: { value: "MY_FLAG" } });
  fireEvent.click(screen.getByTestId("platform-config-lookup-button"));
  fireEvent.click(await screen.findByTestId("platform-config-lookup-manage-button"));
  fireEvent.change(screen.getByTestId("platform-config-override-value-input"), { target: { value: "on" } });
  fireEvent.click(screen.getByTestId("platform-config-override-save-button"));
  await waitFor(() => expect(api.setPlatformConfig).toHaveBeenCalledWith("MY_FLAG", "on"));
});

test("edits an existing override's value", async () => {
  api.listPlatformConfig.mockResolvedValue({ overrides: [OVERRIDE] });
  api.setPlatformConfig.mockResolvedValue({ ok: true, override: { ...OVERRIDE, value: "false" } });
  render(<PlatformConfigStudio />);
  fireEvent.click(await screen.findByTestId(`platform-config-edit-${OVERRIDE._id}`));
  fireEvent.change(screen.getByTestId("platform-config-override-value-input"), { target: { value: "false" } });
  fireEvent.click(screen.getByTestId("platform-config-override-save-button"));
  await waitFor(() => expect(api.setPlatformConfig).toHaveBeenCalledWith(OVERRIDE._id, "false"));
});

test("clears an override", async () => {
  api.listPlatformConfig.mockResolvedValue({ overrides: [OVERRIDE] });
  api.clearPlatformConfig.mockResolvedValue({ ok: true, cleared: true });
  render(<PlatformConfigStudio />);
  fireEvent.click(await screen.findByTestId(`platform-config-clear-${OVERRIDE._id}`));
  await waitFor(() => expect(api.clearPlatformConfig).toHaveBeenCalledWith(OVERRIDE._id));
});

test("shows audit history for an override", async () => {
  api.listPlatformConfig.mockResolvedValue({ overrides: [OVERRIDE] });
  api.getPlatformConfigHistory.mockResolvedValue({
    history: [
      { action: "set", old_value: "false", new_value: "true", by: "admin@test", at: "2026-01-01T00:00:00Z" },
    ],
  });
  render(<PlatformConfigStudio />);
  fireEvent.click(await screen.findByTestId(`platform-config-history-toggle-${OVERRIDE._id}`));
  await waitFor(() => expect(api.getPlatformConfigHistory).toHaveBeenCalledWith(OVERRIDE._id));
  const historyPanel = await screen.findByTestId(`platform-config-history-${OVERRIDE._id}`);
  expect(historyPanel).toHaveTextContent("false");
  expect(historyPanel).toHaveTextContent("true");
  expect(historyPanel).toHaveTextContent("admin@test");
});
