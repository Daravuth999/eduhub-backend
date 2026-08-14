import { render, screen, fireEvent } from "@testing-library/react";
import Teleprompter from "../Teleprompter";

const TWO_SPEAKER_SYNC = {
  paragraphs: [
    {
      id: "p1",
      sentences: [
        { id: "s1", speakerId: "S1", words: [{ word: "Hello", start: 0, end: 1 }] },
        { id: "s2", speakerId: "S2", words: [{ word: "Hi", start: 1, end: 2 }, { word: "there", start: 2, end: 3 }] },
      ],
    },
  ],
  speakers: [{ id: "S1", label: "Teacher" }, { id: "S2", label: "Student" }],
};

const ONE_SPEAKER_SYNC = {
  paragraphs: [
    { id: "p1", sentences: [{ id: "s1", words: [{ word: "Once", start: 0, end: 1 }, { word: "upon", start: 1, end: 2 }] }] },
  ],
  speakers: [],
};

test("shows an honest empty state when there is no synchronized transcript yet", () => {
  render(<Teleprompter sync={null} currentTime={0} />);
  expect(screen.getByTestId("teleprompter-empty")).toBeInTheDocument();
});

test("auto mode resolves to conversation when 2+ speakers exist, with speaker labels shown", () => {
  render(<Teleprompter sync={TWO_SPEAKER_SYNC} currentTime={0} mode="auto" />);
  expect(screen.getByTestId("teleprompter-conversation")).toBeInTheDocument();
  expect(screen.getByText("Teacher")).toBeInTheDocument();
  expect(screen.getByText("Student")).toBeInTheDocument();
});

test("auto mode resolves to storytelling prose for a single-speaker (or speakerless) lesson", () => {
  render(<Teleprompter sync={ONE_SPEAKER_SYNC} currentTime={0} mode="auto" />);
  expect(screen.getByTestId("teleprompter-storytelling")).toBeInTheDocument();
});

test("an explicit mode prop overrides auto-detection", () => {
  render(<Teleprompter sync={TWO_SPEAKER_SYNC} currentTime={0} mode="storytelling" />);
  expect(screen.getByTestId("teleprompter-storytelling")).toBeInTheDocument();
});

test("clicking a word calls onSeek with that word's start time", () => {
  const onSeek = jest.fn();
  render(<Teleprompter sync={ONE_SPEAKER_SYNC} currentTime={0} mode="storytelling" onSeek={onSeek} />);
  fireEvent.click(screen.getByText("upon"));
  expect(onSeek).toHaveBeenCalledWith(1);
});

test("does not crash when the auto-scroll effect runs in an environment without Element.scrollTo", () => {
  // jsdom does not implement scrollTo — the follow tween writes scrollTop
  // directly, which must stay safe here.
  expect(typeof document.createElement("div").scrollTo).not.toBe("function");
  expect(() => render(<Teleprompter sync={TWO_SPEAKER_SYNC} currentTime={1.5} mode="conversation" />)).not.toThrow();
});

test("previously spoken sentences fade (reduced opacity) while the active sentence stays readable", () => {
  render(<Teleprompter sync={TWO_SPEAKER_SYNC} currentTime={2.5} mode="conversation" />);
  // t=2.5 → sentence 1 active ("there" active), sentence 0 past.
  expect(screen.getByTestId("teleprompter-sentence-0")).toHaveStyle({ opacity: "0.45" });
  expect(screen.getByTestId("teleprompter-sentence-1")).toHaveStyle({ opacity: "1" });
});

test("the word tracked by the media clock carries data-word-active", () => {
  render(<Teleprompter sync={TWO_SPEAKER_SYNC} currentTime={2.5} mode="conversation" />);
  expect(screen.getByText(/there/).getAttribute("data-word-active")).toBe("true");
  expect(screen.getByText(/Hello/).getAttribute("data-word-active")).toBeNull();
});

test("manual scroll suspends auto-follow and the Follow playback chip resumes it", () => {
  render(<Teleprompter sync={TWO_SPEAKER_SYNC} currentTime={0.5} mode="conversation" />);
  expect(screen.queryByTestId("teleprompter-follow-chip")).not.toBeInTheDocument();
  fireEvent.wheel(screen.getByTestId("teleprompter-conversation"));
  const chip = screen.getByTestId("teleprompter-follow-chip");
  fireEvent.click(chip);
  expect(screen.queryByTestId("teleprompter-follow-chip")).not.toBeInTheDocument();
});

test("media-clock mode: the host's media element drives highlighting without a currentTime prop", () => {
  const el = document.createElement("video");
  Object.defineProperty(el, "currentTime", { value: 0, writable: true });
  render(<Teleprompter sync={TWO_SPEAKER_SYNC} mediaRef={{ current: el }} mode="conversation" />);
  el.currentTime = 2.5;
  fireEvent(el, new Event("timeupdate"));
  expect(screen.getByText(/there/).getAttribute("data-word-active")).toBe("true");
});

// ── Bilingual (Khmer) translation layer — additive display only, never
//    timing-bearing. See teleprompterConfig.js's showTranslation and
//    sync_schema.py's translationKm (backend) for the full contract.
const BILINGUAL_SYNC = {
  paragraphs: [
    {
      id: "p1",
      sentences: [
        {
          id: "s1", translationKm: "សួស្ដី",
          words: [{ word: "Hello", start: 0, end: 1 }],
        },
        {
          id: "s2", // no translationKm — must render nothing, never a blank/placeholder line
          words: [{ word: "Bye", start: 1, end: 2 }],
        },
      ],
    },
  ],
  speakers: [],
};

test("translation ON shows the Khmer line only for the currently active sentence", () => {
  render(<Teleprompter sync={BILINGUAL_SYNC} currentTime={0.5} mode="storytelling"
                        config={{ showTranslation: true }} />);
  const lines = screen.getAllByTestId("teleprompter-translation-line");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toHaveTextContent("សួស្ដី");
});

test("translation OFF renders no Khmer line at all, even for a sentence that has one", () => {
  render(<Teleprompter sync={BILINGUAL_SYNC} currentTime={0.5} mode="storytelling"
                        config={{ showTranslation: false }} />);
  expect(screen.queryByTestId("teleprompter-translation-line")).not.toBeInTheDocument();
});

test("a sentence without translationKm never shows a Khmer line, even when it becomes active", () => {
  render(<Teleprompter sync={BILINGUAL_SYNC} currentTime={1.5} mode="storytelling"
                        config={{ showTranslation: true }} />);
  // t=1.5 -> sentence 1 ("Bye") is active, but it has no translationKm.
  expect(screen.queryByTestId("teleprompter-translation-line")).not.toBeInTheDocument();
});

test("translation ON vs OFF renders byte-identical English word timing/highlighting", () => {
  const { unmount } = render(
    <Teleprompter sync={BILINGUAL_SYNC} currentTime={0.5} mode="storytelling" config={{ showTranslation: true }} />,
  );
  expect(screen.getByText(/Hello/).getAttribute("data-word-active")).toBe("true");
  unmount();
  render(<Teleprompter sync={BILINGUAL_SYNC} currentTime={0.5} mode="storytelling" config={{ showTranslation: false }} />);
  expect(screen.getByText(/Hello/).getAttribute("data-word-active")).toBe("true");
});

test("Khmer translation is absent by default (showTranslation defaults to false)", () => {
  render(<Teleprompter sync={BILINGUAL_SYNC} currentTime={0.5} mode="storytelling" />);
  expect(screen.queryByTestId("teleprompter-translation-line")).not.toBeInTheDocument();
});

test("conversation mode also shows the Khmer line only for the active bubble", () => {
  const conversationBilingual = {
    paragraphs: [{ id: "p1", sentences: [
      { id: "s1", speakerId: "S1", translationKm: "មួយ", words: [{ word: "One", start: 0, end: 1 }] },
      { id: "s2", speakerId: "S2", translationKm: "ពីរ", words: [{ word: "Two", start: 1, end: 2 }] },
    ] }],
    speakers: [{ id: "S1", label: "A" }, { id: "S2", label: "B" }],
  };
  render(<Teleprompter sync={conversationBilingual} currentTime={0.5} mode="conversation"
                        config={{ showTranslation: true }} />);
  const lines = screen.getAllByTestId("teleprompter-translation-line");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toHaveTextContent("មួយ");
});

// ── Center-focus cinematic reading mode (config.centerFocus, opt-in,
//    default false) — the active sentence stays fully visible/untransformed
//    while past sentences fade+rise and upcoming sentences dim+approach.
//    See focusZone.js for the pure geometry this renders.
const THREE_SENTENCE_SYNC = {
  paragraphs: [{ id: "p1", sentences: [
    { id: "s1", words: [{ word: "First.", start: 0, end: 1 }] },
    { id: "s2", words: [{ word: "Second.", start: 1, end: 2 }] },
    { id: "s3", words: [{ word: "Third.", start: 2, end: 3 }] },
  ] }],
  speakers: [],
};

test("centerFocus off (default): sentences keep the original flat past/future opacity, no transform", () => {
  render(<Teleprompter sync={THREE_SENTENCE_SYNC} currentTime={1.5} mode="storytelling" />);
  expect(screen.getByTestId("teleprompter-sentence-0")).toHaveStyle({ opacity: "0.45" });
  expect(screen.getByTestId("teleprompter-sentence-1")).toHaveStyle({ opacity: "1" });
  expect(screen.getByTestId("teleprompter-sentence-2")).toHaveStyle({ opacity: "0.8" });
  expect(screen.getByTestId("teleprompter-sentence-1").style.transform).toBe("");
});

test("centerFocus on: the active sentence renders fully visible with no transform offset", () => {
  render(<Teleprompter sync={THREE_SENTENCE_SYNC} currentTime={1.5} mode="storytelling"
                        config={{ centerFocus: true }} />);
  const active = screen.getByTestId("teleprompter-sentence-1");
  expect(active).toHaveStyle({ opacity: "1" });
  expect(active.style.transform).toBe("translateY(0px) scale(1)");
});

test("centerFocus on: the already-spoken sentence fades below the flat 0.45 and rises (negative translateY)", () => {
  render(<Teleprompter sync={THREE_SENTENCE_SYNC} currentTime={1.5} mode="storytelling"
                        config={{ centerFocus: true }} />);
  const past = screen.getByTestId("teleprompter-sentence-0");
  const opacity = Number(past.style.opacity);
  expect(opacity).toBeLessThan(1);
  expect(past.style.transform).toMatch(/translateY\(-[\d.]+px\)/);
});

test("centerFocus on: the upcoming sentence dims and approaches (positive translateY)", () => {
  render(<Teleprompter sync={THREE_SENTENCE_SYNC} currentTime={1.5} mode="storytelling"
                        config={{ centerFocus: true }} />);
  const future = screen.getByTestId("teleprompter-sentence-2");
  const opacity = Number(future.style.opacity);
  expect(opacity).toBeLessThan(1);
  expect(future.style.transform).toMatch(/translateY\([\d.]+px\)/);
});

test("centerFocus on: conversation mode gets the same graduated fade treatment as storytelling", () => {
  render(<Teleprompter sync={TWO_SPEAKER_SYNC} currentTime={2.5} mode="conversation"
                        config={{ centerFocus: true }} />);
  const past = screen.getByTestId("teleprompter-sentence-0");
  const active = screen.getByTestId("teleprompter-sentence-1");
  expect(Number(past.style.opacity)).toBeLessThan(1);
  expect(active).toHaveStyle({ opacity: "1" });
  expect(active.style.transform).toBe("translateY(0px) scale(1)");
});

// ── End-of-transcript trailing spacer (Priority 2 refinement) — the
//    presentation-only fix letting the LAST sentence still reach the
//    center-focus anchor. jsdom has no real layout engine (every
//    clientHeight reads 0), so these prove the WIRING is correct — which
//    render path is used, and that it's scoped to centerFocus only — not
//    the exact pixel value, which is verified separately in a real browser
//    (see the session's real-browser measurement report).
test("centerFocus on: the trailing spacer is a measured element, not the fixed h-24 default", () => {
  render(<Teleprompter sync={THREE_SENTENCE_SYNC} currentTime={0.15} mode="storytelling"
                        config={{ centerFocus: true }} />);
  const spacer = screen.getByTestId("teleprompter-trailing-spacer");
  expect(spacer.style.height).not.toBe("");
  expect(spacer.className).not.toMatch(/h-24/);
});

test("centerFocus off (default): the trailing spacer stays the original fixed h-24 element, unmeasured", () => {
  render(<Teleprompter sync={THREE_SENTENCE_SYNC} currentTime={0.15} mode="storytelling" />);
  expect(screen.queryByTestId("teleprompter-trailing-spacer")).not.toBeInTheDocument();
});

test("centerFocus on: conversation mode also gets the measured trailing spacer", () => {
  render(<Teleprompter sync={TWO_SPEAKER_SYNC} currentTime={0.5} mode="conversation"
                        config={{ centerFocus: true }} />);
  expect(screen.getByTestId("teleprompter-trailing-spacer")).toBeInTheDocument();
});

test("centerFocus on: does not crash and still measures correctly across a sentence transition (e.g. reaching the final sentence)", () => {
  const { rerender } = render(
    <Teleprompter sync={THREE_SENTENCE_SYNC} currentTime={0.15} mode="storytelling" config={{ centerFocus: true }} />,
  );
  expect(screen.getByTestId("teleprompter-trailing-spacer")).toBeInTheDocument();
  // Progress to the last sentence — the exact scenario the spacer exists for.
  rerender(<Teleprompter sync={THREE_SENTENCE_SYNC} currentTime={2.5} mode="storytelling" config={{ centerFocus: true }} />);
  expect(screen.getByTestId("teleprompter-trailing-spacer")).toBeInTheDocument();
  expect(screen.getByText(/Third/)).toBeInTheDocument();
});

test("centerFocus never changes which word is highlighted or the karaoke data-word-active attribute", () => {
  const { unmount } = render(
    <Teleprompter sync={THREE_SENTENCE_SYNC} currentTime={1.5} mode="storytelling" config={{ centerFocus: false }} />,
  );
  expect(screen.getByText(/Second/).getAttribute("data-word-active")).toBe("true");
  unmount();
  render(<Teleprompter sync={THREE_SENTENCE_SYNC} currentTime={1.5} mode="storytelling" config={{ centerFocus: true }} />);
  expect(screen.getByText(/Second/).getAttribute("data-word-active")).toBe("true");
});
