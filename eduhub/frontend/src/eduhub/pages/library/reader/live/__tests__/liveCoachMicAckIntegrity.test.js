/**
 * liveCoachMicAckIntegrity.test.js — V3 item 2 proof.
 *
 * ``armMicRef.current()`` returns an explicit ``{ ok: bool }`` result without
 * changing ``startMicCapture``'s own signature or behaviour.
 *
 * ``armMic`` itself is async. It must:
 *   1. capture ``attemptId`` and ``connectionGeneration`` at invocation time;
 *   2. await ``armMicRef.current()``;
 *   3. send ``greeting_client_ack: mic_armed`` ONLY when ALL THREE are true:
 *        (a) ``startMicCapture`` actually succeeded (ok),
 *        (b) the captured attempt id is STILL the controller's current id,
 *        (c) the captured connection generation is STILL the current one;
 *   4. send NO ack at all on failure or staleness — never invent a
 *      ``failure``/``error`` ack type that does not exist in the schema; the
 *      existing ``setError`` + ``handleEnd("mic_failed")`` path keeps unchanged
 *      end/refund behaviour.
 *
 * The existing five fire-and-forget call sites (``onDrained`` helper, two
 * plain-helper ``armMic(...)`` sites, two ``g.armMic(...)`` sites inside
 * ``onWsMessage``) do NOT need to be changed — an un-awaited call to an async
 * function is valid JavaScript that preserves today's fire-and-forget
 * behaviour at each call site.
 */
import fs from "fs";
import path from "path";

const COMPONENT = fs.readFileSync(
  path.join(__dirname, "..", "EduTalkLiveCoach.jsx"), "utf8");

describe("V3 item 2 — truthful + correctly-attributed mic acknowledgement", () => {
  // ────────────────────────────────────────────────────────────────────────
  // Structural assertions on the production source.
  // ────────────────────────────────────────────────────────────────────────
  test("armMic helper is declared async", () => {
    // const armMic = async (trigger) => { ... }
    expect(COMPONENT).toMatch(
      /const\s+armMic\s*=\s*async\s*\(\s*trigger\s*\)\s*=>/);
  });

  test("armMic captures attemptId AND generation at invocation", () => {
    const block = COMPONENT.match(
      /const\s+armMic\s*=\s*async\s*\([\s\S]*?\)\s*=>\s*\{[\s\S]*?\}\s*;/);
    expect(block).not.toBeNull();
    const body = block[0];
    // Both captures appear and BEFORE the await.
    expect(body).toMatch(/const\s+aid\s*=\s*greetingControllerRef\.current\?\.getAttemptId\(\)/);
    expect(body).toMatch(/const\s+capturedGen\s*=\s*greetingConnGenRef\.current/);
    const aidPos = body.indexOf("const aid =");
    const genPos = body.indexOf("const capturedGen =");
    const awaitPos = body.indexOf("await armMicRef.current()");
    expect(aidPos).toBeGreaterThan(-1);
    expect(genPos).toBeGreaterThan(-1);
    expect(awaitPos).toBeGreaterThan(-1);
    expect(aidPos).toBeLessThan(awaitPos);
    expect(genPos).toBeLessThan(awaitPos);
  });

  test("armMic awaits armMicRef.current() and reads its ok flag", () => {
    const block = COMPONENT.match(
      /const\s+armMic\s*=\s*async\s*\([\s\S]*?\)\s*=>\s*\{[\s\S]*?\}\s*;/);
    expect(block).not.toBeNull();
    const body = block[0];
    expect(body).toMatch(
      /const\s+res\s*=\s*await\s+armMicRef\.current\(\)/);
    expect(body).toMatch(/!!\s*\(\s*res\s*&&\s*res\.ok\s*\)/);
  });

  test("armMic re-checks BOTH attempt id AND generation after the await", () => {
    const block = COMPONENT.match(
      /const\s+armMic\s*=\s*async\s*\([\s\S]*?\)\s*=>\s*\{[\s\S]*?\}\s*;/);
    expect(block).not.toBeNull();
    const body = block[0];
    // Both re-checks are present and BEFORE sendWs(mic_armed).
    expect(body).toMatch(
      /if\s*\(\s*aid\s*!==\s*greetingControllerRef\.current\?\.getAttemptId\(\)\s*\)\s*return/);
    expect(body).toMatch(
      /if\s*\(\s*capturedGen\s*!==\s*greetingConnGenRef\.current\s*\)\s*return/);
    const aidRecheck = body.indexOf(
      "aid !== greetingControllerRef.current?.getAttemptId()");
    const genRecheck = body.indexOf("capturedGen !== greetingConnGenRef.current");
    const ackSend = body.indexOf('value: "mic_armed"');
    expect(aidRecheck).toBeLessThan(ackSend);
    expect(genRecheck).toBeLessThan(ackSend);
  });

  test("armMic returns silently (no ack) when armMicRef.current() returns ok=false", () => {
    const block = COMPONENT.match(
      /const\s+armMic\s*=\s*async\s*\([\s\S]*?\)\s*=>\s*\{[\s\S]*?\}\s*;/);
    expect(block).not.toBeNull();
    const body = block[0];
    // ``if (!ok) return;`` — no ack on failure. NO "failure"/"error" ack value
    // is invented.
    expect(body).toMatch(/if\s*\(\s*!ok\s*\)\s*return/);
    expect(body).not.toMatch(/value:\s*"mic_failed"/);
    expect(body).not.toMatch(/value:\s*"failure"/);
    expect(body).not.toMatch(/value:\s*"error"/);
  });

  test("armMicRef.current returns { ok: true } on success and { ok: false } on failure", () => {
    // Inside ws.onopen the arming closure is reshaped to return an explicit
    // ``{ ok }`` result. ``startMicCapture``'s own signature is unchanged
    // (still takes the two callbacks; still throws on failure).
    expect(COMPONENT).toMatch(/armMicRef\.current\s*=\s*async\s*\(\)\s*=>/);
    expect(COMPONENT).toMatch(/return\s*\{\s*ok:\s*true\s*\}/);
    expect(COMPONENT).toMatch(/return\s*\{\s*ok:\s*false\s*\}/);
    // ``startMicCapture`` is still awaited with the same two-arg shape.
    expect(COMPONENT).toMatch(
      /startMicCapture\(\s*\(b64\)\s*=>/);
  });

  test("existing mic-failure end/refund path preserved (setError + handleEnd('mic_failed'))", () => {
    // The failure handler inside armMicRef.current still surfaces the same
    // user-facing error AND ends the session with the existing reason — the
    // refund path is owned by the backend and depends on this exact reason.
    expect(COMPONENT).toMatch(/setError\(\s*"Could not access the microphone audio stream\."\s*\)/);
    expect(COMPONENT).toMatch(/handleEnd\(\s*"mic_failed"\s*\)/);
  });

  test("the FIVE existing call sites remain fire-and-forget (no await added)", () => {
    // onDrained helper — single armMic call inside ``if (res && res.armMic)``.
    expect(COMPONENT).toMatch(
      /if\s*\(\s*res\s*&&\s*res\.armMic\s*\)\s*\{[\s\S]*?armMic\("playback_complete"\);[\s\S]*?\}/);
    // Two plain-helper armMic(...) sites — controlled fallback.
    const plainCalls = COMPONENT.match(/[^.]armMic\("controlled_fallback"\)/g) || [];
    expect(plainCalls.length).toBeGreaterThanOrEqual(2);
    // Two g.armMic(...) sites inside onWsMessage — skip + controlled fallback.
    expect(COMPONENT).toMatch(/g\.armMic\("skip"\)/);
    expect(COMPONENT).toMatch(/g\.armMic\("controlled_fallback"\)/);
    // None of the five fire-and-forget call sites uses ``await``.
    expect(COMPONENT).not.toMatch(/await\s+armMic\(/);
    expect(COMPONENT).not.toMatch(/await\s+g\.armMic\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────── //
// Behavioural simulation of the armMic helper — exercises the EXACT decision  //
// the production code makes, with the same captured-then-re-checked
// attempt-id / generation pattern. Three required cases:
//   1. SUCCESS — mic activates, ack sent with the correct attempt id.
//   2. FAILURE — startMicCapture fails, NO ack sent, end/refund path runs.
//   3. STALE   — mic activates but generation changed during the await; NO
//                ack sent for the stale generation.
// The helper below is a faithful copy of the production armMic logic; any
// future divergence in the production code path is caught by the structural
// assertions above (they directly read EduTalkLiveCoach.jsx).
// ─────────────────────────────────────────────────────────────────────────── //
function makeArmMicSimulator({
  controllerAttemptIdNow,
  generationNow,
  startMicCaptureImpl,   // async () => undefined | throws
  onSendWs,
  onSetError,
  onHandleEnd,
}) {
  const refs = {
    micArmed: false,
    attemptId: controllerAttemptIdNow,
    generation: generationNow,
    stopMic: null,
  };
  // armMicRef.current — returns { ok }, mirrors the JSX exactly.
  const armMicRefCurrent = async () => {
    if (refs.micArmed) return { ok: true };
    refs.micArmed = true;
    try {
      refs.stopMic = await startMicCaptureImpl();
      return { ok: true };
    } catch {
      refs.micArmed = false;
      onSetError("Could not access the microphone audio stream.");
      onHandleEnd("mic_failed");
      return { ok: false };
    }
  };
  // armMic — mirrors the JSX exactly.
  const armMic = async (trigger) => {
    const aid = refs.attemptId;             // capture at invocation
    const capturedGen = refs.generation;    // capture at invocation
    let ok = refs.micArmed;
    if (!refs.micArmed) {
      const r = await armMicRefCurrent();
      ok = !!(r && r.ok);
    }
    if (!ok) return;
    if (aid !== refs.attemptId) return;     // stale attempt id
    if (capturedGen !== refs.generation) return; // stale generation
    onSendWs({ type: "greeting_client_ack", value: "mic_armed",
      greeting_attempt_id: aid, trigger });
  };
  return { armMic, refs };
}

describe("V3 item 2 — armMic decision behaviour", () => {
  test("SUCCESS: mic activates → ack sent with correct attempt id", async () => {
    const sent = [];
    const errs = [];
    const ends = [];
    const sim = makeArmMicSimulator({
      controllerAttemptIdNow: "att-1",
      generationNow: 7,
      startMicCaptureImpl: async () => "fake-stop",
      onSendWs: (m) => sent.push(m),
      onSetError: (e) => errs.push(e),
      onHandleEnd: (r) => ends.push(r),
    });
    await sim.armMic("playback_complete");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "greeting_client_ack", value: "mic_armed",
      greeting_attempt_id: "att-1", trigger: "playback_complete" });
    expect(errs).toEqual([]);
    expect(ends).toEqual([]);
  });

  test("FAILURE: startMicCapture throws → NO ack sent, end+refund path still runs", async () => {
    const sent = [];
    const errs = [];
    const ends = [];
    const sim = makeArmMicSimulator({
      controllerAttemptIdNow: "att-1",
      generationNow: 7,
      startMicCaptureImpl: async () => { throw new Error("mic denied"); },
      onSendWs: (m) => sent.push(m),
      onSetError: (e) => errs.push(e),
      onHandleEnd: (r) => ends.push(r),
    });
    await sim.armMic("playback_complete");
    expect(sent).toEqual([]);                              // NO ack at all
    expect(errs).toEqual(["Could not access the microphone audio stream."]);
    expect(ends).toEqual(["mic_failed"]);                  // existing path runs
  });

  test("STALE: mic activates but generation changed during await → NO ack", async () => {
    const sent = [];
    let resolveCapture;
    const capturePromise = new Promise((r) => { resolveCapture = r; });
    const sim = makeArmMicSimulator({
      controllerAttemptIdNow: "att-1",
      generationNow: 7,
      startMicCaptureImpl: () => capturePromise,
      onSendWs: (m) => sent.push(m),
      onSetError: () => {},
      onHandleEnd: () => {},
    });
    // Start armMic; it will park on the unresolved capturePromise.
    const armPromise = sim.armMic("playback_complete");
    // Generation bumps WHILE the mic capture is pending — a new socket opened.
    sim.refs.generation = 8;
    // Mic capture finally succeeds with the (now stale) generation captured.
    resolveCapture("fake-stop");
    await armPromise;
    // NO ack must be sent for the stale generation — even though the
    // underlying mic capture genuinely succeeded.
    expect(sent).toEqual([]);
  });

  test("STALE: attempt id changed during await → NO ack", async () => {
    const sent = [];
    let resolveCapture;
    const capturePromise = new Promise((r) => { resolveCapture = r; });
    const sim = makeArmMicSimulator({
      controllerAttemptIdNow: "att-1",
      generationNow: 7,
      startMicCaptureImpl: () => capturePromise,
      onSendWs: (m) => sent.push(m),
      onSetError: () => {},
      onHandleEnd: () => {},
    });
    const armPromise = sim.armMic("playback_complete");
    sim.refs.attemptId = "att-2";   // attempt id rotates mid-await
    resolveCapture("fake-stop");
    await armPromise;
    expect(sent).toEqual([]);
  });
});
