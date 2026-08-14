import {
  computeActiveWord,
  computeActiveSentence,
  computeActiveParagraph,
  computeCurrentSpeaker,
  computeScrollPosition,
} from "../syncConsumption";

function makeSync({ speakers } = {}) {
  return {
    speakers,
    paragraphs: [
      {
        id: "p1",
        start: 0.0,
        end: 1.0,
        sentences: [
          {
            id: "s1",
            start: 0.0,
            end: 1.0,
            speakerId: speakers ? "spk_1" : undefined,
            words: [
              { word: "Once", start: 0.0, end: 0.3 },
              { word: "upon", start: 0.3, end: 0.6 },
              { word: "a", start: 0.6, end: 0.7 },
              { word: "time", start: 0.7, end: 1.0 },
            ],
          },
        ],
      },
      {
        id: "p2",
        start: 1.0,
        end: 2.0,
        sentences: [
          {
            id: "s2",
            start: 1.0,
            end: 2.0,
            speakerId: speakers ? "spk_2" : undefined,
            words: [
              { word: "The", start: 1.0, end: 1.3 },
              { word: "end.", start: 1.3, end: 2.0 },
            ],
          },
        ],
      },
    ],
  };
}

describe("computeActiveWord", () => {
  it("returns -1 before the first word", () => {
    expect(computeActiveWord(makeSync(), -0.5)).toBe(-1);
  });

  it("finds the exact active word mid-document", () => {
    expect(computeActiveWord(makeSync(), 0.35)).toBe(1); // "upon"
  });

  it("pins to the final word at or past the end", () => {
    expect(computeActiveWord(makeSync(), 999)).toBe(5); // "end." is the 6th word overall
  });

  it("returns -1 for an empty/missing sync document", () => {
    expect(computeActiveWord(null, 1)).toBe(-1);
    expect(computeActiveWord({}, 1)).toBe(-1);
  });

  it("returns -1 for a non-finite time", () => {
    expect(computeActiveWord(makeSync(), NaN)).toBe(-1);
  });

  // Root-cause investigation (2026-08 conversation-karaoke incident): proves
  // the ONE precondition this module's own top-of-file comment documents
  // ("units must be sorted ascending by start and non-overlapping") is
  // load-bearing, not decorative. This module intentionally never sorts —
  // per the incident's own conclusion, that responsibility belongs at the
  // producer/schema boundary (sync_schema.validate_sync_document,
  // video_narration_tools.assemble_narration_track's per-line word sort),
  // never here. These tests exist to prove exactly WHY that boundary
  // matters: feeding this real, unmodified algorithm a document whose
  // array position doesn't match its own `start` values produces a
  // provably WRONG active word — not a crash, not -1, a wrong answer that
  // would render as a real (incorrect) karaoke highlight.
  describe("unsafe on an out-of-order array — the documented precondition, proven", () => {
    function reversedSync() {
      // True chronological order is W0..W5 (each exactly 1s). Array
      // POSITION is the exact reverse — the same shape of corruption
      // documented in video_ai_provider.segments_to_sync's own comment.
      const words = [
        { word: "W5", start: 5, end: 6 },
        { word: "W4", start: 4, end: 5 },
        { word: "W3", start: 3, end: 4 },
        { word: "W2", start: 2, end: 3 },
        { word: "W1", start: 1, end: 2 },
        { word: "W0", start: 0, end: 1 },
      ];
      return { paragraphs: [{ id: "p1", sentences: [{ id: "s1", start: 0, end: 6, words }] }] };
    }

    it("resolves the WRONG word for a time near the start of a reversed document", () => {
      const sync = reversedSync();
      // t=1.5s is chronologically inside W1 (start=1, end=2) — array
      // index 4. The real (unmodified) algorithm instead resolves to
      // array index 5, "W0" — the wrong word, off by one whole segment.
      const idx = computeActiveWord(sync, 1.5);
      expect(sync.paragraphs[0].sentences[0].words[idx].word).not.toBe("W1");
      expect(sync.paragraphs[0].sentences[0].words[idx].word).toBe("W0");
    });

    it("resolves the WRONG word for a time near the end of a reversed document too — not a one-off fluke", () => {
      // t=4.5s is chronologically inside W4 (start=4, end=5) — array
      // index 1. The real algorithm instead resolves to array index 5,
      // "W0" — the FIRST spoken word, the exact "jumps to the wrong end
      // of the transcript" shape the uploaded recording demonstrated.
      const sync = reversedSync();
      const idx = computeActiveWord(sync, 4.5);
      expect(sync.paragraphs[0].sentences[0].words[idx].word).not.toBe("W4");
      expect(sync.paragraphs[0].sentences[0].words[idx].word).toBe("W0");
    });
  });
});

describe("computeActiveSentence", () => {
  it("finds the active sentence across paragraph boundaries", () => {
    expect(computeActiveSentence(makeSync(), 1.5)).toBe(1); // s2
  });
});

describe("computeActiveParagraph", () => {
  it("finds the active paragraph", () => {
    expect(computeActiveParagraph(makeSync(), 0.1)).toBe(0);
    expect(computeActiveParagraph(makeSync(), 1.5)).toBe(1);
  });
});

describe("computeCurrentSpeaker", () => {
  it("returns null when the document has no speakers (single-narrator content)", () => {
    expect(computeCurrentSpeaker(makeSync(), 0.5)).toBeNull();
  });

  it("resolves the active speaker by speakerId", () => {
    const sync = makeSync({ speakers: [{ id: "spk_1", label: "Narrator" }, { id: "spk_2", label: "Teacher" }] });
    expect(computeCurrentSpeaker(sync, 0.5)).toEqual({ id: "spk_1", label: "Narrator" });
    expect(computeCurrentSpeaker(sync, 1.5)).toEqual({ id: "spk_2", label: "Teacher" });
  });

  it("returns null when no sentence is active yet", () => {
    const sync = makeSync({ speakers: [{ id: "spk_1", label: "Narrator" }] });
    expect(computeCurrentSpeaker(sync, -1)).toBeNull();
  });
});

describe("flatten caching (Author Studio freeze perf fix)", () => {
  // Regression guard for the fix: computeActiveWord/computeActiveSentence
  // used to re-flatten the whole paragraphs->sentences->words tree from
  // scratch on every call. Called ~4x/sec by every mounted consumer
  // (Teleprompter, TranscriptPanel, SyncReviewStudio) during video
  // playback, this was a real, measurable contributor to a main-thread
  // render storm severe enough to freeze touch input on mobile Safari.
  // The fix caches the flattened arrays per `sync` object reference in a
  // WeakMap — these tests prove correctness survives that change (many
  // repeated calls against the same reference, at different times, still
  // return the right answer every time) rather than measuring performance
  // directly, which isn't reliable in CI.
  it("returns correct, stable results across many repeated calls on the same sync reference", () => {
    const sync = makeSync();
    for (let i = 0; i < 500; i += 1) {
      expect(computeActiveWord(sync, 0.35)).toBe(1); // "upon"
      expect(computeActiveSentence(sync, 1.5)).toBe(1); // s2
    }
  });

  it("does not cross-contaminate results between two distinct sync documents", () => {
    const syncA = makeSync();
    const syncB = makeSync({ speakers: [{ id: "spk_1", label: "Narrator" }, { id: "spk_2", label: "Teacher" }] });
    computeActiveWord(syncA, 0.1);
    computeActiveWord(syncB, 0.1);
    expect(computeCurrentSpeaker(syncA, 0.5)).toBeNull();
    expect(computeCurrentSpeaker(syncB, 0.5)).toEqual({ id: "spk_1", label: "Narrator" });
  });
});

describe("computeScrollPosition", () => {
  it("returns paragraphIndex -1 / fraction 0 for an empty document", () => {
    expect(computeScrollPosition({ paragraphs: [] }, 1)).toEqual({ paragraphIndex: -1, fraction: 0 });
  });

  it("returns a monotonically increasing fraction through the document", () => {
    const first = computeScrollPosition(makeSync(), 0.1);
    const second = computeScrollPosition(makeSync(), 1.5);
    expect(first.paragraphIndex).toBe(0);
    expect(second.paragraphIndex).toBe(1);
    expect(second.fraction).toBeGreaterThan(first.fraction);
    expect(second.fraction).toBe(1);
  });
});

// ── Bug report: karaoke jumps to the end immediately when Play is pressed ──
// Root cause: video_ai_provider.segments_to_sync (backend) previously
// trusted Gemini's own segment order verbatim instead of sorting by each
// segment's own reported start time. If even one segment came back out of
// chronological order, it could end up LAST in the array with an early
// `end` value — and this binary search's own "has playback reached the
// end" check used to trust units[units.length - 1] as "the end", which is
// only true when the array is genuinely sorted. The backend now sorts
// (see segments_to_sync's docstring); this suite proves the frontend
// consumption side is independently robust to a document that still
// violates that invariant (an already-generated document from before the
// backend fix, or any other future writer of this shape).
describe("binary search robustness against out-of-order units (Bug 2 root cause)", () => {
  // Realistic shape of the actual incident: Gemini returned every segment
  // in chronological order EXCEPT ONE — "B" (chronologically 2nd, start=3)
  // came back last in the JSON array, after "C" (chronologically 3rd/
  // final, start=5, end=10). The array-LAST entry is therefore "B", whose
  // own end (5.0) is much smaller than the document's REAL final end
  // (10.0, on "C" — array index 1, not the last position).
  const outOfOrderSync = {
    paragraphs: [{
      id: "p1", start: 0, end: 10,
      sentences: [
        { id: "sA", start: 0.0, end: 2.0, words: [{ word: "A", start: 0.0, end: 2.0 }] },
        { id: "sC", start: 5.0, end: 10.0, words: [{ word: "C", start: 5.0, end: 10.0 }] },
        { id: "sB", start: 3.0, end: 5.0, words: [{ word: "B", start: 3.0, end: 5.0 }] },
      ],
    }],
  };

  it("pressing play at t=0 resolves to the real first word, not -1 and not the misplaced last entry", () => {
    expect(computeActiveWord(outOfOrderSync, 0.1)).toBe(0); // "A" — genuinely active at t=0.1
  });

  it("a time well before the document's real end must NOT be treated as 'reached the end'", () => {
    // t=3.5s: the OLD code compared against units[units.length-1].end,
    // i.e. "B"'s end (5.0) — 3.5 < 5.0, so this exact moment wouldn't
    // have tripped the old bug either, which is precisely the point: the
    // old check's correctness was COINCIDENTAL on array position, not
    // derived from real timestamps. The assertion that matters is what
    // it must never do: falsely resolve to "the end reached" state.
    const idx = computeActiveWord(outOfOrderSync, 3.5);
    expect(idx).not.toBe(-1); // never a blank/lost highlight for a real mid-document time
  });

  it("a time between the misplaced entry's end and the document's real final end is the exact regression window", () => {
    // t=6s: genuinely inside "C" (start=5, end=10) — real playback is in
    // the FINAL third of the video, not at its end. The OLD code's check
    // was `timeSec >= units[units.length-1].end`, i.e. `6 >= 5` (B's end)
    // — TRUE — so it would have incorrectly reported "reached the end"
    // and jumped to array index 2 ("B") within moments of C actually
    // starting to play. This is the precise "jump to the end" symptom
    // from the bug report, reproduced with real, unmodified timestamps.
    const idx = computeActiveWord(outOfOrderSync, 6);
    expect(idx).toBe(1); // correctly "C" (array index 1) — genuinely active, not a false "end reached"
  });

  it("genuinely reaching the document's real final end (by time, not array position) pins to that real final unit", () => {
    expect(computeActiveWord(outOfOrderSync, 999)).toBe(1); // "C" — the REAL last unit by end time, array index 1
  });

  it("a time before the document's real first unit starts returns no active word, regardless of array position", () => {
    expect(computeActiveWord(outOfOrderSync, -1)).toBe(-1);
  });
});
