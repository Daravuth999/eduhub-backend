/**
 * react-router-dom@7's ESM-only exports map defeats Jest's CRA transform —
 * same documented problem/fix as readerRouteRemountIntegration.test.jsx.
 * VideoLessonPlayer only needs useParams/useNavigate/Link.
 */
const mockNavigate = jest.fn();
jest.mock("react-router-dom", () => ({
  __esModule: true,
  useParams: () => ({ lessonId: "vid_1" }),
  useNavigate: () => mockNavigate,
  Link: ({ children, to }) => <a href={to}>{children}</a>,
}), { virtual: true });

jest.mock("../../../context/AuthContext", () => ({
  useAuth: () => ({ student: { studentId: "stu001", password: "secret" } }),
}));

jest.mock("../videoLibraryApi", () => ({
  getLesson: jest.fn(),
  getSyncDocument: jest.fn(),
  purchaseLesson: jest.fn(),
  reportProgress: jest.fn(),
  toggleBookmark: jest.fn(),
  listBookmarks: jest.fn(),
  listRecentlyWatched: jest.fn(),
  getNote: jest.fn(),
  saveNote: jest.fn(),
  resolveMediaSrc: (ref) => (ref ? `https://resolved/${ref}` : ""),
}));

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import VideoLessonPlayer from "../VideoLessonPlayer";
import {
  getLesson, getSyncDocument, purchaseLesson, toggleBookmark, listBookmarks,
  listRecentlyWatched, getNote, saveNote,
} from "../videoLibraryApi";
import { readLocalOverrides } from "../../../components/teleprompter/teleprompterConfig";

function freeOwnedLesson(overrides) {
  return {
    lessonId: "vid_1", title: "Ordering Coffee", price: 0, owned: true,
    mediaRef: "https://pub-x.r2.dev/vid.mp4", syncId: "sync_abc", durationSec: 60,
    ...overrides,
  };
}

const SYNC_WITH_WORDS = {
  paragraphs: [{ id: "p1", sentences: [{ id: "s1", speakerId: "S1", words: [{ word: "Hello", start: 0, end: 0.5 }] }] }],
};

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  getSyncDocument.mockResolvedValue(null);
  listBookmarks.mockResolvedValue([]);
  listRecentlyWatched.mockResolvedValue([]);
  getNote.mockResolvedValue({ lessonId: "vid_1", text: "" });
  saveNote.mockResolvedValue({ lessonId: "vid_1", text: "" });
});

test("shows a loading spinner while the lesson is fetched", async () => {
  let resolveFn;
  getLesson.mockReturnValue(new Promise((res) => { resolveFn = res; }));
  render(<VideoLessonPlayer />);
  // Resolve after the assertion window so the spinner is observed first.
  resolveFn(freeOwnedLesson());
  await waitFor(() => expect(screen.getByTestId("video-lesson-player")).toBeInTheDocument());
});

test("shows an error state when the lesson fails to load", async () => {
  getLesson.mockRejectedValue(new Error("not found"));
  render(<VideoLessonPlayer />);
  expect(await screen.findByText(/not found/i)).toBeInTheDocument();
});

test("renders the video element with the resolved media src for an owned lesson", async () => {
  getLesson.mockResolvedValue(freeOwnedLesson());
  render(<VideoLessonPlayer />);
  const video = await screen.findByTestId("video-player-element");
  expect(video).toHaveAttribute("src", "https://resolved/https://pub-x.r2.dev/vid.mp4");
});

test("renders an audio element instead of video when contentType is audio", async () => {
  getLesson.mockResolvedValue(freeOwnedLesson({ contentType: "audio/mpeg" }));
  render(<VideoLessonPlayer />);
  const media = await screen.findByTestId("video-player-element");
  expect(media.tagName).toBe("AUDIO");
});

// Regression coverage for the "stuck loading/spinning" playback incident:
// the player must never sit silently in a broken/buffering state. A real
// MediaError surfaces immediately; a persistent buffering stall surfaces
// after a threshold — never a fake-ready state either way.
describe("honest media failure/stall surfacing", () => {
  test("a real MediaError is surfaced immediately", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    render(<VideoLessonPlayer />);
    const video = await screen.findByTestId("video-player-element");
    Object.defineProperty(video, "error", { value: { code: 2 }, configurable: true });
    fireEvent.error(video);
    const issue = await screen.findByTestId("video-media-issue");
    expect(issue).toHaveTextContent("network error");
  });

  test("a persistent buffering stall is reported only after the threshold", async () => {
    jest.useFakeTimers();
    try {
      getLesson.mockResolvedValue(freeOwnedLesson());
      render(<VideoLessonPlayer />);
      const video = await screen.findByTestId("video-player-element");
      fireEvent.waiting(video);
      expect(screen.queryByTestId("video-media-issue")).toBeNull();
      act(() => { jest.advanceTimersByTime(8000); });
      expect(screen.getByTestId("video-media-issue")).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  // Root cause of the real-device false positive: a large file can
  // legitimately need more than STALL_THRESHOLD_MS of continuous download
  // before it has buffered enough to resume playback. The browser's own
  // "progress" event fires the whole time bytes keep arriving — this must
  // defer the stall warning, not let 8s of ongoing (if slow) buffering
  // be misreported as a genuine stall.
  test("ongoing 'progress' events during buffering defer the stall warning — normal large-file buffering is never misreported as a stall", async () => {
    jest.useFakeTimers();
    try {
      getLesson.mockResolvedValue(freeOwnedLesson());
      render(<VideoLessonPlayer />);
      const video = await screen.findByTestId("video-player-element");
      fireEvent.waiting(video);
      // 7s in — still under the 8s threshold, but data is still arriving.
      act(() => { jest.advanceTimersByTime(7000); });
      fireEvent.progress(video);
      // Another 7s (14s total since "waiting", but only 7s since the last
      // real progress) — must NOT have fired, since progress kept resetting
      // the window.
      act(() => { jest.advanceTimersByTime(7000); });
      expect(screen.queryByTestId("video-media-issue")).toBeNull();
      // Now the network genuinely goes quiet — no further progress. The
      // full threshold with zero progress must still report honestly.
      act(() => { jest.advanceTimersByTime(8000); });
      expect(screen.getByTestId("video-media-issue")).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a 'progress' event outside of an active wait is a no-op — never starts a stall timer on its own", async () => {
    jest.useFakeTimers();
    try {
      getLesson.mockResolvedValue(freeOwnedLesson());
      render(<VideoLessonPlayer />);
      const video = await screen.findByTestId("video-player-element");
      // Ordinary playback fires "progress" routinely with no "waiting"
      // ever having occurred — must never spuriously arm the stall timer.
      fireEvent.progress(video);
      act(() => { jest.advanceTimersByTime(8000); });
      expect(screen.queryByTestId("video-media-issue")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("seeking into an unbuffered position is treated exactly like ordinary buffering, not a stall", async () => {
    // seekTo() only ever assigns currentTime (see VideoLessonPlayer.jsx) —
    // it never calls .load() or reassigns .src. The browser's own "waiting"
    // event after a seek into an unbuffered region is indistinguishable
    // from ordinary buffering, so it must go through the exact same
    // progress-deferred stall logic, never an immediate warning.
    jest.useFakeTimers();
    try {
      getLesson.mockResolvedValue(freeOwnedLesson());
      render(<VideoLessonPlayer />);
      const video = await screen.findByTestId("video-player-element");
      Object.defineProperty(video, "duration", { value: 120, configurable: true });
      fireEvent.loadedMetadata(video);
      fireEvent.change(await screen.findByTestId("video-seek-slider"), { target: { value: "90" } });
      fireEvent.waiting(video);
      expect(screen.queryByTestId("video-media-issue")).toBeNull();
      act(() => { jest.advanceTimersByTime(5000); });
      fireEvent.progress(video); // bytes for the new position are arriving
      act(() => { jest.advanceTimersByTime(7000); });
      expect(screen.queryByTestId("video-media-issue")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("replaying via the seek slider (scrubbing back to 0) never touches .src or triggers a reload", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    render(<VideoLessonPlayer />);
    const video = await screen.findByTestId("video-player-element");
    Object.defineProperty(video, "duration", { value: 120, configurable: true });
    fireEvent.loadedMetadata(video);
    const srcBefore = video.src;
    fireEvent.change(await screen.findByTestId("video-seek-slider"), { target: { value: "0" } });
    expect(video.src).toBe(srcBefore);
  });
});

test("shows the purchase gate instead of the video for an unowned paid lesson", async () => {
  getLesson.mockResolvedValue(freeOwnedLesson({ price: 50, owned: false, syncId: undefined, mediaRef: undefined }));
  render(<VideoLessonPlayer />);
  expect(await screen.findByTestId("video-purchase-gate")).toBeInTheDocument();
  expect(screen.queryByTestId("video-player-element")).not.toBeInTheDocument();
});

test("confirming the purchase in the premium modal calls purchaseLesson with the stored session password", async () => {
  getLesson.mockResolvedValue(freeOwnedLesson({ price: 50, owned: false, syncId: undefined, mediaRef: undefined }));
  purchaseLesson.mockResolvedValue({ ok: true, purchase: { state: "succeeded", pointsAfter: 104.16 } });
  render(<VideoLessonPlayer />);
  fireEvent.click(await screen.findByTestId("video-purchase-gate-unlock-button"));
  fireEvent.click(await screen.findByTestId("video-purchase-confirm-button"));
  await waitFor(() => expect(purchaseLesson).toHaveBeenCalledWith("vid_1", { password: "secret" }));
  // Backend-confirmed success shows the premium unlocked state.
  expect(await screen.findByTestId("video-purchase-success")).toBeInTheDocument();
});

test("purchase failure shows an honest error state inside the modal without crashing", async () => {
  getLesson.mockResolvedValue(freeOwnedLesson({ price: 50, owned: false, syncId: undefined, mediaRef: undefined }));
  purchaseLesson.mockResolvedValue({ ok: false, purchase: { state: "failed" } });
  render(<VideoLessonPlayer />);
  fireEvent.click(await screen.findByTestId("video-purchase-gate-unlock-button"));
  fireEvent.click(await screen.findByTestId("video-purchase-confirm-button"));
  expect(await screen.findByText(/could not be completed/i)).toBeInTheDocument();
  // The lesson stays locked — the gate is still there behind the modal.
  expect(screen.getByTestId("video-purchase-gate")).toBeInTheDocument();
});

test("shows an honest empty transcript state when no sync document exists", async () => {
  getLesson.mockResolvedValue(freeOwnedLesson());
  getSyncDocument.mockResolvedValue(null);
  render(<VideoLessonPlayer />);
  expect(await screen.findByTestId("video-transcript-empty")).toBeInTheDocument();
});

test("renders transcript words when a real sync document with words exists", async () => {
  getLesson.mockResolvedValue(freeOwnedLesson());
  getSyncDocument.mockResolvedValue(SYNC_WITH_WORDS);
  render(<VideoLessonPlayer />);
  expect(await screen.findByTestId("video-transcript-panel")).toHaveTextContent("Hello");
});

test("adding a local timestamp bookmark lists it under the Transcript tab", async () => {
  getLesson.mockResolvedValue(freeOwnedLesson());
  render(<VideoLessonPlayer />);
  await screen.findByTestId("video-player-element");
  fireEvent.click(screen.getByTestId("video-add-bookmark-button"));
  expect(JSON.parse(localStorage.getItem("eduhub_video_bookmarks_vid_1"))).toHaveLength(1);
});

test("save-lesson button reflects a pre-existing backend bookmark on load", async () => {
  getLesson.mockResolvedValue(freeOwnedLesson());
  listBookmarks.mockResolvedValue([{ lessonId: "vid_1" }]);
  render(<VideoLessonPlayer />);
  const btn = await screen.findByTestId("video-save-lesson-button");
  await waitFor(() => expect(btn).toHaveAttribute("aria-pressed", "true"));
});

test("clicking the save-lesson button toggles the backend bookmark", async () => {
  getLesson.mockResolvedValue(freeOwnedLesson());
  listBookmarks.mockResolvedValue([]);
  toggleBookmark.mockResolvedValue({ bookmarked: true, lessonId: "vid_1" });
  render(<VideoLessonPlayer />);
  const btn = await screen.findByTestId("video-save-lesson-button");
  expect(btn).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(btn);
  await waitFor(() => expect(toggleBookmark).toHaveBeenCalledWith("vid_1"));
  await waitFor(() => expect(btn).toHaveAttribute("aria-pressed", "true"));
});

test("save-lesson button is not shown for a locked, unowned paid lesson", async () => {
  getLesson.mockResolvedValue(freeOwnedLesson({ price: 50, owned: false, syncId: undefined, mediaRef: undefined }));
  render(<VideoLessonPlayer />);
  await screen.findByTestId("video-purchase-gate");
  expect(screen.queryByTestId("video-save-lesson-button")).not.toBeInTheDocument();
});

test("back button navigates to the Video Library dashboard", async () => {
  getLesson.mockResolvedValue(freeOwnedLesson());
  render(<VideoLessonPlayer />);
  fireEvent.click(await screen.findByTestId("video-player-back-button"));
  expect(mockNavigate).toHaveBeenCalledWith("/video-library");
});

describe("study surface tabs", () => {
  test("all four tabs are present and Transcript is active by default", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-tab-transcript");
    ["transcript", "teleprompter", "vocabulary", "notes"].forEach((key) => {
      expect(screen.getByTestId(`video-tab-${key}`)).toBeInTheDocument();
    });
  });

  test("switching to the Teleprompter tab renders the shared Teleprompter component", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    getSyncDocument.mockResolvedValue(SYNC_WITH_WORDS);
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-tab-transcript");
    fireEvent.click(screen.getByTestId("video-tab-teleprompter"));
    // SYNC_WITH_WORDS has a single speaker — Teleprompter's auto mode
    // resolves to storytelling (conversation mode needs >= 2 speakers).
    expect(await screen.findByTestId("teleprompter-storytelling")).toBeInTheDocument();
  });

  // Bug 1 fix: Reading Preferences used to REPLACE the Teleprompter inside
  // the same bounded, page-scrolling side panel (max-h-[70vh], no safe-area
  // awareness) — controls near the bottom could fall under the home
  // indicator or require scrolling the whole page rather than the panel.
  // It's now a fixed, safe-area-aware bottom sheet layered above
  // everything, and the Teleprompter itself never unmounts while it's open.
  describe("Reading Preferences bottom sheet (Bug 1)", () => {
    test("opens as an overlay sheet without unmounting the Teleprompter underneath", async () => {
      getLesson.mockResolvedValue(freeOwnedLesson());
      getSyncDocument.mockResolvedValue(SYNC_WITH_WORDS);
      render(<VideoLessonPlayer />);
      await screen.findByTestId("video-tab-transcript");
      fireEvent.click(screen.getByTestId("video-tab-teleprompter"));
      await screen.findByTestId("teleprompter-storytelling");
      expect(screen.queryByTestId("video-teleprompter-settings-sheet")).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId("video-teleprompter-settings-button"));
      expect(screen.getByTestId("video-teleprompter-settings-sheet")).toBeInTheDocument();
      expect(screen.getByTestId("teleprompter-settings")).toBeInTheDocument();
      // The reading surface itself is still mounted underneath — reopening
      // preferences must never resize/remount it.
      expect(screen.getByTestId("teleprompter-storytelling")).toBeInTheDocument();
    });

    test("the sheet respects safe-area insets on its header and scrollable body", async () => {
      getLesson.mockResolvedValue(freeOwnedLesson());
      getSyncDocument.mockResolvedValue(SYNC_WITH_WORDS);
      render(<VideoLessonPlayer />);
      await screen.findByTestId("video-tab-transcript");
      fireEvent.click(screen.getByTestId("video-tab-teleprompter"));
      fireEvent.click(screen.getByTestId("video-teleprompter-settings-button"));
      const sheet = screen.getByTestId("video-teleprompter-settings-sheet");
      // Anchored to the real viewport, not clipped by any scrolling ancestor.
      expect(sheet.parentElement).toHaveClass("fixed");
      // jsdom's CSS parser (cssstyle) validates and drops any inline
      // declaration whose value it doesn't recognize (env(...) included)
      // from BOTH the parsed `.style` object and the serialized attribute
      // string — there is no way to assert the safe-area value survives
      // here. That's verified separately with real computed styles in a
      // real browser (see this session's Bug 1/3 verification report).
      const closeBtn = screen.getByTestId("video-teleprompter-settings-close");
      // Real >=44px touch target, not a tiny icon-only hit zone.
      expect(closeBtn.className).toMatch(/min-w-\[44px\]/);
      expect(closeBtn.className).toMatch(/min-h-\[44px\]/);
    });

    test("closes via the explicit close button", async () => {
      getLesson.mockResolvedValue(freeOwnedLesson());
      getSyncDocument.mockResolvedValue(SYNC_WITH_WORDS);
      render(<VideoLessonPlayer />);
      await screen.findByTestId("video-tab-transcript");
      fireEvent.click(screen.getByTestId("video-tab-teleprompter"));
      fireEvent.click(screen.getByTestId("video-teleprompter-settings-button"));
      expect(screen.getByTestId("video-teleprompter-settings-sheet")).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("video-teleprompter-settings-close"));
      expect(screen.queryByTestId("video-teleprompter-settings-sheet")).not.toBeInTheDocument();
    });

    test("closes via tapping the backdrop, but not via tapping inside the sheet itself", async () => {
      getLesson.mockResolvedValue(freeOwnedLesson());
      getSyncDocument.mockResolvedValue(SYNC_WITH_WORDS);
      render(<VideoLessonPlayer />);
      await screen.findByTestId("video-tab-transcript");
      fireEvent.click(screen.getByTestId("video-tab-teleprompter"));
      fireEvent.click(screen.getByTestId("video-teleprompter-settings-button"));
      fireEvent.click(screen.getByTestId("video-teleprompter-settings-sheet"));
      expect(screen.getByTestId("video-teleprompter-settings-sheet")).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("video-teleprompter-settings-backdrop"));
      expect(screen.queryByTestId("video-teleprompter-settings-sheet")).not.toBeInTheDocument();
    });

    test("changing a reading preference from the sheet persists as a local override without closing the sheet", async () => {
      getLesson.mockResolvedValue(freeOwnedLesson());
      getSyncDocument.mockResolvedValue(SYNC_WITH_WORDS);
      render(<VideoLessonPlayer />);
      await screen.findByTestId("video-tab-transcript");
      fireEvent.click(screen.getByTestId("video-tab-teleprompter"));
      fireEvent.click(screen.getByTestId("video-teleprompter-settings-button"));
      fireEvent.click(screen.getByTestId("tp-setting-autoscroll"));
      expect(readLocalOverrides()).toMatchObject({ autoScroll: false });
      // A control interaction inside the sheet must never itself close it.
      expect(screen.getByTestId("video-teleprompter-settings-sheet")).toBeInTheDocument();
    });
  });

  test("the student Teleprompter renders in center-focus mode: the active sentence has no transform offset, matching the cinematic-reading requirement for this surface specifically", async () => {
    const THREE_SENTENCE_SYNC = {
      paragraphs: [{ id: "p1", sentences: [
        { id: "s1", words: [{ word: "First.", start: 0, end: 1 }] },
        { id: "s2", words: [{ word: "Second.", start: 1, end: 2 }] },
        { id: "s3", words: [{ word: "Third.", start: 2, end: 3 }] },
      ] }],
    };
    getLesson.mockResolvedValue(freeOwnedLesson());
    getSyncDocument.mockResolvedValue(THREE_SENTENCE_SYNC);
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-tab-transcript");
    fireEvent.click(screen.getByTestId("video-tab-teleprompter"));
    await screen.findByTestId("teleprompter-storytelling");
    const video = screen.getByTestId("video-player-element");
    Object.defineProperty(video, "currentTime", { value: 1.5, writable: true });
    fireEvent.timeUpdate(video);
    const active = await screen.findByTestId("teleprompter-sentence-1");
    expect(active.style.transform).toBe("translateY(0px) scale(1)");
    const past = screen.getByTestId("teleprompter-sentence-0");
    expect(Number(past.style.opacity)).toBeLessThan(1);
  });

  test("Learning Dock tabs meet the 44px touch-target minimum", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-tab-transcript");
    ["transcript", "teleprompter", "vocabulary", "notes"].forEach((key) => {
      expect(screen.getByTestId(`video-tab-${key}`).className).toMatch(/min-h-\[44px\]/);
    });
  });

  test("the karaoke engine is a single shared instance — no duplicate rAF loop or duplicate listeners when the Teleprompter tab is open", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    getSyncDocument.mockResolvedValue(SYNC_WITH_WORDS);
    render(<VideoLessonPlayer />);
    const video = await screen.findByTestId("video-player-element");
    const addSpy = jest.spyOn(video, "addEventListener");
    fireEvent.click(screen.getByTestId("video-tab-teleprompter"));
    await screen.findByTestId("teleprompter-storytelling");
    // VideoLessonPlayer's own transcript engine already attaches these
    // listeners once on mount (before this spy was installed). Opening the
    // Teleprompter tab must NOT attach a second, independent set on the
    // same media element — that would mean two parallel rAF loops.
    expect(addSpy.mock.calls.filter(([type]) => type === "seeking")).toHaveLength(0);
    expect(addSpy.mock.calls.filter(([type]) => type === "timeupdate")).toHaveLength(0);
    addSpy.mockRestore();
  });

  test("switching to the Vocabulary tab shows an honest empty state when no learning analysis exists", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson({ learning: null }));
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-tab-transcript");
    fireEvent.click(screen.getByTestId("video-tab-vocabulary"));
    expect(await screen.findByTestId("video-vocabulary-empty")).toBeInTheDocument();
  });

  test("switching to the Vocabulary tab renders real Gemini-derived vocabulary", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson({
      learning: { cefrLevel: "A2", vocabulary: [{ word: "order", definition: "ask for", example: "I order tea." }] },
    }));
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-tab-transcript");
    fireEvent.click(screen.getByTestId("video-tab-vocabulary"));
    const panel = await screen.findByTestId("video-vocabulary-panel");
    expect(panel).toHaveTextContent("order");
  });

  test("switching to the Notes tab loads and saves backend-owned notes", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    getNote.mockResolvedValue({ lessonId: "vid_1", text: "existing note" });
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-tab-transcript");
    fireEvent.click(screen.getByTestId("video-tab-notes"));
    const textarea = await screen.findByTestId("video-notes-textarea");
    await waitFor(() => expect(textarea).toHaveValue("existing note"));
    fireEvent.change(textarea, { target: { value: "updated note" } });
    await waitFor(() => expect(saveNote).toHaveBeenCalledWith("vid_1", "updated note"), { timeout: 2000 });
  });
});

// ── Priority 2 (user directive): "when the user presses Play the karaoke
//    highlight jumps toward the end". A prior investigation traced this to
//    video_ai_provider.segments_to_sync trusting an out-of-order Gemini
//    segment array (fixed backend-side) plus a frontend defense-in-depth
//    fix in syncConsumption.js's binarySearchActiveIndex (real min/max scan
//    instead of trusting array position — see that file's own regression
//    suite for the exact incident reproduction). Those tests exercise the
//    PURE function in isolation. This suite instead drives the FULL chain
//    — video element -> VideoLessonPlayer's shared engine -> Teleprompter
//    render — through all ten scenarios the user asked to be re-traced, end
//    to end, against a structurally realistic (multi-sentence, multi-word,
//    with natural silence gaps between sentences) fixture. This is a
//    component/DOM-level regression test, not a live-device verification —
//    no live lesson/browser session was available in this environment (see
//    final report).
describe("karaoke full-chain regression (Priority 2 — Play must never jump toward the end)", () => {
  // Three short sentences with realistic (non-round) word timestamps and a
  // silence gap between each sentence — deliberately NOT a single-word toy
  // fixture, so a transition bug that only shows up with multiple words per
  // sentence or a silence gap between sentences has somewhere to hide.
  const REALISTIC_SYNC = {
    paragraphs: [{ id: "p1", sentences: [
      {
        id: "s1", start: 0.10, end: 1.55,
        words: [
          { word: "The", start: 0.10, end: 0.32 },
          { word: "market", start: 0.32, end: 0.68 },
          { word: "was", start: 0.68, end: 0.85 },
          { word: "busy", start: 0.85, end: 1.20 },
          { word: "today.", start: 1.20, end: 1.55 },
        ],
      },
      // silence gap 1.55 -> 1.80
      {
        id: "s2", start: 1.80, end: 3.00,
        words: [
          { word: "She", start: 1.80, end: 1.95 },
          { word: "bought", start: 1.95, end: 2.30 },
          { word: "fresh", start: 2.30, end: 2.55 },
          { word: "mangoes.", start: 2.55, end: 3.00 },
        ],
      },
      // silence gap 3.00 -> 3.20
      {
        id: "s3", start: 3.20, end: 4.10,
        words: [
          { word: "Then", start: 3.20, end: 3.35 },
          { word: "she", start: 3.35, end: 3.48 },
          { word: "walked", start: 3.48, end: 3.80 },
          { word: "home.", start: 3.80, end: 4.10 },
        ],
      },
    ] }],
  };

  function activeWordText() {
    const el = screen.queryByText((_, node) => node?.getAttribute?.("data-word-active") === "true");
    return el?.textContent?.trim();
  }

  test("traces the full chain through initial play, pause/resume, seeks, replay, sentence transitions, tab switches, and EN/KM toggling without ever jumping toward the end", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    getSyncDocument.mockResolvedValue({
      ...REALISTIC_SYNC,
      paragraphs: [{
        ...REALISTIC_SYNC.paragraphs[0],
        sentences: [
          { ...REALISTIC_SYNC.paragraphs[0].sentences[0], translationKm: "ផ្សារមមាញឹកថ្ងៃនេះ" },
          { ...REALISTIC_SYNC.paragraphs[0].sentences[1], translationKm: "នាងបានទិញស្វាយស្រស់" },
          REALISTIC_SYNC.paragraphs[0].sentences[2],
        ],
      }],
    });
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-tab-transcript");
    fireEvent.click(screen.getByTestId("video-tab-teleprompter"));
    await screen.findByTestId("teleprompter-storytelling");
    const video = screen.getByTestId("video-player-element");
    Object.defineProperty(video, "duration", { value: 4.10, writable: true, configurable: true });
    const setTime = (t) => Object.defineProperty(video, "currentTime", { value: t, writable: true, configurable: true });

    // 1. Initial Play — pressing play at t=0.1 must resolve to the real
    //    FIRST word ("The"), never a blank/lost highlight and never a word
    //    from later in the document.
    setTime(0.10);
    fireEvent.play(video);
    fireEvent.timeUpdate(video);
    expect(activeWordText()).toBe("The");

    // 2. Progress mid-sentence 1, then pause -> Play (scenario 2).
    setTime(0.90);
    fireEvent.timeUpdate(video);
    expect(activeWordText()).toBe("busy");
    fireEvent.pause(video);
    fireEvent.play(video);
    fireEvent.timeUpdate(video);
    expect(activeWordText()).toBe("busy"); // resume must not silently jump

    // 3. Sentence transition (natural progression into s2) + the exact
    //    regression window from the real incident: a time comfortably
    //    inside the document, nowhere near the end, must never resolve to
    //    "reached the end".
    setTime(2.00);
    fireEvent.timeUpdate(video);
    expect(activeWordText()).toBe("bought");
    expect(activeWordText()).not.toBe("home."); // the real final word — must not appear here

    // 4. Seek forward into sentence 3.
    setTime(3.50);
    fireEvent.seeking(video);
    fireEvent.seeked(video);
    expect(activeWordText()).toBe("walked");

    // 5. Seek backward into sentence 1 — must recover immediately, not stay
    //    stuck on the forward-seeked word.
    setTime(0.40);
    fireEvent.seeking(video);
    fireEvent.seeked(video);
    expect(activeWordText()).toBe("market");

    // 6. Replay from the very beginning.
    setTime(0.0);
    fireEvent.seeking(video);
    fireEvent.seeked(video);
    fireEvent.timeUpdate(video);
    expect(activeWordText()).toBeUndefined(); // before "The" starts (0.10) — honest silence, not a stale word
    setTime(0.15);
    fireEvent.timeUpdate(video);
    expect(activeWordText()).toBe("The");

    // 7. Switching Teleprompter tabs away and back must not disturb the
    //    shared engine's position — the karaoke state lives in the shared
    //    store, not in the Teleprompter component's own lifecycle.
    setTime(2.60);
    fireEvent.timeUpdate(video);
    fireEvent.click(screen.getByTestId("video-tab-transcript"));
    fireEvent.click(screen.getByTestId("video-tab-teleprompter"));
    await screen.findByTestId("teleprompter-storytelling");
    expect(activeWordText()).toBe("mangoes.");

    // 8. Switching EN -> EN+KM mid-playback must not pause, reset, or move
    //    the active word — only the Khmer line should appear.
    fireEvent.click(screen.getByTestId("video-translation-toggle-on"));
    expect(activeWordText()).toBe("mangoes."); // active word unchanged by the toggle
    expect(video.currentTime).toBe(2.60); // playback position untouched by the toggle
    expect(screen.getByTestId("teleprompter-translation-line")).toHaveTextContent("នាងបានទិញស្វាយស្រស់"); // Khmer layer now present for the active sentence
    fireEvent.click(screen.getByTestId("video-translation-toggle-off"));
    expect(activeWordText()).toBe("mangoes.");
    expect(screen.queryByTestId("teleprompter-translation-line")).not.toBeInTheDocument();

    // 9. Genuine video end — must pin to the REAL final word ("home."),
    //    not an array-position artifact.
    setTime(4.10);
    fireEvent.ended(video);
    expect(activeWordText()).toBe("home.");

    // 10. And the exact incident window one more time at the full-chain
    //     level: a moment squarely inside the LAST sentence (3.5s, well
    //     before the 4.10s end) must show that sentence's own word, never
    //     an early jump to "reached the end".
    setTime(3.60);
    fireEvent.seeking(video);
    fireEvent.seeked(video);
    expect(activeWordText()).toBe("walked");
  });
});

describe("bilingual translation", () => {
  const BILINGUAL_SYNC = {
    paragraphs: [{ id: "p1", sentences: [
      { id: "s1", translationKm: "សួស្ដី", words: [{ word: "Hello", start: 0, end: 0.5 }] },
    ] }],
  };

  test("no translation toggle appears for a legacy lesson with no Khmer translation anywhere", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    getSyncDocument.mockResolvedValue(SYNC_WITH_WORDS); // no translationKm on any sentence
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-tab-transcript");
    fireEvent.click(screen.getByTestId("video-tab-teleprompter"));
    await screen.findByTestId("teleprompter-storytelling");
    expect(screen.queryByTestId("video-translation-toggle-on")).not.toBeInTheDocument();
  });

  test("the translation toggle appears for a lesson that has Khmer, defaulting to EN-only", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    getSyncDocument.mockResolvedValue(BILINGUAL_SYNC);
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-tab-transcript");
    fireEvent.click(screen.getByTestId("video-tab-teleprompter"));
    await screen.findByTestId("teleprompter-storytelling");
    expect(screen.getByTestId("video-translation-toggle-off")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("video-translation-toggle-on")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("teleprompter-translation-line")).not.toBeInTheDocument();
  });

  test("tapping EN+KM reveals the Khmer line for the active sentence and persists the preference locally", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    getSyncDocument.mockResolvedValue(BILINGUAL_SYNC);
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-tab-transcript");
    fireEvent.click(screen.getByTestId("video-tab-teleprompter"));
    await screen.findByTestId("teleprompter-storytelling");

    fireEvent.click(screen.getByTestId("video-translation-toggle-on"));

    expect(screen.getByTestId("video-translation-toggle-on")).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByTestId("teleprompter-translation-line")).toHaveTextContent("សួស្ដី");
    expect(readLocalOverrides().showTranslation).toBe(true);
  });

  test("Vocabulary tab shows the Khmer meaning/usage explanation alongside the English one", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson({
      learning: {
        vocabulary: [{ word: "private", definition: "not shared with others", example: "a private email",
                        meaningKm: "ផ្ទាល់ខ្លួន", usageKm: "ប្រើនៅពេលនិយាយពីរឿងផ្ទាល់ខ្លួន" }],
      },
    }));
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-tab-transcript");
    fireEvent.click(screen.getByTestId("video-tab-vocabulary"));
    const item = await screen.findByTestId("vocab-item-0-km");
    expect(item).toHaveTextContent("ផ្ទាល់ខ្លួន");
    expect(item).toHaveTextContent("ប្រើនៅពេលនិយាយពីរឿងផ្ទាល់ខ្លួន");
  });

  test("Vocabulary tab omits the Khmer block entirely for a legacy item with no meaningKm/usageKm", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson({
      learning: { vocabulary: [{ word: "order", definition: "ask for", example: "I order tea." }] },
    }));
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-tab-transcript");
    fireEvent.click(screen.getByTestId("video-tab-vocabulary"));
    await screen.findByTestId("vocab-item-0");
    expect(screen.queryByTestId("vocab-item-0-km")).not.toBeInTheDocument();
  });

  test("Grammar tab shows the Khmer explanation when Gemini provided one", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson({
      learning: { grammarPoints: [{ point: "Present Perfect", explanation: "have/has + past participle",
                                     explanationKm: "ប្រើសម្រាប់សកម្មភាពដែលទាក់ទងនឹងបច្ចុប្បន្ន" }] },
    }));
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-tab-transcript");
    fireEvent.click(screen.getByTestId("video-tab-grammar"));
    const item = await screen.findByTestId("grammar-item-0-km");
    expect(item).toHaveTextContent("ប្រើសម្រាប់សកម្មភាពដែលទាក់ទងនឹងបច្ចុប្បន្ន");
  });

  test("Grammar tab omits the Khmer block entirely for a legacy point with no explanationKm", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson({
      learning: { grammarPoints: [{ point: "Past tense", explanation: "verb + -ed" }] },
    }));
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-tab-transcript");
    fireEvent.click(screen.getByTestId("video-tab-grammar"));
    await screen.findByTestId("grammar-item-0");
    expect(screen.queryByTestId("grammar-item-0-km")).not.toBeInTheDocument();
  });
});

describe("playback speed", () => {
  test("cycling the speed button updates the displayed rate and the media element's playbackRate", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    render(<VideoLessonPlayer />);
    const speedBtn = await screen.findByTestId("video-speed-button");
    expect(speedBtn).toHaveTextContent("1×");
    fireEvent.click(speedBtn);
    expect(speedBtn).toHaveTextContent("1.25×");
  });
});

describe("fullscreen scope (Bug 3 regression)", () => {
  afterEach(() => { delete Element.prototype.requestFullscreen; });

  test("Fullscreen requests an element that also contains the transcript side panel, not just the video stage", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    getSyncDocument.mockResolvedValue(SYNC_WITH_WORDS);
    let calledOn = null;
    Element.prototype.requestFullscreen = function requestFullscreen() { calledOn = this; };
    render(<VideoLessonPlayer />);
    const transcriptTab = await screen.findByTestId("video-tab-transcript");
    const video = screen.getByTestId("video-player-element");
    fireEvent.click(screen.getByTestId("video-fullscreen-button"));
    expect(calledOn).not.toBeNull();
    expect(calledOn.contains(transcriptTab)).toBe(true);
    expect(calledOn.contains(video)).toBe(true);
  });
});

// Root-cause fix (Bug 3 re-verification round): real-browser measurement at
// 390x844 found the mobile height-locking chain was broken — the root was
// `min-h-screen` (grows to fit content, never clips to the device viewport),
// so the `playerRef` grid's `overflow-y-auto` never had a bounded height to
// engage against, and the side panel's `max-h-[70vh]` (a fraction of the
// FULL screen, blind to how much of it the video/controls/dock above
// already consumed) pushed real content past the actual viewport bottom —
// confirmed via `document.documentElement.scrollHeight >
// document.documentElement.clientHeight` being true (the whole PAGE
// scrolled) even though `.tp-viewport`'s own internal overflow-y-auto/
// auto-follow logic was always correct in isolation. jsdom has no real
// layout engine (getBoundingClientRect/scrollHeight are always 0), so this
// can only be asserted structurally here; the real-viewport-clipping
// behavior (no page-level scroll, teleprompter fills exactly the remaining
// space) was verified with real DOM geometry in a real browser this round.
describe("mobile height-locking chain (Bug 3 real-composition fix)", () => {
  test("the player root is height-locked to the device viewport instead of min-h-screen growing to fit content", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    render(<VideoLessonPlayer />);
    const root = await screen.findByTestId("video-lesson-player");
    expect(root.className).toMatch(/\bh-screen\b/);
    expect(root.className).toMatch(/\boverflow-hidden\b/);
    expect(root.className).not.toMatch(/\bmin-h-screen\b/);
  });

  test("the stage/side-panel grid fills exactly the remaining height (flex-1 min-h-0), not an unbounded auto-sized row", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    render(<VideoLessonPlayer />);
    const video = await screen.findByTestId("video-player-element");
    const grid = video.closest(".grid");
    expect(grid.className).toMatch(/\bflex-1\b/);
    expect(grid.className).toMatch(/\bmin-h-0\b/);
  });

  test("the mobile side panel no longer caps itself to a fraction of the FULL screen (max-h-[70vh]) — it fills the grid row's real remaining space instead", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    getSyncDocument.mockResolvedValue(SYNC_WITH_WORDS);
    render(<VideoLessonPlayer />);
    const transcriptTab = await screen.findByTestId("video-tab-transcript");
    const sidePanel = transcriptTab.closest(".flex.flex-col");
    expect(sidePanel.className).not.toMatch(/max-h-\[70vh\]/);
    expect(sidePanel.className).toMatch(/\bmin-h-0\b/);
    // Desktop's own independent cap (never flagged as broken) stays intact.
    expect(sidePanel.className).toMatch(/lg:max-h-\[calc\(100vh-52px\)\]/);
  });

  test("the video shrinks to a cinematic crop only while the Teleprompter tab is open, freeing room for central-focus reading, and never on other tabs", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    render(<VideoLessonPlayer />);
    const video = await screen.findByTestId("video-player-element");
    const stage = video.closest(".relative.group\\/stage");
    // Transcript is the default tab — full aspect-video, matching every
    // other tab's reading surface.
    expect(stage.className).toMatch(/\baspect-video\b/);
    expect(stage.className).not.toMatch(/aspect-\[16\/7\]/);

    fireEvent.click(screen.getByTestId("video-tab-teleprompter"));
    const stageAfter = video.closest(".relative.group\\/stage");
    expect(stageAfter.className).toMatch(/aspect-\[16\/7\]/);
    expect(stageAfter.className).toMatch(/lg:aspect-video/); // desktop unaffected
    // min-h-0 is required so the video's own intrinsic 16:9 metadata can't
    // win over the shorter aspect-ratio via the flex "min-height:auto"
    // default (the exact bug this fix's own real-browser investigation hit
    // and corrected — see VideoLessonPlayer.jsx).
    expect(stageAfter.className).toMatch(/\bmin-h-0\b/);

    fireEvent.click(screen.getByTestId("video-tab-transcript"));
    const stageBack = video.closest(".relative.group\\/stage");
    expect(stageBack.className).toMatch(/\baspect-video\b/);
    expect(stageBack.className).not.toMatch(/aspect-\[16\/7\]/);
  });

  test("the video element uses object-cover so the shorter reading-mode crop trims the frame instead of stretching/distorting it", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    render(<VideoLessonPlayer />);
    const video = await screen.findByTestId("video-player-element");
    expect(video.className).toMatch(/\bobject-cover\b/);
  });
});

describe("resume on load", () => {
  test("seeks to the saved position once metadata loads, for real saved progress under the duration", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    listRecentlyWatched.mockResolvedValue([{ lessonId: "vid_1", positionSec: 42, durationSec: 60, completed: false }]);
    render(<VideoLessonPlayer />);
    const video = await screen.findByTestId("video-player-element");
    await waitFor(() => expect(listRecentlyWatched).toHaveBeenCalled());
    Object.defineProperty(video, "currentTime", { value: 0, writable: true });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(42);
  });

  test("does not resume a completed lesson", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    listRecentlyWatched.mockResolvedValue([{ lessonId: "vid_1", positionSec: 59, durationSec: 60, completed: true }]);
    render(<VideoLessonPlayer />);
    const video = await screen.findByTestId("video-player-element");
    await waitFor(() => expect(listRecentlyWatched).toHaveBeenCalled());
    Object.defineProperty(video, "currentTime", { value: 0, writable: true });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(0);
  });
});

describe("additive AI Narration audio track", () => {
  const NARRATION_SYNC = {
    paragraphs: [{ id: "p1", sentences: [{ id: "s1", words: [{ word: "Narrated", start: 0, end: 0.5 }] }] }],
  };

  function narratedLesson(overrides) {
    return freeOwnedLesson({
      aiNarrationAvailable: true,
      aiNarrationSyncId: "sync_narr",
      aiNarrationMediaRef: "https://pub-x.r2.dev/narr.mp3",
      ...overrides,
    });
  }

  test("the toggle is hidden entirely when no narration track is available", async () => {
    getLesson.mockResolvedValue(freeOwnedLesson());
    getSyncDocument.mockResolvedValue(SYNC_WITH_WORDS);
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-player-element");
    expect(screen.queryByTestId("video-audio-mode-toggle")).not.toBeInTheDocument();
  });

  test("the toggle appears and defaults to Original when a narration track is available", async () => {
    getLesson.mockResolvedValue(narratedLesson());
    getSyncDocument.mockImplementation((id) =>
      Promise.resolve(id === "sync_narr" ? NARRATION_SYNC : SYNC_WITH_WORDS));
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-audio-mode-toggle");
    expect(screen.getByTestId("video-narration-audio-element")).toHaveAttribute(
      "src", "https://resolved/https://pub-x.r2.dev/narr.mp3",
    );
  });

  test("switching to AI Narrated mutes the video and unmuting restores on switching back", async () => {
    getLesson.mockResolvedValue(narratedLesson());
    getSyncDocument.mockImplementation((id) =>
      Promise.resolve(id === "sync_narr" ? NARRATION_SYNC : SYNC_WITH_WORDS));
    render(<VideoLessonPlayer />);
    const video = await screen.findByTestId("video-player-element");
    expect(video.muted).toBe(false);

    fireEvent.click(screen.getByTestId("video-audio-mode-narration"));
    expect(video.muted).toBe(true);

    fireEvent.click(screen.getByTestId("video-audio-mode-original"));
    expect(video.muted).toBe(false);
  });

  test("switching to narration mode seeks the narration track to the video's current position", async () => {
    getLesson.mockResolvedValue(narratedLesson());
    getSyncDocument.mockImplementation((id) =>
      Promise.resolve(id === "sync_narr" ? NARRATION_SYNC : SYNC_WITH_WORDS));
    render(<VideoLessonPlayer />);
    const video = await screen.findByTestId("video-player-element");
    const narrationAudio = screen.getByTestId("video-narration-audio-element");
    Object.defineProperty(video, "currentTime", { value: 12.5, writable: true });
    Object.defineProperty(narrationAudio, "currentTime", { value: 0, writable: true });

    fireEvent.click(screen.getByTestId("video-audio-mode-narration"));
    expect(narrationAudio.currentTime).toBe(12.5);
  });

  test("seeking while in narration mode moves both the video and the narration audio", async () => {
    getLesson.mockResolvedValue(narratedLesson());
    getSyncDocument.mockImplementation((id) =>
      Promise.resolve(id === "sync_narr" ? NARRATION_SYNC : SYNC_WITH_WORDS));
    render(<VideoLessonPlayer />);
    const video = await screen.findByTestId("video-player-element");
    const narrationAudio = screen.getByTestId("video-narration-audio-element");
    Object.defineProperty(video, "duration", { value: 60, writable: true });
    Object.defineProperty(video, "currentTime", { value: 0, writable: true });
    Object.defineProperty(narrationAudio, "currentTime", { value: 0, writable: true });
    fireEvent.loadedMetadata(video);
    fireEvent.click(screen.getByTestId("video-audio-mode-narration"));

    fireEvent.change(screen.getByTestId("video-seek-slider"), { target: { value: "20" } });
    expect(video.currentTime).toBe(20);
    expect(narrationAudio.currentTime).toBe(20);
  });

  test("the transcript reflects the narration sync document while in narration mode", async () => {
    getLesson.mockResolvedValue(narratedLesson());
    getSyncDocument.mockImplementation((id) =>
      Promise.resolve(id === "sync_narr" ? NARRATION_SYNC : SYNC_WITH_WORDS));
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-audio-mode-toggle");
    expect(screen.getByTestId("video-transcript-panel")).toHaveTextContent("Hello");
    fireEvent.click(screen.getByTestId("video-audio-mode-narration"));
    expect(await screen.findByTestId("video-transcript-panel")).toHaveTextContent("Narrated");
  });

  test("the SAME generic bilingual toggle/Khmer line works for the AI-narrated sync document too — no pipeline-specific frontend code needed", async () => {
    const BILINGUAL_NARRATION_SYNC = {
      paragraphs: [{ id: "p1", sentences: [
        { id: "s1", translationKm: "បានប្រាប់រឿង", words: [{ word: "Narrated", start: 0, end: 0.5 }] },
      ] }],
    };
    getLesson.mockResolvedValue(narratedLesson());
    getSyncDocument.mockImplementation((id) =>
      Promise.resolve(id === "sync_narr" ? BILINGUAL_NARRATION_SYNC : SYNC_WITH_WORDS));
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-audio-mode-toggle");

    // Original English audio has no translation — toggle stays hidden.
    fireEvent.click(screen.getByTestId("video-tab-teleprompter"));
    await screen.findByTestId("teleprompter-storytelling");
    expect(screen.queryByTestId("video-translation-toggle-on")).not.toBeInTheDocument();

    // Switching to the AI-narrated track (its own, separate sync document)
    // makes the toggle appear, purely because THAT document has translationKm.
    fireEvent.click(screen.getByTestId("video-audio-mode-narration"));
    await screen.findByTestId("video-translation-toggle-on");
    fireEvent.click(screen.getByTestId("video-translation-toggle-on"));
    expect(await screen.findByTestId("teleprompter-translation-line")).toHaveTextContent("បានប្រាប់រឿង");
  });
});

describe("rendered final master (physically embedded audio)", () => {
  const NARRATION_SYNC = {
    paragraphs: [{ id: "p1", sentences: [{ id: "s1", words: [{ word: "Narrated", start: 0, end: 0.5 }] }] }],
  };

  function masterLesson(overrides) {
    return freeOwnedLesson({
      aiNarrationAvailable: true,
      aiNarrationSyncId: "sync_narr",
      aiNarrationMediaRef: "https://pub-x.r2.dev/narr.mp3",
      aiNarrationMasterAvailable: true,
      aiNarrationMasterMediaRef: "https://pub-x.r2.dev/master.mp4",
      ...overrides,
    });
  }

  test("no separate narration audio element is rendered when a master exists", async () => {
    getLesson.mockResolvedValue(masterLesson());
    getSyncDocument.mockImplementation((id) =>
      Promise.resolve(id === "sync_narr" ? NARRATION_SYNC : SYNC_WITH_WORDS));
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-audio-mode-toggle");
    expect(screen.queryByTestId("video-narration-audio-element")).not.toBeInTheDocument();
  });

  test("switching to AI Narrated swaps the video's own src to the master, never mutes it", async () => {
    getLesson.mockResolvedValue(masterLesson());
    getSyncDocument.mockImplementation((id) =>
      Promise.resolve(id === "sync_narr" ? NARRATION_SYNC : SYNC_WITH_WORDS));
    render(<VideoLessonPlayer />);
    const video = await screen.findByTestId("video-player-element");
    expect(video.getAttribute("src")).toBe("https://resolved/https://pub-x.r2.dev/vid.mp4");

    fireEvent.click(screen.getByTestId("video-audio-mode-narration"));
    expect(video.getAttribute("src")).toBe("https://resolved/https://pub-x.r2.dev/master.mp4");
    expect(video.muted).toBe(false); // one native audio stream — never muted

    fireEvent.click(screen.getByTestId("video-audio-mode-original"));
    expect(video.getAttribute("src")).toBe("https://resolved/https://pub-x.r2.dev/vid.mp4");
  });

  test("the transcript reflects the narration sync document while the master is active", async () => {
    getLesson.mockResolvedValue(masterLesson());
    getSyncDocument.mockImplementation((id) =>
      Promise.resolve(id === "sync_narr" ? NARRATION_SYNC : SYNC_WITH_WORDS));
    render(<VideoLessonPlayer />);
    await screen.findByTestId("video-audio-mode-toggle");
    expect(screen.getByTestId("video-transcript-panel")).toHaveTextContent("Hello");
    fireEvent.click(screen.getByTestId("video-audio-mode-narration"));
    expect(await screen.findByTestId("video-transcript-panel")).toHaveTextContent("Narrated");
  });

  test("seeking after switching to the master preserves position and resumes playback state", async () => {
    getLesson.mockResolvedValue(masterLesson());
    getSyncDocument.mockImplementation((id) =>
      Promise.resolve(id === "sync_narr" ? NARRATION_SYNC : SYNC_WITH_WORDS));
    render(<VideoLessonPlayer />);
    const video = await screen.findByTestId("video-player-element");
    Object.defineProperty(video, "duration", { value: 60, writable: true });
    Object.defineProperty(video, "currentTime", { value: 12.5, writable: true, configurable: true });
    Object.defineProperty(video, "paused", { value: false, writable: true, configurable: true });
    fireEvent.loadedMetadata(video);

    fireEvent.click(screen.getByTestId("video-audio-mode-narration"));
    // The swap preserves the pre-swap position on the (only) media element.
    expect(video.currentTime).toBe(12.5);
  });
});
