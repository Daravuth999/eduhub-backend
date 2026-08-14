import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EventsPage from "../EventsPage";
import { eventEngineApi, EventEngineApiError } from "../lib/eventEngineApi";

jest.mock("../lib/eventEngineApi", () => {
  const actual = jest.requireActual("../lib/eventEngineApi");
  return {
    ...actual,
    eventEngineApi: { listAvailableEvents: jest.fn(), registerForEvent: jest.fn() },
  };
});

const mockedApi = eventEngineApi as jest.Mocked<typeof eventEngineApi>;

function availableEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    _id: "evt_1",
    event_type: "speaking_lab_session",
    template_id: "tmpl_1",
    template_name: "Weekly Speaking Lab",
    state: "registration_open",
    schedule: "A",
    entry_fee: 5,
    ...overrides,
  };
}

function registerResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true,
    session_id: "sl_1",
    lucky_code: "ABC123",
    position: 3,
    entry_fee: 5,
    pool_total: 25,
    player_count: 5,
    idempotent_replay: false,
    ...overrides,
  };
}

describe("EventsPage — browse available events + register", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("shows a loading state, then lists available events", async () => {
    mockedApi.listAvailableEvents.mockResolvedValueOnce([availableEvent()]);
    render(<EventsPage />);
    expect(screen.getByTestId("events-page-loading")).toBeInTheDocument();
    await waitFor(() => expect(mockedApi.listAvailableEvents).toHaveBeenCalled());
    expect(await screen.findByTestId("events-page-card-evt_1")).toHaveTextContent("Weekly Speaking Lab");
    expect(screen.getByText(/Schedule A/)).toBeInTheDocument();
    expect(screen.getByText(/Entry: 5 pts/)).toBeInTheDocument();
  });

  test("shows an empty state when no events are open", async () => {
    mockedApi.listAvailableEvents.mockResolvedValueOnce([]);
    render(<EventsPage />);
    expect(await screen.findByTestId("events-page-empty")).toBeInTheDocument();
  });

  test("shows a load error message when the events list fails to fetch", async () => {
    mockedApi.listAvailableEvents.mockRejectedValueOnce(
      new EventEngineApiError("backend_unreachable", "network down", 0),
    );
    render(<EventsPage />);
    expect(await screen.findByTestId("events-page-error")).toHaveTextContent("network down");
  });

  test("registers for an event and shows the ticket outcome", async () => {
    const user = userEvent.setup();
    mockedApi.listAvailableEvents.mockResolvedValueOnce([availableEvent()]);
    mockedApi.registerForEvent.mockResolvedValueOnce(registerResult());
    render(<EventsPage />);

    await user.click(await screen.findByTestId("events-page-register-evt_1"));
    expect(mockedApi.registerForEvent).toHaveBeenCalledWith("evt_1");
    expect(await screen.findByTestId("events-page-ticket-evt_1")).toHaveTextContent("ABC123");
    expect(screen.getByText(/Pool: 25 pts/)).toBeInTheDocument();
    expect(screen.getByText(/5 players/)).toBeInTheDocument();
  });

  test("shows a friendly error and a retry button when registration fails", async () => {
    const user = userEvent.setup();
    mockedApi.listAvailableEvents.mockResolvedValueOnce([availableEvent()]);
    mockedApi.registerForEvent.mockRejectedValueOnce(
      new EventEngineApiError("insufficient_points", "raw backend text", 400),
    );
    render(<EventsPage />);

    await user.click(await screen.findByTestId("events-page-register-evt_1"));
    expect(await screen.findByText(/don't have enough points/i)).toBeInTheDocument();
    expect(screen.getByTestId("events-page-retry-evt_1")).toBeInTheDocument();
  });

  test("retrying registration calls registerForEvent again", async () => {
    const user = userEvent.setup();
    mockedApi.listAvailableEvents.mockResolvedValueOnce([availableEvent()]);
    mockedApi.registerForEvent
      .mockRejectedValueOnce(new EventEngineApiError("event_not_open", "not open", 400))
      .mockResolvedValueOnce(registerResult());
    render(<EventsPage />);

    await user.click(await screen.findByTestId("events-page-register-evt_1"));
    await user.click(await screen.findByTestId("events-page-retry-evt_1"));
    expect(mockedApi.registerForEvent).toHaveBeenCalledTimes(2);
    expect(await screen.findByTestId("events-page-ticket-evt_1")).toHaveTextContent("ABC123");
  });
});
