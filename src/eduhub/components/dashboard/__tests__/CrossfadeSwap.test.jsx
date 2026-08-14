import { render, screen, waitFor } from "@testing-library/react";
import CrossfadeSwap from "../CrossfadeSwap";

test("renders its children", () => {
  render(
    <CrossfadeSwap dataKey="k1">
      <div data-testid="child">Hello</div>
    </CrossfadeSwap>,
  );
  expect(screen.getByTestId("child")).toHaveTextContent("Hello");
});

test("re-renders the same child content when dataKey changes, without crashing or losing the content", async () => {
  const { rerender } = render(
    <CrossfadeSwap dataKey="k1">
      <div data-testid="child">Version A</div>
    </CrossfadeSwap>,
  );
  expect(screen.getByTestId("child")).toHaveTextContent("Version A");

  rerender(
    <CrossfadeSwap dataKey="k2">
      <div data-testid="child">Version B</div>
    </CrossfadeSwap>,
  );
  // mode="wait" plays the exit transition before mounting the new child —
  // the swap isn't synchronous, so wait for it rather than asserting
  // immediately after rerender().
  await waitFor(() => expect(screen.getByTestId("child")).toHaveTextContent("Version B"));
});

test("passing the same dataKey again does not remount the child (no flicker on unrelated re-renders)", () => {
  const { rerender } = render(
    <CrossfadeSwap dataKey="k1">
      <div data-testid="child">Stable</div>
    </CrossfadeSwap>,
  );
  const firstNode = screen.getByTestId("child");

  rerender(
    <CrossfadeSwap dataKey="k1">
      <div data-testid="child">Stable</div>
    </CrossfadeSwap>,
  );
  expect(screen.getByTestId("child")).toBe(firstNode);
});
