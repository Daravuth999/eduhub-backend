import { render } from "@testing-library/react";
import { useRef } from "react";
import useKeyboardBodyLock from "../useKeyboardBodyLock";

function Harness() {
  const ref = useRef(null);
  useKeyboardBodyLock(ref);
  return <input ref={ref} data-testid="probe" />;
}

afterEach(() => {
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  document.body.style.width = "";
  document.body.style.overflow = "";
});

test("locks the body in place on focus", () => {
  const { getByTestId } = render(<Harness />);
  Object.defineProperty(window, "scrollY", { value: 240, configurable: true });

  getByTestId("probe").focus();

  expect(document.body.style.position).toBe("fixed");
  expect(document.body.style.top).toBe("-240px");
  expect(document.body.style.overflow).toBe("hidden");
});

test("unlocks and restores scroll position on blur", () => {
  const { getByTestId } = render(<Harness />);
  Object.defineProperty(window, "scrollY", { value: 88, configurable: true });
  const scrollToSpy = jest.spyOn(window, "scrollTo").mockImplementation(() => {});

  const input = getByTestId("probe");
  input.focus();
  input.blur();

  expect(document.body.style.position).toBe("");
  expect(document.body.style.overflow).toBe("");
  expect(scrollToSpy).toHaveBeenCalledWith(0, 88);
  scrollToSpy.mockRestore();
});

test("a second focus without an intervening blur does not double-lock or lose the original offset", () => {
  const { getByTestId } = render(<Harness />);
  const input = getByTestId("probe");

  Object.defineProperty(window, "scrollY", { value: 100, configurable: true });
  input.focus();
  Object.defineProperty(window, "scrollY", { value: 999, configurable: true });
  input.focus(); // no-op: already locked

  expect(document.body.style.top).toBe("-100px");
});

test("unmounting while focused restores the body instead of leaving it locked", () => {
  const { getByTestId, unmount } = render(<Harness />);
  Object.defineProperty(window, "scrollY", { value: 50, configurable: true });
  getByTestId("probe").focus();

  unmount();

  expect(document.body.style.position).toBe("");
});

test("does nothing when the ref is not yet attached to an element", () => {
  function EmptyRefHarness() {
    const ref = useRef(null);
    useKeyboardBodyLock(ref);
    return <div data-testid="no-input" />;
  }
  expect(() => render(<EmptyRefHarness />)).not.toThrow();
  expect(document.body.style.position).toBe("");
});
