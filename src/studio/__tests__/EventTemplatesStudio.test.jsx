/**
 * EventTemplatesStudio.test.jsx — Author Studio panel for the Event Engine
 * (architecture.md §4.3). Mocks ./api entirely (network layer covered by
 * event_engine.py's own backend test suite). Asserts the UI CONTRACT:
 *   • lists event templates on mount
 *   • creates a new template via the real API functions
 *   • publish/unpublish/archive/duplicate round-trip through the API
 *   • creating an event from a published template calls createEvent
 *   • transitioning an event calls transitionEvent with the right target
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import EventTemplatesStudio from "../EventTemplatesStudio";
import * as api from "../api";

jest.mock("../api", () => ({
  listEventTemplates: jest.fn(),
  getEventTemplate: jest.fn(),
  createEventTemplate: jest.fn(),
  updateEventTemplate: jest.fn(),
  publishEventTemplate: jest.fn(),
  unpublishEventTemplate: jest.fn(),
  archiveEventTemplate: jest.fn(),
  duplicateEventTemplate: jest.fn(),
  listEvents: jest.fn(),
  getEvent: jest.fn(),
  createEvent: jest.fn(),
  transitionEvent: jest.fn(),
  getPrizePoolForSession: jest.fn(),
  getPrizePoolBalance: jest.fn(),
  setTemplateRewardPool: jest.fn(),
  getTemplateRewardPool: jest.fn(),
}));

const DRAFT_TEMPLATE = {
  _id: "tmpl-1",
  name: "Weekly Speaking Lab",
  event_type: "speaking_lab_session",
  status: "draft",
  version: 1,
  runtime_defaults: { entry_fee: 10 },
  timers: {},
  updated_at: "2026-01-01T00:00:00Z",
};

const PUBLISHED_TEMPLATE = { ...DRAFT_TEMPLATE, _id: "tmpl-2", status: "published" };

beforeEach(() => {
  jest.clearAllMocks();
  api.listEventTemplates.mockResolvedValue({ templates: [] });
  api.listEvents.mockResolvedValue({ events: [] });
  api.getPrizePoolForSession.mockResolvedValue({ pool: null });
  api.setTemplateRewardPool.mockResolvedValue({ ok: true, balance: 0 });
});

test("loads and lists event templates on mount", async () => {
  api.listEventTemplates.mockResolvedValue({ templates: [DRAFT_TEMPLATE] });
  render(<EventTemplatesStudio />);
  await waitFor(() => expect(api.listEventTemplates).toHaveBeenCalled());
  expect(await screen.findByTestId(`event-template-row-${DRAFT_TEMPLATE._id}`)).toHaveTextContent("Weekly Speaking Lab");
});

test("shows an empty state when no templates exist yet", async () => {
  render(<EventTemplatesStudio />);
  expect(await screen.findByText(/No event templates yet/i)).toBeInTheDocument();
});

test("creates a new template via the real API", async () => {
  api.createEventTemplate.mockResolvedValue({ template: DRAFT_TEMPLATE });
  render(<EventTemplatesStudio />);
  fireEvent.click(await screen.findByTestId("event-template-new-button"));
  fireEvent.change(screen.getByTestId("event-template-name-input"), { target: { value: "Weekly Speaking Lab" } });
  fireEvent.change(screen.getByTestId("event-template-entry-fee-input"), { target: { value: "10" } });
  fireEvent.click(screen.getByTestId("event-template-save-button"));
  await waitFor(() => expect(api.createEventTemplate).toHaveBeenCalled());
  const payload = api.createEventTemplate.mock.calls[0][0];
  expect(payload.name).toBe("Weekly Speaking Lab");
  expect(payload.event_type).toBe("speaking_lab_session");
  expect(payload.runtime_defaults).toEqual({ entry_fee: 10 });
});

test("rejects an out-of-range entry fee before calling the API", async () => {
  render(<EventTemplatesStudio />);
  fireEvent.click(await screen.findByTestId("event-template-new-button"));
  fireEvent.change(screen.getByTestId("event-template-name-input"), { target: { value: "X" } });
  fireEvent.change(screen.getByTestId("event-template-entry-fee-input"), { target: { value: "9999" } });
  fireEvent.click(screen.getByTestId("event-template-save-button"));
  expect(await screen.findByText(/Entry fee must be/i)).toBeInTheDocument();
  expect(api.createEventTemplate).not.toHaveBeenCalled();
});

test("publish calls publishEventTemplate with the template id", async () => {
  api.listEventTemplates.mockResolvedValue({ templates: [DRAFT_TEMPLATE] });
  api.publishEventTemplate.mockResolvedValue({ template: { ...DRAFT_TEMPLATE, status: "published" } });
  render(<EventTemplatesStudio />);
  fireEvent.click(await screen.findByTestId(`event-template-publish-${DRAFT_TEMPLATE._id}`));
  await waitFor(() => expect(api.publishEventTemplate).toHaveBeenCalledWith(DRAFT_TEMPLATE._id));
});

test("unpublish calls unpublishEventTemplate with the template id", async () => {
  api.listEventTemplates.mockResolvedValue({ templates: [PUBLISHED_TEMPLATE] });
  api.unpublishEventTemplate.mockResolvedValue({ template: DRAFT_TEMPLATE });
  render(<EventTemplatesStudio />);
  fireEvent.click(await screen.findByTestId(`event-template-unpublish-${PUBLISHED_TEMPLATE._id}`));
  await waitFor(() => expect(api.unpublishEventTemplate).toHaveBeenCalledWith(PUBLISHED_TEMPLATE._id));
});

test("archive calls archiveEventTemplate with the template id", async () => {
  api.listEventTemplates.mockResolvedValue({ templates: [PUBLISHED_TEMPLATE] });
  api.archiveEventTemplate.mockResolvedValue({ template: { ...DRAFT_TEMPLATE, status: "archived" } });
  render(<EventTemplatesStudio />);
  fireEvent.click(await screen.findByTestId(`event-template-archive-${PUBLISHED_TEMPLATE._id}`));
  await waitFor(() => expect(api.archiveEventTemplate).toHaveBeenCalledWith(PUBLISHED_TEMPLATE._id));
});

test("duplicate calls duplicateEventTemplate with the template id", async () => {
  api.listEventTemplates.mockResolvedValue({ templates: [PUBLISHED_TEMPLATE] });
  api.duplicateEventTemplate.mockResolvedValue({ template: { ...DRAFT_TEMPLATE, _id: "tmpl-3" } });
  render(<EventTemplatesStudio />);
  fireEvent.click(await screen.findByTestId(`event-template-duplicate-${PUBLISHED_TEMPLATE._id}`));
  await waitFor(() => expect(api.duplicateEventTemplate).toHaveBeenCalledWith(PUBLISHED_TEMPLATE._id));
});

test("creating an event from a published template calls createEvent with the template id", async () => {
  api.listEventTemplates.mockResolvedValue({ templates: [PUBLISHED_TEMPLATE] });
  api.createEvent.mockResolvedValue({ event: { _id: "evt-1", state: "draft" } });
  render(<EventTemplatesStudio />);
  fireEvent.click(await screen.findByTestId(`event-template-events-${PUBLISHED_TEMPLATE._id}`));
  fireEvent.click(await screen.findByTestId(`event-create-from-${PUBLISHED_TEMPLATE._id}`));
  await waitFor(() => expect(api.createEvent).toHaveBeenCalledWith(
    expect.objectContaining({ template_id: PUBLISHED_TEMPLATE._id }),
  ));
});

test("transitioning an event calls transitionEvent with the next state", async () => {
  api.listEventTemplates.mockResolvedValue({ templates: [PUBLISHED_TEMPLATE] });
  api.listEvents.mockResolvedValue({
    events: [{ _id: "evt-1", template_id: PUBLISHED_TEMPLATE._id, state: "draft", entry_fee: 10, schedule: "" }],
  });
  api.transitionEvent.mockResolvedValue({ event: { _id: "evt-1", state: "scheduled" } });
  render(<EventTemplatesStudio />);
  fireEvent.click(await screen.findByTestId(`event-template-events-${PUBLISHED_TEMPLATE._id}`));
  fireEvent.click(await screen.findByTestId("event-transition-evt-1-scheduled"));
  await waitFor(() => expect(api.transitionEvent).toHaveBeenCalledWith("evt-1", "scheduled"));
});

/* ── Reward Pool — the single admin configuration action ──────────────── */
test("creating a template with Reward Pool fields saves everything in one action", async () => {
  api.createEventTemplate.mockResolvedValue({ template: DRAFT_TEMPLATE });
  render(<EventTemplatesStudio />);
  fireEvent.click(await screen.findByTestId("event-template-new-button"));
  fireEvent.change(screen.getByTestId("event-template-name-input"), { target: { value: "Weekly Speaking Lab" } });
  fireEvent.change(screen.getByTestId("event-template-entry-fee-input"), { target: { value: "0" } });
  fireEvent.change(screen.getByTestId("event-template-reward-points-input"), { target: { value: "500" } });
  fireEvent.change(screen.getByTestId("event-template-num-winners-input"), { target: { value: "3" } });
  fireEvent.change(screen.getByTestId("event-template-split-input"), { target: { value: "50,30,20" } });
  fireEvent.click(screen.getByTestId("event-template-save-button"));
  await waitFor(() => expect(api.createEventTemplate).toHaveBeenCalled());
  expect(api.createEventTemplate.mock.calls[0][0].prize_policy).toBeUndefined();
  await waitFor(() => expect(api.setTemplateRewardPool).toHaveBeenCalledWith(
    DRAFT_TEMPLATE._id, { points: 500, num_winners: 3, split: [50, 30, 20] },
  ));
});

test("no Reward Pool call happens when the Reward Pool fields are left blank", async () => {
  api.createEventTemplate.mockResolvedValue({ template: DRAFT_TEMPLATE });
  render(<EventTemplatesStudio />);
  fireEvent.click(await screen.findByTestId("event-template-new-button"));
  fireEvent.change(screen.getByTestId("event-template-name-input"), { target: { value: "X" } });
  fireEvent.click(screen.getByTestId("event-template-save-button"));
  await waitFor(() => expect(api.createEventTemplate).toHaveBeenCalled());
  expect(api.setTemplateRewardPool).not.toHaveBeenCalled();
});

test("rejects an out-of-range number of winners before calling the API", async () => {
  render(<EventTemplatesStudio />);
  fireEvent.click(await screen.findByTestId("event-template-new-button"));
  fireEvent.change(screen.getByTestId("event-template-name-input"), { target: { value: "X" } });
  fireEvent.change(screen.getByTestId("event-template-num-winners-input"), { target: { value: "9" } });
  fireEvent.click(screen.getByTestId("event-template-save-button"));
  expect(await screen.findByText(/Number of winners must be/i)).toBeInTheDocument();
  expect(api.createEventTemplate).not.toHaveBeenCalled();
});

test("expanded template row shows the configured Reward Pool", async () => {
  const tmplWithPolicy = {
    ...DRAFT_TEMPLATE,
    prize_policy: { reward_pool_points: 500, num_winners: 2, split: [60, 40] },
  };
  api.listEventTemplates.mockResolvedValue({ templates: [tmplWithPolicy] });
  render(<EventTemplatesStudio />);
  const row = await screen.findByTestId(`event-template-row-${tmplWithPolicy._id}`);
  fireEvent.click(screen.getByText("Weekly Speaking Lab"));
  expect(row).toHaveTextContent("500 pts");
  expect(row).toHaveTextContent("60 / 40");
});

test("Reward Pool on a PUBLISHED template row saves via one action", async () => {
  const publishedWithPolicy = {
    ...PUBLISHED_TEMPLATE,
    prize_policy: { reward_pool_points: 200, num_winners: 3, split: [50, 30, 20] },
  };
  api.listEventTemplates.mockResolvedValue({ templates: [publishedWithPolicy] });
  render(<EventTemplatesStudio />);
  fireEvent.click(await screen.findByTestId(`event-template-rewardpool-${publishedWithPolicy._id}`));
  const pointsInput = screen.getByTestId(`reward-pool-${publishedWithPolicy._id}-reward-points-input`);
  expect(pointsInput).toHaveValue(200); // prefilled from the template
  fireEvent.change(pointsInput, { target: { value: "800" } });
  fireEvent.click(screen.getByTestId(`reward-pool-save-${publishedWithPolicy._id}`));
  await waitFor(() => expect(api.setTemplateRewardPool).toHaveBeenCalledWith(
    publishedWithPolicy._id, { points: 800, num_winners: 3, split: [50, 30, 20] },
  ));
});

/* ── Per-event pool readout — plain admin language only ───────────────── */
test("event row shows the reward pool balance in plain language", async () => {
  api.listEventTemplates.mockResolvedValue({ templates: [PUBLISHED_TEMPLATE] });
  api.listEvents.mockResolvedValue({
    events: [{
      _id: "evt-3", template_id: PUBLISHED_TEMPLATE._id, state: "registration_open",
      entry_fee: 0, schedule: "", linked_session_id: "sl_2",
    }],
  });
  api.getPrizePoolForSession.mockResolvedValue({ pool: { _id: "pool_xyz", name: "Weekly — Reward Pool" } });
  api.getPrizePoolBalance.mockResolvedValue({ balance: 500 });
  render(<EventTemplatesStudio />);
  fireEvent.click(await screen.findByTestId(`event-template-events-${PUBLISHED_TEMPLATE._id}`));
  const pool = await screen.findByTestId("event-pool-evt-3");
  expect(pool).toHaveTextContent("Reward pool:");
  expect(pool).toHaveTextContent("500 PTS");
  // No implementation terminology and no ids leak into the row
  expect(pool).not.toHaveTextContent(/funding source/i);
  expect(pool).not.toHaveTextContent("sl_2");
});

test("entry-fee event row shows a plain entry-fee pool label", async () => {
  api.listEventTemplates.mockResolvedValue({ templates: [PUBLISHED_TEMPLATE] });
  api.listEvents.mockResolvedValue({
    events: [{
      _id: "evt-2", template_id: PUBLISHED_TEMPLATE._id, state: "registration_open",
      entry_fee: 10, schedule: "", linked_session_id: "sl_1",
    }],
  });
  render(<EventTemplatesStudio />);
  fireEvent.click(await screen.findByTestId(`event-template-events-${PUBLISHED_TEMPLATE._id}`));
  const pool = await screen.findByTestId("event-pool-evt-2");
  expect(pool).toHaveTextContent("entry fees (10 pts per player)");
});
