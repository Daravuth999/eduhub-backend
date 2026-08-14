/**
 * RuntimeDashboardStudio.test.jsx — Author Studio's "Runtime Dashboard".
 * Mocks ./api entirely (aggregation logic covered by event_engine.py's
 * own get_runtime_dashboard backend tests). Asserts the UI CONTRACT:
 *   • loads and buckets events into active/upcoming/finished
 *   • shows summary totals (active count, participants, prize pool)
 *   • shows a live indicator for realtime_active events
 *   • shows empty states when a bucket has no events
 */
import { render, screen, waitFor } from "@testing-library/react";
import RuntimeDashboardStudio from "../RuntimeDashboardStudio";
import * as api from "../api";

jest.mock("../api", () => ({
  getEventsRuntimeDashboard: jest.fn(),
}));

const ACTIVE_EVENT = {
  _id: "evt_1", template_name: "Weekly Speaking Lab", state: "live",
  participant_count: 5, estimated_prize_pool: 50, health: "healthy",
  realtime_active: true, schedule: "A",
};
const UPCOMING_EVENT = {
  _id: "evt_2", template_name: "Weekly Speaking Lab", state: "scheduled",
  participant_count: 0, estimated_prize_pool: 0, health: "not_started",
  realtime_active: false, schedule: "B",
};
const FINISHED_EVENT = {
  _id: "evt_3", template_name: "Weekly Speaking Lab", state: "archived",
  participant_count: 8, estimated_prize_pool: 80, health: "completed",
  realtime_active: false, schedule: "A",
};

beforeEach(() => {
  jest.clearAllMocks();
});

test("loads and buckets events into active/upcoming/finished", async () => {
  api.getEventsRuntimeDashboard.mockResolvedValue({
    active: [ACTIVE_EVENT], upcoming: [UPCOMING_EVENT], finished: [FINISHED_EVENT],
  });
  render(<RuntimeDashboardStudio />);
  await waitFor(() => expect(api.getEventsRuntimeDashboard).toHaveBeenCalled());
  expect(await screen.findByTestId("runtime-dashboard-active")).toHaveTextContent("Weekly Speaking Lab");
  expect(screen.getByTestId("runtime-dashboard-upcoming")).toBeInTheDocument();
  expect(screen.getByTestId("runtime-dashboard-finished")).toBeInTheDocument();
});

test("shows summary totals across active and upcoming events", async () => {
  api.getEventsRuntimeDashboard.mockResolvedValue({
    active: [ACTIVE_EVENT], upcoming: [UPCOMING_EVENT], finished: [],
  });
  render(<RuntimeDashboardStudio />);
  const summary = await screen.findByTestId("runtime-dashboard-summary");
  expect(summary).toHaveTextContent("1"); // active count
  expect(summary).toHaveTextContent("5"); // total participants
  expect(summary).toHaveTextContent("50 pts"); // total estimated pool
});

test("shows a live indicator for realtime_active events", async () => {
  api.getEventsRuntimeDashboard.mockResolvedValue({ active: [ACTIVE_EVENT], upcoming: [], finished: [] });
  render(<RuntimeDashboardStudio />);
  const card = await screen.findByTestId(`runtime-dashboard-event-${ACTIVE_EVENT._id}`);
  expect(card).toHaveTextContent("Live");
});

test("shows empty states when all buckets are empty", async () => {
  api.getEventsRuntimeDashboard.mockResolvedValue({ active: [], upcoming: [], finished: [] });
  render(<RuntimeDashboardStudio />);
  expect(await screen.findByText(/No events are currently active/i)).toBeInTheDocument();
  expect(screen.getByText(/No events are scheduled yet/i)).toBeInTheDocument();
  expect(screen.getByText(/No events have finished yet/i)).toBeInTheDocument();
});

/* ── Admin-language display: live reward pool, no implementation terms ── */
test("shows the live reward pool balance in plain admin language", async () => {
  const poolFundedEvent = {
    _id: "evt_4", template_name: "Season Pool Event", state: "live",
    participant_count: 3, estimated_prize_pool: 0, health: "healthy",
    realtime_active: false, schedule: "A",
    prize_pool_balance: 500, lucky_code_count: 7, winner_count: 0,
  };
  api.getEventsRuntimeDashboard.mockResolvedValue({ active: [poolFundedEvent], upcoming: [], finished: [] });
  render(<RuntimeDashboardStudio />);
  const card = await screen.findByTestId(`runtime-dashboard-event-${poolFundedEvent._id}`);
  expect(card).toHaveTextContent("500 pts reward pool");
  // No implementation terminology anywhere on the card
  expect(card).not.toHaveTextContent(/funding source|linked|Prize Pool\)/i);

  const summary = await screen.findByTestId("runtime-dashboard-summary");
  expect(summary).toHaveTextContent("Total reward pool");
  expect(summary).toHaveTextContent("500 pts"); // sums the LIVE balance, not a stale estimate
});

test("falls back to the entry-fee estimate for events without a reward pool", async () => {
  api.getEventsRuntimeDashboard.mockResolvedValue({ active: [ACTIVE_EVENT], upcoming: [], finished: [] });
  render(<RuntimeDashboardStudio />);
  const card = await screen.findByTestId(`runtime-dashboard-event-${ACTIVE_EVENT._id}`);
  expect(card).toHaveTextContent("~50 pts reward pool");
});

test("shows lucky codes and winners counts on each event card", async () => {
  const event = {
    ...ACTIVE_EVENT, _id: "evt_5",
    lucky_code_count: 7, winner_count: 3,
  };
  api.getEventsRuntimeDashboard.mockResolvedValue({ active: [event], upcoming: [], finished: [] });
  render(<RuntimeDashboardStudio />);
  const card = await screen.findByTestId("runtime-dashboard-event-evt_5");
  expect(card).toHaveTextContent("7 lucky codes");
  expect(card).toHaveTextContent("3 winners");
});
