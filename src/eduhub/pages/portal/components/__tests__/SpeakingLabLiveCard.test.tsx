import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SpeakingLabLiveCard from "../SpeakingLabLiveCard";
import { speakingLabApi, SpeakingLabApiError } from "../../lib/speakingLabApi";

jest.mock("../../lib/speakingLabApi", () => {
  const actual = jest.requireActual("../../lib/speakingLabApi");
  return {
    ...actual,
    speakingLabApi: { activeSession: jest.fn(), joinActive: jest.fn() },
  };
});

const mockedApi = speakingLabApi as jest.Mocked<typeof speakingLabApi>;

function activeSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true,
    active: true,
    session_id: "sl_1",
    schedule: "AB",
    entry_fee: 4,
    pool_total: 0,
    player_count: 3,
    direct_join_enabled: true,
    existing_entry: null,
    ...overrides,
  };
}

describe("SpeakingLabLiveCard — one-tap live card", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("renders NOTHING (hidden) when there is no live session", async () => {
    mockedApi.activeSession.mockResolvedValueOnce(activeSession({ active: false }));
    const { container } = render(<SpeakingLabLiveCard />);
    await waitFor(() => expect(mockedApi.activeSession).toHaveBeenCalled());
    expect(screen.queryByTestId("speaking-lab-live-card")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  test("FAILS SILENT — renders nothing (never an error) when the check throws", async () => {
    mockedApi.activeSession.mockRejectedValueOnce(
      new SpeakingLabApiError("backend_unreachable", "network down", 0),
    );
    const { container } = render(<SpeakingLabLiveCard />);
    await waitFor(() => expect(mockedApi.activeSession).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    // No "couldn't reach" text ever reaches the dashboard.
    expect(screen.queryByText(/couldn't reach/i)).not.toBeInTheDocument();
  });

  test("stays hidden when a session is live but joining is not open yet", async () => {
    mockedApi.activeSession.mockResolvedValueOnce(
      activeSession({ direct_join_enabled: false }),
    );
    const { container } = render(<SpeakingLabLiveCard />);
    await waitFor(() => expect(mockedApi.activeSession).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  test("shows a one-tap Join offer when a session is live and joinable", async () => {
    mockedApi.activeSession.mockResolvedValueOnce(activeSession());
    render(<SpeakingLabLiveCard />);
    await waitFor(() =>
      expect(screen.getByTestId("speaking-lab-join-now")).toBeInTheDocument(),
    );
    expect(screen.getByText(/speaking lab is live/i)).toBeInTheDocument();
    expect(screen.getByText(/entry: 4 pts/i)).toBeInTheDocument();
  });

  test("one tap joins and shows the Lucky Code immediately", async () => {
    const user = userEvent.setup();
    mockedApi.activeSession.mockResolvedValueOnce(activeSession());
    mockedApi.joinActive.mockResolvedValueOnce({
      ok: true, session_id: "sl_1", lucky_code: "STAR-7", position: 4,
      entry_fee: 4, pool_total: 16, player_count: 4, idempotent_replay: false,
    });

    render(<SpeakingLabLiveCard />);
    await waitFor(() =>
      expect(screen.getByTestId("speaking-lab-join-now")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("speaking-lab-join-now"));

    await waitFor(() => expect(screen.getByTestId("speaking-lab-live-code")).toHaveTextContent("STAR-7"));
    expect(screen.getByText(/you're in/i)).toBeInTheDocument();
    expect(mockedApi.joinActive).toHaveBeenCalledTimes(1);
  });

  test("shows the existing ticket immediately if the student already joined", async () => {
    mockedApi.activeSession.mockResolvedValueOnce(
      activeSession({ existing_entry: { lucky_code: "MOON-2", status: "confirmed" } }),
    );
    render(<SpeakingLabLiveCard />);
    await waitFor(() =>
      expect(screen.getByTestId("speaking-lab-live-code")).toHaveTextContent("MOON-2"),
    );
    // Already in -> no Join button.
    expect(screen.queryByTestId("speaking-lab-join-now")).not.toBeInTheDocument();
    expect(mockedApi.joinActive).not.toHaveBeenCalled();
  });

  test("maps a join failure to a friendly message with a Try again button (no charge on failure)", async () => {
    const user = userEvent.setup();
    mockedApi.activeSession.mockResolvedValueOnce(activeSession());
    mockedApi.joinActive.mockRejectedValueOnce(
      new SpeakingLabApiError("insufficient_points", "balance too low", 402),
    );

    render(<SpeakingLabLiveCard />);
    await waitFor(() =>
      expect(screen.getByTestId("speaking-lab-join-now")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("speaking-lab-join-now"));

    await waitFor(() =>
      expect(screen.getByText(/don't have enough points/i)).toBeInTheDocument(),
    );
    expect(screen.getByTestId("speaking-lab-try-again")).toBeInTheDocument();
  });

  test("an ambiguous join outcome resolves via active-session instead of re-charging", async () => {
    const user = userEvent.setup();
    mockedApi.activeSession.mockResolvedValueOnce(activeSession());
    mockedApi.joinActive.mockRejectedValueOnce(
      new SpeakingLabApiError("ambiguous_timeout", "took too long", 0),
    );
    // The resolve read finds the join actually succeeded.
    mockedApi.activeSession.mockResolvedValueOnce(
      activeSession({ existing_entry: { lucky_code: "SUN-4", status: "confirmed" } }),
    );

    render(<SpeakingLabLiveCard />);
    await waitFor(() =>
      expect(screen.getByTestId("speaking-lab-join-now")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("speaking-lab-join-now"));

    await waitFor(() => expect(screen.getByTestId("speaking-lab-live-code")).toHaveTextContent("SUN-4"));
    expect(mockedApi.joinActive).toHaveBeenCalledTimes(1);
    expect(mockedApi.activeSession).toHaveBeenCalledTimes(2);
  });
});
