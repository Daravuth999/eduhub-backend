/**
 * WinnerShowcaseBanner.test.jsx — Automatic Winner Showcase (architecture
 * continuation). Mocks useWinnerShowcaseRotation entirely (its own tests
 * cover fetch/rotation/expiry); this file only proves the UI CONTRACT:
 * renders nothing until a showcase is active, then shows champion/top
 * winners/distribution status, and lets the user jump between showcases.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import WinnerShowcaseBanner from "../WinnerShowcaseBanner";
import useWinnerShowcaseRotation from "../../hooks/useWinnerShowcaseRotation";

jest.mock("../../hooks/useWinnerShowcaseRotation");

test("renders nothing when no showcase is active", () => {
  useWinnerShowcaseRotation.mockReturnValue({ current: null, count: 0, index: 0, setIndex: jest.fn() });
  const { container } = render(<WinnerShowcaseBanner />);
  expect(container).toBeEmptyDOMElement();
});

test("shows the event name, champion, and reward-sent status", () => {
  useWinnerShowcaseRotation.mockReturnValue({
    current: {
      key: "evt_1",
      content: {
        eventName: "July Speaking Tournament",
        champion: { display_name: "Sok", amount: 150 },
        topWinners: [
          { display_name: "Sok", amount: 150 },
          { display_name: "Dara", amount: 100 },
        ],
        distributionCompleted: true,
      },
    },
    count: 1, index: 0, setIndex: jest.fn(),
  });
  render(<WinnerShowcaseBanner />);
  const banner = screen.getByTestId("winner-showcase-banner");
  expect(banner).toHaveTextContent("July Speaking Tournament");
  expect(screen.getByTestId("winner-showcase-champion")).toHaveTextContent("Sok");
  expect(screen.getByTestId("winner-showcase-champion")).toHaveTextContent("150 pts");
  expect(banner).toHaveTextContent("Dara");
  expect(banner).toHaveTextContent("Rewards Sent");
});

test("does not show 'Rewards Sent' when distribution is not yet completed", () => {
  useWinnerShowcaseRotation.mockReturnValue({
    current: { key: "evt_1", content: { eventName: "E", champion: { display_name: "Sok" }, distributionCompleted: false } },
    count: 1, index: 0, setIndex: jest.fn(),
  });
  render(<WinnerShowcaseBanner />);
  expect(screen.queryByText("Rewards Sent")).not.toBeInTheDocument();
});

test("shows rotation dots and lets a user jump to a specific showcase", () => {
  const setIndex = jest.fn();
  useWinnerShowcaseRotation.mockReturnValue({
    current: { key: "evt_1", content: { eventName: "E1", champion: { display_name: "Sok" } } },
    count: 3, index: 0, setIndex,
  });
  render(<WinnerShowcaseBanner />);
  const dots = screen.getByTestId("winner-showcase-dots");
  const buttons = dots.querySelectorAll("button");
  expect(buttons).toHaveLength(3);
  fireEvent.click(buttons[2]);
  expect(setIndex).toHaveBeenCalledWith(2);
});

test("does not show rotation dots when only one showcase is active", () => {
  useWinnerShowcaseRotation.mockReturnValue({
    current: { key: "evt_1", content: { eventName: "E1", champion: { display_name: "Sok" } } },
    count: 1, index: 0, setIndex: jest.fn(),
  });
  render(<WinnerShowcaseBanner />);
  expect(screen.queryByTestId("winner-showcase-dots")).not.toBeInTheDocument();
});
