import { renderHook, act } from "@testing-library/react";
import useAutoFollow from "../useAutoFollow";

// Regression guard for a real integration defect found while auditing the
// Video Library surgical refinement package: Author Studio's (unmodified)
// TeleprompterPanel.jsx renders Teleprompter with `sync` starting as null
// (fetched async, no loading gate) — so the scrollable container does not
// exist in the DOM on first render. It appears on a LATER render once the
// sync document resolves, without the component ever unmounting. A naive
// `[containerRef, enabled]` effect dependency array never re-fires in that
// case, since the ref OBJECT's identity never changes — only `.current`
// does — so manual-scroll suspend silently never attaches for the rest of
// that session. Fixed by useAutoFollow.js's containerTick watcher.
test("manual-scroll suspend still attaches once the container appears on a later render", () => {
  const containerRef = { current: null }; // same ref object identity throughout
  const { result, rerender } = renderHook(
    ({ hasContainer }) => {
      if (hasContainer && !containerRef.current) {
        containerRef.current = document.createElement("div");
      }
      return useAutoFollow({ containerRef, activeIdx: -1, getTargetEl: () => null });
    },
    { initialProps: { hasContainer: false } },
  );

  expect(result.current.following).toBe(true);

  // The sync document resolves; the real container div mounts for the
  // first time on this render, but containerRef itself never changed
  // identity, only its `.current`.
  rerender({ hasContainer: true });

  act(() => {
    containerRef.current.dispatchEvent(new Event("wheel"));
  });

  expect(result.current.following).toBe(false);
});

// Regression guard for the "video moves while reading" bug reported against
// TeleprompterPanel.jsx: jsdom reports clientHeight/scrollHeight/offsetTop
// as 0 for every element unless a test explicitly stubs them, which means a
// container with NO real height ceiling (maxScroll always 0, exactly the
// production bug) and a container with a REAL ceiling were previously
// indistinguishable to this suite — both "passed" by doing nothing. This
// test stubs realistic dimensions for a properly-bounded container (the
// fixed shape once TeleprompterPanel.jsx's max-height ships) and proves
// useAutoFollow actually writes a non-zero, advancing scrollTop as the
// active sentence progresses — the one thing the bug prevented.
test("writes an advancing scrollTop on a container with a real clientHeight/scrollHeight gap", () => {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
  Object.defineProperty(container, "scrollHeight", { value: 2000, configurable: true });
  let scrollTopValue = 0;
  Object.defineProperty(container, "scrollTop", {
    get: () => scrollTopValue,
    set: (v) => { scrollTopValue = v; },
    configurable: true,
  });
  const containerRef = { current: container };

  const sentenceEls = [0, 1, 2, 3, 4].map((i) => {
    const el = document.createElement("div");
    Object.defineProperty(el, "offsetTop", { value: i * 300, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 40, configurable: true });
    return el;
  });

  const { result, rerender } = renderHook(
    ({ activeIdx }) => useAutoFollow({
      containerRef,
      activeIdx,
      getTargetEl: () => sentenceEls[activeIdx],
      enabled: true,
      anchorFor: (c) => c.clientHeight * 0.35,
    }),
    { initialProps: { activeIdx: 0 } },
  );

  // Immediate (reduced-motion-equivalent) path is exercised via jsdom's
  // absent requestAnimationFrame in this environment, so the write happens
  // synchronously inside the effect — no timer/rAF driving needed here.
  act(() => { result.current.scrollToActive(true); });
  const afterFirst = container.scrollTop;

  rerender({ activeIdx: 3 }); // sentence progressed well past the first screenful
  act(() => { result.current.scrollToActive(true); });
  const afterAdvance = container.scrollTop;

  expect(afterAdvance).toBeGreaterThan(afterFirst);
  expect(afterAdvance).toBeGreaterThan(0);
  // Never scrolls past what the container actually has to give.
  expect(afterAdvance).toBeLessThanOrEqual(container.scrollHeight - container.clientHeight);
});
