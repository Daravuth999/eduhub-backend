// syncConsumption.js — Universal Synchronization Engine, Reader consumption
// interface (Phase 0 — Universal Synchronization Foundation).
//
// Per docs/proposals/universal-synchronization-engine-technical-spec.md §7:
// operates on the CANONICAL synchronization schema (the backend's
// sync_schema.py document shape: paragraphs -> sentences -> words, each
// with {start, end}), using the same binary-search-with-tolerance
// discipline already proven in ChapterBlocks.jsx's computeTimestampActiveWord
// and DialogTurn.jsx's computeWordSyncActiveWord.
//
// Deliberately NOT wired into ChapterBlocks.jsx/DialogTurn.jsx in this pass
// — per the approved roadmap, Phase 0 is "no Reader modifications"
// (smart-books-engine-architecture-study.md §10). Those two files keep
// their own existing, untouched, already-tested legacy functions serving
// today's wordTimestamps-only books. Wiring the Reader to actually consume
// a fetched canonical sync document (via GET /api/sync/{syncId}) is Phase 3
// ("extend the highlight engine to sentence/paragraph granularity").
//
// This module is therefore new, self-contained, and additive: it changes
// no existing file's behavior and carries zero risk to the current Reader.

/**
 * Binary search with a small time-tolerance for floating-point boundaries,
 * falling back to "most recently finished unit" when between two units —
 * same discipline as ChapterBlocks.jsx's computeTimestampActiveWord.
 * `units` must be sorted ascending by start and non-overlapping.
 */
function binarySearchActiveIndex(units, timeSec) {
  if (!Array.isArray(units) || units.length === 0) return -1;
  if (!Number.isFinite(timeSec)) return -1;

  // Both "before the document even starts" and "has playback reached the
  // end" must be checked against the REAL earliest start / latest end
  // across every unit, never assumed to be units[0]/units[last] by array
  // POSITION. The backend now sorts provider segments chronologically
  // before building a sync document (see video_ai_provider.segments_to_
  // sync), but this stays a defense-in-depth check — not a load-bearing
  // fix — for any already-generated document from before that fix, or any
  // other future writer of this shape. Root-cause incident: one out-of-
  // order segment made the array's LAST entry (by position) an EARLY
  // sentence with a small `end`, so `timeSec >= units[last].end` started
  // being true almost immediately after playback began and stayed true
  // for the rest of the video — the karaoke highlight appeared to "jump
  // to the end" (the last-rendered item in the transcript) within seconds
  // of pressing Play, never recovering.
  let minStart = Infinity;
  let maxEnd = -Infinity;
  let maxEndIdx = units.length - 1;
  for (let i = 0; i < units.length; i++) {
    if (units[i].start < minStart) minStart = units[i].start;
    if (units[i].end >= maxEnd) {
      maxEnd = units[i].end;
      maxEndIdx = i;
    }
  }
  if (timeSec < minStart) return -1;
  if (timeSec >= maxEnd) return maxEndIdx;

  const TOL = 0.01;
  let lo = 0;
  let hi = units.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const u = units[mid];
    if (timeSec >= u.start - TOL && timeSec <= u.end + TOL) {
      found = mid;
      break;
    } else if (timeSec < u.start) {
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (found === -1) {
    for (let i = units.length - 1; i >= 0; i--) {
      if (units[i].end <= timeSec) {
        found = i;
        break;
      }
    }
  }
  return found;
}

function flattenSentencesRaw(sync) {
  const out = [];
  for (const p of sync?.paragraphs || []) {
    for (const s of p?.sentences || []) out.push(s);
  }
  return out;
}

// Perf fix: computeActiveWord/computeActiveSentence are called on every
// media `timeupdate` tick (~4/sec) by every mounted consumer (Teleprompter,
// TranscriptPanel, SyncReviewStudio) — re-flattening the whole document from
// scratch each call is O(n) work repeated needlessly, since a `sync` object
// is always treated as immutable in this codebase (every edit produces a
// brand-new object via setSync(await editSync(...)) rather than mutating in
// place). Caching the flattened arrays per `sync` reference in a WeakMap is
// therefore correctness-preserving (a given reference's flattened form never
// goes stale) and lets the GC reclaim the cache entry once that sync object
// is no longer referenced. Confirmed via Author Studio audit as one
// contributor to a real main-thread render-storm on long transcripts during
// video playback (see SyncReviewStudio.jsx's SentenceRow memoization fix for
// the other, larger contributor).
const _flattenCache = new WeakMap();

function getFlattened(sync) {
  if (!sync || typeof sync !== "object") return { sentences: [], words: [] };
  let cached = _flattenCache.get(sync);
  if (!cached) {
    const sentences = flattenSentencesRaw(sync);
    const words = [];
    for (const s of sentences) for (const w of s?.words || []) words.push(w);
    cached = { sentences, words };
    _flattenCache.set(sync, cached);
  }
  return cached;
}

function flattenSentences(sync) {
  return getFlattened(sync).sentences;
}

function flattenWords(sync) {
  return getFlattened(sync).words;
}

/** Index of the active word across the whole canonical sync document. */
export function computeActiveWord(sync, timeSec) {
  return binarySearchActiveIndex(flattenWords(sync), timeSec);
}

/** Index of the active sentence (flattened across all paragraphs). */
export function computeActiveSentence(sync, timeSec) {
  return binarySearchActiveIndex(flattenSentences(sync), timeSec);
}

/** Index of the active paragraph. */
export function computeActiveParagraph(sync, timeSec) {
  return binarySearchActiveIndex(sync?.paragraphs || [], timeSec);
}

/**
 * The speaker object ({id, label, ...}) active at `timeSec`, or null when
 * the document has no speakers (single-narrator content — spec §2) or no
 * sentence is active yet.
 */
export function computeCurrentSpeaker(sync, timeSec) {
  const sentences = flattenSentences(sync);
  const idx = binarySearchActiveIndex(sentences, timeSec);
  if (idx < 0) return null;
  const speakerId = sentences[idx]?.speakerId;
  if (!speakerId) return null;
  const speakers = sync?.speakers || [];
  return speakers.find((sp) => sp.id === speakerId) || { id: speakerId, label: speakerId };
}

/**
 * Auto-scroll positioning data for the active paragraph — returns the data
 * a Reader needs (which paragraph, how far through the document), not a
 * DOM scroll operation itself. `viewportMeta` is accepted for a future
 * Reader integration (e.g. element heights) and is currently unused by the
 * calculation; kept in the signature to match the agreed spec §7 interface
 * without a breaking change when that integration lands.
 */
export function computeScrollPosition(sync, timeSec, viewportMeta = {}) { // eslint-disable-line no-unused-vars
  const paragraphs = sync?.paragraphs || [];
  if (paragraphs.length === 0) return { paragraphIndex: -1, fraction: 0 };
  const idx = binarySearchActiveIndex(paragraphs, timeSec);
  if (idx < 0) return { paragraphIndex: -1, fraction: 0 };
  return { paragraphIndex: idx, fraction: (idx + 1) / paragraphs.length };
}
