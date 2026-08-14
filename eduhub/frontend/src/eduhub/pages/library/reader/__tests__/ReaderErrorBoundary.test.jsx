/**
 * ReaderErrorBoundary.test.jsx — Issue 2 fix proof.
 *
 * The Reader route previously had no error boundary anywhere above it —
 * a render-time exception in the Reader subtree unmounted the whole tree
 * with nothing to catch it, leaving the student on a blank page with no
 * recovery path. This boundary is small and fully mountable (unlike
 * ReaderPage itself), so it gets a real render-based test rather than a
 * structural one.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import ReaderErrorBoundary from "../ReaderErrorBoundary";

function Boom() {
  throw new Error("kaboom");
}

describe("ReaderErrorBoundary", () => {
  let consoleErrorSpy;
  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test("renders children normally when nothing throws", () => {
    render(
      <ReaderErrorBoundary>
        <div data-testid="reader-content">All good</div>
      </ReaderErrorBoundary>
    );
    expect(screen.getByTestId("reader-content")).toBeInTheDocument();
    expect(screen.queryByTestId("reader-error-boundary")).not.toBeInTheDocument();
  });

  test("catches a render error and shows the recoverable fallback instead of unmounting to blank", () => {
    render(
      <ReaderErrorBoundary>
        <Boom />
      </ReaderErrorBoundary>
    );
    expect(screen.getByTestId("reader-error-boundary")).toBeInTheDocument();
    expect(screen.getByTestId("reader-error-reload")).toBeInTheDocument();
    expect(screen.getByTestId("reader-error-back")).toBeInTheDocument();
  });

  test("the fallback offers a real recovery path (reload button + back-to-library link), not a dead end", () => {
    render(
      <ReaderErrorBoundary>
        <Boom />
      </ReaderErrorBoundary>
    );
    const backLink = screen.getByTestId("reader-error-back");
    expect(backLink.getAttribute("href")).toBe("/library");
  });

  test("reset() clears the error state so a retried render can recover", () => {
    let shouldThrow = true;
    function MaybeBoom() {
      if (shouldThrow) throw new Error("kaboom");
      return <div data-testid="recovered">Recovered</div>;
    }
    const ref = React.createRef();
    function Wrapper() {
      return (
        <ReaderErrorBoundary ref={ref}>
          <MaybeBoom />
        </ReaderErrorBoundary>
      );
    }
    const { rerender } = render(<Wrapper />);
    expect(screen.getByTestId("reader-error-boundary")).toBeInTheDocument();

    // Fix the underlying condition, then invoke the boundary's own reset.
    shouldThrow = false;
    ref.current.reset();
    rerender(<Wrapper />);
    expect(screen.getByTestId("recovered")).toBeInTheDocument();
  });
});
