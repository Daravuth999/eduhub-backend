/**
 * LiveCoachTopUpNudge.test.jsx — BUG 3 hardening regression coverage: the
 * pill must offer its OWN dismiss control, independent of the top-up CTA,
 * and the two must never trigger each other.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import LiveCoachTopUpNudge from "../LiveCoachTopUpNudge";

test("clicking the CTA calls onTopUp", () => {
  const onTopUp = jest.fn();
  render(<LiveCoachTopUpNudge variant="start" onTopUp={onTopUp} />);
  fireEvent.click(screen.getByLabelText("Top up EduHub points"));
  expect(onTopUp).toHaveBeenCalledTimes(1);
});

test("renders no dismiss control when onDismiss is not provided", () => {
  render(<LiveCoachTopUpNudge variant="start" onTopUp={() => {}} />);
  expect(screen.queryByTestId("live-topup-nudge-dismiss-start")).not.toBeInTheDocument();
});

test("clicking dismiss calls onDismiss and never calls onTopUp", () => {
  const onTopUp = jest.fn();
  const onDismiss = jest.fn();
  render(<LiveCoachTopUpNudge variant="report" onTopUp={onTopUp} onDismiss={onDismiss} />);

  fireEvent.click(screen.getByTestId("live-topup-nudge-dismiss-report"));

  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(onTopUp).not.toHaveBeenCalled();
});

test("the CTA and dismiss are independent sibling buttons, not nested (valid HTML, both keyboard-focusable)", () => {
  render(<LiveCoachTopUpNudge variant="start" onTopUp={() => {}} onDismiss={() => {}} />);
  const cta = screen.getByLabelText("Top up EduHub points");
  const dismiss = screen.getByTestId("live-topup-nudge-dismiss-start");
  expect(cta.tagName).toBe("BUTTON");
  expect(dismiss.tagName).toBe("BUTTON");
  // Neither button contains the other.
  expect(cta.contains(dismiss)).toBe(false);
  expect(dismiss.contains(cta)).toBe(false);
});

test("disabled disables the CTA but the dismiss control still works", () => {
  const onTopUp = jest.fn();
  const onDismiss = jest.fn();
  render(<LiveCoachTopUpNudge variant="start" onTopUp={onTopUp} onDismiss={onDismiss} disabled />);

  expect(screen.getByLabelText("Top up EduHub points")).toBeDisabled();
  fireEvent.click(screen.getByTestId("live-topup-nudge-dismiss-start"));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("shows the settled balance on the report variant when provided", () => {
  render(
    <LiveCoachTopUpNudge
      variant="report"
      finalization={{ settled_balance: 12 }}
      onTopUp={() => {}}
    />,
  );
  expect(screen.getByTestId("live-topup-nudge-balance-report")).toHaveTextContent("12 pts");
});
