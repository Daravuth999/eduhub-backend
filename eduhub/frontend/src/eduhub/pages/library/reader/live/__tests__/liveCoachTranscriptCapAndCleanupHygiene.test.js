/**
 * liveCoachTranscriptCapAndCleanupHygiene.test.js — re-audit hardening
 * proof for two independent findings:
 *
 * 1. Unbounded transcript growth: LiveTranscriptPanel renders every entry
 *    of the `transcript` state array via a plain .map() with no
 *    virtualization or cap, and the array itself grew for the entire
 *    session with no bound. Capped to the most recent MAX_TRANSCRIPT_LINES
 *    utterance blocks (oldest dropped first — a live scrolling feed cares
 *    about recent context, unlike the backend's report transcript which
 *    keeps the earliest entries).
 *
 * 2. cleanup() hygiene: cleanup() is called from 3 sites (unmount effect,
 *    finishToReport, closeAll) but previously only closeAll() went on to
 *    null sessionRef.current itself afterward — every OTHER ref in
 *    cleanup() self-nulls right where it's used, sessionRef was the one
 *    exception.
 *
 * Uses the same source-level structural-assertion convention as
 * liveCoachWsErrorGrace.test.js / liveCoachTopupNudge.test.js — a full
 * WebSocket-driven mount of this component is impractical (mic capture,
 * audio player, multiple lazily-initialised controllers).
 */
import fs from "fs";
import path from "path";

const COMPONENT = fs.readFileSync(
  path.join(__dirname, "..", "EduTalkLiveCoach.jsx"), "utf8");

describe("re-audit fix: transcript array is capped, not unbounded", () => {
  test("MAX_TRANSCRIPT_LINES constant exists with a sane, generous bound", () => {
    const m = COMPONENT.match(/const MAX_TRANSCRIPT_LINES = (\d+);/);
    expect(m).not.toBeNull();
    const cap = Number(m[1]);
    expect(cap).toBeGreaterThan(50);   // generous enough for any normal session
    expect(cap).toBeLessThan(10000);   // still an actual bound, not decorative
  });

  test("the transcript-growth setTranscript() reducer applies the cap via slice()", () => {
    const idx = COMPONENT.indexOf('case "transcript":');
    // NOTE: 'case "turn_complete":' also appears earlier in the file inside
    // a separate, unrelated nested switch — search FROM idx so this finds
    // the case that actually closes the "transcript" case's block.
    const nextCase = COMPONENT.indexOf('case "turn_complete":', idx);
    expect(idx).toBeGreaterThan(-1);
    expect(nextCase).toBeGreaterThan(idx);
    const block = COMPONENT.slice(idx, nextCase);
    expect(block).toMatch(/next\.length > MAX_TRANSCRIPT_LINES/);
    expect(block).toMatch(/next\.slice\(next\.length - MAX_TRANSCRIPT_LINES\)/);
  });
});

describe("re-audit fix: cleanup() nulls sessionRef.current like every other ref", () => {
  test("cleanup() body contains an unconditional sessionRef.current = null", () => {
    const cleanupStart = COMPONENT.indexOf("const cleanup = useCallback(() => {");
    const cleanupEnd = COMPONENT.indexOf("}, []);", cleanupStart);
    expect(cleanupStart).toBeGreaterThan(-1);
    expect(cleanupEnd).toBeGreaterThan(cleanupStart);
    const body = COMPONENT.slice(cleanupStart, cleanupEnd);
    expect(body).toMatch(/sessionRef\.current = null;/);
  });

  test("finishToReport still captures session_id into a local var BEFORE calling cleanup() (safety precondition for the fix above)", () => {
    const start = COMPONENT.indexOf("const finishToReport = useCallback(");
    const end = COMPONENT.indexOf("[cleanup, config, setBalance]", start);
    expect(start).toBeGreaterThan(-1);
    const block = COMPONENT.slice(start, end);
    const sidIdx = block.indexOf("const sid = sessionRef.current?.session_id");
    const cleanupCallIdx = block.indexOf("cleanup();");
    expect(sidIdx).toBeGreaterThan(-1);
    expect(cleanupCallIdx).toBeGreaterThan(sidIdx);
  });
});
