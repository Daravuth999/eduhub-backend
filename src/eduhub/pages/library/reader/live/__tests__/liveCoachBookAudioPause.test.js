/**
 * liveCoachBookAudioPause.test.js — book/coach audio overlap fix proof.
 *
 * Bug report: clicking "Start" on EduTalk Live Coach did not pause the
 * book's narration audio (a fully separate player) — both played at
 * once, the coach's speech and the narrator interfering with each other.
 * Root cause: EduTalkLiveCoach.jsx never imported/read the book audio
 * context at all (confirmed — zero references before this fix), so it
 * had no way to know or control whether narration was playing.
 *
 * Fix: startSession() pauses book audio (if currently playing) the
 * instant Start is tapped, and cleanup()/the two early-failure branches
 * resume it again — but ONLY if this component was the one that paused
 * it (bookAudioWasPlayingRef), so a student who had already paused the
 * book themselves never gets it auto-resumed.
 *
 * `bookAudio` (the context value) changes identity every currentTime
 * tick while narration plays. It is cached into a ref rather than added
 * to any useCallback's dependency array — depending on it directly would
 * recreate cleanup() every ~250ms and re-run the unmount effect
 * constantly. This file asserts that discipline holds.
 *
 * EduTalkLiveCoach.jsx cannot be mounted under this repo's Jest setup
 * (huge controller/context surface — see liveCoachStaleGenerationGuard
 * .test.js for precedent), so this follows the same source-level
 * structural-assertion convention used throughout this session's fixes.
 */
import fs from "fs";
import path from "path";

const COMPONENT = fs.readFileSync(
  path.join(__dirname, "..", "EduTalkLiveCoach.jsx"), "utf8");

function extractBlock(source, header, len = 1200) {
  const start = source.indexOf(header);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, start + len);
}

describe("book/coach audio overlap fix", () => {
  test("imports useBookAudio from the SAME AudioPlayerContext the book player uses (no second audio engine)", () => {
    expect(COMPONENT).toMatch(
      /import\s*\{\s*useBookAudio\s*\}\s*from\s*"\.\.\/AudioPlayerContext"/);
  });

  test("bookAudio is cached into a ref, not depended on directly, to avoid recreating cleanup() every currentTime tick", () => {
    expect(COMPONENT).toMatch(/const bookAudio = useBookAudio\(\);/);
    expect(COMPONENT).toMatch(/const bookAudioRef = useRef\(bookAudio\);/);
    expect(COMPONENT).toMatch(/bookAudioRef\.current = bookAudio;/);
  });

  test("a dedicated ref tracks whether WE paused book audio (never conflated with the student's own pause)", () => {
    expect(COMPONENT).toMatch(/const bookAudioWasPlayingRef = useRef\(false\);/);
  });

  test("startSession pauses book audio at the very top, before mic probe / API calls, capturing whether it was playing", () => {
    const body = extractBlock(COMPONENT, "const startSession = useCallback(async () => {", 2000);
    const capturePos = body.indexOf("bookAudioWasPlayingRef.current = !!bookAudioRef.current?.playing;");
    const pausePos = body.indexOf("bookAudioRef.current.pause();");
    const micProbePos = body.indexOf("getUserMedia");
    expect(capturePos).toBeGreaterThan(-1);
    expect(pausePos).toBeGreaterThan(-1);
    expect(micProbePos).toBeGreaterThan(-1);
    expect(capturePos).toBeLessThan(micProbePos);
    expect(pausePos).toBeLessThan(micProbePos);
  });

  test("both early-failure branches (mic denied, startLiveSession failure) resume book audio before returning", () => {
    const micFailBody = extractBlock(
      COMPONENT,
      'Please allow microphone access in your browser, then try again.',
      500,
    );
    expect(micFailBody).toMatch(/if \(bookAudioWasPlayingRef\.current\) \{/);
    expect(micFailBody).toMatch(/bookAudioRef\.current\?\.play\?\.\(\);/);

    const apiFailBody = extractBlock(
      COMPONENT,
      'setError(e?.message || "Could not start the session.");',
      500,
    );
    expect(apiFailBody).toMatch(/if \(bookAudioWasPlayingRef\.current\) \{/);
    expect(apiFailBody).toMatch(/bookAudioRef\.current\?\.play\?\.\(\);/);
  });

  test("cleanup() resumes book audio (covers every other exit path: normal end, WS drop, unmount, explicit close)", () => {
    const body = extractBlock(COMPONENT, "const cleanup = useCallback(() => {", 1500);
    expect(body).toMatch(/if \(bookAudioWasPlayingRef\.current\) \{/);
    expect(body).toMatch(/bookAudioWasPlayingRef\.current = false;/);
    expect(body).toMatch(/bookAudioRef\.current\?\.play\?\.\(\);/);
  });

  test("cleanup's resume block appears before the unrelated Issue-4 active-session-registry logic that follows it", () => {
    const body = extractBlock(COMPONENT, "const cleanup = useCallback(() => {", 1500);
    const resumePos = body.indexOf("bookAudioRef.current?.play?.();");
    const laterPos = body.indexOf("stopMicRef.current?.();");
    expect(resumePos).toBeGreaterThan(-1);
    expect(laterPos).toBeGreaterThan(-1);
    expect(resumePos).toBeLessThan(laterPos);
  });
});
