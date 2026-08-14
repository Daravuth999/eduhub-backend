/**
 * interactionRuntimeFoundation.test.jsx — Checkpoint 1 foundation tests for
 * the shared frontend interaction runtime: progress cache/sync, the shared
 * observer/reduced-motion/expanded-card runtime, and the accessibility
 * announcer singleton. No visual interaction component exists yet — these
 * tests exercise the runtime skeleton directly.
 */
import fs from "fs";
import path from "path";
import React, { useRef } from "react";
import { render, screen, act } from "@testing-library/react";
import { renderHook, waitFor } from "@testing-library/react";

jest.mock("../bookInteractionProgressApi", () => ({
  syncProgress: jest.fn(),
  getProgress: jest.fn(),
}));
const progressApi = require("../bookInteractionProgressApi");
const { useBookInteractionProgress } = require("../useBookInteractionProgress");
const {
  InteractionRuntimeProvider, useInteractionRuntime, useInView,
} = require("../PremiumInteractionShell");
const { announce } = require("../interactionAccessibility");

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  progressApi.getProgress.mockResolvedValue({ items: [] });
  progressApi.syncProgress.mockResolvedValue({ success: true, results: [] });
});

// ── progress cache key + scoping ────────────────────────────────────────────
describe("useBookInteractionProgress — local cache", () => {
  test("cache key includes studentId, bookSlug, and revision", async () => {
    const { result } = renderHook(() =>
      useBookInteractionProgress({ studentId: "stu1", bookSlug: "my-book", revision: 3 }));
    await act(async () => { result.current.markCompleted("ch1", "vocab_01"); });
    const keys = Object.keys(localStorage.__proto__.constructor === Storage ? {} : {});
    let found = null;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith("eduhub_interaction_progress_v1:")) found = k;
    }
    expect(found).toBe("eduhub_interaction_progress_v1:stu1:my-book:3");
  });

  test("item state is keyed by chapterId:blockId and reflects a local mutation instantly", async () => {
    const { result } = renderHook(() =>
      useBookInteractionProgress({ studentId: "stu1", bookSlug: "b", revision: 1 }));
    await act(async () => { result.current.markCompleted("ch1", "vocab_01"); });
    expect(result.current.getItemState("ch1", "vocab_01").completed).toBe(true);
    expect(result.current.getItemState("ch1", "vocab_02").completed).toBe(false);
  });
});

// ── debounced, non-blocking server sync ────────────────────────────────────
describe("useBookInteractionProgress — server sync", () => {
  test("server sync is debounced, not fired on every local mutation", async () => {
    jest.useFakeTimers();
    const { result } = renderHook(() =>
      useBookInteractionProgress({ studentId: "stu1", bookSlug: "b", revision: 1 }));
    act(() => {
      result.current.markExplored("ch1", "vocab_01");
      result.current.recordAttempt("ch1", "vocab_01", 1);
      result.current.recordAttempt("ch1", "vocab_01", 2);
    });
    expect(progressApi.syncProgress).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(2100); });
    expect(progressApi.syncProgress).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  test("a failed sync never throws and local state remains authoritative", async () => {
    progressApi.syncProgress.mockRejectedValue(new Error("network down"));
    jest.useFakeTimers();
    const { result } = renderHook(() =>
      useBookInteractionProgress({ studentId: "stu1", bookSlug: "b", revision: 1 }));
    act(() => { result.current.markCompleted("ch1", "vocab_01"); });
    await act(async () => { jest.advanceTimersByTime(2100); });
    expect(result.current.getItemState("ch1", "vocab_01").completed).toBe(true);
    jest.useRealTimers();
  });

  test("stale in-flight getProgress request is aborted when bookSlug changes", async () => {
    const capturedSignals = [];
    progressApi.getProgress.mockImplementation((slug, rev, signal) => {
      capturedSignals.push(signal);
      return new Promise(() => {}); // never resolves
    });
    const { rerender } = renderHook(
      ({ bookSlug }) => useBookInteractionProgress({ studentId: "stu1", bookSlug, revision: 1 }),
      { initialProps: { bookSlug: "book-a" } },
    );
    await waitFor(() => expect(capturedSignals.length).toBe(1));
    const firstSignal = capturedSignals[0];
    expect(firstSignal.aborted).toBe(false);
    rerender({ bookSlug: "book-b" });
    await waitFor(() => expect(capturedSignals.length).toBe(2));
    expect(firstSignal.aborted).toBe(true); // the FIRST (now-stale) request was aborted
    expect(capturedSignals[1].aborted).toBe(false); // the new request for book-b is live
  });

  test("disabled hook never touches localStorage or the network (old books pay nothing)", async () => {
    const setItemSpy = jest.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() =>
      useBookInteractionProgress({ studentId: "stu1", bookSlug: "b", revision: 1, enabled: false }));
    await act(async () => { result.current.markCompleted("ch1", "vocab_01"); });
    expect(progressApi.getProgress).not.toHaveBeenCalled();
    expect(progressApi.syncProgress).not.toHaveBeenCalled();
    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });
});

// ── shared observer / reduced-motion / expanded-card runtime ──────────────
describe("PremiumInteractionShell — shared runtime", () => {
  function Probe() {
    const ref = useRef(null);
    const inView = useInView(ref);
    const { reducedMotion } = useInteractionRuntime();
    return <div ref={ref} data-testid="probe" data-inview={String(inView)} data-reduced={String(reducedMotion)} />;
  }

  const realIntersectionObserver = global.IntersectionObserver;
  const realMatchMedia = window.matchMedia;
  afterEach(() => {
    global.IntersectionObserver = realIntersectionObserver;
    window.matchMedia = realMatchMedia;
  });

  test("observer is disconnected on provider unmount", () => {
    const disconnect = jest.fn();
    const observe = jest.fn();
    global.IntersectionObserver = jest.fn(() => ({ observe, unobserve: jest.fn(), disconnect }));
    const { unmount } = render(
      <InteractionRuntimeProvider bookSlug="b" revision={1}><Probe /></InteractionRuntimeProvider>,
    );
    expect(observe).toHaveBeenCalled();
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  test("reduced-motion preference is read once and shared via context", () => {
    global.IntersectionObserver = jest.fn(() => ({ observe: jest.fn(), unobserve: jest.fn(), disconnect: jest.fn() }));
    window.matchMedia = jest.fn().mockReturnValue({
      matches: true, addEventListener: jest.fn(), removeEventListener: jest.fn(),
    });
    render(<InteractionRuntimeProvider bookSlug="b" revision={1}><Probe /></InteractionRuntimeProvider>);
    expect(screen.getByTestId("probe")).toHaveAttribute("data-reduced", "true");
  });

  test("useInteractionRuntime outside a provider returns a safe default (never crashes)", () => {
    render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveAttribute("data-reduced", "false");
  });
});

// ── accessibility announcer singleton ──────────────────────────────────────
describe("interactionAccessibility — announcer singleton", () => {
  test("multiple announce() calls reuse exactly one live-region node", () => {
    announce("First message");
    announce("Second message");
    const nodes = document.querySelectorAll('[data-testid="bf-interaction-announcer"]');
    expect(nodes.length).toBe(1);
  });
});

// ── structural: student Reader bundle never imports Author Studio code ────
describe("bundle isolation (structural)", () => {
  const DIR = path.resolve(__dirname, "..");
  const files = ["bookInteractionProgressApi.js", "useBookInteractionProgress.js",
    "PremiumInteractionShell.jsx", "interactionAccessibility.js",
    "interactionTierPolicy.js", "interactionDensityPolicy.js"];

  test.each(files)("%s does not import from src/studio (Author Studio bundle)", (file) => {
    const src = fs.readFileSync(path.join(DIR, file), "utf8");
    expect(src).not.toMatch(/from\s+["'].*\/studio\//);
    expect(src).not.toMatch(/require\(["'].*\/studio\//);
  });
});
