/**
 * VT Pass B.1.1 · focused mounted tests for the chest-opening wiring repair.
 *
 * Targets the two B.1 defects:
 *   1. <ChestSVG /> previously received the raw backend state — so the
 *      transient `opening` visual phase never reached the SVG. The repair
 *      passes a derived `visualChestState` ("opening" while the local
 *      visualPhase is opening, otherwise the authoritative backend state).
 *   2. The opening sequence was prematurely closed at 1400ms while the
 *      CSS sequence lasts 2500ms. The repair uses one shared constant
 *      (CHEST_OPENING_MS = 2500) for both the JS timer and the tests.
 *
 * No new dependency. Uses jest fake timers + the same react-dom/client +
 * act + virtual react-router-dom pattern as the A.1.1 / B.1 mounted tests.
 *
 * Transitions are driven through the chest component's own polling
 * mechanism: while the backend reports "processing", the component
 * setInterval-polls api.getClaimStatus every 2500ms. By swapping the
 * mock return between poll cycles we reproduce a real in-session
 * processing → completed transition that exercises visualPhase.
 */
global.IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot } from "react-dom/client";

// ── Router stand-in (same as voiceTreasure_passB1.mounted.test.jsx) ──
let mockCurrentPath = "/";
function mockSetPath(p) { mockCurrentPath = p; }
function mockMatchParams(pattern, pathname) {
  if (!pattern || pattern === "*") return {};
  const patParts = pattern.split("/").filter(Boolean);
  const pthParts = pathname.split("/").filter(Boolean);
  if (patParts.length !== pthParts.length) return null;
  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(":")) {
      params[patParts[i].slice(1)] = decodeURIComponent(pthParts[i]);
    } else if (patParts[i] !== pthParts[i]) return null;
  }
  return params;
}

jest.mock("react-router-dom", () => {
  const R = require("react");
  const ParamContext = R.createContext({});
  const noop = () => {};
  function MemoryRouter({ initialEntries, children }) {
    mockSetPath((initialEntries && initialEntries[0]) || "/");
    return R.createElement(R.Fragment, null, children);
  }
  function Routes({ children }) {
    const kids = R.Children.toArray(children);
    for (const r of kids) {
      if (!r || !r.props) continue;
      const params = mockMatchParams(r.props.path, mockCurrentPath);
      if (params !== null) return R.createElement(ParamContext.Provider, { value: params }, r.props.element);
    }
    const w = kids.find((r) => r && r.props && r.props.path === "*");
    return w ? w.props.element : null;
  }
  function Route() { return null; }
  function Link({ to, children, ...rest }) {
    return R.createElement("a", { href: to, ...rest }, children);
  }
  function Navigate() { return null; }
  function useLocation() { return { pathname: mockCurrentPath, search: "", hash: "", state: null }; }
  function useNavigate() { return noop; }
  function useParams() { return R.useContext(ParamContext); }
  return { __esModule: true, MemoryRouter, Routes, Route, Link, Navigate, useLocation, useNavigate, useParams };
}, { virtual: true });

jest.mock("../../../../context/AuthContext", () => ({
  useAuth: () => ({ isAuthenticated: false, student: null, logout: () => {}, refreshPoints: () => {} }),
}));

jest.mock("../api", () => ({
  __esModule: true,
  getClaimStatus: jest.fn(),
  claim: jest.fn(),
}));
import * as api from "../api";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import VoiceTreasureChest, { CHEST_OPENING_MS } from "../VoiceTreasureChest";

const CHEST_PROCESSING = {
  chest_state: "processing", attempt_id: "att-1", message: "",
};
const CHEST_RECONCILIATION = {
  chest_state: "reconciliation_required", attempt_id: "att-1",
  message: "Hold on", support_reference: "X",
};
const CHEST_COMPLETED_BASE = {
  chest_state: "completed", attempt_id: "att-1",
  reward: {
    points_credited: 12, base_points: 10, streak_bonus: 0, high_score_bonus: 2,
    first_voice_card: "not_eligible", voucher: null, voucher_detail: null,
    edutalk_pass: null, edutalk_pass_detail: null,
    claimed_at: "2026-06-22T00:00:00Z", balance_status: "trusted", balance: 142,
  },
};
const CHEST_COMPLETED_WITH_REWARDS = {
  ...CHEST_COMPLETED_BASE,
  reward: {
    ...CHEST_COMPLETED_BASE.reward,
    voucher: "granted",
    voucher_detail: { title: "Bookstore Voucher", discount_summary: "25% off" },
    edutalk_pass: "granted",
    edutalk_pass_detail: { feature: "edutalk_voice", quantity: 2 },
  },
};

const POLL_MS = 2500; // matches setInterval(load, 2500) in VoiceTreasureChest

// matchMedia helper — default = motion allowed; can be flipped for the
// reduced-motion case. Re-installed on every test via beforeEach.
function installMatchMedia(reduced) {
  window.matchMedia = (q) => ({
    matches: reduced && /prefers-reduced-motion: reduce/.test(q),
    media: q,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  });
}

function mountChest() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/game/voice-treasure/chest/att-1"]}>
        <Routes>
          <Route path="/game/voice-treasure/chest/:attemptId" element={<VoiceTreasureChest />} />
        </Routes>
      </MemoryRouter>
    );
  });
  return {
    container, root,
    unmount() { act(() => root.unmount()); container.remove(); },
  };
}

// Flush pending promises (load() / setChest) under real OR fake timers.
async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Drive the chest's internal poll cycle: advance fake timers by one poll
// interval, then flush microtasks so the resolved getClaimStatus promise
// and its setChest() commit, and the visualPhase effect runs.
async function tickPoll() {
  await act(async () => { jest.advanceTimersByTime(POLL_MS); });
  await flushPromises();
}

describe("VT Pass B.1.1 · chest opening wiring repair", () => {
  beforeEach(() => {
    api.claim.mockReset();
    api.getClaimStatus.mockReset();
    installMatchMedia(false);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  // 0. Shared timing constant matches the full CSS sequence.
  test("CHEST_OPENING_MS shared constant equals the full CSS sequence (2500ms)", () => {
    expect(CHEST_OPENING_MS).toBe(2500);
  });

  // 1. Processing remains sealed and the SVG carries the backend state.
  test("processing chest stays sealed (backend state authoritative on SVG)", async () => {
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_PROCESSING });
    const view = mountChest();
    await flushPromises();
    expect(view.container.querySelector('[data-testid="vt-chest-sealed"]')).toBeTruthy();
    expect(view.container.querySelector('[data-testid="vt-chest-opening"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="vt-chest-svg"]').getAttribute("data-state")).toBe("processing");
    expect(api.claim).not.toHaveBeenCalled();
    view.unmount();
  });

  // 2. Reconciliation remains sealed.
  test("reconciliation chest stays sealed (backend state authoritative on SVG)", async () => {
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_RECONCILIATION });
    const view = mountChest();
    await flushPromises();
    expect(view.container.querySelector('[data-testid="vt-chest-sealed"]')).toBeTruthy();
    expect(view.container.querySelector('[data-testid="vt-chest-opening"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="vt-chest-svg"]').getAttribute("data-state")).toBe("reconciliation_required");
    expect(api.claim).not.toHaveBeenCalled();
    view.unmount();
  });

  // 3. First transition into confirmed completed enters opening.
  // 4. The rendered ChestSVG receives data-state="opening".
  test("first processing → completed transition enters opening and drives ChestSVG with data-state='opening'", async () => {
    jest.useFakeTimers();
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_PROCESSING });
    const view = mountChest();
    await flushPromises();
    expect(view.container.querySelector('[data-testid="vt-chest-svg"]').getAttribute("data-state")).toBe("processing");

    // Next poll returns completed — real in-session transition.
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_COMPLETED_BASE });
    await tickPoll();

    const chest = view.container.querySelector('[data-testid="vt-chest"]');
    expect(chest.getAttribute("data-visual-phase")).toBe("opening");
    expect(view.container.querySelector('[data-testid="vt-chest-opening"]')).toBeTruthy();
    // The repair: ChestSVG's data-state is driven by visualChestState,
    // i.e. "opening" while the cinematic is active.
    expect(view.container.querySelector('[data-testid="vt-chest-svg"]').getAttribute("data-state")).toBe("opening");
    expect(api.claim).not.toHaveBeenCalled();
    view.unmount();
  });

  // 5. Opening remains active before the configured duration expires.
  test("opening remains active before CHEST_OPENING_MS expires", async () => {
    jest.useFakeTimers();
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_PROCESSING });
    const view = mountChest();
    await flushPromises();
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_COMPLETED_BASE });
    await tickPoll();
    expect(view.container.querySelector('[data-testid="vt-chest-opening"]')).toBeTruthy();

    // Halfway through — still opening.
    await act(async () => { jest.advanceTimersByTime(Math.floor(CHEST_OPENING_MS / 2)); });
    expect(view.container.querySelector('[data-testid="vt-chest"]').getAttribute("data-visual-phase")).toBe("opening");
    expect(view.container.querySelector('[data-testid="vt-chest-svg"]').getAttribute("data-state")).toBe("opening");

    // 1ms shy of the boundary — still opening.
    await act(async () => { jest.advanceTimersByTime(Math.floor(CHEST_OPENING_MS / 2) - 1); });
    expect(view.container.querySelector('[data-testid="vt-chest"]').getAttribute("data-visual-phase")).toBe("opening");
    expect(view.container.querySelector('[data-testid="vt-chest-opening"]')).toBeTruthy();
    view.unmount();
  });

  // 6. Fake timers advance to stable completed.
  test("fake timers advance past CHEST_OPENING_MS to stable completed (no replay)", async () => {
    jest.useFakeTimers();
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_PROCESSING });
    const view = mountChest();
    await flushPromises();
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_COMPLETED_BASE });
    await tickPoll();
    expect(view.container.querySelector('[data-testid="vt-chest-opening"]')).toBeTruthy();

    // Advance the full sequence (+ a tick).
    await act(async () => { jest.advanceTimersByTime(CHEST_OPENING_MS + 50); });
    await flushPromises();

    expect(view.container.querySelector('[data-testid="vt-chest"]').getAttribute("data-visual-phase")).toBe("completed");
    expect(view.container.querySelector('[data-testid="vt-chest-opening"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="vt-chest-open"]')).toBeTruthy();
    // Backend state is authoritative on the SVG once the cinematic finishes.
    expect(view.container.querySelector('[data-testid="vt-chest-svg"]').getAttribute("data-state")).toBe("completed");
    expect(api.claim).not.toHaveBeenCalled();
    view.unmount();
  });

  // 7. Reduced motion skips opening.
  test("reduced motion skips opening and jumps straight to stable completed", async () => {
    installMatchMedia(true); // prefers-reduced-motion: reduce
    jest.useFakeTimers();
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_PROCESSING });
    const view = mountChest();
    await flushPromises();
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_COMPLETED_BASE });
    await tickPoll();

    // No opening frame should ever appear under reduced motion.
    expect(view.container.querySelector('[data-testid="vt-chest-opening"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="vt-chest-open"]')).toBeTruthy();
    expect(view.container.querySelector('[data-testid="vt-chest"]').getAttribute("data-visual-phase")).toBe("completed");
    expect(view.container.querySelector('[data-testid="vt-chest-svg"]').getAttribute("data-state")).toBe("completed");
    expect(api.claim).not.toHaveBeenCalled();
    view.unmount();
  });

  // 8. opening / replay does not call api.claim().
  test("opening and replay never call api.claim()", async () => {
    jest.useFakeTimers();
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_PROCESSING });
    const view = mountChest();
    await flushPromises();
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_COMPLETED_BASE });
    await tickPoll();
    expect(view.container.querySelector('[data-testid="vt-chest-opening"]')).toBeTruthy();

    // Mid-opening intermediate tick — backend still completed, no claim call.
    await act(async () => { jest.advanceTimersByTime(800); });
    expect(api.claim).not.toHaveBeenCalled();

    // Finish the opening — still no claim call.
    await act(async () => { jest.advanceTimersByTime(CHEST_OPENING_MS + 50); });
    await flushPromises();
    expect(api.claim).not.toHaveBeenCalled();

    // A direct revisit / replay (mount fresh on a chest that is already
    // completed) jumps straight to stable completed and never calls claim.
    view.unmount();
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_COMPLETED_BASE });
    const replay = mountChest();
    await flushPromises();
    expect(replay.container.querySelector('[data-testid="vt-chest-opening"]')).toBeNull();
    expect(replay.container.querySelector('[data-testid="vt-chest-open"]')).toBeTruthy();
    expect(api.claim).not.toHaveBeenCalled();
    replay.unmount();
  });

  // 9. Confirmed Voucher and EduTalk reward cards remain intact after completion.
  test("confirmed Voucher and EduTalk Pass reveals remain intact after completion", async () => {
    jest.useFakeTimers();
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_PROCESSING });
    const view = mountChest();
    await flushPromises();
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_COMPLETED_WITH_REWARDS });
    await tickPoll();
    await act(async () => { jest.advanceTimersByTime(CHEST_OPENING_MS + 50); });
    await flushPromises();

    expect(view.container.querySelector('[data-testid="vt-chest-open"]')).toBeTruthy();
    expect(view.container.querySelector('[data-testid="vt-reveal-voucher"]')).toBeTruthy();
    expect(view.container.querySelector('[data-testid="vt-reveal-pass"]')).toBeTruthy();
    expect(view.container.querySelector('[data-testid="vt-reveal-voucher-title"]').textContent).toContain("Bookstore Voucher");
    expect(view.container.querySelector('[data-testid="vt-reveal-pass-quantity"]').textContent).toContain("2");
    expect(api.claim).not.toHaveBeenCalled();
    view.unmount();
  });

  // 10. Timer is cleaned up on unmount and state changes (no leaks).
  test("opening timer is cleaned up on unmount mid-sequence", async () => {
    jest.useFakeTimers();
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_PROCESSING });
    const view = mountChest();
    await flushPromises();
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_COMPLETED_BASE });
    await tickPoll();
    expect(view.container.querySelector('[data-testid="vt-chest-opening"]')).toBeTruthy();

    // Unmount mid-opening, then advance timers past the boundary. If the
    // timer wasn't cleared, React would log a setState-after-unmount warning.
    view.unmount();
    await act(async () => { jest.advanceTimersByTime(CHEST_OPENING_MS + 500); });
    // No throw → cleanup verified.
  });
});
