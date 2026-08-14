/**
 * eduTalkPasswordHydrationRace.test.js — P0 regression proof.
 *
 * Root cause (verified against actual AuthContext.jsx source): the 30-day
 * persistent profile cache strips `password`/`portalData.Password` before
 * writing to localStorage (stripSensitive()), by design. On every page
 * refresh / PWA reopen, `student` is first seeded from that stripped
 * cache — no password — and a SEPARATE async effect (AuthContext's v11.4
 * GAS re-hydration) re-fetches the real password shortly after. Nothing
 * that only needs isAuthenticated/studentId/points (Reader, balance,
 * Dashboard) is affected, so the rest of the PWA looks fully logged in,
 * but EduTalkPanel's old `_doStart` read a render-time snapshot and threw
 * "please log in again" immediately if that snapshot had no password —
 * even though the student WAS authenticated and the real password was
 * seconds away from arriving via the hydration effect already in flight.
 *
 * EduTalkPanel.jsx has no mountable Jest harness in this codebase
 * (documented precedent: readerPageSafePageIndex.test.js). This copies
 * the pure resolver/waiter verbatim and proves the actual race mechanics
 * with fake timers — same convention as paginationRemountCausality.test.js.
 */

function _resolvePassword(studentObj) {
  if (!studentObj) return "";
  if (studentObj.password) return String(studentObj.password);
  const pd = studentObj.portalData || {};
  return String(pd.Password ?? pd.password ?? "");
}

function _waitForPassword(studentRef, timeoutMs = 4000, intervalMs = 250) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const pw = _resolvePassword(studentRef.current);
      if (pw) return resolve(pw);
      if (Date.now() >= deadline) return resolve("");
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

const fs = require("fs");
const path = require("path");
const PANEL_SRC = fs.readFileSync(
  path.join(__dirname, "..", "EduTalkPanel.jsx"),
  "utf8",
);
const LIVE_COACH_SRC = fs.readFileSync(
  path.join(__dirname, "..", "live", "EduTalkLiveCoach.jsx"),
  "utf8",
);

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("MECHANISM: a stripped-cache student (cold start / refresh) resolves to no password, exactly matching stripSensitive()'s contract", () => {
  const strippedStudent = { studentId: "S1", name: "Dara", portalPoints: 170, portalData: { XP: 500 } }; // password + portalData.Password both absent, as stripSensitive() leaves them
  expect(_resolvePassword(strippedStudent)).toBe("");
});

test("REGRESSION (fixed): a tap during the hydration gap now waits and succeeds once the ref updates, instead of failing immediately", async () => {
  const studentRef = { current: { studentId: "S1", portalData: {} } }; // no password yet
  const waitPromise = _waitForPassword(studentRef, 4000, 250);

  // Simulate AuthContext's v11.4 re-hydration effect landing ~500ms later
  // (setStudent() with the real GAS-fetched password) — this is a REAL,
  // already-in-flight effect, not a hypothetical.
  setTimeout(() => {
    studentRef.current = { studentId: "S1", portalData: { Password: "real-pw-from-sheet" } };
  }, 500);

  jest.advanceTimersByTime(750);
  await Promise.resolve(); // flush the resolved setTimeout callback's microtask
  await jest.runOnlyPendingTimersAsync?.().catch(() => {}); // no-op if unsupported

  const result = await waitPromise;
  expect(result).toBe("real-pw-from-sheet");
});

test("HONEST FAILURE: if hydration genuinely never lands (GAS truly unreachable), the wait still terminates and reports no password", async () => {
  const studentRef = { current: { studentId: "S1", portalData: {} } };
  const waitPromise = _waitForPassword(studentRef, 4000, 250);
  jest.advanceTimersByTime(4001);
  const result = await waitPromise;
  expect(result).toBe("");
});

test("EduTalkPanel.jsx: _doStart no longer throws on the render-time snapshot alone — it waits via the live ref first", () => {
  expect(PANEL_SRC).toMatch(
    /const password = hasPassword \? resolvedPassword : await _waitForPassword\(studentRef\);/,
  );
  expect(PANEL_SRC).toContain('if (!password) {\n      throw new Error("Please refresh and log in again to use EduTalk.");');
});

test("EduTalkPanel.jsx: studentRef mirrors the live student value (same pattern AuthContext.jsx itself uses)", () => {
  expect(PANEL_SRC).toMatch(/const studentRef = useRef\(student\);/);
  expect(PANEL_SRC).toMatch(/useEffect\(\(\) => \{ studentRef\.current = student; \}, \[student\]\);/);
});

test("EduTalkLiveCoach.jsx: startSession waits for password AFTER player.resume() — never before it (iOS audio-unlock constraint preserved)", () => {
  const resumeIdx = LIVE_COACH_SRC.indexOf("player.resume();");
  const waitIdx = LIVE_COACH_SRC.indexOf("_waitForPassword(studentRef)", LIVE_COACH_SRC.indexOf("const startSession"));
  expect(resumeIdx).toBeGreaterThan(-1);
  expect(waitIdx).toBeGreaterThan(resumeIdx);
});

test("EduTalkLiveCoach.jsx: a failed password wait cleans up the audio player and resumes book audio, matching the mic-denied branch's own cleanup contract", () => {
  const idx = LIVE_COACH_SRC.indexOf("resolvedStartPassword");
  const block = LIVE_COACH_SRC.slice(idx, idx + 700);
  expect(block).toContain("playerRef.current?.close()");
  expect(block).toContain("setStarting(false)");
  expect(block).toContain("bookAudioWasPlayingRef.current");
});

test("P0-2: the visibilitychange handler resumes BOTH the playback player AND the mic capture (parity fix — see liveMicAudioContextRecovery.test.js for the liveAudio.js side)", () => {
  const idx = LIVE_COACH_SRC.indexOf("document.addEventListener(\"visibilitychange\"");
  const block = LIVE_COACH_SRC.slice(idx - 400, idx);
  expect(block).toContain("playerRef.current?.resume();");
  expect(block).toContain("stopMicRef.current?.resume?.();");
});
