import { render, screen, act } from "@testing-library/react";
import EduHubPointsPill from "../EduHubPointsPill";

// framer-motion's useReducedMotion() reads window.matchMedia. jsdom does not
// implement it, so every test here explicitly controls the value rather
// than relying on an unmocked call throwing or silently defaulting.
function mockMatchMedia(reduced) {
  window.matchMedia = jest.fn().mockImplementation((query) => ({
    matches: reduced,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
  }));
}

beforeEach(() => {
  mockMatchMedia(true); // reduced motion by default — animation off, deterministic final value immediately
});

test("renders the exact production float-precision leak correctly", () => {
  render(<EduHubPointsPill value={154.15999999999988} />);
  expect(screen.getByTestId("eduhub-points-pill-value")).toHaveTextContent("154.16");
});

test("integer values show no decimals", () => {
  render(<EduHubPointsPill value={154.0000001} />);
  expect(screen.getByTestId("eduhub-points-pill-value")).toHaveTextContent("154");
});

test("preserves a genuine single decimal", () => {
  render(<EduHubPointsPill value={154.1} />);
  expect(screen.getByTestId("eduhub-points-pill-value")).toHaveTextContent("154.1");
});

test("adds locale-aware thousands separators", () => {
  render(<EduHubPointsPill value={1200} />);
  expect(screen.getByTestId("eduhub-points-pill-value")).toHaveTextContent("1,200");
  const { unmount } = render(<EduHubPointsPill value={18250} testId="p2" />);
  expect(screen.getByTestId("p2-value")).toHaveTextContent("18,250");
  unmount();
});

test("zero renders as 0, not blank or NaN", () => {
  render(<EduHubPointsPill value={0} />);
  expect(screen.getByTestId("eduhub-points-pill-value")).toHaveTextContent("0");
});

test("null/undefined/non-numeric value falls back to 0 instead of crashing", () => {
  const { unmount } = render(<EduHubPointsPill value={null} />);
  expect(screen.getByTestId("eduhub-points-pill-value")).toHaveTextContent("0");
  unmount();
  const { unmount: unmount2 } = render(<EduHubPointsPill value={undefined} testId="p2" />);
  expect(screen.getByTestId("p2-value")).toHaveTextContent("0");
  unmount2();
  render(<EduHubPointsPill value="not a number" testId="p3" />);
  expect(screen.getByTestId("p3-value")).toHaveTextContent("0");
});

test("renders the pts suffix by default and can hide it", () => {
  render(<EduHubPointsPill value={100} />);
  expect(screen.getByTestId("eduhub-points-pill")).toHaveTextContent("pts");
  render(<EduHubPointsPill value={100} suffix="" testId="p2" />);
  expect(screen.getByTestId("p2")).not.toHaveTextContent("pts");
});

test("renders without crashing when the OS does not request reduced motion", () => {
  mockMatchMedia(false);
  expect(() => render(<EduHubPointsPill value={42} />)).not.toThrow();
});

test("value increasing does not throw and settles on the new formatted value", () => {
  const { rerender } = render(<EduHubPointsPill value={100} />);
  act(() => {
    rerender(<EduHubPointsPill value={250} />);
  });
  expect(screen.getByTestId("eduhub-points-pill-value")).toHaveTextContent("250");
});

test("value decreasing does not throw and settles on the new formatted value", () => {
  const { rerender } = render(<EduHubPointsPill value={250} />);
  act(() => {
    rerender(<EduHubPointsPill value={100} />);
  });
  expect(screen.getByTestId("eduhub-points-pill-value")).toHaveTextContent("100");
});

test("supports the sm/md/lg size variants without crashing", () => {
  const { unmount: u1 } = render(<EduHubPointsPill value={10} size="sm" testId="s" />);
  expect(screen.getByTestId("s")).toBeInTheDocument();
  u1();
  const { unmount: u2 } = render(<EduHubPointsPill value={10} size="lg" testId="l" />);
  expect(screen.getByTestId("l")).toBeInTheDocument();
  u2();
});
