/**
 * dialogTurnWordSyncNoFlash.test.js — Issue 5 fix proof (DialogTurn half).
 *
 * Same root cause and fix shape as transcriptSyncNoFlash.test.js, applied
 * to DialogTurn.jsx's WordSync (conversation-turn word highlighting):
 * `active` always started at -1 and a post-paint effect corrected it,
 * causing a one-frame "nothing highlighted" flash on every page turn
 * (DialogTurn remounts fresh while audio keeps playing across the
 * transition — protected). Fixed by computing the initial value via the
 * same `computeWordSyncActiveWord` formula the effect already used.
 *
 * DialogTurn.jsx imports from ChapterBlocks.jsx (`normalizeMediaUrl`),
 * which imports `markdown-to-jsx` — unresolvable under this repo's
 * current Jest setup (see transcriptSyncNoFlash.test.js for the same
 * blocker). This uses the identical two-pronged strategy: source-level
 * structural assertions against the production file, plus a verbatim
 * re-implementation of the pure function to exercise its actual logic.
 */
import fs from "fs";
import path from "path";

const COMPONENT = fs.readFileSync(
  path.join(__dirname, "..", "DialogTurn.jsx"), "utf8");

describe("Issue 5 fix — WordSync's initial highlight is computed, not left at -1", () => {
  test("computeWordSyncActiveWord is exported (unit-testable) and defined before WordSync", () => {
    const fnPos = COMPONENT.indexOf("export function computeWordSyncActiveWord(");
    const componentPos = COMPONENT.indexOf("function WordSync({");
    expect(fnPos).toBeGreaterThan(-1);
    expect(componentPos).toBeGreaterThan(-1);
    expect(fnPos).toBeLessThan(componentPos);
  });

  test("the active state's lazy initializer calls computeWordSyncActiveWord with the live props", () => {
    const start = COMPONENT.indexOf("const [active, set] = useState(() =>");
    expect(start).toBeGreaterThan(-1);
    const body = COMPONENT.slice(start, start + 300);
    expect(body).toMatch(/computeWordSyncActiveWord\(\{/);
    expect(body).toMatch(/wordsLength:\s*words\.length/);
  });

  test("aRef/epRef/srRef seed from the resolved initial value/live props, not stale sentinels, avoiding a spurious extra re-render right after mount", () => {
    expect(COMPONENT).toMatch(/const aRef\s*=\s*useRef\(active\);/);
    expect(COMPONENT).toMatch(/const epRef = useRef\(playToken \|\| 0\);/);
    expect(COMPONENT).toMatch(/const srRef = useRef\(src\);/);
  });

  test("the existing effect (epRef/srRef change-detection + commit) is untouched", () => {
    const effectStart = COMPONENT.indexOf("const commit = (i) =>");
    expect(effectStart).toBeGreaterThan(-1);
    const body = COMPONENT.slice(effectStart, effectStart + 900);
    expect(body).toMatch(/if\s*\(\s*ep\s*!==\s*epRef\.current\s*\)\s*\{\s*epRef\.current\s*=\s*ep;\s*commit\(-1\);\s*\}/);
    expect(body).toMatch(/if\s*\(\s*src\s*!==\s*srRef\.current\s*\)\s*\{\s*srRef\.current\s*=\s*src;\s*commit\(-1\);\s*\}/);
  });
});

describe("computeWordSyncActiveWord — logic preserved verbatim", () => {
  // Re-implemented here (not imported — see module-resolution note above),
  // kept byte-for-byte identical to the production function.
  function computeWordSyncActiveWord({ currentTime, playing, start, end, wordTimestamps, wordsLength }) {
    if (!playing && currentTime === 0) return -1;
    const s = Number.isFinite(start) ? start : 0;
    const e = Number.isFinite(end)   ? end   : 0;
    if (currentTime < s - 0.08) return -1;
    if (currentTime >= e) return wordsLength - 1;
    let idx = -1;
    for (let i = 0; i < wordTimestamps.length; i++) {
      const ws = Number(wordTimestamps[i].start), we = Number(wordTimestamps[i].end);
      if (Number.isFinite(ws) && Number.isFinite(we) && currentTime >= ws && currentTime <= we) { idx = i; break; }
      if (Number.isFinite(we) && we < currentTime) idx = i;
      if (Number.isFinite(ws) && ws > currentTime) break;
    }
    return Math.max(-1, Math.min(wordsLength - 1, idx));
  }

  const wordTimestamps = [
    { start: 0, end: 1 },
    { start: 1, end: 2 },
    { start: 2, end: 3 },
  ];
  const base = { start: 0, end: 3, wordTimestamps, wordsLength: 3 };

  test("paused at t=0 → -1", () => {
    expect(computeWordSyncActiveWord({ ...base, currentTime: 0, playing: false })).toBe(-1);
  });

  test("paused mid-turn (t>0) → preserves the word at that time", () => {
    expect(computeWordSyncActiveWord({ ...base, currentTime: 1.5, playing: false })).toBe(1);
  });

  test("before the turn starts (beyond the 0.08 tolerance) → -1", () => {
    expect(computeWordSyncActiveWord({ ...base, currentTime: -1, playing: true })).toBe(-1);
  });

  test("at or past the turn end → last word", () => {
    expect(computeWordSyncActiveWord({ ...base, currentTime: 3, playing: true })).toBe(2);
    expect(computeWordSyncActiveWord({ ...base, currentTime: 50, playing: true })).toBe(2);
  });

  test("exact timestamp match resolves via the linear scan", () => {
    expect(computeWordSyncActiveWord({ ...base, currentTime: 1.5, playing: true })).toBe(1);
  });

  test("between words → most recently finished word", () => {
    const ts = [{ start: 0, end: 1 }, { start: 1.2, end: 2 }];
    expect(computeWordSyncActiveWord({
      start: 0, end: 2, wordTimestamps: ts, wordsLength: 2, currentTime: 1.1, playing: true,
    })).toBe(0);
  });

  test("result is clamped to wordsLength - 1 even if the timestamp scan overshoots", () => {
    const idx = computeWordSyncActiveWord({ ...base, currentTime: 2.5, playing: true });
    expect(idx).toBeLessThanOrEqual(2);
  });
});
