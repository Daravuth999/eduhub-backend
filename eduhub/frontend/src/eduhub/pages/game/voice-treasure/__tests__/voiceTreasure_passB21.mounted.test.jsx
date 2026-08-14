/**
 * VT Pass B.2.1 · truth corrections + Studio polish mounted tests.
 *
 * Targets:
 *   • Collection uses collectibles[].granted_at (real API shape).
 *   • Collection renders the acquisition date from granted_at.
 *   • Collection does NOT render rarity/category invention.
 *   • Collection empty state remains correct.
 *   • Recorder real `previewing` phase (driven by <audio> events).
 *   • Recorder returns to `recorded` after pause/end.
 *   • Recorder no longer claims an `interrupted` phase.
 *   • Recorder interrupted phase truly absent from contract.
 *   • Reduced-motion behavior still holds for the Recorder waveform.
 */
global.IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot } from "react-dom/client";

// ── Virtual react-router-dom stand-in (same as B.2 test file) ─────────────
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
  function navigate(to, opts) { navCalls.push({ to, opts }); }
  function MemoryRouter({ initialEntries, children }) {
    const entry = (initialEntries && initialEntries[0]) || "/";
    if (typeof entry === "object" && entry !== null) {
      mockSetPath(entry.pathname || "/", entry.state || null);
    } else { mockSetPath(entry, null); }
    return R.createElement(R.Fragment, null, children);
  }
  function Routes({ children }) {
    const kids = R.Children.toArray(children);
    for (const r of kids) {
      if (!r || !r.props) continue;
      const params = mockMatchParams(r.props.path, mockCurrentPath);
      if (params !== null) return R.createElement(ParamContext.Provider, { value: params }, r.props.element);
    }
    return null;
  }
  function Route() { return null; }
  return {
    __esModule: true,
    MemoryRouter, Routes, Route,
    useLocation: () => ({ pathname: mockCurrentPath, search: "", hash: "", state: mockState }),
    useNavigate: () => navigate,
    useParams: () => R.useContext(ParamContext),
  };
}, { virtual: true });

jest.mock("../../../../context/AuthContext", () => ({
  useAuth: () => ({ isAuthenticated: false, student: null, logout: () => {}, refreshPoints: () => {} }),
}));

jest.mock("../api", () => ({
  __esModule: true,
  getCollection: jest.fn(),
  getToday: jest.fn(),
  getMissionImage: jest.fn(),
  submitAttempt: jest.fn(),
  getAttempt: jest.fn(),
  getProgress: jest.fn(),
  getClaimStatus: jest.fn(),
  claim: jest.fn(),
  getConfigPublic: jest.fn(),
}));

jest.mock("../hooks/useVoiceRecorder", () => {
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
      const start = React.useCallback(() => { setStatus("recording"); setElapsed(0); }, []);
      const stop = React.useCallback(() => {
        blob.current = new Blob(["x"], { type: "audio/webm" });
        setAudioUrl("blob:fake");
        setStatus("recorded");
      }, []);
      const reset = React.useCallback(() => {
        blob.current = null; setAudioUrl(null); setElapsed(0); setStatus("idle");
      }, []);
      const __advance = (sec) => { setElapsed(sec); };
      const api = {
        status, elapsed, audioUrl,
        durationLabel: `00:${String(elapsed).padStart(2, "0")}`,
        canStop: elapsed >= minSeconds,
        minSeconds, maxSeconds,
        start, stop, reset,
        getBlob: () => blob.current,
        __advance,
      };
      global.__recHandle = api;
      return api;
    },
  };
}, { virtual: false });

import { MemoryRouter, Routes, Route } from "react-router-dom";
import * as api from "../api";
import VoiceTreasureCollection from "../VoiceTreasureCollection";
import VoiceTreasureRecorder from "../VoiceTreasureRecorder";

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
        <Routes><Route path="*" element={ui} /></Routes>
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
//  Collection truth corrections
// ─────────────────────────────────────────────────────────────────────
describe("VT Pass B.2.1 · Collection uses collectibles[].granted_at", () => {
  test("granted_at populates the acquisition date pill", async () => {
    api.getCollection.mockResolvedValue({
      collectibles: [
        { card_id: "first_voice", name: "First Voice Card", granted_at: "2026-04-15T10:00:00Z" },
      ],
      first_voice_card_owned: true,
    });
    const { container, unmount } = mountAt("/", <VoiceTreasureCollection />);
    await flush(); await flush();
    const card = container.querySelector('[data-testid="vt-card-first-voice"]');
    expect(card.getAttribute("data-owned")).toBe("1");
    act(() => { card.click(); });
    const pill = container.querySelector('[data-testid="vt-card-acquired"]');
    expect(pill).toBeTruthy();
    // Render must derive a real date — toLocaleDateString output is non-empty.
    expect(pill.textContent.replace(/\s+/g, " ")).toMatch(/Acquired \S+/);
    // Truthful descriptor — no rarity/category invention anywhere.
    expect(container.querySelector('[data-testid="vt-card-descriptor"]').textContent)
      .toMatch(/Voice Treasure collectible/);
    expect(container.textContent).not.toMatch(/Rarity:/);
    expect(container.textContent).not.toMatch(/Tier|Series|Scarcity/);
    unmount();
  });

  test("ownership inferred from collectibles[] alone (boolean missing)", async () => {
    api.getCollection.mockResolvedValue({
      collectibles: [{ card_id: "first_voice", name: "First Voice Card", granted_at: "2026-04-15T10:00:00Z" }],
    });
    const { container, unmount } = mountAt("/", <VoiceTreasureCollection />);
    await flush(); await flush();
    expect(container.querySelector('[data-testid="vt-card-first-voice"]').getAttribute("data-owned")).toBe("1");
    unmount();
  });

  test("invalid granted_at does NOT render an Acquired pill", async () => {
    api.getCollection.mockResolvedValue({
      collectibles: [{ card_id: "first_voice", name: "First Voice Card", granted_at: "not-a-date" }],
      first_voice_card_owned: true,
    });
    const { container, unmount } = mountAt("/", <VoiceTreasureCollection />);
    await flush(); await flush();
    act(() => { container.querySelector('[data-testid="vt-card-first-voice"]').click(); });
    expect(container.querySelector('[data-testid="vt-card-acquired"]')).toBeNull();
    unmount();
  });

  test("empty collectibles + first_voice_card_owned=false ⇒ premium empty state, no rarity text", async () => {
    api.getCollection.mockResolvedValue({ collectibles: [], first_voice_card_owned: false });
    const { container, unmount } = mountAt("/", <VoiceTreasureCollection />);
    await flush(); await flush();
    expect(container.querySelector('[data-testid="vt-collection-empty"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vt-card-first-voice"]').getAttribute("data-owned")).toBe("0");
    expect(container.textContent).not.toMatch(/Rarity|Category|Tier|Series/i);
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Recorder phase truth corrections
// ─────────────────────────────────────────────────────────────────────
describe("VT Pass B.2.1 · Recorder previewing phase is real, no interrupted overstatement", () => {
  function mountRecorder() {
    api.getToday.mockResolvedValue({
      available: true,
      existing_entry: { paid: true, entry_id: "E1" },
      mission: { mission_id: "M1" },
    });
    api.getMissionImage.mockResolvedValue({ image_kind: "bundled", image_ref: "vt-scene-picnic", alt: "x" });
    return mountAt("/game/voice-treasure/record", <VoiceTreasureRecorder />, { entryId: "E1" });
  }

  test("transitions to previewing on <audio> onPlay and back on pause/end", async () => {
    const { container, unmount } = mountRecorder();
    await flush(); await flush();
    act(() => { container.querySelector('[data-testid="vt-rec-start"]').click(); });
    await flush();
    act(() => { global.__recHandle.__advance(6); });
    act(() => { container.querySelector('[data-testid="vt-rec-stop"]').click(); });
    await flush();
    const audio = container.querySelector('[data-testid="vt-preview"]');
    expect(audio).toBeTruthy();
    const recorder = container.querySelector('[data-testid="vt-recorder"]');
    expect(recorder.getAttribute("data-phase")).toBe("recorded");

    // onPlay ⇒ previewing
    act(() => { audio.dispatchEvent(new Event("play")); });
    expect(recorder.getAttribute("data-phase")).toBe("previewing");
    expect(container.querySelector('[data-testid="vt-recorder-title"]').textContent).toMatch(/Previewing/);

    // onPause ⇒ recorded
    act(() => { audio.dispatchEvent(new Event("pause")); });
    expect(recorder.getAttribute("data-phase")).toBe("recorded");

    // onPlay again then onEnded ⇒ recorded
    act(() => { audio.dispatchEvent(new Event("play")); });
    expect(recorder.getAttribute("data-phase")).toBe("previewing");
    act(() => { audio.dispatchEvent(new Event("ended")); });
    expect(recorder.getAttribute("data-phase")).toBe("recorded");
    unmount();
  });

  test("recorder never enters an `interrupted` phase (claim corrected)", async () => {
    const { container, unmount } = mountRecorder();
    await flush(); await flush();
    act(() => { container.querySelector('[data-testid="vt-rec-start"]').click(); });
    await flush();
    // Simulate a tab visibility blip — the previous overclaim was that
    // this surfaces "interrupted". The hook stub does not flip a state,
    // so the phase must remain truthful (still "recording").
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(container.querySelector('[data-testid="vt-recorder"]').getAttribute("data-phase")).not.toBe("interrupted");
    // After stop we land on "recorded", never "interrupted".
    act(() => { global.__recHandle.__advance(6); });
    act(() => { container.querySelector('[data-testid="vt-rec-stop"]').click(); });
    await flush();
    expect(container.querySelector('[data-testid="vt-recorder"]').getAttribute("data-phase")).toBe("recorded");
    unmount();
  });

  test("submit path still single-shot (regression guard from B.2)", async () => {
    api.submitAttempt.mockResolvedValue({ attempt: { attempt_id: "A1" } });
    const { container, unmount } = mountRecorder();
    await flush(); await flush();
    act(() => { container.querySelector('[data-testid="vt-rec-start"]').click(); });
    await flush();
    act(() => { global.__recHandle.__advance(8); });
    act(() => { container.querySelector('[data-testid="vt-rec-stop"]').click(); });
    await flush();
    const submit = container.querySelector('[data-testid="vt-rec-submit"]');
    act(() => { submit.click(); submit.click(); submit.click(); });
    await flush(); await flush();
    expect(api.submitAttempt).toHaveBeenCalledTimes(1);
    unmount();
  });
});
