/**
 * readingHub.test.jsx — real mounted-component coverage for the P1/P1-B
 * Reading Hub shell: the docked/peek/expanded state machine, module
 * composition (audio/EduTalk/Live Coach), context-priority ordering,
 * Narration Mode, edge-peek positioning, and the "no duplicated floating
 * controls" auto-collapse contract.
 *
 * Unlike ReaderPage.jsx/EduTalkPanel.jsx (no mountable harness — markdown-
 * to-jsx / WebSocket complexity), ReadingHub.jsx has none of those
 * dependencies, so this uses the codebase's standard
 * @testing-library/react mount pattern (see readerRouteRemountIntegration
 * .test.jsx for the same convention).
 *
 * useBookAudio() is mocked directly (not driven through the real
 * BookAudioProvider) so this file tests ONLY ReadingHub's own composition
 * logic — AudioPlayerContext.jsx's playback engine (play/pause/seek/speed)
 * is untouched by this feature and out of scope here.
 */
import { render, screen, fireEvent, act } from "@testing-library/react";

// jsdom never runs real animation frames, so framer-motion's
// AnimatePresence (mode="wait") leaves an exiting element parked
// mid-animation indefinitely — the entering element never appears
// synchronously. This mock renders motion.* as plain passthrough elements
// (preserving whatever `animate`/`style` values ReadingHub passes, so the
// edge-peek `x` offset is inspectable) and AnimatePresence as a plain
// fragment, so the test can assert on ReadingHub's own state-machine
// logic (what SHOULD be in the DOM / what x it asked for) rather than
// framer-motion's animation timing (a separate, already battle-tested
// library, not what this file is testing).
// Drag simulation: real framer-motion drives onDragStart/onDragEnd off
// pointer-gesture physics jsdom can't reproduce. The mock instead exposes
// them as plain DOM CustomEvents ("test:dragstart" / "test:dragend") on the
// rendered node, so a test can dispatch one directly to exercise
// ReadingHub's OWN drag-end handling (useDockPosition, dockStyle) without
// needing to fake real pointer physics — a separate, already-battle-tested
// concern of the framer-motion library itself.
jest.mock("framer-motion", () => {
  const React = require("react");
  const passthrough = (tag) =>
    React.forwardRef(({ children, initial, animate, exit, transition, whileHover, whileFocus, whileTap, whileDrag, drag, dragMomentum, dragElastic, onDragStart, onDragEnd, ...rest }, ref) => {
      const style = animate && typeof animate.x === "number" ? { ...rest.style, "--motion-x": animate.x } : rest.style;
      const domRef = React.useRef(null);
      React.useImperativeHandle(ref, () => domRef.current);
      React.useEffect(() => {
        const el = domRef.current;
        if (!el) return undefined;
        const handleStart = (e) => onDragStart?.(e, e.detail);
        const handleEnd = (e) => onDragEnd?.(e, e.detail);
        el.addEventListener("test:dragstart", handleStart);
        el.addEventListener("test:dragend", handleEnd);
        return () => {
          el.removeEventListener("test:dragstart", handleStart);
          el.removeEventListener("test:dragend", handleEnd);
        };
      }, [onDragStart, onDragEnd]);
      return React.createElement(tag, { ref: domRef, ...rest, style, "data-motion-x": animate?.x }, children);
    });
  return {
    motion: new Proxy({}, { get: (_t, tag) => passthrough(tag) }),
    AnimatePresence: ({ children }) => React.createElement(React.Fragment, null, children),
    useReducedMotion: () => false,
  };
});

import ReadingHub from "../ReadingHub";

let mockAudioCtx = null;
jest.mock("../AudioPlayerContext", () => ({
  useBookAudio: () => mockAudioCtx,
}));

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  mockAudioCtx = null;
  window.matchMedia = jest.fn().mockReturnValue({
    matches: false,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
  });
  // P2 — the intro tooltip's "seen" flag is real jsdom localStorage, which
  // persists across tests in the same file unless cleared.
  window.localStorage.removeItem("eduhub_reading_hub_intro_seen");
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  jest.useRealTimers();
});

// Paused by default — most tests care about the PLAIN bubble/peek/expanded
// flow, not Narration Mode specifically (which has its own dedicated tests
// below and intentionally sets playing:true).
function pausedAudio(overrides = {}) {
  return {
    src: "https://cdn.example/track.mp3",
    playing: false,
    currentTime: 15,
    duration: 202,
    meta: { title: "Conversation — Chapter 1" },
    toggle: jest.fn(),
    retry: jest.fn(),
    error: null,
    ...overrides,
  };
}
function playingAudio(overrides = {}) {
  return pausedAudio({ playing: true, ...overrides });
}

test("renders nothing when there is no audio, no EduTalk, and no Live Coach available", () => {
  const { container } = render(<ReadingHub eduTalk={null} liveCoach={null} />);
  expect(container).toBeEmptyDOMElement();
});

test("docked bubble renders when a book-audio track is present (paused), even with no EduTalk/Live Coach", () => {
  mockAudioCtx = pausedAudio();
  render(<ReadingHub eduTalk={null} liveCoach={null} />);
  expect(screen.getByTestId("reading-hub-bubble")).toBeInTheDocument();
});

test("docked bubble renders from EduTalk/Live Coach alone, with no audio track", () => {
  render(
    <ReadingHub
      eduTalk={{ visible: true, label: "8 pts", isActive: false, onOpen: jest.fn() }}
      liveCoach={null}
    />,
  );
  expect(screen.getByTestId("reading-hub-bubble")).toBeInTheDocument();
});

test("tapping the docked bubble opens peek mode, listing every available module as a row", () => {
  mockAudioCtx = pausedAudio();
  const eduTalk = { visible: true, label: "8 pts", isActive: false, onOpen: jest.fn() };
  const liveCoach = { visible: true, label: "Available", onOpen: jest.fn() };
  render(<ReadingHub eduTalk={eduTalk} liveCoach={liveCoach} />);

  fireEvent.click(screen.getByTestId("reading-hub-bubble"));

  expect(screen.getByTestId("reading-hub-peek")).toBeInTheDocument();
  expect(screen.getByTestId("reading-hub-row-audio")).toBeInTheDocument();
  expect(screen.getByTestId("reading-hub-row-edutalk")).toBeInTheDocument();
  expect(screen.getByTestId("reading-hub-row-livecoach")).toBeInTheDocument();
});

test("Phase B — Context Awareness: peek rows are ordered Live Coach > EduTalk > Audio, regardless of prop order or availability order", () => {
  mockAudioCtx = pausedAudio();
  const eduTalk = { visible: true, label: "8 pts", isActive: false, onOpen: jest.fn() };
  const liveCoach = { visible: true, label: "Available", onOpen: jest.fn() };
  render(<ReadingHub eduTalk={eduTalk} liveCoach={liveCoach} />);
  fireEvent.click(screen.getByTestId("reading-hub-bubble"));

  const rowKeys = screen.getAllByRole("menuitem").map((el) => el.dataset.testid);
  expect(rowKeys).toEqual([
    "reading-hub-row-livecoach",
    "reading-hub-row-edutalk",
    "reading-hub-row-audio",
  ]);
});

test("Phase B — Context Awareness: the docked bubble icon reflects the HIGHEST-priority available module, not just audio", () => {
  // Live Coach outranks EduTalk and Audio — even though audio has a track
  // (paused, so Narration Mode doesn't apply), the bubble should reflect
  // Live Coach's icon (Mic), proving priority — not first-registered —
  // decides what the docked bubble shows.
  mockAudioCtx = pausedAudio();
  const eduTalk = { visible: true, label: "8 pts", isActive: false, onOpen: jest.fn() };
  const liveCoach = { visible: true, label: "Available", onOpen: jest.fn() };
  render(<ReadingHub eduTalk={eduTalk} liveCoach={liveCoach} />);

  // lucide-react's Mic icon renders an <svg class="lucide-mic">.
  expect(screen.getByTestId("reading-hub-bubble").querySelector("svg.lucide-mic")).toBeInTheDocument();
});

test("tapping the EduTalk row calls the SAME onOpen EduTalkPanel's own fab always called, then collapses", () => {
  const onOpen = jest.fn();
  render(
    <ReadingHub
      eduTalk={{ visible: true, label: "8 pts", isActive: false, onOpen }}
      liveCoach={null}
    />,
  );
  fireEvent.click(screen.getByTestId("reading-hub-bubble"));
  fireEvent.click(screen.getByTestId("reading-hub-row-edutalk"));

  expect(onOpen).toHaveBeenCalledTimes(1);
  // Collapses back to docked — Hub never keeps its own panel open once it
  // has handed off to the real subsystem's own overlay.
  expect(screen.getByTestId("reading-hub-bubble")).toBeInTheDocument();
  expect(screen.queryByTestId("reading-hub-peek")).not.toBeInTheDocument();
});

test("tapping the audio row expands into the now-playing scrub view", () => {
  mockAudioCtx = pausedAudio({ currentTime: 15, duration: 202 });
  render(<ReadingHub eduTalk={null} liveCoach={null} />);
  fireEvent.click(screen.getByTestId("reading-hub-bubble"));
  fireEvent.click(screen.getByTestId("reading-hub-row-audio"));

  expect(screen.getByTestId("reading-hub-expanded")).toBeInTheDocument();
  expect(screen.getByText("0:15 / 3:22")).toBeInTheDocument();
});

test("the expanded play button calls the SAME toggle() PersistentMiniPlayer always called", () => {
  const toggle = jest.fn();
  mockAudioCtx = pausedAudio({ toggle });
  render(<ReadingHub eduTalk={null} liveCoach={null} />);
  fireEvent.click(screen.getByTestId("reading-hub-bubble"));
  fireEvent.click(screen.getByTestId("reading-hub-row-audio"));
  fireEvent.click(screen.getByTestId("reading-hub-toggle"));

  expect(toggle).toHaveBeenCalledTimes(1);
});

test("context priority: Hub auto-collapses to docked the instant EduTalk reports visible:false (its own overlay took over) — no duplicated floating controls", () => {
  mockAudioCtx = pausedAudio();
  const onOpen = jest.fn();
  const { rerender } = render(
    <ReadingHub eduTalk={{ visible: true, label: "8 pts", isActive: false, onOpen }} liveCoach={null} />,
  );
  fireEvent.click(screen.getByTestId("reading-hub-bubble")); // -> peek
  expect(screen.getByTestId("reading-hub-peek")).toBeInTheDocument();

  // EduTalk's own session UI has now taken over (matches the exact signal
  // EduTalkPanel.jsx's onFabState reports once phase !== "idle").
  rerender(
    <ReadingHub eduTalk={{ visible: false, label: "8 pts", isActive: true, onOpen }} liveCoach={null} />,
  );

  expect(screen.queryByTestId("reading-hub-peek")).not.toBeInTheDocument();
  expect(screen.getByTestId("reading-hub-bubble")).toBeInTheDocument();
});

test("context priority: same auto-collapse contract for Live Coach taking over", () => {
  const onOpen = jest.fn();
  const { rerender } = render(
    <ReadingHub eduTalk={null} liveCoach={{ visible: true, label: "Available", onOpen }} />,
  );
  fireEvent.click(screen.getByTestId("reading-hub-bubble"));
  expect(screen.getByTestId("reading-hub-peek")).toBeInTheDocument();

  rerender(<ReadingHub eduTalk={null} liveCoach={{ visible: false, label: "Available", onOpen }} />);

  expect(screen.queryByTestId("reading-hub-peek")).not.toBeInTheDocument();
});

test("an audio error state still renders the docked bubble and expanded panel routes the play button through retry() instead of toggle()", () => {
  const retry = jest.fn();
  const toggle = jest.fn();
  mockAudioCtx = pausedAudio({ error: "Network error", retry, toggle });
  render(<ReadingHub eduTalk={null} liveCoach={null} />);
  fireEvent.click(screen.getByTestId("reading-hub-bubble"));
  fireEvent.click(screen.getByTestId("reading-hub-row-audio"));
  fireEvent.click(screen.getByTestId("reading-hub-toggle"));

  expect(retry).toHaveBeenCalledTimes(1);
  expect(toggle).not.toHaveBeenCalled();
});

test("collapse (×) button in expanded view returns to docked", () => {
  mockAudioCtx = pausedAudio();
  render(<ReadingHub eduTalk={null} liveCoach={null} />);
  fireEvent.click(screen.getByTestId("reading-hub-bubble"));
  fireEvent.click(screen.getByTestId("reading-hub-row-audio"));
  expect(screen.getByTestId("reading-hub-expanded")).toBeInTheDocument();

  fireEvent.click(screen.getByTestId("reading-hub-collapse"));

  expect(screen.queryByTestId("reading-hub-expanded")).not.toBeInTheDocument();
  expect(screen.getByTestId("reading-hub-bubble")).toBeInTheDocument();
});

// ── Phase B — Narration Mode ────────────────────────────────────────────

test("Narration Mode: while audio plays and no higher-priority module is available, docked state shows the compact player, not the plain bubble", () => {
  mockAudioCtx = playingAudio();
  render(<ReadingHub eduTalk={null} liveCoach={null} />);

  expect(screen.getByTestId("reading-hub-compact-player")).toBeInTheDocument();
  expect(screen.queryByTestId("reading-hub-bubble")).not.toBeInTheDocument();
});

test("Narration Mode: a merely-available (idle, not in-session) Live Coach never outranks ACTIVELY playing audio — 'active' beats 'available'", () => {
  // Live Coach can never be both `visible:true` AND genuinely mid-session
  // at once (its onFabState reports visible:false the instant a session
  // opens — the auto-collapse tests above cover that). So a visible
  // liveCoach row is, definitionally, merely available — and per the
  // spec's own framing ("Voice session ACTIVE -> Coach occupies primary
  // slot", "Narration ONLY -> Compact Player"), actively playing audio
  // correctly still wins here.
  mockAudioCtx = playingAudio();
  const liveCoach = { visible: true, label: "Available", onOpen: jest.fn() };
  render(<ReadingHub eduTalk={null} liveCoach={liveCoach} />);

  expect(screen.getByTestId("reading-hub-compact-player")).toBeInTheDocument();
});

test("Narration Mode: does NOT engage when EduTalk has a genuinely ACTIVE session (isActive:true), even while audio plays — priority order wins on a true tie", () => {
  mockAudioCtx = playingAudio();
  const eduTalk = { visible: true, label: "Active 2/5", isActive: true, onOpen: jest.fn() };
  render(<ReadingHub eduTalk={eduTalk} liveCoach={null} />);

  expect(screen.queryByTestId("reading-hub-compact-player")).not.toBeInTheDocument();
  expect(screen.getByTestId("reading-hub-bubble").querySelector("svg.lucide-message-circle")).toBeInTheDocument();
});

test("Narration Mode: the compact toggle button calls toggle() directly without opening peek (event does not bubble to the pill's own onClick)", () => {
  const toggle = jest.fn();
  mockAudioCtx = playingAudio({ toggle });
  render(<ReadingHub eduTalk={null} liveCoach={null} />);

  fireEvent.click(screen.getByTestId("reading-hub-compact-toggle"));

  expect(toggle).toHaveBeenCalledTimes(1);
  // Did NOT also open peek — stopPropagation prevented the pill's own
  // handler from firing.
  expect(screen.queryByTestId("reading-hub-peek")).not.toBeInTheDocument();
});

test("Narration Mode: tapping the pill itself (not the toggle button) opens peek — Coach/EduTalk remain reachable in one tap", () => {
  mockAudioCtx = playingAudio();
  const eduTalk = { visible: true, label: "8 pts", isActive: false, onOpen: jest.fn() };
  render(<ReadingHub eduTalk={eduTalk} liveCoach={null} />);

  fireEvent.click(screen.getByTestId("reading-hub-compact-player"));

  expect(screen.getByTestId("reading-hub-peek")).toBeInTheDocument();
});

test("Narration Mode: shows elapsed time and a progress fill proportional to currentTime/duration", () => {
  mockAudioCtx = playingAudio({ currentTime: 101, duration: 202 });
  render(<ReadingHub eduTalk={null} liveCoach={null} />);

  expect(screen.getByText("1:41")).toBeInTheDocument();
  const fill = screen.getByTestId("reading-hub-compact-player").querySelector(".reading-hub__compact-progress-fill");
  expect(fill).toHaveStyle({ width: "50%" });
});

// ── Phase B — Edge Peek ──────────────────────────────────────────────────

test("Edge Peek: the plain docked bubble asks framer-motion to animate a non-zero x offset at rest (peeking past the dock edge)", () => {
  mockAudioCtx = pausedAudio();
  render(<ReadingHub eduTalk={null} liveCoach={null} />);
  const bubble = screen.getByTestId("reading-hub-bubble");
  // The mock surfaces the requested `animate.x` via a data attribute (see
  // the framer-motion mock above) — this proves ReadingHub is asking for
  // a peek offset, not that framer-motion renders it (a separate,
  // already-tested library).
  expect(Number(bubble.dataset.motionX)).not.toBe(0);
});

// Note: prefers-reduced-motion suppressing the peek offset
// (`prefersReducedMotion ? 0 : ...` in ReadingHub.jsx) is a trivial
// ternary verified by code review rather than a second isolated-module
// test here — re-mocking framer-motion's useReducedMotion mid-suite (via
// jest.resetModules/doMock) to flip just that one branch adds real
// fragility for a one-line condition already exercised at the "false"
// branch above.

test("Phase C audit fix: Hub renders nothing while the completion celebration (`celebrating`) is showing, even with audio/EduTalk/Live Coach available", () => {
  mockAudioCtx = playingAudio();
  const { container } = render(
    <ReadingHub
      eduTalk={{ visible: true, label: "EduTalk" }}
      liveCoach={{ visible: true, label: "Live Coach" }}
      celebrating
    />
  );
  expect(container).toBeEmptyDOMElement();
});

test("Phase C audit fix: Hub renders normally again once `celebrating` clears", () => {
  mockAudioCtx = pausedAudio();
  render(<ReadingHub eduTalk={null} liveCoach={null} celebrating={false} />);
  expect(screen.getByTestId("reading-hub-bubble")).toBeInTheDocument();
});

test("P2 audit fix: dragging to dock at the RIGHT edge actually sets a real right offset, not 'auto' (regression test for the computed-key bug)", () => {
  mockAudioCtx = pausedAudio();
  render(<ReadingHub eduTalk={null} liveCoach={null} />);
  const bubble = screen.getByTestId("reading-hub-bubble");
  act(() => { bubble.dispatchEvent(new CustomEvent("test:dragstart")); });
  act(() => { bubble.dispatchEvent(new CustomEvent("test:dragend", { detail: { point: { x: 900, y: 400 } } })); });
  const hub = screen.getByTestId("reading-hub");
  // jsdom's CSSOM (cssstyle) can't parse `auto` or CSS functions like
  // max()/env() for top/left/right/bottom at all — even a plain
  // `right: "auto"` string is silently dropped (verified directly against
  // jsdom's cssstyle package), so `.style.right`/`.style.left` are not a
  // reliable way to observe this in a test regardless of which side of the
  // bug is being checked. `data-dock-right`/`data-dock-left` mirror the
  // literal JS values ReadingHub computed (see ReadingHub.jsx) — this is
  // exactly the object-construction bug being regression-tested: the
  // computed `[pos.side]` key used to always get overwritten back to
  // "auto" by a trailing literal key, regardless of which side was picked.
  expect(hub.dataset.dockRight).not.toBe("auto");
  expect(hub.dataset.dockRight).toMatch(/env\(safe-area-inset-right\)/);
  expect(hub.dataset.dockLeft).toBe("auto");
});

test("P2 audit fix: dragging to dock at the LEFT edge actually sets a real left offset, not 'auto'", () => {
  mockAudioCtx = pausedAudio();
  render(<ReadingHub eduTalk={null} liveCoach={null} />);
  const bubble = screen.getByTestId("reading-hub-bubble");
  act(() => { bubble.dispatchEvent(new CustomEvent("test:dragstart")); });
  act(() => { bubble.dispatchEvent(new CustomEvent("test:dragend", { detail: { point: { x: 10, y: 400 } } })); });
  const hub = screen.getByTestId("reading-hub");
  // See the RIGHT-edge test above for why this reads `data-dock-*` rather
  // than `.style.left`/`.right` directly.
  expect(hub.dataset.dockLeft).not.toBe("auto");
  expect(hub.dataset.dockLeft).toMatch(/env\(safe-area-inset-left\)/);
  expect(hub.dataset.dockRight).toBe("auto");
});

test("P2 audit fix: opening peek moves focus onto the panel (docked bubble unmounts via AnimatePresence, which used to silently drop focus back to <body>)", () => {
  mockAudioCtx = pausedAudio();
  render(<ReadingHub eduTalk={null} liveCoach={null} />);
  fireEvent.click(screen.getByTestId("reading-hub-bubble"));
  expect(screen.getByTestId("reading-hub-peek")).toHaveFocus();
});

test("P2 audit fix: opening expanded moves focus onto the panel", () => {
  mockAudioCtx = pausedAudio();
  render(<ReadingHub eduTalk={null} liveCoach={null} />);
  fireEvent.click(screen.getByTestId("reading-hub-bubble"));
  fireEvent.click(screen.getByTestId("reading-hub-row-audio"));
  expect(screen.getByTestId("reading-hub-expanded")).toHaveFocus();
});

test("Escape key collapses an open peek panel back to docked (keyboard-nav gap found in P2 audit)", () => {
  mockAudioCtx = pausedAudio();
  render(<ReadingHub eduTalk={null} liveCoach={null} />);
  fireEvent.click(screen.getByTestId("reading-hub-bubble"));
  expect(screen.getByTestId("reading-hub-peek")).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByTestId("reading-hub-peek")).not.toBeInTheDocument();
  expect(screen.getByTestId("reading-hub-bubble")).toBeInTheDocument();
});

test("Escape key collapses an open expanded panel back to docked", () => {
  mockAudioCtx = pausedAudio();
  render(<ReadingHub eduTalk={null} liveCoach={null} />);
  fireEvent.click(screen.getByTestId("reading-hub-bubble"));
  fireEvent.click(screen.getByTestId("reading-hub-row-audio"));
  expect(screen.getByTestId("reading-hub-expanded")).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByTestId("reading-hub-expanded")).not.toBeInTheDocument();
});

describe("P2 — Progressive Discovery tooltip", () => {
  beforeEach(() => jest.useFakeTimers());

  test("shows once after a short delay for a first-time device, then auto-dismisses and remembers forever", () => {
    mockAudioCtx = pausedAudio();
    render(<ReadingHub eduTalk={null} liveCoach={null} />);
    expect(screen.queryByTestId("reading-hub-intro")).not.toBeInTheDocument();
    act(() => { jest.advanceTimersByTime(900); });
    expect(screen.getByTestId("reading-hub-intro")).toBeInTheDocument();
    act(() => { jest.advanceTimersByTime(6000); });
    expect(screen.queryByTestId("reading-hub-intro")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("eduhub_reading_hub_intro_seen")).toBe("1");
  });

  test("never shows again once localStorage already records it as seen", () => {
    window.localStorage.setItem("eduhub_reading_hub_intro_seen", "1");
    mockAudioCtx = pausedAudio();
    render(<ReadingHub eduTalk={null} liveCoach={null} />);
    act(() => { jest.advanceTimersByTime(5000); });
    expect(screen.queryByTestId("reading-hub-intro")).not.toBeInTheDocument();
  });

  test("tapping the bubble while the intro is showing dismisses it immediately and remembers the dismissal", () => {
    mockAudioCtx = pausedAudio();
    render(<ReadingHub eduTalk={null} liveCoach={null} />);
    act(() => { jest.advanceTimersByTime(900); });
    expect(screen.getByTestId("reading-hub-intro")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("reading-hub-bubble"));
    expect(screen.queryByTestId("reading-hub-intro")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("eduhub_reading_hub_intro_seen")).toBe("1");
  });
});

test("P2 — Identity: a static sparkle identity mark shows at true idle, and disappears once the module becomes active", () => {
  mockAudioCtx = pausedAudio();
  const { rerender } = render(<ReadingHub eduTalk={null} liveCoach={null} />);
  expect(screen.getByTestId("reading-hub-identity-mark")).toBeInTheDocument();
  mockAudioCtx = playingAudio();
  rerender(<ReadingHub eduTalk={null} liveCoach={null} />);
  // Now in Narration Mode (compact player), not the plain bubble — the
  // identity mark only ever renders on the idle plain-bubble variant.
  expect(screen.queryByTestId("reading-hub-identity-mark")).not.toBeInTheDocument();
});
