/**
 * liveCoachRewardPolling.test.js — Correction 2 (final) coverage.
 *
 * Behavioural tests for the bounded-poll controller's timer-starvation
 * gate. CRITICAL: these tests drive the ACTUAL production controller
 * (``createRewardPollController`` exported from ``liveCoachRewardLogic.js``)
 * — the very same factory the ``EduTalkLiveCoach.jsx`` component uses — with
 * an injected fake clock. There is no separately reconstructed imitation of
 * the gate: the code under test IS the code that ships.
 *
 * Mandated behaviours:
 *   * seven rapid same-offer pending events leave EXACTLY one timer and
 *     consume ZERO attempts before execution;
 *   * a request that rejects still lets the next bounded request run;
 *   * a temporary offer:null result retries within the bounded budget;
 *   * an eventual granted result stops polling and reveals once;
 *   * requests never overlap (one in-flight request maximum);
 *   * repeated reconnects for the SAME session do not reset the budget;
 *   * the maximum attempt budget remains bounded;
 *   * a session change and an unmount cancel the loop;
 *   * terminal and expired never reveal success.
 */
import fs from "fs";
import path from "path";
import {
  createRewardPollController,
  createAnnounceRetryController,
  classifyAnnounceAck,
  announceRetryDelayMs,
  ANNOUNCE_RETRY,
  decideNextPoll,
  applyRecoveredOffer,
  isPollableRecoveredState,
  isTerminalRecoveredState,
  nextPollDelayMs,
  RECOVERY_POLL,
  initialRewardState,
} from "../liveCoachRewardLogic";

const COMPONENT = fs.readFileSync(
  path.join(__dirname, "..", "EduTalkLiveCoach.jsx"), "utf8");
const API = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "..", "..", "lib", "edutalkLiveApi.js"),
  "utf8");

// ────────────────────────────────────────────────────────────────────────
// Fake clock that the REAL controller schedules against.
// ────────────────────────────────────────────────────────────────────────
function makeFakeClock() {
  let nowMs = 0;
  let seq = 1;
  const timers = new Map(); // id -> { cb, at }
  return {
    now: () => nowMs,
    setTimer: (cb, delay) => {
      const id = seq++;
      timers.set(id, { cb, at: nowMs + delay });
      return id;
    },
    clearTimer: (id) => { timers.delete(id); },
    advance: (ms) => {
      const target = nowMs + ms;
      let guard = 0;
      // Fire due timers in chronological order up to `target`.
      while (true) {
        let next = null;
        for (const [id, t] of timers.entries()) {
          if (t.at <= target && (next === null || t.at < next.at)) {
            next = { id, ...t };
          }
        }
        if (!next) break;
        nowMs = next.at;
        timers.delete(next.id);
        next.cb();
        if (++guard > 100000) throw new Error("runaway timer loop");
      }
      nowMs = target;
    },
    pending: () => timers.size,
  };
}

function makeRealController() {
  const clock = makeFakeClock();
  const executed = [];
  const ctrl = createRewardPollController({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    // Models one recovery request firing. The caller (a test) decides the
    // outcome by calling ctrl.settle(decision) afterwards, exactly like the
    // production recoverActiveOffer.
    execute: () => { executed.push(clock.now()); },
  });
  return { clock, ctrl, executed };
}

// ────────────────────────────────────────────────────────────────────────
// 1. Timer-starvation gate against the REAL controller.
// ────────────────────────────────────────────────────────────────────────
describe("Real controller — timer-starvation gate (Correction 2)", () => {
  test("7 rapid same-offer pending events: 1 timer, 0 attempts consumed", () => {
    const { clock, ctrl, executed } = makeRealController();
    for (let i = 0; i < 7; i += 1) {
      ctrl.armCycle("pending_confirmation", "off-A");
    }
    expect(clock.pending()).toBe(1);
    expect(ctrl.getAttempts()).toBe(0);
    expect(executed.length).toBe(0);
  });

  test("attempt consumed only when the timer executes (not on events)", () => {
    const { clock, ctrl, executed } = makeRealController();
    ctrl.armCycle("pending_confirmation", "off-A");
    ctrl.armCycle("pending_confirmation", "off-A");
    ctrl.armCycle("pending_confirmation", "off-A");
    expect(ctrl.getAttempts()).toBe(0);
    clock.advance(nextPollDelayMs(0) + 1);
    expect(executed.length).toBe(1);
    expect(ctrl.getAttempts()).toBe(1);
  });

  test("first request rejects → next bounded request runs", () => {
    const { clock, ctrl, executed } = makeRealController();
    ctrl.armCycle("pending_confirmation", "off-A");
    clock.advance(nextPollDelayMs(0) + 1);
    expect(executed.length).toBe(1);
    // The request "rejected": decideNextPoll for a transient error while a
    // claim is unresolved schedules the next bounded poll.
    ctrl.settle(decideNextPoll({
      outcome: "error", recovered: null,
      prevState: { claiming: true, offer: null, revealOpen: false },
    }));
    clock.advance(nextPollDelayMs(1) + 1);
    expect(executed.length).toBe(2);
    expect(ctrl.getAttempts()).toBe(2);
  });

  test("temporary offer:null retries within the bounded budget", () => {
    const { clock, ctrl, executed } = makeRealController();
    const unresolved = { claiming: true, offer: null, revealOpen: false };
    ctrl.armCycle("pending_confirmation", "off-A");
    clock.advance(nextPollDelayMs(0) + 1);
    ctrl.settle(decideNextPoll({
      outcome: "empty", recovered: null, prevState: unresolved }));
    clock.advance(nextPollDelayMs(1) + 1);
    expect(executed.length).toBe(2);
  });

  test("eventual granted stops polling (no further timers)", () => {
    const { clock, ctrl, executed } = makeRealController();
    const unresolved = { claiming: true, offer: null, revealOpen: false };
    ctrl.armCycle("pending_confirmation", "off-A");
    clock.advance(nextPollDelayMs(0) + 1);
    ctrl.settle(decideNextPoll({
      outcome: "empty", recovered: null, prevState: unresolved }));
    clock.advance(nextPollDelayMs(1) + 1);
    expect(executed.length).toBe(2);
    // granted discovered → decideNextPoll returns schedule:false.
    ctrl.endCycle();
    ctrl.settle(decideNextPoll({
      outcome: "recovered",
      recovered: { state: "granted", offer_id: "off-A" },
      prevState: unresolved,
    }));
    expect(clock.pending()).toBe(0);
    clock.advance(60000);
    expect(executed.length).toBe(2); // no further executions
  });

  test("requests never overlap (single in-flight maximum)", () => {
    const { clock, ctrl, executed } = makeRealController();
    ctrl.armCycle("pending_confirmation", "off-A");
    clock.advance(nextPollDelayMs(0) + 1);
    expect(executed.length).toBe(1);
    // The request is now in-flight (settle not yet called). Any arming /
    // scheduling must be a no-op — no second timer, no overlap.
    expect(ctrl.isInflight()).toBe(true);
    ctrl.armCycle("pending_confirmation", "off-A");
    ctrl.scheduleNext("pending_confirmation");
    expect(clock.pending()).toBe(0);
    clock.advance(60000);
    expect(executed.length).toBe(1);
  });

  test("repeated reconnects for the SAME session do not reset the budget", () => {
    const { clock, ctrl } = makeRealController();
    const unresolved = { claiming: true, offer: null, revealOpen: false };
    ctrl.onSessionOpen("sess-1");
    ctrl.armCycle("pending_confirmation", "off-A");
    clock.advance(nextPollDelayMs(0) + 1);
    ctrl.settle(decideNextPoll({
      outcome: "empty", recovered: null, prevState: unresolved }));
    clock.advance(nextPollDelayMs(1) + 1);
    expect(ctrl.getAttempts()).toBe(2);
    // Three identical reconnects for the SAME session — budget preserved.
    ctrl.onSessionOpen("sess-1");
    ctrl.onSessionOpen("sess-1");
    ctrl.onSessionOpen("sess-1");
    expect(ctrl.getAttempts()).toBe(2);
    // A genuinely new session resets.
    ctrl.onSessionOpen("sess-2");
    expect(ctrl.getAttempts()).toBe(0);
  });

  test("maximum attempt budget remains bounded", () => {
    const { clock, ctrl, executed } = makeRealController();
    const unresolved = { claiming: true, offer: null, revealOpen: false };
    ctrl.armCycle("pending_confirmation", "off-A");
    for (let i = 0; i < 1000; i += 1) {
      clock.advance(RECOVERY_POLL.maxDelayMs + 1);
      // Always try to keep polling — the controller must cap it.
      ctrl.settle({ schedule: true, stateHint: "pending_confirmation" });
      // Hammer with duplicate events too.
      ctrl.armCycle("pending_confirmation", "off-A");
    }
    expect(executed.length).toBeLessThanOrEqual(RECOVERY_POLL.maxAttempts);
    expect(ctrl.getAttempts()).toBeLessThanOrEqual(RECOVERY_POLL.maxAttempts);
  });

  test("session change cancels the loop", () => {
    const { clock, ctrl } = makeRealController();
    ctrl.armCycle("pending_confirmation", "off-A");
    expect(clock.pending()).toBe(1);
    ctrl.cancel(); // session change / unmount
    expect(clock.pending()).toBe(0);
    expect(ctrl.getAttempts()).toBe(0);
    expect(ctrl.isInflight()).toBe(false);
  });

  test("unmount cancels the loop (no execution after cancel)", () => {
    const { clock, ctrl, executed } = makeRealController();
    ctrl.armCycle("pending_confirmation", "off-A");
    ctrl.cancel();
    clock.advance(60000);
    expect(executed.length).toBe(0);
  });

  test("terminal and expired never (re)arm and never reveal success", () => {
    const { ctrl } = makeRealController();
    // Non-pollable hints never schedule.
    expect(ctrl.scheduleNext("granted")).toBe(false);
    expect(ctrl.scheduleNext("grant_terminal_failed")).toBe(false);
    expect(ctrl.scheduleNext("expired")).toBe(false);
    expect(isPollableRecoveredState("granted")).toBe(false);
    expect(isTerminalRecoveredState("expired")).toBe(true);
    // The reveal reducer never opens success for terminal/expired.
    const t = applyRecoveredOffer(
      initialRewardState,
      { offer_id: "t1", session_id: "S", state: "grant_terminal_failed" },
      "S");
    expect(t.revealOpen).toBe(false);
    const e = applyRecoveredOffer(
      initialRewardState,
      { offer_id: "e1", session_id: "S", state: "expired" }, "S");
    expect(e.revealOpen).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 2. Granted reveals exactly once (reducer dedupe).
// ────────────────────────────────────────────────────────────────────────
describe("Granted reveals exactly once (Correction 2)", () => {
  test("granted reveals once; repeated granted recovery is a no-op", () => {
    let s = applyRecoveredOffer(
      initialRewardState,
      { offer_id: "g1", session_id: "S", state: "granted",
        reward_type: "points", reward_amount: 5 }, "S");
    expect(s.revealOpen).toBe(true);
    expect(s.claimedOfferIds).toContain("g1");
    const again = applyRecoveredOffer(
      { ...s, revealOpen: false },
      { offer_id: "g1", session_id: "S", state: "granted",
        reward_amount: 5 }, "S");
    expect(again.revealOpen).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 3. Static — the component uses the SAME production controller (not a
//    reconstructed imitation), and arms/cancels through it.
// ────────────────────────────────────────────────────────────────────────
describe("Component uses the production controller directly (Correction 2)", () => {
  test("component imports and instantiates createRewardPollController", () => {
    expect(COMPONENT).toContain("createRewardPollController");
    expect(COMPONENT).toContain("rewardPollControllerRef.current = createRewardPollController");
  });
  test("component arms cycles through controller.armCycle", () => {
    expect(COMPONENT).toMatch(/rewardPollControllerRef\.current\.armCycle/);
  });
  test("component resets session budget through controller.onSessionOpen", () => {
    expect(COMPONENT).toMatch(/rewardPollControllerRef\.current\.onSessionOpen/);
  });
  test("component cancels the controller on cleanup", () => {
    expect(COMPONENT).toContain("rewardPollControllerRef.current?.cancel()");
  });
  test("controller settle drives the next bounded poll", () => {
    expect(COMPONENT).toMatch(/ctrl\.settle\(decision\)/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 4. Correction 1 — delayed-confirmed congratulations is delivered over the
//    LIVE WebSocket (not the removed REST→in-memory-context endpoint), and
//    the offer is marked locally complete ONLY on a delivered / already
//    delivered ack.
// ────────────────────────────────────────────────────────────────────────
describe("Delayed-confirmed announcement uses the live WebSocket (Correction 1)", () => {
  test("component sends an announce_confirmed_reward WS command", () => {
    expect(COMPONENT).toContain('type: "announce_confirmed_reward"');
  });
  test("only granted/confirmed states trigger the announce command", () => {
    expect(COMPONENT).toMatch(
      /recState === "granted"\s*\|\|\s*recState === "confirmed"/);
  });
  test("the offer is NOT marked announced before delivery is proven", () => {
    // The send must NOT be preceded by an add to the dedupe set inside the
    // same granted branch (the bug being fixed). The add happens ONLY in
    // the reward_announce_ack handler.
    const grantedBranch = COMPONENT.split('type: "announce_confirmed_reward"')[0]
      .split('recState === "granted"').pop();
    expect(grantedBranch).not.toContain("rewardConfirmedAnnouncedRef.current.add");
  });
  test("ack marks the offer complete only on delivered / already_delivered", () => {
    expect(COMPONENT).toContain('case "reward_announce_ack":');
    expect(COMPONENT).toMatch(
      /msg\.delivered \|\| msg\.already_delivered/);
    expect(COMPONENT).toContain("rewardConfirmedAnnouncedRef.current.add(msg.offer_id)");
  });
  test("the fragile REST announce endpoint has been removed", () => {
    expect(COMPONENT).not.toContain("announceConfirmedRecovered");
    expect(API).not.toContain("announceConfirmedRecovered");
    expect(API).not.toContain("/api/edutalk/coach-rewards/announce-confirmed");
  });
});

// ────────────────────────────────────────────────────────────────────────
// 5. Correction B — bounded ANNOUNCEMENT-DELIVERY retry controller.
//    Drives the ACTUAL production helper (createAnnounceRetryController),
//    the same factory the component instantiates. Separate from the wallet
//    poll controller; never touches the wallet.
// ────────────────────────────────────────────────────────────────────────
function makeAnnController(opts) {
  const clock = makeFakeClock();
  const sends = [];
  let socketOpen = (opts && opts.socketOpen !== undefined) ? opts.socketOpen : true;
  const ctrl = createAnnounceRetryController({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    send: (offerId, sessionId) => { if (socketOpen) sends.push({ offerId, sessionId }); },
    maxAttempts: opts && opts.maxAttempts,
  });
  return { clock, ctrl, sends, setSocket: (v) => { socketOpen = v; } };
}

describe("classifyAnnounceAck (Correction B)", () => {
  test("delivered / already_delivered => delivered", () => {
    expect(classifyAnnounceAck({ delivered: true })).toBe("delivered");
    expect(classifyAnnounceAck({ already_delivered: true })).toBe("delivered");
  });
  test("retryable reasons / flag / null => retry", () => {
    for (const r of ["in_progress", "inject_failed", "no_live_session", "socket_unavailable", "stale"]) {
      expect(classifyAnnounceAck({ delivered: false, reason: r })).toBe("retry");
    }
    expect(classifyAnnounceAck({ retryable: true, reason: "x" })).toBe("retry");
    expect(classifyAnnounceAck(null)).toBe("retry");
  });
  test("permanent rejections => stop", () => {
    for (const r of ["wrong_owner", "wrong_session", "not_granted", "no_offer"]) {
      expect(classifyAnnounceAck({ delivered: false, reason: r })).toBe("stop");
    }
  });
  test("backoff bounded", () => {
    expect(announceRetryDelayMs(0)).toBe(ANNOUNCE_RETRY.baseDelayMs);
    expect(announceRetryDelayMs(99)).toBeLessThanOrEqual(ANNOUNCE_RETRY.maxDelayMs);
  });
});

describe("announcement retry controller (Correction B)", () => {
  test("1. granted reward sends one announcement", () => {
    const { ctrl, sends, clock } = makeAnnController();
    ctrl.start("o1", "s1");
    expect(sends).toEqual([{ offerId: "o1", sessionId: "s1" }]);
    expect(ctrl.getAttempts()).toBe(1);
    expect(clock.pending()).toBe(1);
  });
  test("2. inject_failed schedules a bounded retry", () => {
    const { ctrl, sends, clock } = makeAnnController();
    ctrl.start("o1", "s1");
    expect(ctrl.onAck({ offer_id: "o1", delivered: false, reason: "inject_failed" })).toBe("retry");
    clock.advance(announceRetryDelayMs(1) + 1);
    expect(sends.length).toBe(2);
  });
  test("3. in_progress schedules a later retry", () => {
    const { ctrl, sends, clock } = makeAnnController();
    ctrl.start("o1", "s1");
    expect(ctrl.onAck({ offer_id: "o1", reason: "in_progress" })).toBe("retry");
    expect(sends.length).toBe(1);
    clock.advance(announceRetryDelayMs(1) + 1);
    expect(sends.length).toBe(2);
  });
  test("4. closed socket remains retryable after reconnect", () => {
    const h = makeAnnController({ socketOpen: false });
    h.ctrl.start("o1", "s1");
    expect(h.sends.length).toBe(0);
    expect(h.ctrl.isDone()).toBe(false);
    h.setSocket(true);
    h.ctrl.requestImmediate();
    expect(h.sends.length).toBe(1);
    expect(h.ctrl.onAck({ offer_id: "o1", delivered: true })).toBe("delivered");
    expect(h.ctrl.isDone()).toBe(true);
  });
  test("5. eventual delivered stops retries", () => {
    const { ctrl, sends, clock } = makeAnnController();
    ctrl.start("o1", "s1");
    ctrl.onAck({ offer_id: "o1", reason: "in_progress" });
    clock.advance(announceRetryDelayMs(1) + 1);
    expect(ctrl.onAck({ offer_id: "o1", delivered: true })).toBe("delivered");
    const n = sends.length;
    clock.advance(60000);
    expect(sends.length).toBe(n);
    expect(ctrl.getOutcome()).toBe("delivered");
  });
  test("6. true already_delivered stops retries", () => {
    const { ctrl, sends, clock } = makeAnnController();
    ctrl.start("o1", "s1");
    expect(ctrl.onAck({ offer_id: "o1", already_delivered: true })).toBe("delivered");
    const n = sends.length;
    clock.advance(60000);
    expect(sends.length).toBe(n);
  });
  test("7. repeated granted does not reset the budget", () => {
    const { ctrl, clock } = makeAnnController();
    ctrl.start("o1", "s1");
    ctrl.onAck({ offer_id: "o1", reason: "in_progress" });
    clock.advance(announceRetryDelayMs(1) + 1);
    expect(ctrl.getAttempts()).toBe(2);
    ctrl.start("o1", "s1"); ctrl.start("o1", "s1");
    expect(ctrl.getAttempts()).toBe(2);
    ctrl.start("o2", "s1");
    expect(ctrl.getAttempts()).toBe(1);
  });
  test("8. one timer / one in-flight maximum", () => {
    const { ctrl, sends, clock } = makeAnnController();
    ctrl.start("o1", "s1");
    expect(ctrl.isInflight()).toBe(true);
    ctrl.start("o1", "s1"); ctrl.start("o1", "s1");
    expect(clock.pending()).toBe(1);
    expect(sends.length).toBe(1);
  });
  test("9. cancel stops retries (session change / unmount)", () => {
    const { ctrl, sends, clock } = makeAnnController();
    ctrl.start("o1", "s1");
    ctrl.cancel();
    expect(ctrl.isDone()).toBe(true);
    expect(clock.pending()).toBe(0);
    clock.advance(60000);
    expect(sends.length).toBe(1);
    expect(ctrl.getOutcome()).toBe("cancelled");
  });
  test("10. permanent rejection stops without success", () => {
    const { ctrl, sends, clock } = makeAnnController();
    ctrl.start("o1", "s1");
    expect(ctrl.onAck({ offer_id: "o1", reason: "wrong_session" })).toBe("rejected");
    expect(ctrl.isDone()).toBe(true);
    clock.advance(60000);
    expect(sends.length).toBe(1);
  });
  test("11. visual reveal remains once (independent of retries)", () => {
    let s = applyRecoveredOffer(initialRewardState,
      { offer_id: "o1", session_id: "s1", state: "granted", reward_amount: 5 }, "s1");
    expect(s.revealOpen).toBe(true);
    const again = applyRecoveredOffer({ ...s, revealOpen: false },
      { offer_id: "o1", session_id: "s1", state: "granted", reward_amount: 5 }, "s1");
    expect(again.revealOpen).toBe(false);
  });
  test("12. controller never sends anything but the announcement", () => {
    const { ctrl, sends, clock } = makeAnnController();
    ctrl.start("o1", "s1");
    for (let i = 0; i < 20; i++) {
      ctrl.onAck({ offer_id: "o1", reason: "in_progress" });
      clock.advance(announceRetryDelayMs(99) + 1);
    }
    sends.forEach((x) => expect(x).toEqual({ offerId: "o1", sessionId: "s1" }));
    expect(ctrl.getAttempts()).toBeLessThanOrEqual(ANNOUNCE_RETRY.maxAttempts);
  });
  test("attempt budget bounded and exhausts", () => {
    const { ctrl, sends, clock } = makeAnnController({ maxAttempts: 3 });
    ctrl.start("o1", "s1");
    for (let i = 0; i < 10; i++) {
      ctrl.onAck({ offer_id: "o1", reason: "inject_failed" });
      clock.advance(announceRetryDelayMs(99) + 1);
    }
    expect(sends.length).toBeLessThanOrEqual(3);
    expect(ctrl.getOutcome()).toBe("exhausted");
  });
  test("stale acks for a different offer are ignored", () => {
    const { ctrl } = makeAnnController();
    ctrl.start("o1", "s1");
    expect(ctrl.onAck({ offer_id: "OTHER", delivered: true })).not.toBe("delivered");
    expect(ctrl.isDone()).toBe(false);
  });
});

describe("Component wires the announcement-retry controller (Correction B)", () => {
  test("component instantiates createAnnounceRetryController", () => {
    expect(COMPONENT).toContain("createAnnounceRetryController");
    expect(COMPONENT).toContain("announceRetryControllerRef.current = createAnnounceRetryController");
  });
  test("granted branch arms the controller (not a one-shot send)", () => {
    expect(COMPONENT).toMatch(/announceRetryControllerRef\.current\.start\(recOfferId, sidAtRequest\)/);
  });
  test("ack handler feeds the controller; completion gated on durable evidence", () => {
    expect(COMPONENT).toContain("announceRetryControllerRef.current.onAck(msg)");
    expect(COMPONENT).toMatch(/msg\.delivered \|\| msg\.already_delivered/);
  });
  test("reconnect resumes and cleanup cancels", () => {
    expect(COMPONENT).toContain("announceRetryControllerRef.current.requestImmediate()");
    expect(COMPONENT).toContain("announceRetryControllerRef.current?.cancel()");
  });
});
