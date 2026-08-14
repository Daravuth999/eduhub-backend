import { render, screen, act } from "@testing-library/react";
import useVisualViewportKeyboard from "../useVisualViewportKeyboard";

// Inline fake visualViewport — mirrors the established codebase pattern
// (jsdom has no real VisualViewport implementation).
class FakeVisualViewport {
  constructor() {
    this.height = 800;
    this.offsetTop = 0;
    this._listeners = {};
  }
  addEventListener(type, fn) {
    this._listeners[type] = this._listeners[type] || [];
    this._listeners[type].push(fn);
  }
  removeEventListener(type, fn) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
  }
  fire(type) {
    (this._listeners[type] || []).forEach((fn) => fn());
  }
}

function Harness() {
  const isKeyboardOpen = useVisualViewportKeyboard();
  return <div data-testid="state">{isKeyboardOpen ? "open" : "closed"}</div>;
}

let fakeVv;

beforeEach(() => {
  fakeVv = new FakeVisualViewport();
  window.visualViewport = fakeVv;
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
});

afterEach(() => {
  delete window.visualViewport;
});

test("reports closed when the visual viewport matches window height", () => {
  render(<Harness />);
  expect(screen.getByTestId("state")).toHaveTextContent("closed");
});

test("reports open once the visual viewport shrinks past the threshold", () => {
  render(<Harness />);
  act(() => {
    fakeVv.height = 500; // 300px inset — well past the 120px threshold
    fakeVv.fire("resize");
  });
  expect(screen.getByTestId("state")).toHaveTextContent("open");
});

test("a small inset (e.g. browser chrome collapsing) stays under the threshold and reports closed", () => {
  render(<Harness />);
  act(() => {
    fakeVv.height = 760; // 40px inset
    fakeVv.fire("resize");
  });
  expect(screen.getByTestId("state")).toHaveTextContent("closed");
});

test("returns to closed once the keyboard height is restored", () => {
  render(<Harness />);
  act(() => {
    fakeVv.height = 500;
    fakeVv.fire("resize");
  });
  expect(screen.getByTestId("state")).toHaveTextContent("open");

  act(() => {
    fakeVv.height = 800;
    fakeVv.fire("resize");
  });
  expect(screen.getByTestId("state")).toHaveTextContent("closed");
});

test("never throws when visualViewport is unavailable (older browsers)", () => {
  delete window.visualViewport;
  expect(() => render(<Harness />)).not.toThrow();
  expect(screen.getByTestId("state")).toHaveTextContent("closed");
});

// Regression test for the actual production bug: with the viewport
// meta's `interactive-widget=resizes-content` directive active, the
// LAYOUT viewport (window.innerHeight) shrinks in lockstep with the
// VISUAL viewport when the keyboard opens — a diff between the two at
// the same instant stays ~0. The old (v1) diff-based formula would
// never have detected the keyboard in this mode; the baseline-tracking
// approach must still catch it.
test("detects the keyboard even when innerHeight and visualViewport shrink together (resizes-content mode)", () => {
  render(<Harness />);
  act(() => {
    Object.defineProperty(window, "innerHeight", { value: 500, configurable: true });
    fakeVv.height = 500;
    fakeVv.fire("resize");
  });
  expect(screen.getByTestId("state")).toHaveTextContent("open");
});

test("falls back to window resize events (not visualViewport) when visualViewport is unavailable", () => {
  delete window.visualViewport;
  render(<Harness />);
  act(() => {
    Object.defineProperty(window, "innerHeight", { value: 500, configurable: true });
    window.dispatchEvent(new Event("resize"));
  });
  expect(screen.getByTestId("state")).toHaveTextContent("open");
});
