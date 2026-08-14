/**
 * VT Pass B.1 · mounted component tests for the Visual Foundation.
 *
 * Uses React 19's `act` + `react-dom/client` directly (the same pattern as
 * the A.1.1 mounted tests). No new dependency. A minimal virtual mock for
 * react-router-dom is provided so the dashboard / chest can render under
 * jsdom without needing the ESM-only router resolver.
 */
global.IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot } from "react-dom/client";

// ── Router stand-in (same pattern as voiceTreasure_passA1.mounted.test.jsx) ──
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
  getToday: jest.fn(),
  getConfigPublic: jest.fn(),
  getProgress: jest.fn(),
  getClaimStatus: jest.fn(),
  claim: jest.fn(),
  submitAttempt: jest.fn(),
  getAttempt: jest.fn(),
}));
import * as api from "../api";

import { MemoryRouter, Routes, Route } from "react-router-dom";
import VTStage from "../VTStage";
import VoiceTreasureDashboard from "../VoiceTreasureDashboard";
import VoiceTreasureChest from "../VoiceTreasureChest";

function mount(path, ui) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    );
  });
  return { container, root, unmount() { act(() => root.unmount()); container.remove(); } };
}

function mountChest(path, statusPayload, secondPayload) {
  api.getClaimStatus.mockReset();
  api.getClaimStatus.mockResolvedValueOnce(statusPayload);
  if (secondPayload) api.getClaimStatus.mockResolvedValueOnce(secondPayload);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/game/voice-treasure/chest/:attemptId" element={<VoiceTreasureChest />} />
        </Routes>
      </MemoryRouter>
    );
  });
  return { container, root, unmount() { act(() => root.unmount()); container.remove(); } };
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

// ────────────────────────────────────────────────────────────────────────────
// 1. VTStage renders all required layers
// ────────────────────────────────────────────────────────────────────────────
describe("VT Pass B.1 · VTStage layers", () => {
  test("renders backdrop + frame + glass + decor", () => {
    const { container, unmount } = mount("/", <VTStage>hello</VTStage>);
    expect(container.querySelector('[data-testid="vts-stage"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vts-backdrop"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vts-frame"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vts-glass"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vts-decor"]')).toBeTruthy();
    expect(container.textContent).toContain("hello");
    unmount();
  });

  test("renders the scene/hero artwork layer when sceneImage is provided", () => {
    const { container, unmount } = mount("/", <VTStage sceneImage="/test-scene.webp" sceneAlt="Test scene" />);
    const sceneImg = container.querySelector('[data-testid="vts-scene-img"]');
    expect(sceneImg).toBeTruthy();
    expect(sceneImg.getAttribute("src")).toBe("/test-scene.webp");
    expect(sceneImg.getAttribute("alt")).toBe("Test scene");
    expect(container.querySelector('[data-testid="vts-scrim"]')).toBeTruthy();
    unmount();
  });

  test("skips the scene layer when no sceneImage is provided", () => {
    const { container, unmount } = mount("/", <VTStage />);
    expect(container.querySelector('[data-testid="vts-scene"]')).toBeNull();
    expect(container.querySelector('[data-testid="vts-scene-img"]')).toBeNull();
    unmount();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Dashboard immersive reconstruction
// ────────────────────────────────────────────────────────────────────────────
describe("VT Pass B.1 · Dashboard", () => {
  beforeEach(() => {
    api.getToday.mockReset();
    api.getConfigPublic.mockReset();
    api.getProgress.mockReset();
  });

  test("renders authoritative Points balance + scene art + Lucide streak icon", async () => {
    api.getToday.mockResolvedValueOnce({
      available: true,
      student: { display_name: "Bopha" },
      balance: { points: 1234 },
      entry: { entry_cost_points: 5 },
      mission: {
        title: "Birthday Party",
        prompt: "Describe the birthday party.",
        difficulty: "beginner",
        image_kind: "bundled",
        image_ref: "vt-scene-birthday",
      },
      limits: { limit_reached: false },
    });
    api.getConfigPublic.mockResolvedValueOnce({
      effective: { master_points_reward_enabled: true },
      config: { rewards: { points_reward_enabled: true, base_points_reward: 5, maximum_points_reward: 50, first_voice_card_enabled: true } },
    });
    api.getProgress.mockResolvedValueOnce({
      streak_days: 3, missions_completed: 7, longest_streak: 5, collection_count: 2,
    });

    const { container, unmount } = mount("/game/voice-treasure", <VoiceTreasureDashboard />);
    await flush(); await flush();

    expect(container.querySelector('[data-testid="vts-stage"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-balance-points"]').textContent).toContain("1,234 pts");
    expect(container.querySelector('[data-testid="vt-student-name"]').textContent).toContain("Bopha");
    expect(container.querySelector('[data-testid="vt-hero-title"]').textContent).toContain("Birthday Party");
    // Bundled scene resolved to a real imported asset → scene layer renders.
    expect(container.querySelector('[data-testid="vts-scene-img"]')).toBeTruthy();
    // Streak chip uses the Lucide flame icon (data-testid pin), not 🔥.
    expect(container.querySelector('[data-testid="vt-streak-icon"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-streak"]').textContent).not.toContain("🔥");
    unmount();
  });

  test("does NOT show fake currencies anywhere", async () => {
    api.getToday.mockResolvedValueOnce({
      available: true,
      student: { display_name: "Sok" },
      balance: { points: 0 },
      entry: { entry_cost_points: 5 },
      mission: { title: "Today's Mission", prompt: "Tell us." },
      limits: { limit_reached: false },
    });
    api.getConfigPublic.mockResolvedValueOnce(null);
    api.getProgress.mockResolvedValueOnce(null);

    const { container, unmount } = mount("/game/voice-treasure", <VoiceTreasureDashboard />);
    await flush(); await flush();

    const text = container.textContent.toLowerCase();
    // Never invent these currencies / surfaces.
    for (const banned of ["gem", "diamond", "shop", "season pass", "skin", "title", "boost", "loot"]) {
      expect(text.includes(banned)).toBe(false);
    }
    unmount();
  });

  test("primary emoji placeholders are absent (no 🔥 / 🃏 in source-visible text)", async () => {
    api.getToday.mockResolvedValueOnce({
      available: true,
      student: { display_name: "X" },
      balance: { points: 10 },
      entry: { entry_cost_points: 0 },
      mission: { title: "M", prompt: "P" },
      limits: { limit_reached: false },
    });
    api.getConfigPublic.mockResolvedValueOnce(null);
    api.getProgress.mockResolvedValueOnce({ streak_days: 5 });

    const { container, unmount } = mount("/game/voice-treasure", <VoiceTreasureDashboard />);
    await flush(); await flush();
    expect(container.textContent).not.toMatch(/🔥/);
    expect(container.textContent).not.toMatch(/🃏/);
    unmount();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Chest transient opening phase
// ────────────────────────────────────────────────────────────────────────────
const CHEST_PROCESSING = {
  chest_state: "processing", attempt_id: "att-1", message: "",
};
const CHEST_RECONCILIATION = {
  chest_state: "reconciliation_required", attempt_id: "att-1", message: "Hold on", support_reference: "X",
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

describe("VT Pass B.1 · chest state behavior", () => {
  beforeEach(() => { api.claim.mockReset(); });

  test("processing chest stays sealed", async () => {
    const { container, unmount } = mountChest("/game/voice-treasure/chest/att-1", { chest: CHEST_PROCESSING });
    await flush();
    expect(container.querySelector('[data-testid="vt-chest-sealed"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-chest-opening"]')).toBeNull();
    expect(container.querySelector('[data-testid="vt-chest-open"]')).toBeNull();
    expect(api.claim).not.toHaveBeenCalled();
    unmount();
  });

  test("reconciliation chest stays sealed", async () => {
    const { container, unmount } = mountChest("/game/voice-treasure/chest/att-1", { chest: CHEST_RECONCILIATION });
    await flush();
    expect(container.querySelector('[data-testid="vt-chest-sealed"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-chest-opening"]')).toBeNull();
    expect(container.querySelector('[data-testid="vt-chest-open"]')).toBeNull();
    expect(api.claim).not.toHaveBeenCalled();
    unmount();
  });

  test("direct visit to a chest already completed jumps to stable completed (no opening replay)", async () => {
    const { container, unmount } = mountChest("/game/voice-treasure/chest/att-1", { chest: CHEST_COMPLETED_BASE });
    await flush();
    expect(container.querySelector('[data-testid="vt-chest-open"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-chest-opening"]')).toBeNull();
    expect(api.claim).not.toHaveBeenCalled();
    unmount();
  });

  test("animation / opening phase never calls api.claim()", async () => {
    // Mount in processing, then re-render with completed.
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    api.getClaimStatus.mockReset();
    api.getClaimStatus.mockResolvedValue({ chest: CHEST_PROCESSING });
    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/game/voice-treasure/chest/att-1"]}>
          <Routes>
            <Route path="/game/voice-treasure/chest/:attemptId" element={<VoiceTreasureChest />} />
          </Routes>
        </MemoryRouter>
      );
    });
    await flush();
    // Replay re-render — animation idempotent.
    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/game/voice-treasure/chest/att-1"]}>
          <Routes>
            <Route path="/game/voice-treasure/chest/:attemptId" element={<VoiceTreasureChest />} />
          </Routes>
        </MemoryRouter>
      );
    });
    await flush();
    expect(api.claim).not.toHaveBeenCalled();
    act(() => root.unmount()); container.remove();
  });

  test("confirmed Voucher/EduTalk reveal still works after opening (A.1.1 invariant)", async () => {
    const completedPayload = {
      chest: {
        ...CHEST_COMPLETED_BASE,
        reward: {
          ...CHEST_COMPLETED_BASE.reward,
          voucher: "granted",
          voucher_detail: { title: "Bookstore Voucher", discount_summary: "25% off" },
          edutalk_pass: "granted",
          edutalk_pass_detail: { feature: "edutalk_voice", quantity: 2 },
        },
      },
    };
    const { container, unmount } = mountChest("/game/voice-treasure/chest/att-1", completedPayload);
    await flush();
    expect(container.querySelector('[data-testid="vt-reveal-voucher"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-reveal-pass"]')).toBeTruthy();
    expect(api.claim).not.toHaveBeenCalled();
    unmount();
  });
});
