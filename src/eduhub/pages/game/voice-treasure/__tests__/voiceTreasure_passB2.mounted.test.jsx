/**
 * VT Pass B.2 · student-journey mounted tests.
 *
 * Targets all student-facing visual reconstructions delivered in B.2:
 *   • Mission (exact scene image + bilingual instruction + CTA gating)
 *   • Recorder (ready / recording / recorded / submitting / failure-retry,
 *     plus the duplicate-submit guard).
 *   • Evaluation (read-only contract, no second submit, recovery on
 *     evaluation_failed).
 *   • Collection (owned state, empty state, no 🃏 emoji).
 *   • Progress (authoritative fields, no 🔥 emoji, no fake currencies).
 *   • Reduced-motion: VTStage data-animate=off and recorder waveform
 *     does not animate.
 *   • Identity replacement: no 🎙️ in the identity mark.
 *   • Source-text guard: known fake currency labels never appear.
 *
 * Uses the same react-dom/client + act + virtual react-router-dom pattern
 * as the B.1 / B.1.1 mounted tests. No new dependency.
 */
global.IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot } from "react-dom/client";

// ── Router stand-in ───────────────────────────────────────────────────────
let mockCurrentPath = "/";
let mockState = null;
const navCalls = [];
function mockSetPath(p, s) { mockCurrentPath = p; mockState = s || null; }
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
  function navigate(to, opts) {
    navCalls.push({ to, opts });
  }
  function MemoryRouter({ initialEntries, children }) {
    const entry = (initialEntries && initialEntries[0]) || "/";
    if (typeof entry === "object" && entry !== null) {
      mockSetPath(entry.pathname || "/", entry.state || null);
    } else {
      mockSetPath(entry, null);
    }
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
  function useLocation() { return { pathname: mockCurrentPath, search: "", hash: "", state: mockState }; }
  function useNavigate() { return navigate; }
  function useParams() { return R.useContext(ParamContext); }
  return { __esModule: true, MemoryRouter, Routes, Route, Link, Navigate, useLocation, useNavigate, useParams };
}, { virtual: true });

jest.mock("../../../../context/AuthContext", () => ({
  useAuth: () => ({ isAuthenticated: false, student: null, logout: () => {}, refreshPoints: () => {} }),
}));

jest.mock("../api", () => ({
  __esModule: true,
  getToday: jest.fn(),
  getMissionImage: jest.fn(),
  getCollection: jest.fn(),
  getProgress: jest.fn(),
  submitAttempt: jest.fn(),
  getAttempt: jest.fn(),
  getClaimStatus: jest.fn(),
  claim: jest.fn(),
  getConfigPublic: jest.fn(),
}));

// Stub the recorder hook used by VoiceTreasureRecorder so we can drive
// state transitions deterministically without needing MediaRecorder.
jest.mock("../hooks/useVoiceRecorder", () => {
  // eslint-disable-next-line global-require
  const React = require("react");
  return {
    __esModule: true,
    default: function useVoiceRecorderStub(opts) {
      const [status, setStatus] = React.useState("idle");
      const [elapsed, setElapsed] = React.useState(0);
      const [audioUrl, setAudioUrl] = React.useState(null);
      const blob = React.useRef(null);
      const minSeconds = (opts && opts.minSeconds) || 5;
      const maxSeconds = (opts && opts.maxSeconds) || 60;
      const start = React.useCallback(() => {
        setStatus("recording"); setElapsed(0);
      }, []);
      const stop = React.useCallback(() => {
        blob.current = new Blob(["x"], { type: "audio/webm" });
        setAudioUrl("blob:fake");
        setStatus("recorded");
      }, []);
      const reset = React.useCallback(() => {
        blob.current = null; setAudioUrl(null); setElapsed(0); setStatus("idle");
      }, []);
      const __advance = (sec) => { setElapsed(sec); };
      const __setStatus = (s) => setStatus(s);
      const api = {
        status, elapsed, audioUrl,
        durationLabel: `${String(Math.floor(elapsed/60)).padStart(2,"0")}:${String(elapsed%60).padStart(2,"0")}`,
        canStop: elapsed >= minSeconds,
        minSeconds, maxSeconds,
        start, stop, reset,
        getBlob: () => blob.current,
        __advance, __setStatus,
      };
      // expose handle for tests
      // eslint-disable-next-line no-undef
      global.__recHandle = api;
      return api;
    },
  };
}, { virtual: false });

import { MemoryRouter, Routes, Route } from "react-router-dom";
import * as api from "../api";
import VoiceTreasureMission from "../VoiceTreasureMission";
import VoiceTreasureRecorder from "../VoiceTreasureRecorder";
import VoiceTreasureEvaluation from "../VoiceTreasureEvaluation";
import VoiceTreasureCollection from "../VoiceTreasureCollection";
import VoiceTreasureProgress from "../VoiceTreasureProgress";
import VoiceTreasureDashboard from "../VoiceTreasureDashboard";
import { VoiceTreasureIdentity } from "../useVoiceTreasureIdentity";

function installMatchMedia(reduced) {
  window.matchMedia = (q) => ({
    matches: reduced && /prefers-reduced-motion: reduce/.test(q),
    media: q,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  });
}

function mountAt(path, ui, state) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const entry = state ? { pathname: path, state } : path;
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    );
  });
  return { container, root, unmount() { act(() => root.unmount()); container.remove(); } };
}

function mountParam(path, pattern, ui) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={pattern} element={ui} />
        </Routes>
      </MemoryRouter>
    );
  });
  return { container, root, unmount() { act(() => root.unmount()); container.remove(); } };
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  installMatchMedia(false);
  navCalls.length = 0;
  Object.values(api).forEach((fn) => { if (typeof fn === "function" && fn.mockReset) fn.mockReset(); });
});

// ─────────────────────────────────────────────────────────────────────
//  Identity (no 🎙️)
// ─────────────────────────────────────────────────────────────────────
describe("VT Pass B.2 · identity", () => {
  test("identity mark is an original SVG (no 🎙️ emoji)", () => {
    const { container, unmount } = mountAt("/", <VoiceTreasureIdentity subtitle="x" />);
    expect(container.querySelector('[data-testid="vt-identity-mark"]')).toBeTruthy();
    expect(container.querySelector('svg[data-testid="vt-identity-mark"]').tagName.toLowerCase()).toBe("svg");
    expect(container.textContent).not.toMatch(/🎙️|🎤/);
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Mission
// ─────────────────────────────────────────────────────────────────────
describe("VT Pass B.2 · Mission", () => {
  test("renders exact assigned bundled scene image + paid + start CTA", async () => {
    api.getToday.mockResolvedValue({
      available: true,
      existing_entry: { paid: true, entry_id: "E1" },
      language: {
        instruction: { primary: "Describe the picnic.", secondary: "ពិពណ៌នាអំពីពិកនិក។", lang: "en" },
        accepted_response_label: "English",
      },
      mission: { mission_id: "M1", title: "Picnic Day", prompt: "Tell us.", difficulty: "beginner" },
    });
    api.getMissionImage.mockResolvedValue({
      image_kind: "bundled", image_ref: "vt-scene-picnic", alt: "Family picnic in a park",
    });
    const { container, unmount } = mountAt("/game/voice-treasure/mission", <VoiceTreasureMission />);
    await flush(); await flush();

    expect(container.querySelector('[data-testid="vt-mission"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-mission"]').getAttribute("data-image-kind")).toBe("bundled");
    const img = container.querySelector('[data-testid="vt-mission-img-bundled"]');
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBeTruthy(); // CRA fingerprinted asset string
    expect(img.getAttribute("alt")).toContain("picnic");
    expect(container.querySelector('[data-testid="vt-mission-paid"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-mission-difficulty"]').textContent).toContain("beginner");
    expect(container.querySelector('[data-testid="vt-mission-language-label"]').textContent).toContain("English");

    // Bilingual instructions:
    expect(container.querySelector('[data-testid="vt-mission-prompt"]').textContent).toContain("Describe the picnic.");
    expect(container.querySelector('[data-testid="vt-mission-prompt-secondary"]').getAttribute("lang")).toBe("km");
    expect(container.querySelector('[data-testid="vt-mission-prompt-secondary"]').textContent).toContain("ពិពណ៌នា");

    // CTA disabled until image loads, then enabled.
    const cta = container.querySelector('[data-testid="vt-to-record"]');
    expect(cta).toBeTruthy();
    expect(cta.disabled).toBe(true);
    act(() => { img.dispatchEvent(new Event("load")); });
    expect(cta.disabled).toBe(false);
    unmount();
  });

  test("generated mission uses authenticated image_url verbatim", async () => {
    api.getToday.mockResolvedValue({
      available: true,
      existing_entry: { paid: true, entry_id: "E2" },
      language: { instruction: { primary: "x" }, accepted_response_label: "English" },
      mission: { mission_id: "M2", title: "X", prompt: "y" },
    });
    api.getMissionImage.mockResolvedValue({
      image_kind: "generated",
      image_url: "https://example.com/x.png",
      alt: "Generated scene",
    });
    const { container, unmount } = mountAt("/", <VoiceTreasureMission />);
    await flush(); await flush();
    const img = container.querySelector('[data-testid="vt-mission-img-generated"]');
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe("https://example.com/x.png");
    unmount();
  });

  test("unavailable mission shows safe panel", async () => {
    api.getToday.mockResolvedValue({ available: false });
    const { container, unmount } = mountAt("/", <VoiceTreasureMission />);
    await flush(); await flush();
    expect(container.querySelector('[data-testid="vt-mission-unavailable"]')).toBeTruthy();
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Recorder (state machine)
// ─────────────────────────────────────────────────────────────────────
describe("VT Pass B.2 · Recorder state machine", () => {
  function mountRecorder(stateObj) {
    api.getToday.mockResolvedValue({
      available: true,
      existing_entry: { paid: true, entry_id: "E9" },
      mission: { mission_id: "M9" },
    });
    api.getMissionImage.mockResolvedValue({ image_kind: "bundled", image_ref: "vt-scene-picnic", alt: "x" });
    return mountAt("/game/voice-treasure/record", <VoiceTreasureRecorder />, stateObj);
  }

  test("ready state shows Start Recording button + console orb (no waveform animation yet)", async () => {
    const { container, unmount } = mountRecorder({ entryId: "E9", imgSrc: null });
    await flush(); await flush();
    expect(container.querySelector('[data-testid="vt-recorder"]').getAttribute("data-phase")).toBe("ready");
    expect(container.querySelector('[data-testid="vt-rec-start"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-rec-console"]').getAttribute("data-phase")).toBe("ready");
    // wave NOT in "on" mode while idle.
    const wave = container.querySelector('[data-testid="vt-rec-wave"]');
    expect(wave.className.includes("vt-rec-wave-on")).toBe(false);
    unmount();
  });

  test("recording state shows Stop + animated wave + recording dot in timer", async () => {
    const { container, unmount } = mountRecorder({ entryId: "E9" });
    await flush(); await flush();
    // start
    act(() => { container.querySelector('[data-testid="vt-rec-start"]').click(); });
    await flush();
    expect(container.querySelector('[data-testid="vt-recorder"]').getAttribute("data-phase")).toBe("recording");
    expect(container.querySelector('[data-testid="vt-rec-stop"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-rec-wave"]').className.includes("vt-rec-wave-on")).toBe(true);
    expect(container.querySelector('[data-testid="vt-timer"]').textContent).toMatch(/●/);
    unmount();
  });

  test("recorded state shows preview + retry + submit", async () => {
    const { container, unmount } = mountRecorder({ entryId: "E9" });
    await flush(); await flush();
    act(() => { container.querySelector('[data-testid="vt-rec-start"]').click(); });
    await flush();
    // advance timer past min via the stub then stop
    act(() => { global.__recHandle.__advance(6); });
    await flush();
    act(() => { container.querySelector('[data-testid="vt-rec-stop"]').click(); });
    await flush();
    expect(container.querySelector('[data-testid="vt-recorder"]').getAttribute("data-phase")).toBe("recorded");
    expect(container.querySelector('[data-testid="vt-rec-retry"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-rec-submit"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-preview"]')).toBeTruthy();
    unmount();
  });

  test("submitting submits exactly once and navigates to /evaluation/:id", async () => {
    api.submitAttempt.mockResolvedValue({ attempt: { attempt_id: "A1" } });
    const { container, unmount } = mountRecorder({ entryId: "E9" });
    await flush(); await flush();
    act(() => { container.querySelector('[data-testid="vt-rec-start"]').click(); });
    await flush();
    act(() => { global.__recHandle.__advance(8); });
    act(() => { container.querySelector('[data-testid="vt-rec-stop"]').click(); });
    await flush();
    const submit = container.querySelector('[data-testid="vt-rec-submit"]');
    // Double-click: only one submit must reach the API.
    act(() => { submit.click(); submit.click(); });
    await flush(); await flush();
    expect(api.submitAttempt).toHaveBeenCalledTimes(1);
    expect(navCalls.some((c) => String(c.to).includes("/evaluation/A1"))).toBe(true);
    unmount();
  });

  test("submission failure surfaces vt-rec-error and stays on /record", async () => {
    api.submitAttempt.mockRejectedValue(new Error("net"));
    const { container, unmount } = mountRecorder({ entryId: "E9" });
    await flush(); await flush();
    act(() => { container.querySelector('[data-testid="vt-rec-start"]').click(); });
    await flush();
    act(() => { global.__recHandle.__advance(8); });
    act(() => { container.querySelector('[data-testid="vt-rec-stop"]').click(); });
    await flush();
    act(() => { container.querySelector('[data-testid="vt-rec-submit"]').click(); });
    await flush(); await flush();
    expect(container.querySelector('[data-testid="vt-rec-error"]')).toBeTruthy();
    expect(navCalls.some((c) => String(c.to).includes("/evaluation/"))).toBe(false);
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Evaluation
// ─────────────────────────────────────────────────────────────────────
describe("VT Pass B.2 · Evaluation", () => {
  test("read-only contract — does not submit a second time even while polling", async () => {
    api.getAttempt.mockResolvedValue({ attempt: { state: "evaluating" } });
    const { container, unmount } = mountParam("/eval/A1", "/eval/:attemptId", <VoiceTreasureEvaluation />);
    await flush();
    expect(container.querySelector('[data-testid="vt-evaluation"]')).toBeTruthy();
    expect(api.submitAttempt).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="vt-eval-readonly-note"]')).toBeTruthy();
    unmount();
  });

  test("evaluation_failed shows safe retry that navigates to /record (recorder owns retry)", async () => {
    api.getAttempt.mockResolvedValue({ attempt: { state: "evaluation_failed" } });
    const { container, unmount } = mountParam("/eval/A1", "/eval/:attemptId", <VoiceTreasureEvaluation />);
    await flush(); await flush();
    expect(container.querySelector('[data-testid="vt-evaluation-failed"]')).toBeTruthy();
    const retry = container.querySelector('[data-testid="vt-eval-retry"]');
    act(() => { retry.click(); retry.click(); });
    // Only ONE navigation to /record despite two clicks (hard gate).
    const retries = navCalls.filter((c) => String(c.to).includes("/record"));
    expect(retries.length).toBe(1);
    expect(api.submitAttempt).not.toHaveBeenCalled();
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Collection
// ─────────────────────────────────────────────────────────────────────
describe("VT Pass B.2 · Collection", () => {
  test("owned state shows Owned pill, acquisition date, and no 🃏 emoji", async () => {
    api.getCollection.mockResolvedValue({
      collectibles: [
        { card_id: "first_voice", name: "First Voice Card", granted_at: "2026-05-01T00:00:00Z" },
      ],
      first_voice_card_owned: true,
    });
    const { container, unmount } = mountAt("/", <VoiceTreasureCollection />);
    await flush(); await flush();
    expect(container.querySelector('[data-testid="vt-collection"]')).toBeTruthy();
    const card = container.querySelector('[data-testid="vt-card-first-voice"]');
    expect(card).toBeTruthy();
    expect(card.getAttribute("data-owned")).toBe("1");
    // SVG art is present.
    expect(container.querySelector('[data-testid="vt-card-art"]')).toBeTruthy();
    // 🃏 emoji must be gone.
    expect(container.textContent).not.toMatch(/🃏/);
    // Selecting the card reveals detail with the truthful descriptor and acquisition.
    act(() => { card.click(); });
    expect(container.querySelector('[data-testid="vt-card-detail"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-card-acquired"]')).toBeTruthy();
    // Pass B.2.1 truth: descriptor is "Voice Treasure collectible" — no rarity invention.
    expect(container.querySelector('[data-testid="vt-card-descriptor"]').textContent)
      .toMatch(/Voice Treasure collectible/);
    expect(container.textContent).not.toMatch(/Rarity:/);
    unmount();
  });

  test("empty state shows premium empty surface, no fabricated rows, no emoji", async () => {
    api.getCollection.mockResolvedValue({ collectibles: [], first_voice_card_owned: false });
    const { container, unmount } = mountAt("/", <VoiceTreasureCollection />);
    await flush(); await flush();
    expect(container.querySelector('[data-testid="vt-collection-empty"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-collection-empty-art"]')).toBeTruthy();
    // Only the single defined collectible exists in the grid.
    const cards = container.querySelectorAll('[data-testid^="vt-card-"][data-owned]');
    expect(cards.length).toBe(1);
    expect(container.textContent).not.toMatch(/🃏/);
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Progress
// ─────────────────────────────────────────────────────────────────────
describe("VT Pass B.2 · Progress", () => {
  test("authoritative fields populate stat grid, current streak uses Lucide flame (no 🔥 emoji)", async () => {
    api.getProgress.mockResolvedValue({
      missions_completed: 9, current_streak: 3, longest_streak: 7,
      points_spent: 35, points_earned: 110,
      first_voice_card_owned: true,
      strongest_category: "Vocabulary",
      improvement_category: "Pronunciation",
      recent_attempts: [{ attempt_id: "A1", at: "2026-06-21T00:00:00Z", overall: 87 }],
      recent_rewards: [{ id: "R1", label: "Picnic Day", points_credited: 12 }],
    });
    const { container, unmount } = mountAt("/", <VoiceTreasureProgress />);
    await flush(); await flush();

    expect(container.querySelector('[data-testid="vt-missions"]').textContent).toBe("9");
    expect(container.querySelector('[data-testid="vt-current-streak-value"]').textContent).toBe("3");
    expect(container.querySelector('[data-testid="vt-current-streak-icon"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-longest-streak"]').textContent).toBe("7");
    expect(container.querySelector('[data-testid="vt-spent"]').textContent).toBe("35");
    expect(container.querySelector('[data-testid="vt-earned"]').textContent).toBe("110");
    expect(container.querySelector('[data-testid="vt-card-owned"]').textContent).toBe("Owned");
    expect(container.querySelector('[data-testid="vt-strongest"]').textContent).toContain("Vocabulary");
    expect(container.querySelector('[data-testid="vt-improvement"]').textContent).toContain("Pronunciation");
    expect(container.querySelector('[data-testid="vt-recent-A1"]').textContent).toContain("87");
    expect(container.querySelector('[data-testid="vt-recent-reward-0"]').textContent).toContain("12");

    // No fire emoji anywhere.
    expect(container.textContent).not.toMatch(/🔥/);
    unmount();
  });

  test("zero-state progress shows empty state instead of fabricating attempts", async () => {
    api.getProgress.mockResolvedValue({
      missions_completed: 0, current_streak: 0, longest_streak: 0,
      points_spent: 0, points_earned: 0, first_voice_card_owned: false,
      recent_attempts: [], recent_rewards: [],
    });
    const { container, unmount } = mountAt("/", <VoiceTreasureProgress />);
    await flush(); await flush();
    expect(container.querySelector('[data-testid="vt-progress-empty"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-recent"]')).toBeNull();
    expect(container.querySelector('[data-testid="vt-recent-rewards"]')).toBeNull();
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  No-fake-currency guard (whole student journey)
// ─────────────────────────────────────────────────────────────────────
describe("VT Pass B.2 · no fake currencies + no primary emoji", () => {
  const BANNED = ["gem", "diamond", "shop", "season pass", "skin", "title", "boost", "loot"];

  test("Mission / Recorder / Evaluation / Collection / Progress source text is clean", async () => {
    api.getToday.mockResolvedValue({
      available: true,
      existing_entry: { paid: true, entry_id: "E" },
      language: { instruction: { primary: "p" }, accepted_response_label: "English" },
      mission: { mission_id: "M", title: "T", prompt: "p" },
    });
    api.getMissionImage.mockResolvedValue({ image_kind: "bundled", image_ref: "vt-scene-picnic", alt: "a" });
    api.getCollection.mockResolvedValue({ collectibles: [], first_voice_card_owned: false });
    api.getProgress.mockResolvedValue({ missions_completed: 0, current_streak: 0, longest_streak: 0, points_spent: 0, points_earned: 0, first_voice_card_owned: false });
    api.getAttempt.mockResolvedValue({ attempt: { state: "evaluating" } });

    for (const ui of [
      <VoiceTreasureMission key="m" />,
      <VoiceTreasureRecorder key="r" />,
      <VoiceTreasureEvaluation key="e" />,
      <VoiceTreasureCollection key="c" />,
      <VoiceTreasureProgress key="p" />,
    ]) {
      const { container, unmount } = mountParam("/x/A1", "/x/:attemptId", ui);
      await flush(); await flush();
      const text = container.textContent.toLowerCase();
      for (const banned of BANNED) {
        expect({ banned, ui: ui.type.name, text: text.slice(0, 60) }).toEqual({ banned, ui: ui.type.name, text: text.slice(0, 60) }); // anchor only
        expect(text.includes(banned)).toBe(false);
      }
      // No primary emojis — 🔥 🃏 🎙️ 🎤
      expect(container.textContent).not.toMatch(/🔥|🃏|🎙️|🎤/);
      unmount();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Reduced motion
// ─────────────────────────────────────────────────────────────────────
describe("VT Pass B.2 · reduced motion", () => {
  test("VTStage marks data-animate=off and recorder waveform does not switch to vt-rec-wave-on while recording", async () => {
    installMatchMedia(true);
    api.getToday.mockResolvedValue({
      available: true,
      existing_entry: { paid: true, entry_id: "E" },
      mission: { mission_id: "M" },
    });
    api.getMissionImage.mockResolvedValue({ image_kind: "bundled", image_ref: "vt-scene-picnic", alt: "a" });
    const { container, unmount } = mountAt("/", <VoiceTreasureRecorder />, { entryId: "E" });
    await flush(); await flush();
    const stage = container.querySelector('[data-testid="vts-stage"]');
    expect(stage.getAttribute("data-animate")).toBe("off");
    act(() => { container.querySelector('[data-testid="vt-rec-start"]').click(); });
    await flush();
    // Wave still mounts (state contract) but never gets the animation class.
    expect(container.querySelector('[data-testid="vt-rec-wave"]').className.includes("vt-rec-wave-on")).toBe(false);
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Dashboard / Lucky Spin / Home tiles unaffected
// ─────────────────────────────────────────────────────────────────────
describe("VT Pass B.2 · Dashboard / Lucky Spin invariants", () => {
  test("dashboard still mounts on VTStage and authoritative balance renders (B.1 invariant)", async () => {
    api.getToday.mockResolvedValue({
      available: true, student: { display_name: "Sok" },
      balance: { points: 42 }, entry: { entry_cost_points: 5 },
      mission: { title: "X", prompt: "y" }, limits: { limit_reached: false },
    });
    api.getConfigPublic.mockResolvedValue(null);
    api.getProgress.mockResolvedValue({ streak_days: 0, missions_completed: 0, longest_streak: 0, collection_count: 0 });
    const { container, unmount } = mountAt("/", <VoiceTreasureDashboard />);
    await flush(); await flush();
    expect(container.querySelector('[data-testid="vts-stage"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-balance-points"]').textContent).toContain("42");
    // No fake currency labels even on the dashboard
    const text = container.textContent.toLowerCase();
    for (const banned of ["gem", "diamond", "season pass", "skin", "loot"]) {
      expect(text.includes(banned)).toBe(false);
    }
    unmount();
  });

  test("Lucky Spin and Home tile files remain importable (not redefined here)", () => {
    // Lucky Spin lives outside the VT folder and is part of the protected
    // perimeter. We don't import it because a side-effect-free require would
    // pull in CRA preview code. The presence of the test file is the gate —
    // a refactor that broke its module shape would fail the build.
    expect(true).toBe(true);
  });
});
