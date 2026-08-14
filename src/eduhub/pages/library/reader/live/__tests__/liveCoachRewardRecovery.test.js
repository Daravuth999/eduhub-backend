/**
 * liveCoachRewardRecovery.test.js — Blocker E coverage for active-offer
 * recovery + bounded polling. Exercises the PURE shared helpers that the
 * real ``EduTalkLiveCoach.jsx`` component consumes (no divergent inline
 * machine, no second test framework, no RTL). Also statically asserts the
 * actual component imports and uses the shared recovery helper.
 */
import fs from "fs";
import path from "path";
import {
  initialRewardState,
  applyRecoveredOffer,
  isPollableRecoveredState,
  isTerminalRecoveredState,
  nextPollDelayMs,
  RECOVERY_POLL,
} from "../liveCoachRewardLogic";

const SID = "sid-recover-1";

describe("liveCoachReward recovery (Blocker E)", () => {
  test("granted recovery reveals exactly once (deduped by offer_id)", () => {
    const s1 = applyRecoveredOffer(
      initialRewardState,
      {
        offer_id: "rwd_g1", session_id: SID, state: "granted",
        reward_type: "points", reward_amount: 5,
        reward_summary: "5 EduHub Points", confirmed_message: "Nice!",
      },
      SID,
    );
    expect(s1.revealOpen).toBe(true);
    expect(s1.result.reward_amount).toBe(5);
    expect(s1.claimedOfferIds).toContain("rwd_g1");
    // A second recovery of the same granted offer must NOT replay reveal.
    const s2 = applyRecoveredOffer(
      { ...s1, revealOpen: false },
      { offer_id: "rwd_g1", session_id: SID, state: "granted",
        reward_amount: 5 },
      SID,
    );
    expect(s2.revealOpen).toBe(false);
  });

  test("claimable recovery mounts the claim button", () => {
    const s = applyRecoveredOffer(
      initialRewardState,
      { offer_id: "rwd_c1", session_id: SID, state: "claimable",
        button_label: "Open surprise", pre_claim_message: "Ready!" },
      SID,
    );
    expect(s.offer).not.toBeNull();
    expect(s.offer.offer_id).toBe("rwd_c1");
    expect(s.revealOpen).toBe(false);
  });

  test("pending recovery never reveals success (keeps waiting)", () => {
    const s = applyRecoveredOffer(
      initialRewardState,
      { offer_id: "rwd_p1", session_id: SID, state: "pending_confirmation" },
      SID,
    );
    expect(s.revealOpen).toBe(false);
    expect(s.result).toBeNull();
    expect(s.claiming).toBe(true);
  });

  test("unknown recovery never reveals success", () => {
    const s = applyRecoveredOffer(
      initialRewardState,
      { offer_id: "rwd_u1", session_id: SID, state: "grant_unknown" },
      SID,
    );
    expect(s.revealOpen).toBe(false);
    expect(s.result).toBeNull();
  });

  test("terminal recovery never reveals success", () => {
    const s = applyRecoveredOffer(
      initialRewardState,
      { offer_id: "rwd_t1", session_id: SID, state: "grant_terminal_failed" },
      SID,
    );
    expect(s.revealOpen).toBe(false);
    expect(s.result).toBeNull();
    expect(s.claiming).toBe(false);
  });

  test("stale/foreign session recovery is rejected", () => {
    const granted = {
      offer_id: "rwd_x", session_id: "other-sid", state: "granted",
      reward_amount: 5,
    };
    expect(applyRecoveredOffer(initialRewardState, granted, SID))
      .toBe(initialRewardState);
    const missing = { offer_id: "rwd_y", state: "granted", reward_amount: 5 };
    expect(applyRecoveredOffer(initialRewardState, missing, SID))
      .toBe(initialRewardState);
  });

  test("null/garbage recovery is a no-op", () => {
    expect(applyRecoveredOffer(initialRewardState, null, SID))
      .toBe(initialRewardState);
    expect(applyRecoveredOffer(initialRewardState, 42, SID))
      .toBe(initialRewardState);
  });

  test("only non-final states are pollable", () => {
    ["pending_confirmation", "pending", "retryable", "grant_retryable",
      "unknown", "grant_unknown"].forEach((st) => {
      expect(isPollableRecoveredState(st)).toBe(true);
      expect(isTerminalRecoveredState(st)).toBe(false);
    });
    ["granted", "confirmed", "grant_terminal_failed", "failed_terminal",
      "terminal", "expired"].forEach((st) => {
      expect(isPollableRecoveredState(st)).toBe(false);
      expect(isTerminalRecoveredState(st)).toBe(true);
    });
  });

  test("bounded polling backoff is monotonic and capped", () => {
    let prev = 0;
    for (let i = 0; i < RECOVERY_POLL.maxAttempts; i += 1) {
      const d = nextPollDelayMs(i);
      expect(d).toBeGreaterThanOrEqual(prev);
      expect(d).toBeLessThanOrEqual(RECOVERY_POLL.maxDelayMs);
      prev = d;
    }
    // far-out attempts stay capped, never unbounded
    expect(nextPollDelayMs(99)).toBe(RECOVERY_POLL.maxDelayMs);
    expect(RECOVERY_POLL.maxAttempts).toBeGreaterThan(0);
  });

  test("actual component imports and USES the shared recovery helper", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "EduTalkLiveCoach.jsx"), "utf8");
    const logic = fs.readFileSync(
      path.join(__dirname, "..", "liveCoachRewardLogic.js"), "utf8");
    // It must consume the shared helpers (no divergent inline machine).
    expect(src).toContain("applyRecoveredOffer");
    expect(src).toContain("getActiveRewardOffer");
    // Bounded-poll scheduling is owned by the SHARED production controller,
    // which the component instantiates directly; the controller consumes
    // the pollable-state + backoff helpers.
    expect(src).toContain("createRewardPollController");
    expect(logic).toContain("isPollableRecoveredState");
    expect(logic).toContain("nextPollDelayMs");
    // and dispatch recovery through the reducer
    expect(src).toContain('kind: "recovered"');
  });
});
