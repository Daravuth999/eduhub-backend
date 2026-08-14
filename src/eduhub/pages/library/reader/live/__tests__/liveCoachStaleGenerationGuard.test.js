/**
 * liveCoachStaleGenerationGuard.test.js — V3 item 1 proof.
 *
 * Every onmessage case, ws.onerror, and ws.onclose must reject a frame/event
 * BEFORE any side effect when either:
 *   - the captured connection generation != greetingConnGenRef.current, OR
 *   - the emitting socket != wsRef.current.
 *
 * Both checks together are required — generation alone misses a
 * same-generation-but-replaced socket; socket identity alone misses a
 * generation bump on the same socket instance.
 *
 * V3 confirmed-broken locations (each previously performed a side effect
 * before checking staleness) — proven gated after fix:
 *   - case "ready"               (started the request watchdog)
 *   - case "coach_greeting_sent" (cleared the request watchdog)
 *   - case "requested" (nested)  (cleared & started watchdogs unconditionally)
 *   - case "failed"    (nested)  (cleared watchdogs unconditionally)
 *   - generic case "turn_complete" (cleared the legacy quarantine flag)
 *   - ws.onerror                 (set connection state to "reconnecting")
 *   - ws.onclose                 (called restEnd("ws_close"))
 *
 * V3 already-correct locations (controller's own stale guards): asserted to
 * REMAIN unchanged.
 *
 * This file uses the existing repo pattern of asserting the production
 * component (``EduTalkLiveCoach.jsx``) IS the integration under test via
 * source-level structural assertions (same pattern as
 * ``liveCoachRewardImmediatePoll.test.js`` /
 * ``liveCoachRewardRecovery.test.js`` already use here), combined with pure
 * controller behaviour assertions where applicable. No standalone helper
 * substitutes for the production code path.
 */
import fs from "fs";
import path from "path";
import {
  createGreetingController,
  GREETING_STATUS,
} from "../liveCoachGreetingState";

const COMPONENT = fs.readFileSync(
  path.join(__dirname, "..", "EduTalkLiveCoach.jsx"), "utf8");

describe("V3 item 1 — generation-safe socket integration", () => {
  // ────────────────────────────────────────────────────────────────────────
  // The combined guard exists and is used at every previously-broken case.
  // ────────────────────────────────────────────────────────────────────────
  test("onWsMessage takes the socket as a third argument", () => {
    // The handler signature is widened to receive the socket instance so
    // it can compare it against ``wsRef.current``.
    expect(COMPONENT).toMatch(
      /onWsMessage\s*=\s*useCallback\(\s*\(\s*ev\s*,\s*capturedGen\s*,\s*socket\s*\)\s*=>/);
    // ws.onmessage passes the actual socket instance to the handler.
    expect(COMPONENT).toMatch(
      /ws\.onmessage\s*=\s*\(ev\)\s*=>\s*onWsMessage\(ev,\s*capturedGen,\s*ws\)/);
  });

  test("combined isStale() guard checks both generation AND socket identity", () => {
    // The helper compares the captured ``gen`` against the live ref AND the
    // captured ``socket`` against ``wsRef.current``. Both checks together —
    // neither alone is sufficient.
    expect(COMPONENT).toMatch(
      /const\s+isStale\s*=\s*\(\)\s*=>\s*[\s\S]*?gen\s*!==\s*greetingConnGenRef\.current/);
    expect(COMPONENT).toMatch(
      /const\s+isStale\s*=\s*\(\)\s*=>\s*[\s\S]*?socket\s*!==\s*wsRef\.current/);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Each previously-broken location is now gated BEFORE any side effect.
  // ────────────────────────────────────────────────────────────────────────
  test('"ready" gates before starting the request watchdog', () => {
    // Pattern: case "ready": { ... if (isStale()) break; ... startWd("request"...
    const block = COMPONENT.match(
      /case\s+"ready":\s*\{[\s\S]*?break;\s*\}/);
    expect(block).not.toBeNull();
    const body = block[0];
    const stalePos = body.indexOf("isStale()");
    const sidePos = body.indexOf('startWd("request"');
    expect(stalePos).toBeGreaterThan(-1);
    expect(sidePos).toBeGreaterThan(-1);
    expect(stalePos).toBeLessThan(sidePos);   // guard BEFORE side effect
  });

  test('"coach_greeting_sent" gates before clearing the request watchdog', () => {
    const block = COMPONENT.match(
      /case\s+"coach_greeting_sent":\s*\{[\s\S]*?break;\s*\}/);
    expect(block).not.toBeNull();
    const body = block[0];
    const stalePos = body.indexOf("isStale()");
    const sidePos = body.indexOf('clearWd("request")');
    expect(stalePos).toBeGreaterThan(-1);
    expect(sidePos).toBeGreaterThan(-1);
    expect(stalePos).toBeLessThan(sidePos);
  });

  test('nested "requested" gates before clearWd/startWd and uses controller result', () => {
    // case "requested": { if (isStale()) break; const r = ctrl?.onServerRequested(...);
    //   if (r && (r.stale || r.ignored)) break; clearWd("request"); startWd("firstAudio"...
    const block = COMPONENT.match(
      /case\s+"requested":\s*\{[\s\S]*?break;\s*\}/);
    expect(block).not.toBeNull();
    const body = block[0];
    expect(body).toMatch(/if\s*\(\s*isStale\(\)\s*\)\s*break/);
    expect(body).toMatch(/const\s+r\s*=\s*ctrl\?\.onServerRequested\(/);
    expect(body).toMatch(/if\s*\(\s*r\s*&&\s*\(r\.stale\s*\|\|\s*r\.ignored\)\s*\)\s*break/);
    // Guards (stale + controller stale/ignored) appear BEFORE clearWd / startWd.
    const stalePos = body.indexOf("isStale()");
    const ctrlResPos = body.indexOf("r.stale");
    const clearPos = body.indexOf('clearWd("request")');
    const startPos = body.indexOf('startWd("firstAudio"');
    expect(stalePos).toBeLessThan(ctrlResPos);
    expect(ctrlResPos).toBeLessThan(clearPos);
    expect(clearPos).toBeLessThan(startPos);
  });

  test('nested "failed" gates before clearWd calls and uses controller result', () => {
    const block = COMPONENT.match(
      /case\s+"failed":\s*\{[\s\S]*?break;\s*\}/);
    expect(block).not.toBeNull();
    const body = block[0];
    expect(body).toMatch(/if\s*\(\s*isStale\(\)\s*\)\s*break/);
    expect(body).toMatch(/const\s+r\s*=\s*ctrl\?\.onFailed\(/);
    expect(body).toMatch(/if\s*\(\s*r\s*&&\s*\(r\.stale\s*\|\|\s*r\.ignored\)\s*\)\s*break/);
    const ctrlResPos = body.indexOf("r.stale");
    const clearReqPos = body.indexOf('clearWd("request")');
    const clearFaPos = body.indexOf('clearWd("firstAudio")');
    expect(ctrlResPos).toBeLessThan(clearReqPos);
    expect(ctrlResPos).toBeLessThan(clearFaPos);
  });

  test('generic top-level "turn_complete" gates before clearing the legacy quarantine flag', () => {
    // The non-greedy ``[\s\S]*?break;`` regex stops at the FIRST ``break;``
    // which is the early-return ``if (isStale()) break;`` itself — so we
    // locate the case by index instead and slice the surrounding block
    // explicitly. The generic top-level case is the only one that contains
    // both the legacy-quarantine clear AND the ``setOrbState("listening")``
    // call.
    const allMatches = [];
    const re = /case\s+"turn_complete":/g;
    let m;
    while ((m = re.exec(COMPONENT)) !== null) {
      // Slice ~1000 chars after each match — enough to cover the longest case.
      allMatches.push(COMPONENT.slice(m.index, m.index + 2000));
    }
    expect(allMatches.length).toBeGreaterThanOrEqual(2);
    const body = allMatches.find((slice) =>
      slice.includes("greetingLegacyQuarantineRef.current = false")
      && slice.includes('setOrbState("listening")'));
    expect(body).toBeDefined();
    expect(body).toMatch(/if\s*\(\s*isStale\(\)\s*\)\s*break/);
    const stalePos = body.indexOf("isStale()");
    const sidePos = body.indexOf("greetingLegacyQuarantineRef.current = false");
    expect(stalePos).toBeGreaterThan(-1);
    expect(sidePos).toBeGreaterThan(-1);
    expect(stalePos).toBeLessThan(sidePos);
  });

  test("ws.onerror checks socket identity before setConnection", () => {
    const block = COMPONENT.match(
      /ws\.onerror\s*=\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*;/);
    expect(block).not.toBeNull();
    const body = block[0];
    expect(body).toMatch(/if\s*\(\s*ws\s*!==\s*wsRef\.current\s*\)\s*return/);
    const guardPos = body.indexOf("ws !== wsRef.current");
    const sidePos = body.indexOf("setConnection");
    expect(guardPos).toBeGreaterThan(-1);
    expect(sidePos).toBeGreaterThan(-1);
    expect(guardPos).toBeLessThan(sidePos);
  });

  test("ws.onclose checks socket identity before restEnd", () => {
    const block = COMPONENT.match(
      /ws\.onclose\s*=\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*;/);
    expect(block).not.toBeNull();
    const body = block[0];
    expect(body).toMatch(/if\s*\(\s*ws\s*!==\s*wsRef\.current\s*\)\s*return/);
    const guardPos = body.indexOf("ws !== wsRef.current");
    const sidePos = body.indexOf('restEnd("ws_close")');
    expect(guardPos).toBeGreaterThan(-1);
    expect(sidePos).toBeGreaterThan(-1);
    expect(guardPos).toBeLessThan(sidePos);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Regression — the "already correctly gated" locations remain unchanged.
  // ────────────────────────────────────────────────────────────────────────
  test("nested 'first_audio' still checks (r && !r.stale && !r.ignored)", () => {
    const block = COMPONENT.match(
      /case\s+"first_audio":\s*\{[\s\S]*?break;\s*\}/);
    expect(block).not.toBeNull();
    expect(block[0]).toMatch(
      /if\s*\(\s*r\s*&&\s*!r\.stale\s*&&\s*!r\.ignored\s*\)/);
  });

  test("nested 'skipped' still breaks on r.stale before any side effect", () => {
    const block = COMPONENT.match(
      /case\s+"skipped":\s*\{[\s\S]*?break;\s*\}/);
    expect(block).not.toBeNull();
    const body = block[0];
    expect(body).toMatch(
      /if\s*\(\s*r\s*&&\s*r\.stale\s*\)\s*break/);
    const guardPos = body.indexOf("r.stale");
    const sidePos = body.indexOf("clearAllWd()");
    expect(guardPos).toBeLessThan(sidePos);
  });

  test("onTurnComplete helper still gates on (res.accepted && res.armDrainWait)", () => {
    expect(COMPONENT).toMatch(
      /if\s*\(\s*res\.accepted\s*&&\s*res\.armDrainWait\s*\)/);
  });

  test("onCancelledAck helper still gates on res.armMic", () => {
    // The helper body: ``if (res && res.armMic) armMic("controlled_fallback");``
    const onCancelledAckBlock = COMPONENT.match(
      /onCancelledAck\s*=\s*\([\s\S]*?\)\s*=>\s*\{[\s\S]*?\}\s*;/);
    expect(onCancelledAckBlock).not.toBeNull();
    expect(onCancelledAckBlock[0]).toMatch(
      /if\s*\(\s*res\s*&&\s*res\.armMic\s*\)/);
  });

  test("'audio' case still calls shouldSuppressGreetingAudio with both generations", () => {
    expect(COMPONENT).toMatch(/shouldSuppressGreetingAudio\(/);
    expect(COMPONENT).toMatch(/capturedConnectionGeneration:\s*gen/);
    expect(COMPONENT).toMatch(/activeConnectionGeneration:\s*ctrl\?\.getGeneration\?\.\(\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────── //
// Pure controller behaviour proof — frames carrying an old connection         //
// generation are returned as ``{ stale: true }`` and CANNOT change controller //
// state. This is the underlying contract the JSX guards lean on for the      //
// "delivered late from a stale generation has zero effect on current state"  //
// requirement. (Re-asserted independently here to avoid relying on the JSX   //
// guards alone.)                                                              //
// ─────────────────────────────────────────────────────────────────────────── //
describe("V3 item 1 — stale frames cannot mutate controller state", () => {
  function arm(c) {
    c.onConnectionOpen();
    return c.onConnectionOpen().connectionGeneration; // gen 2 active
  }

  test("stale ready → onServerRequested(stale) cannot change attempt id", () => {
    const c = createGreetingController();
    const gen = arm(c);
    const r = c.onServerRequested({
      attemptId: "att-stale", connectionGeneration: gen - 1 });
    expect(r.stale).toBe(true);
    expect(c.getAttemptId()).toBeNull();
    expect(c.getState().status).toBe(GREETING_STATUS.AWAITING_REQUEST);
  });

  test("stale coach_greeting_sent (legacy frame) cannot adopt attempt id", () => {
    const c = createGreetingController();
    const gen = arm(c);
    const r = c.onLegacyGreetingSent({
      attemptId: "legacy-stale", connectionGeneration: gen - 1 });
    expect(r.stale).toBe(true);
    expect(c.getAttemptId()).toBeNull();
  });

  test("stale failed cannot mark fallback or change attempt", () => {
    const c = createGreetingController();
    const gen = arm(c);
    const r = c.onFailed({
      attemptId: "att-x", reason: "x", connectionGeneration: gen - 1 });
    expect(r.stale).toBe(true);
    expect(c.getState().fallbackRequested).toBe(false);
    expect(c.getState().cancelled).toBe(false);
  });

  test("stale turn_complete cannot mark turnCompleteSeen", () => {
    const c = createGreetingController();
    const gen = arm(c);
    c.onServerRequested({ attemptId: "att-current", connectionGeneration: gen });
    const r = c.onTurnComplete({
      attemptId: "att-current", connectionGeneration: gen - 1 });
    expect(r.stale).toBe(true);
    expect(c.getState().turnCompleteSeen).toBe(false);
  });

  test("stale onCancelledAck cannot arm the mic", () => {
    const c = createGreetingController();
    const gen = arm(c);
    c.onServerRequested({ attemptId: "att-current", connectionGeneration: gen });
    const r = c.onCancelledAck({
      attemptId: "att-current", connectionGeneration: gen - 1 });
    expect(r.stale).toBe(true);
    expect(c.micIsArmed()).toBe(false);
  });
});
