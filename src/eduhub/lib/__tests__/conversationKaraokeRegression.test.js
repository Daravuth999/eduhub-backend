/**
 * conversationKaraokeRegression.test.js — permanent regression fixture for
 * the "Sealing the Deal" conversation-karaoke incident (2026-08).
 *
 * Evidence trail (see the session's investigation, not repeated here):
 *   1. Uploaded recording: at video.currentTime≈0, the Teleprompter
 *      highlighted "commitment." — the LAST word of the transcript.
 *   2. Root cause proven at the code level: assemble_narration_track (the
 *      AI-narrated conversation producer) had no defensive chronological
 *      sort, unlike its sibling ASR producer (segments_to_sync). Fixed at
 *      two points: a per-line word sort in assemble_narration_track, and a
 *      new chronological-invariant CHECK in sync_schema.validate_sync_
 *      document — the one gate every sync document (any producer) must
 *      pass through before persistence.
 *   3. Proven separately (syncConsumption.test.js) that the frontend's
 *      binary search is genuinely unsafe for an out-of-order array — which
 *      is exactly WHY the fix belongs at the producer/schema boundary, not
 *      as a frontend sort.
 *
 * This file proves the OTHER half: given a document that IS chronologically
 * ordered (what the backend fix now guarantees for every future document),
 * the real, unmodified frontend karaoke engine (useSyncHighlight +
 * syncConsumption) behaves correctly through an entire conversation
 * lifecycle — start, speaker turns, end, replay, seek, remount, and lesson
 * switch. Nothing here is a frontend workaround; it is proof the consumer
 * side already does the right thing once its one precondition is met.
 */
import { renderHook, act } from "@testing-library/react";
import { useSyncHighlight, buildSentenceMetas } from "../useSyncHighlight";
import { computeCurrentSpeaker } from "../syncConsumption";

beforeAll(() => {
  global.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
});

// Compact but genuinely multi-turn, matching the real recording's opening/
// closing lines and true alternating speaker structure. Word timestamps
// are the SAME shape assemble_narration_track now guarantees: strictly
// chronological across the whole document, array position matching start.
const SEALING_THE_DEAL_SYNC = {
  paragraphs: [
    {
      id: "p1",
      sentences: [
        {
          id: "s1", start: 0.0, end: 2.0, speakerId: "S1",
          words: [
            { word: "Welcome", start: 0.0, end: 0.5 },
            { word: "to", start: 0.5, end: 0.7 },
            { word: "the", start: 0.7, end: 0.9 },
            { word: "negotiation.", start: 0.9, end: 2.0 },
          ],
        },
        {
          id: "s2", start: 2.0, end: 4.0, speakerId: "S2",
          words: [
            { word: "Thanks", start: 2.0, end: 2.4 },
            { word: "for", start: 2.4, end: 2.6 },
            { word: "meeting", start: 2.6, end: 3.0 },
            { word: "today.", start: 3.0, end: 4.0 },
          ],
        },
        {
          id: "s3", start: 4.0, end: 6.0, speakerId: "S1",
          words: [
            { word: "Of", start: 4.0, end: 4.2 },
            { word: "course,", start: 4.2, end: 4.6 },
            { word: "I'll", start: 4.6, end: 4.8 },
            { word: "be", start: 4.8, end: 5.0 },
            { word: "upfront.", start: 5.0, end: 6.0 },
          ],
        },
        {
          id: "s4", start: 6.0, end: 8.0, speakerId: "S2",
          words: [
            { word: "Let's", start: 6.0, end: 6.3 },
            { word: "find", start: 6.3, end: 6.6 },
            { word: "a", start: 6.6, end: 6.7 },
            { word: "compromise.", start: 6.7, end: 8.0 },
          ],
        },
        {
          id: "s5", start: 8.0, end: 10.0, speakerId: "S1",
          words: [
            { word: "Thanks", start: 8.0, end: 8.4 },
            { word: "for", start: 8.4, end: 8.6 },
            { word: "watching.", start: 8.6, end: 9.0 },
            { word: "Remember", start: 9.0, end: 9.4 },
            { word: "commitment.", start: 9.4, end: 10.0 },
          ],
        },
      ],
    },
  ],
  speakers: [{ id: "S1", label: "S1" }, { id: "S2", label: "S2" }],
  durationSec: 10.0,
};

function makeVideo() {
  const el = document.createElement("video");
  Object.defineProperty(el, "currentTime", { value: 0, writable: true });
  Object.defineProperty(el, "duration", { value: 10.0, writable: true });
  Object.defineProperty(el, "paused", { value: true, writable: true });
  Object.defineProperty(el, "ended", { value: false, writable: true });
  return el;
}

function seek(el, t, { ended = false } = {}) {
  el.currentTime = t;
  el.ended = ended;
  act(() => el.dispatchEvent(new Event(ended ? "ended" : "seeked")));
}

describe("Conversation karaoke — full lifecycle against a correctly-ordered document", () => {
  test("start: currentTime=0 resolves the FIRST spoken word of the FIRST speaker — never the last", () => {
    const el = makeVideo();
    const ref = { current: el };
    const { result } = renderHook(() => useSyncHighlight(ref, SEALING_THE_DEAL_SYNC, 0));
    seek(el, 0.0);
    const { wordIdx, sentenceIdx } = result.current.getState();
    const metas = buildSentenceMetas(SEALING_THE_DEAL_SYNC);
    expect(sentenceIdx).toBe(0);
    const local = wordIdx - metas[sentenceIdx].wordOffset;
    expect(SEALING_THE_DEAL_SYNC.paragraphs[0].sentences[sentenceIdx].words[local].word).toBe("Welcome");
    expect(computeCurrentSpeaker(SEALING_THE_DEAL_SYNC, 0.0)).toEqual({ id: "S1", label: "S1" });
  });

  test("progress: currentTime increasing advances the active word strictly chronologically, never skipping backward", () => {
    const el = makeVideo();
    const ref = { current: el };
    const { result } = renderHook(() => useSyncHighlight(ref, SEALING_THE_DEAL_SYNC, 0));
    const seenSentenceIdx = [];
    for (const t of [0.1, 0.6, 2.1, 4.1, 6.1, 8.1, 9.5]) {
      seek(el, t);
      seenSentenceIdx.push(result.current.getState().sentenceIdx);
    }
    // Non-decreasing sentence index across the whole conversation.
    for (let i = 1; i < seenSentenceIdx.length; i++) {
      expect(seenSentenceIdx[i]).toBeGreaterThanOrEqual(seenSentenceIdx[i - 1]);
    }
    expect(seenSentenceIdx).toEqual([0, 0, 1, 2, 3, 4, 4]);
  });

  test("speaker change: S1 -> S2 -> S1 -> S2 selects the CORRECT next speaker's words at each turn boundary", () => {
    const points = [
      { t: 0.5, speaker: "S1" },
      { t: 2.5, speaker: "S2" },
      { t: 4.5, speaker: "S1" },
      { t: 6.5, speaker: "S2" },
      { t: 8.5, speaker: "S1" },
    ];
    for (const { t, speaker } of points) {
      const sp = computeCurrentSpeaker(SEALING_THE_DEAL_SYNC, t);
      expect(sp.id).toBe(speaker);
    }
  });

  test("end: currentTime near duration resolves the FINAL spoken sentence and word — 'commitment.'", () => {
    const el = makeVideo();
    const ref = { current: el };
    const { result } = renderHook(() => useSyncHighlight(ref, SEALING_THE_DEAL_SYNC, 0));
    seek(el, 9.95);
    const { wordIdx, sentenceIdx } = result.current.getState();
    const metas = buildSentenceMetas(SEALING_THE_DEAL_SYNC);
    expect(sentenceIdx).toBe(4);
    const local = wordIdx - metas[sentenceIdx].wordOffset;
    expect(SEALING_THE_DEAL_SYNC.paragraphs[0].sentences[4].words[local].word).toBe("commitment.");
  });

  test("replay: after ended, seeking back to 0 (the real player's restart behavior) resolves the FIRST word again — no stuck end-of-transcript state", () => {
    const el = makeVideo();
    const ref = { current: el };
    const { result } = renderHook(() => useSyncHighlight(ref, SEALING_THE_DEAL_SYNC, 0));
    seek(el, 9.95);
    expect(result.current.getState().sentenceIdx).toBe(4);
    seek(el, 0.0); // real <video> restart: currentTime resets to 0
    const { wordIdx, sentenceIdx } = result.current.getState();
    expect(sentenceIdx).toBe(0);
    expect(SEALING_THE_DEAL_SYNC.paragraphs[0].sentences[0].words[wordIdx].word).toBe("Welcome");
  });

  test("seek forward: jumping ahead resolves the correct corresponding phrase, not the previous one", () => {
    const el = makeVideo();
    const ref = { current: el };
    const { result } = renderHook(() => useSyncHighlight(ref, SEALING_THE_DEAL_SYNC, 0));
    seek(el, 0.1);
    expect(result.current.getState().sentenceIdx).toBe(0);
    seek(el, 6.7); // jump forward into sentence 4 ("Let's find a compromise.")
    const { wordIdx, sentenceIdx } = result.current.getState();
    expect(sentenceIdx).toBe(3);
    const metas = buildSentenceMetas(SEALING_THE_DEAL_SYNC);
    const local = wordIdx - metas[sentenceIdx].wordOffset;
    expect(SEALING_THE_DEAL_SYNC.paragraphs[0].sentences[3].words[local].word).toBe("compromise.");
  });

  test("seek backward: jumping back resolves the correct earlier phrase, not the one just left", () => {
    const el = makeVideo();
    const ref = { current: el };
    const { result } = renderHook(() => useSyncHighlight(ref, SEALING_THE_DEAL_SYNC, 0));
    seek(el, 8.5);
    expect(result.current.getState().sentenceIdx).toBe(4);
    seek(el, 2.5); // jump back into sentence 1 ("Thanks for meeting today.")
    const { sentenceIdx } = result.current.getState();
    expect(sentenceIdx).toBe(1);
  });

  test("Teleprompter remount: a fresh hook instance against a currentTime=0 element starts clean — never inherits a stale/final active index from a previous mount", () => {
    const el = makeVideo();
    const ref = { current: el };
    const first = renderHook(() => useSyncHighlight(ref, SEALING_THE_DEAL_SYNC, 0));
    seek(el, 9.95);
    expect(first.result.current.getState().sentenceIdx).toBe(4);
    first.unmount();

    // Remount: a genuinely NEW store (createSyncHighlightStore is called
    // fresh per hook instance via useMemo), against the element reset to
    // the start — exactly the "student reopens the Teleprompter" case.
    el.currentTime = 0;
    const second = renderHook(() => useSyncHighlight(ref, SEALING_THE_DEAL_SYNC, 0));
    seek(el, 0.0);
    expect(second.result.current.getState().sentenceIdx).toBe(0);
  });

  test("lesson switch: a different sync document replacing the old one resolves ITS OWN first word — never retains the previous lesson's state", () => {
    const OTHER_LESSON_SYNC = {
      paragraphs: [{
        id: "p1",
        sentences: [{
          id: "s1", start: 0, end: 1, speakerId: "Narrator",
          words: [{ word: "Once", start: 0, end: 0.5 }, { word: "upon", start: 0.5, end: 1.0 }],
        }],
      }],
    };
    const el = makeVideo();
    const ref = { current: el };
    const { result, rerender } = renderHook(
      ({ sync }) => useSyncHighlight(ref, sync, 0),
      { initialProps: { sync: SEALING_THE_DEAL_SYNC } },
    );
    seek(el, 9.95);
    expect(result.current.getState().sentenceIdx).toBe(4);

    // Switching lessons: new sync doc, media element reset to 0 (the real
    // VideoLessonPlayer behavior when navigating to a different lessonId).
    el.currentTime = 0;
    rerender({ sync: OTHER_LESSON_SYNC });
    seek(el, 0.0);
    const { wordIdx, sentenceIdx } = result.current.getState();
    expect(sentenceIdx).toBe(0);
    expect(OTHER_LESSON_SYNC.paragraphs[0].sentences[0].words[wordIdx].word).toBe("Once");
  });
});
