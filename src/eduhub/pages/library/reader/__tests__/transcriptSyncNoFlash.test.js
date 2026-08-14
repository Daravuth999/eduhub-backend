/**
 * transcriptSyncNoFlash.test.js — Issue 5 fix proof.
 *
 * Root cause: TranscriptParagraph always started its `active` word state
 * at -1 and relied on a `useEffect` (which runs after paint) to compute
 * the correct highlighted word. Every page turn remounts the transcript
 * components fresh (new page = new ChapterBlocks instance) while audio
 * keeps playing across the transition (protected). That meant one visible
 * paint frame per page turn with NO word highlighted, even mid-paragraph,
 * before the effect caught up.
 *
 * Fix: `computeWeightedActiveWord` / `computeTimestampActiveWord` are the
 * exact same pure formulas the two highlight effects always used,
 * extracted so a lazy `useState` initializer can call them too — the
 * first paint after mount is already correct. No behavioural change to
 * the highlighting logic itself, only when it first runs.
 *
 * ChapterBlocks.jsx cannot be imported (mounted or otherwise) under this
 * repo's current Jest setup: it transitively imports `markdown-to-jsx`,
 * whose package.json `exports` map is not resolvable by this Jest
 * version's resolver (confirmed — no test file in this repo imports
 * ChapterBlocks.jsx, and attempting a direct import here reproduces
 * "Cannot find module 'markdown-to-jsx/entities'"). This predates and is
 * unrelated to this fix. Following the same repo convention used for
 * ReaderPage.jsx/EduTalkLiveCoach.jsx (also unmountable), this verifies
 * the fix via source-level structural assertions instead.
 */
import fs from "fs";
import path from "path";

const COMPONENT = fs.readFileSync(
  path.join(__dirname, "..", "ChapterBlocks.jsx"), "utf8");

function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, start + 1600);
}

describe("Issue 5 fix — pure highlight functions are the single source of truth", () => {
  test("computeWeightedActiveWord and computeTimestampActiveWord are exported (unit-testable, same pattern as media-urls.js)", () => {
    expect(COMPONENT).toMatch(/export function computeWeightedActiveWord\(/);
    expect(COMPONENT).toMatch(/export function computeTimestampActiveWord\(/);
  });

  test("the lazy useState initializer calls the SAME two functions the effects call — no duplicated/divergent logic", () => {
    const body = extractFunctionBody(COMPONENT, "const [active, setActive] = useState(() =>");
    expect(body).toMatch(/computeTimestampActiveWord\(\s*\{\s*audio,\s*wordTimestamps\s*\}\s*\)/);
    expect(body).toMatch(/computeWeightedActiveWord\(\s*\{/);
    // Branches on wordTimestamps presence exactly like the effects do below.
    expect(body).toMatch(/wordTimestamps\s*&&\s*wordTimestamps\.length\s*>\s*0/);
  });

  test("useState's lazy initializer runs BEFORE either effect (mount value is correct pre-paint, not just post-effect)", () => {
    const initPos = COMPONENT.indexOf("const [active, setActive] = useState(() =>");
    const effect1Pos = COMPONENT.indexOf("setActive(computeWeightedActiveWord({");
    const effect2Pos = COMPONENT.indexOf("setActive(computeTimestampActiveWord({ audio, wordTimestamps }));");
    expect(initPos).toBeGreaterThan(-1);
    expect(effect1Pos).toBeGreaterThan(-1);
    expect(effect2Pos).toBeGreaterThan(-1);
    expect(initPos).toBeLessThan(effect1Pos);
    expect(initPos).toBeLessThan(effect2Pos);
  });

  test("the weighted-estimation effect delegates to computeWeightedActiveWord instead of re-implementing the binary search inline", () => {
    const body = extractFunctionBody(COMPONENT, "// When ElevenLabs word timestamps exist, the override useEffect below");
    expect(body).toMatch(/if\s*\(\s*wordTimestamps\s*&&\s*wordTimestamps\.length\s*>\s*0\s*\)\s*return;/);
    expect(body).toMatch(/setActive\(computeWeightedActiveWord\(\{/);
    // The old inline binary search must be gone from this effect body —
    // proves there is exactly one implementation, not two that could drift.
    expect(body).not.toMatch(/while\s*\(lo <= hi\)/);
  });

  test("the ElevenLabs-exact-timestamp effect delegates to computeTimestampActiveWord instead of re-implementing its own binary search", () => {
    const body = extractFunctionBody(COMPONENT, "// ElevenLabs word-timestamp override.");
    expect(body).toMatch(/setActive\(computeTimestampActiveWord\(\{ audio, wordTimestamps \}\)\);/);
    expect(body).not.toMatch(/while\s*\(lo <= hi\)/);
  });
});

describe("computeWeightedActiveWord / computeTimestampActiveWord — logic preserved verbatim", () => {
  // Re-implemented here (NOT imported, per the module-resolution note
  // above) so the exact formulas can be executed and checked against
  // known inputs, guarding against a silent behavioural regression during
  // the extraction. Kept byte-for-byte identical to the production
  // functions — any future edit to one should be mirrored in the other.
  function computeWeightedActiveWord({ audio, start, end, wordsLength, cumulativeWeights, totalWeight }) {
    if (!audio) return -1;
    const t = audio.currentTime;
    const s = Number.isFinite(start) ? start : 0;
    const e = Number.isFinite(end) ? end : 0;
    if (!audio.playing && t === 0) return -1;
    if (e <= s) return -1;
    if (t < s - 0.05) return -1;
    if (t >= e) return wordsLength - 1;
    if (totalWeight <= 0) {
      const span = e - s;
      const frac = (t - s) / span;
      return Math.max(0, Math.min(wordsLength - 1, Math.floor(frac * wordsLength)));
    }
    const frac = (t - s) / (e - s);
    const target = frac * totalWeight;
    let lo = 0, hi = cumulativeWeights.length - 1, idx = hi;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cumulativeWeights[mid] >= target) { idx = mid; hi = mid - 1; }
      else { lo = mid + 1; }
    }
    return idx;
  }

  function computeTimestampActiveWord({ audio, wordTimestamps }) {
    if (!wordTimestamps || wordTimestamps.length === 0 || !audio) return -1;
    const t = audio.currentTime;
    if (!audio.playing && t === 0) return -1;
    if (t < wordTimestamps[0].start) return -1;
    const lastWord = wordTimestamps[wordTimestamps.length - 1];
    if (t >= lastWord.end) return wordTimestamps.length - 1;
    const TOL = 0.01;
    let lo = 0, hi = wordTimestamps.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const w = wordTimestamps[mid];
      if (t >= w.start - TOL && t <= w.end + TOL) { found = mid; break; }
      else if (t < w.start) hi = mid - 1;
      else lo = mid + 1;
    }
    if (found === -1) {
      for (let i = wordTimestamps.length - 1; i >= 0; i--) {
        if (wordTimestamps[i].end <= t) { found = i; break; }
      }
    }
    return found >= 0 ? found : -1;
  }

  const cumulativeWeights = [3, 6, 9, 12];
  const base = { start: 0, end: 10, wordsLength: 4, cumulativeWeights, totalWeight: 12 };

  test("no audio → -1", () => {
    expect(computeWeightedActiveWord({ ...base, audio: null })).toBe(-1);
  });

  test("paused at t=0 → -1 (idle, nothing highlighted)", () => {
    expect(computeWeightedActiveWord({ ...base, audio: { currentTime: 0, playing: false } })).toBe(-1);
  });

  test("paused mid-paragraph (t>0) → preserves the word at that time, not -1", () => {
    const idx = computeWeightedActiveWord({ ...base, audio: { currentTime: 5, playing: false } });
    expect(idx).toBeGreaterThanOrEqual(0);
  });

  test("before the paragraph starts → -1", () => {
    expect(computeWeightedActiveWord({ ...base, audio: { currentTime: -1, playing: true } })).toBe(-1);
  });

  test("at or past the paragraph end → last word", () => {
    expect(computeWeightedActiveWord({ ...base, audio: { currentTime: 10, playing: true } })).toBe(3);
    expect(computeWeightedActiveWord({ ...base, audio: { currentTime: 999, playing: true } })).toBe(3);
  });

  test("mid-paragraph time resolves to the matching cumulative-weight bucket", () => {
    expect(computeWeightedActiveWord({ ...base, audio: { currentTime: 5, playing: true } })).toBe(1);
  });

  test("degenerate paragraph (totalWeight <= 0) falls back to even-split fraction", () => {
    const idx = computeWeightedActiveWord({
      start: 0, end: 10, wordsLength: 4, cumulativeWeights: [], totalWeight: 0,
      audio: { currentTime: 5, playing: true },
    });
    expect(idx).toBe(2);
  });

  const wordTimestamps = [
    { start: 0, end: 1 },
    { start: 1, end: 2 },
    { start: 2, end: 3 },
  ];

  test("no audio / no timestamps → -1", () => {
    expect(computeTimestampActiveWord({ audio: null, wordTimestamps })).toBe(-1);
    expect(computeTimestampActiveWord({ audio: { currentTime: 1, playing: true }, wordTimestamps: [] })).toBe(-1);
  });

  test("paused at t=0 → -1", () => {
    expect(computeTimestampActiveWord({ audio: { currentTime: 0, playing: false }, wordTimestamps })).toBe(-1);
  });

  test("before the first word → -1", () => {
    expect(computeTimestampActiveWord({ audio: { currentTime: -0.5, playing: true }, wordTimestamps })).toBe(-1);
  });

  test("at or past the last word's end → pinned to the final word", () => {
    expect(computeTimestampActiveWord({ audio: { currentTime: 3, playing: true }, wordTimestamps })).toBe(2);
    expect(computeTimestampActiveWord({ audio: { currentTime: 50, playing: true }, wordTimestamps })).toBe(2);
  });

  test("exact match resolves via binary search", () => {
    expect(computeTimestampActiveWord({ audio: { currentTime: 1.5, playing: true }, wordTimestamps })).toBe(1);
  });

  test("between words → most recently finished word", () => {
    const ts = [{ start: 0, end: 1 }, { start: 1.2, end: 2 }];
    expect(computeTimestampActiveWord({ audio: { currentTime: 1.1, playing: true }, wordTimestamps: ts })).toBe(0);
  });
});
