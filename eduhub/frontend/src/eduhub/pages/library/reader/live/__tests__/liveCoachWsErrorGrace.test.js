/**
 * liveCoachWsErrorGrace.test.js — Issue 4 audit item "Issue 3" fix proof.
 *
 * Root cause: EduTalkLiveCoach's ws.onerror set connection state to
 * "reconnecting" but no reconnect logic exists anywhere — the backend's
 * live bridge finalizes (cancels) the entire Gemini session the moment its
 * own WebSocket closes, so a resumed client socket could never rejoin the
 * same live session. In the normal case ws.onclose follows onerror within
 * milliseconds and already finalizes via restEnd("ws_close"), refunding/
 * charging correctly. But if onclose is ever delayed or never arrives, the
 * student was left staring at a "Reconnecting…" promise indefinitely while
 * the mic and countdown timer kept running against a dead socket.
 *
 * Fix (additive, no reconnect protocol, no backend change):
 *   1. ws.onerror still sets "reconnecting" (unchanged, still gated by the
 *      existing V3 socket-identity check — see liveCoachStaleGenerationGuard
 *      .test.js), then arms a single bounded grace timer.
 *   2. If ws.onclose has not already finalized the session by the time the
 *      grace timer fires, it force-finalizes via the SAME REST path
 *      (restEnd) ws.onclose already uses — so refund/charge/report-card
 *      behaviour is identical to any other end reason, just bounded in time
 *      instead of indefinite.
 *   3. ws.onclose and cleanup() both clear the grace timer so the common
 *      case (onclose arrives promptly) never double-fires restEnd.
 *   4. LiveVoiceOrb's copy no longer promises a reconnect that never
 *      happens.
 *
 * This file uses the same repo convention as liveCoachStaleGenerationGuard
 * .test.js: source-level structural assertions against the actual
 * production component, since EduTalkLiveCoach's dependency surface (mic
 * capture, audio player, multiple lazily-initialised controllers) makes a
 * full WebSocket-driven mount impractical — no standalone helper
 * substitutes for the production code path.
 */
import fs from "fs";
import path from "path";

const COMPONENT = fs.readFileSync(
  path.join(__dirname, "..", "EduTalkLiveCoach.jsx"), "utf8");
const ORB = fs.readFileSync(
  path.join(__dirname, "..", "LiveVoiceOrb.jsx"), "utf8");

function extractBlock(source, header) {
  const start = source.indexOf(header);
  expect(start).toBeGreaterThan(-1);
  // Grab a generous slice — enough to cover the whole handler body.
  return source.slice(start, start + 2200);
}

describe("Issue 3 fix — bounded ws.onerror grace timer", () => {
  test("a dedicated ref backs the grace timer (not reused from an unrelated timer)", () => {
    expect(COMPONENT).toMatch(/const\s+wsErrorGraceTimerRef\s*=\s*useRef\(null\)/);
  });

  test("ws.onerror still gates on socket identity, still sets reconnecting, then arms a bounded timer", () => {
    const body = extractBlock(COMPONENT, "ws.onerror = () => {");
    const guardPos = body.indexOf("ws !== wsRef.current");
    const connPos = body.indexOf('setConnection("reconnecting")');
    const armPos = body.indexOf("wsErrorGraceTimerRef.current = setTimeout(");
    expect(guardPos).toBeGreaterThan(-1);
    expect(connPos).toBeGreaterThan(-1);
    expect(armPos).toBeGreaterThan(-1);
    // Order matters: identity check, then the (unchanged, protected) UI
    // state update, then the new bounded safety net.
    expect(guardPos).toBeLessThan(connPos);
    expect(connPos).toBeLessThan(armPos);
  });

  test("the grace timer's callback re-checks socket identity and ending/report state before finalizing", () => {
    const body = extractBlock(COMPONENT, "wsErrorGraceTimerRef.current = setTimeout(");
    // Must not blindly finalize — only if this is still the live socket and
    // the session hasn't already ended/reported through another path.
    expect(body).toMatch(/if\s*\(\s*ws\s*!==\s*wsRef\.current\s*\)\s*return/);
    expect(body).toMatch(
      /if\s*\(\s*endingRef\.current\s*\|\|\s*phaseRef\.current\s*===\s*"report"\s*\)\s*return/);
    expect(body).toMatch(/restEnd\("ws_error_timeout"\)/);
  });

  test("the grace timer uses a named, bounded constant (not a magic number, not unbounded)", () => {
    expect(COMPONENT).toMatch(/const\s+WS_ERROR_GRACE_MS\s*=\s*5_000/);
  });

  test("ws.onclose clears the grace timer before its own identity-gated finalize", () => {
    const body = extractBlock(COMPONENT, "ws.onclose = () => {");
    const guardPos = body.indexOf("ws !== wsRef.current");
    const clearPos = body.indexOf("clearTimeout(wsErrorGraceTimerRef.current)");
    const finalizePos = body.indexOf('restEnd("ws_close")');
    expect(guardPos).toBeGreaterThan(-1);
    expect(clearPos).toBeGreaterThan(-1);
    expect(finalizePos).toBeGreaterThan(-1);
    expect(guardPos).toBeLessThan(clearPos);
    expect(clearPos).toBeLessThan(finalizePos);
  });

  test("cleanup() also clears the grace timer (unmount / explicit end never leaves a stray finalize pending)", () => {
    const body = extractBlock(COMPONENT, "const cleanup = useCallback(() => {");
    expect(body).toMatch(/if\s*\(\s*wsErrorGraceTimerRef\.current\s*\)\s*clearTimeout\(wsErrorGraceTimerRef\.current\)/);
    expect(body).toMatch(/wsErrorGraceTimerRef\.current\s*=\s*null/);
  });
});

describe("Issue 3 fix — honest connection-lost copy", () => {
  test("LiveVoiceOrb no longer promises a reconnect that never happens", () => {
    expect(ORB).not.toMatch(/Reconnecting/);
  });

  test("the non-connected/non-connecting label communicates the session is ending, not recovering", () => {
    const connectingPos = ORB.indexOf('connection === "connecting"');
    const endingPos = ORB.indexOf("ending session");
    expect(connectingPos).toBeGreaterThan(-1);
    expect(endingPos).toBeGreaterThan(-1);
    expect(connectingPos).toBeLessThan(endingPos);
  });
});
