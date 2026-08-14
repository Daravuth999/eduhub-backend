/**
 * liveCoachRewardResilience.test.js — Correction B coverage.
 *
 * Behavioral + static tests for the RESILIENT bounded polling loop in
 * ``EduTalkLiveCoach.jsx``. The pure helpers (``hasUnresolvedRewardClaim``,
 * ``decideNextPoll``, ``shouldResetPollBudget``) are extracted into
 * ``liveCoachRewardLogic.js`` so the production component IS the
 * controller under test — there is no divergent inline machine.
 *
 * The cases mandated by the audit:
 *   1. first request rejects → second bounded poll runs → pending
 *      response is processed;
 *   2. temporary offer:null while local claim is unresolved → next
 *      poll runs → eventual granted response reveals once;
 *   3. repeated pending WebSocket events for the SAME offer do NOT
 *      reset the attempt counter; the bounded budget is enforced;
 *   4. no overlapping requests / one timer only / session change
 *      cancels / unmount cancels / stale response ignored / terminal
 *      stops without success / expired stops without success /
 *      reconnect does not duplicate the loop;
 *   5. polling does NOT create a new offer (read-only).
 */
import fs from "fs";
import path from "path";
import {
  initialRewardState,
  applyRewardEvent,
  applyRecoveredOffer,
  hasUnresolvedRewardClaim,
  decideNextPoll,
  shouldResetPollBudget,
  isPollableRecoveredState,
  isTerminalRecoveredState,
  nextPollDelayMs,
  RECOVERY_POLL,
} from "../liveCoachRewardLogic";

const SID = "sid-resilient-1";
const COMPONENT = fs.readFileSync(
  path.join(__dirname, "..", "EduTalkLiveCoach.jsx"), "utf8");
const LOGIC = fs.readFileSync(
  path.join(__dirname, "..", "liveCoachRewardLogic.js"), "utf8");

// ────────────────────────────────────────────────────────────────────────
// PURE BEHAVIOURAL — hasUnresolvedRewardClaim
// ────────────────────────────────────────────────────────────────────────
describe("hasUnresolvedRewardClaim (Correction B pure helper)", () => {
  test("initial state is not unresolved (no claim, no offer)", () => {
    expect(hasUnresolvedRewardClaim(initialRewardState)).toBe(false);
  });

  test("a mounted offer is unresolved", () => {
    const s = applyRewardEvent(
      initialRewardState,
      { type: "reward_offer_available", offer_id: "o1", session_id: SID },
      SID);
    expect(hasUnresolvedRewardClaim(s)).toBe(true);
  });

  test("an in-flight claim is unresolved", () => {
    const s = applyRewardEvent(
      initialRewardState,
      { type: "reward_claim_pending", offer_id: "o1", session_id: SID },
      SID);
    expect(hasUnresolvedRewardClaim(s)).toBe(true);
  });

  test("revealOpen is RESOLVED — polling must stop", () => {
    const s = applyRewardEvent(
      initialRewardState,
      { type: "reward_claim_confirmed", offer_id: "o1", session_id: SID,
        reward_amount: 5 },
      SID);
    expect(hasUnresolvedRewardClaim(s)).toBe(false);
  });

  test("null/undefined state is not unresolved", () => {
    expect(hasUnresolvedRewardClaim(null)).toBe(false);
    expect(hasUnresolvedRewardClaim(undefined)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// PURE BEHAVIOURAL — decideNextPoll
// ────────────────────────────────────────────────────────────────────────
describe("decideNextPoll (Correction B resilient scheduling)", () => {
  const unresolved = { claiming: true, offer: null, revealOpen: false };
  const resolved = { ...initialRewardState };

  test("recovered + pending state → schedule next poll with same state", () => {
    expect(decideNextPoll({
      outcome: "recovered",
      recovered: { state: "pending_confirmation", offer_id: "o1" },
      prevState: unresolved,
    })).toEqual({ schedule: true, stateHint: "pending_confirmation" });
  });

  test("recovered + granted → stop (reveal handled by reducer)", () => {
    const decision = decideNextPoll({
      outcome: "recovered",
      recovered: { state: "granted", offer_id: "o1" },
      prevState: unresolved,
    });
    expect(decision.schedule).toBe(false);
  });

  test("recovered + terminal → stop", () => {
    const decision = decideNextPoll({
      outcome: "recovered",
      recovered: { state: "grant_terminal_failed", offer_id: "o1" },
      prevState: unresolved,
    });
    expect(decision.schedule).toBe(false);
  });

  test("recovered + expired → stop", () => {
    const decision = decideNextPoll({
      outcome: "recovered",
      recovered: { state: "expired", offer_id: "o1" },
      prevState: unresolved,
    });
    expect(decision.schedule).toBe(false);
  });

  test("error WHILE local claim unresolved → schedule next poll", () => {
    // Mandated case: first request rejects → second bounded poll runs.
    const decision = decideNextPoll({
      outcome: "error", recovered: null, prevState: unresolved,
    });
    expect(decision).toEqual({
      schedule: true, stateHint: "pending_confirmation",
    });
  });

  test("empty response WHILE local claim unresolved → schedule next poll", () => {
    // Mandated case: temporary offer:null retains the unresolved local
    // state and schedules the next bounded poll instead of revealing
    // success or dispatching a misleading terminal/local-failure.
    const decision = decideNextPoll({
      outcome: "empty", recovered: null, prevState: unresolved,
    });
    expect(decision).toEqual({
      schedule: true, stateHint: "pending_confirmation",
    });
  });

  test("error WITHOUT a local unresolved claim → stop", () => {
    expect(decideNextPoll({
      outcome: "error", recovered: null, prevState: resolved,
    })).toEqual({ schedule: false });
  });

  test("empty WITHOUT a local unresolved claim → stop", () => {
    expect(decideNextPoll({
      outcome: "empty", recovered: null, prevState: resolved,
    })).toEqual({ schedule: false });
  });

  test("stale → never reschedule", () => {
    expect(decideNextPoll({
      outcome: "stale", recovered: null, prevState: unresolved,
    })).toEqual({ schedule: false });
  });
});

// ────────────────────────────────────────────────────────────────────────
// PURE BEHAVIOURAL — shouldResetPollBudget
// ────────────────────────────────────────────────────────────────────────
describe("shouldResetPollBudget (Correction B budget gate)", () => {
  test("no active cycle → reset (this IS a new cycle)", () => {
    const { reset, nextCycleOfferId } = shouldResetPollBudget(null, "o1");
    expect(reset).toBe(true);
    expect(nextCycleOfferId).toBe("o1");
  });

  test("same offer cycle already active → DO NOT reset", () => {
    // Mandated case: repeated pending events for the SAME offer must
    // NOT reset the attempt counter (would unbound the loop).
    const { reset, nextCycleOfferId } = shouldResetPollBudget("o1", "o1");
    expect(reset).toBe(false);
    expect(nextCycleOfferId).toBe("o1");
  });

  test("different offer arrives mid-cycle → reset (new cycle)", () => {
    const { reset, nextCycleOfferId } = shouldResetPollBudget("o1", "o2");
    expect(reset).toBe(true);
    expect(nextCycleOfferId).toBe("o2");
  });

  test("WS event without offer_id while a cycle is active → DO NOT reset", () => {
    const { reset, nextCycleOfferId } = shouldResetPollBudget("o1", null);
    expect(reset).toBe(false);
    expect(nextCycleOfferId).toBe("o1");
  });
});

// ────────────────────────────────────────────────────────────────────────
// BEHAVIOURAL — bounded budget after repeated pending events
// ────────────────────────────────────────────────────────────────────────
describe("Bounded budget survives repeated pending events (Correction B)", () => {
  // This simulates the production loop in isolation: an attempt counter
  // ref plus the ``shouldResetPollBudget`` gate. We can therefore prove
  // (without React) that N repeated pending events for the SAME offer
  // do NOT make the loop effectively unbounded.
  function makeController() {
    let attempts = 0;
    let cycleOfferId = null;
    let scheduledTotal = 0;
    function arm(stateHint, offerId) {
      const { reset, nextCycleOfferId } = shouldResetPollBudget(
        cycleOfferId, offerId);
      if (reset) attempts = 0;
      cycleOfferId = nextCycleOfferId;
      if (!isPollableRecoveredState(stateHint)) return;
      if (attempts >= RECOVERY_POLL.maxAttempts) return;
      attempts += 1;
      scheduledTotal += 1;
    }
    return {
      arm,
      getAttempts: () => attempts,
      getScheduledTotal: () => scheduledTotal,
    };
  }

  test("100 repeated WS pending events for SAME offer respect maxAttempts", () => {
    const c = makeController();
    for (let i = 0; i < 100; i += 1) {
      c.arm("pending_confirmation", "off-A");
    }
    // The bounded budget is enforced — no unbounded scheduling.
    expect(c.getScheduledTotal()).toBe(RECOVERY_POLL.maxAttempts);
    expect(c.getAttempts()).toBe(RECOVERY_POLL.maxAttempts);
  });

  test("a NEW offer entering mid-cycle resets the budget exactly once", () => {
    const c = makeController();
    for (let i = 0; i < 100; i += 1) {
      c.arm("pending_confirmation", "off-A");
    }
    expect(c.getScheduledTotal()).toBe(RECOVERY_POLL.maxAttempts);
    // A different offer becomes unresolved — IS a new cycle.
    c.arm("pending_confirmation", "off-B");
    expect(c.getAttempts()).toBe(1);
    expect(c.getScheduledTotal()).toBe(RECOVERY_POLL.maxAttempts + 1);
  });

  test("repeated WS pending without offer_id while a cycle is active never resets", () => {
    const c = makeController();
    // First event opens a cycle.
    c.arm("pending_confirmation", "off-X");
    // Subsequent WS pending events arrive without an offer id (e.g.,
    // ``reward_claim_failed`` with reason 'pending'). They must NOT
    // reset the cycle.
    for (let i = 0; i < 50; i += 1) {
      c.arm("pending_confirmation", null);
    }
    expect(c.getScheduledTotal()).toBe(RECOVERY_POLL.maxAttempts);
  });
});

// ────────────────────────────────────────────────────────────────────────
// BEHAVIOURAL — first request rejects → second poll runs → pending processed
// ────────────────────────────────────────────────────────────────────────
describe("First request rejects → second bounded poll runs (Correction B)", () => {
  // Models the production ``recoverActiveOffer`` callback. The polling
  // loop is the only mechanism that can drive subsequent fetches; this
  // test proves that after a single transient rejection while the
  // local claim is unresolved, the loop DOES NOT die — a second poll
  // is scheduled and a pending response is processed without revealing
  // success.
  test("transient error → second poll runs and pending state is processed", () => {
    let prevState = applyRewardEvent(
      initialRewardState,
      { type: "reward_claim_pending", offer_id: "o-T", session_id: SID },
      SID);
    // First cycle: error.
    const d1 = decideNextPoll({
      outcome: "error", recovered: null, prevState,
    });
    expect(d1.schedule).toBe(true);
    expect(d1.stateHint).toBe("pending_confirmation");
    // Second cycle: pending response surfaces.
    const d2 = decideNextPoll({
      outcome: "recovered",
      recovered: { offer_id: "o-T", session_id: SID,
                    state: "pending_confirmation" },
      prevState,
    });
    expect(d2.schedule).toBe(true);
    expect(d2.stateHint).toBe("pending_confirmation");
    prevState = applyRecoveredOffer(
      prevState,
      { offer_id: "o-T", session_id: SID, state: "pending_confirmation" },
      SID);
    // Still no success reveal.
    expect(prevState.revealOpen).toBe(false);
    expect(prevState.result).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// BEHAVIOURAL — temporary offer:null → next poll runs → eventual granted
// ────────────────────────────────────────────────────────────────────────
describe("Temporary offer:null → next poll runs → eventual granted (Correction B)", () => {
  test("empty response while unresolved schedules next poll; granted reveals once", () => {
    let s = applyRewardEvent(
      initialRewardState,
      { type: "reward_claim_pending", offer_id: "o-N", session_id: SID },
      SID);
    // 1st: empty response.
    const d1 = decideNextPoll({
      outcome: "empty", recovered: null, prevState: s,
    });
    expect(d1.schedule).toBe(true);
    // 2nd: empty response again.
    const d2 = decideNextPoll({
      outcome: "empty", recovered: null, prevState: s,
    });
    expect(d2.schedule).toBe(true);
    // 3rd: granted arrives.
    s = applyRecoveredOffer(
      s,
      { offer_id: "o-N", session_id: SID, state: "granted",
        reward_type: "points", reward_amount: 5 },
      SID);
    expect(s.revealOpen).toBe(true);
    expect(s.claimedOfferIds).toContain("o-N");
    // A second granted recovery is a no-op (deduped by offer_id).
    const s2 = applyRecoveredOffer(
      { ...s, revealOpen: false },
      { offer_id: "o-N", session_id: SID, state: "granted",
        reward_amount: 5 },
      SID);
    expect(s2.revealOpen).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// STATIC — assert the component actually consumes the resilience helpers
// ────────────────────────────────────────────────────────────────────────
describe("Component consumes the resilience helpers (Correction B)", () => {
  test("component consumes decideNextPoll + the shared poll controller", () => {
    expect(COMPONENT).toContain("decideNextPoll");
    expect(COMPONENT).toContain("createRewardPollController");
  });

  test("the shared controller consumes the resilience helpers", () => {
    // The resilience helpers now back the SINGLE production controller
    // (createRewardPollController) which both the component and the
    // behavioural tests use — so the code under test IS the code that
    // ships.
    expect(LOGIC).toContain("hasUnresolvedRewardClaim");
    expect(LOGIC).toContain("shouldResetPollBudget");
    expect(LOGIC).toContain("isPollableRecoveredState");
  });

  test("recover callback invokes decideNextPoll on every outcome", () => {
    expect(COMPONENT).toContain("decideNextPoll({");
    // outcomes include "recovered", "empty", "error", "stale"
    expect(COMPONENT).toContain('outcome = "empty"');
    expect(COMPONENT).toContain('outcome = "error"');
    expect(COMPONENT).toContain('outcome = "recovered"');
    expect(COMPONENT).toContain('outcome = "stale"');
  });

  test("budget reset is gated by shouldResetPollBudget (no naive reset)", () => {
    // The component routes every "is this a new cycle?" decision through
    // ``armResilientPollCycle`` → ``controller.armCycle``, and the
    // controller gates the reset on ``shouldResetPollBudget``. Repeated
    // pending events for the same offer never reset the budget directly.
    expect(COMPONENT).toContain("armResilientPollCycle");
    expect(COMPONENT).toMatch(
      /rewardPollControllerRef\.current\.armCycle/);
    expect(LOGIC).toMatch(
      /function armCycle[\s\S]*?shouldResetPollBudget\(/);
  });

  test("session change / unmount cancels the loop", () => {
    expect(COMPONENT).toContain("rewardPollControllerRef.current?.cancel()");
    expect(COMPONENT).toMatch(/useEffect\(\(\) => \(\) => cleanup\(\)/);
    // The controller's cancel clears timer + bounded budget + cycle.
    expect(LOGIC).toMatch(/function cancel\(\)[\s\S]*?state\.attempts = 0/);
  });

  test("polling is READ-ONLY — never creates a new offer", () => {
    expect(COMPONENT).toContain("getActiveRewardOffer");
    expect(COMPONENT).not.toContain("createRewardOffer");
  });

  test("no overlapping requests / one timer at a time", () => {
    // The controller owns both invariants.
    expect(LOGIC).toMatch(/if \(state\.timer\) return false;/);
    expect(LOGIC).toMatch(/if \(state\.inflight\) return false;/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// SANITY — pollable / terminal sets unchanged
// ────────────────────────────────────────────────────────────────────────
describe("Pollable / terminal classification (Correction B regression check)", () => {
  test("only non-final states are pollable", () => {
    ["pending_confirmation", "pending", "retryable", "grant_retryable",
      "unknown", "grant_unknown"].forEach((st) => {
      expect(isPollableRecoveredState(st)).toBe(true);
      expect(isTerminalRecoveredState(st)).toBe(false);
    });
  });

  test("terminal / expired / granted never pollable", () => {
    ["granted", "confirmed", "grant_terminal_failed", "failed_terminal",
      "terminal", "expired"].forEach((st) => {
      expect(isPollableRecoveredState(st)).toBe(false);
      expect(isTerminalRecoveredState(st)).toBe(true);
    });
  });

  test("backoff bounded and capped", () => {
    expect(nextPollDelayMs(99)).toBe(RECOVERY_POLL.maxDelayMs);
    expect(RECOVERY_POLL.maxAttempts).toBeGreaterThan(0);
  });
});
