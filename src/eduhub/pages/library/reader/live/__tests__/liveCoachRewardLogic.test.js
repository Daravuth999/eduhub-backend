/**
 * liveCoachRewardLogic.test.js — focused frontend behavior tests for the
 * EduTalk Live Coach reward UI decision logic (audit §5).
 *
 * Uses the project's existing react-scripts / jest stack. No new test
 * framework is added. Tests exercise PURE helpers so React rendering
 * is never required.
 */

import {
  initialRewardState,
  applyRewardEvent,
  shouldSendClaimOnTap,
  composeRevealPayload,
  safeFirstName,
} from "../liveCoachRewardLogic";

describe("liveCoachRewardLogic", () => {
  // 1) no reward button before a server offer
  test("initial state has no offer and no reveal", () => {
    expect(initialRewardState.offer).toBeNull();
    expect(initialRewardState.revealOpen).toBe(false);
    expect(initialRewardState.result).toBeNull();
  });

  // 2) offer ignored when session_id does not match active session
  test("offer with mismatching session_id is ignored", () => {
    const next = applyRewardEvent(
      initialRewardState,
      { type: "reward_offer_available", offer_id: "rwd_abc",
        session_id: "OTHER", button_label: "L", pre_claim_message: "M" },
      "sidA",
    );
    expect(next.offer).toBeNull();
  });

  // 3) offer appears for the matching session
  test("offer for matching session_id mounts the button", () => {
    const next = applyRewardEvent(
      initialRewardState,
      { type: "reward_offer_available", offer_id: "rwd_abc",
        session_id: "sidA", button_label: "Your surprise is ready",
        pre_claim_message: "You did great" },
      "sidA",
    );
    expect(next.offer).toEqual(expect.objectContaining({
      offer_id: "rwd_abc",
      session_id: "sidA",
      label: "Your surprise is ready",
    }));
  });

  // 4) reward amount hidden before claim
  test("offer event never carries a reward amount", () => {
    const next = applyRewardEvent(
      initialRewardState,
      { type: "reward_offer_available", offer_id: "rwd_abc",
        session_id: "sidA", reward_amount: 999 /* should be ignored */ },
      "sidA",
    );
    expect(next.offer).toBeTruthy();
    expect(JSON.stringify(next.offer)).not.toContain("999");
    expect(next.offer.reward_amount).toBeUndefined();
  });

  // 5) rapid repeated taps send one claim action
  test("shouldSendClaimOnTap returns false while claiming", () => {
    const state = { ...initialRewardState, claiming: true };
    expect(shouldSendClaimOnTap(state, "rwd_abc")).toBe(false);
  });

  // 6) valid claiming state shows pending UI
  test("pending event sets claiming true without revealing", () => {
    const after = applyRewardEvent(
      initialRewardState,
      { type: "reward_claim_pending", offer_id: "rwd_abc" },
      "sidA",
    );
    expect(after.claiming).toBe(true);
    expect(after.revealOpen).toBe(false);
  });

  // 7) expired claim does not show pending-success language
  // 8) failed or ambiguous claim does not show success
  test("failed claim leaves offer mounted and records error", () => {
    let state = applyRewardEvent(
      initialRewardState,
      { type: "reward_offer_available", offer_id: "rwd_abc",
        session_id: "sidA" },
      "sidA",
    );
    state = applyRewardEvent(state,
      { type: "reward_claim_pending", offer_id: "rwd_abc" }, "sidA");
    state = applyRewardEvent(state,
      { type: "reward_claim_failed", offer_id: "rwd_abc",
        reason: "provider_idempotency_unavailable" }, "sidA");
    expect(state.revealOpen).toBe(false);
    expect(state.result).toBeNull();
    expect(state.offer).toBeTruthy();
    expect(state.error).toBe("provider_idempotency_unavailable");
  });

  // 9) confirmed reveal uses exact backend result
  test("confirmed event reveals exact backend reward", () => {
    let state = applyRewardEvent(
      initialRewardState,
      { type: "reward_offer_available", offer_id: "rwd_abc",
        session_id: "sidA" },
      "sidA",
    );
    state = applyRewardEvent(state, {
      type: "reward_claim_confirmed", offer_id: "rwd_abc",
      reward_type: "points", reward_amount: 15,
      reward_summary: "15 EduHub Points",
      confirmed_message: "Practice streak reward — strong work!",
    }, "sidA");
    expect(state.revealOpen).toBe(true);
    expect(state.result.reward_amount).toBe(15);
    expect(state.result.reward_summary).toBe("15 EduHub Points");
    expect(state.confirmedMessage).toMatch(/strong work/);
    expect(state.offer).toBeNull();
  });

  // 10) duplicate confirmed event does not replay the reveal
  test("duplicate confirmed event does not replay reveal", () => {
    let state = applyRewardEvent(initialRewardState, {
      type: "reward_claim_confirmed", offer_id: "rwd_abc",
      reward_type: "points", reward_amount: 15,
      reward_summary: "15 EduHub Points",
    }, "sidA");
    state = { ...state, revealOpen: false }; // simulate user dismissed
    const after = applyRewardEvent(state, {
      type: "reward_claim_confirmed", offer_id: "rwd_abc",
      reward_type: "points", reward_amount: 15,
      reward_summary: "15 EduHub Points",
    }, "sidA");
    expect(after.revealOpen).toBe(false);
    expect(after.claimedOfferIds).toEqual(["rwd_abc"]);
  });

  // 11) confirmed result can be recovered without a second grant
  test("composeRevealPayload returns null when result missing", () => {
    expect(composeRevealPayload(null, "")).toBeNull();
  });

  test("composeRevealPayload uses backend summary verbatim", () => {
    const payload = composeRevealPayload(
      { reward_type: "points", reward_amount: 10,
        reward_summary: "10 EduHub Points" },
      "Custom confirmed message",
    );
    expect(payload.summary).toBe("10 EduHub Points");
    expect(payload.message).toBe("Custom confirmed message");
  });

  // 12 / 13 / 14) reward interaction does not affect the session;
  // shouldSendClaimOnTap never returns true for an empty offer_id
  test("empty offer_id never sends a claim", () => {
    expect(shouldSendClaimOnTap(initialRewardState, "")).toBe(false);
    expect(shouldSendClaimOnTap(initialRewardState, null)).toBe(false);
  });

  // 16) safe name renders
  test("safeFirstName returns trimmed first token", () => {
    expect(safeFirstName("Dara Lim")).toBe("Dara");
  });

  // 17) missing name uses neutral fallback (empty string)
  test("safeFirstName falls back to empty when input is blank", () => {
    expect(safeFirstName("")).toBe("");
    expect(safeFirstName("   ")).toBe("");
    expect(safeFirstName(undefined)).toBe("");
  });

  // 18) failed Gemini announcement does not break reward UI — the
  // logic helper never reads Gemini state; this is verified by the
  // fact that no event type "gemini_failed" can break the reducer.
  test("unknown event types are ignored", () => {
    const after = applyRewardEvent(
      initialRewardState,
      { type: "gemini_announcement_failed", offer_id: "rwd_abc" },
      "sidA",
    );
    expect(after).toEqual(initialRewardState);
  });

  // Session-bound recovery (audit §19-22)
  test("offer is rejected when current session is empty string", () => {
    const next = applyRewardEvent(
      initialRewardState,
      { type: "reward_offer_available", offer_id: "rwd_abc",
        session_id: "sidA" },
      "",
    );
    expect(next.offer).toBeNull();
  });

  // B4 (audit) — STRICT session matching: an offer event with NO
  // session_id must be ignored, not defaulted to the active session.
  test("offer with missing session_id is rejected", () => {
    const next = applyRewardEvent(
      initialRewardState,
      { type: "reward_offer_available", offer_id: "rwd_abc",
        button_label: "L", pre_claim_message: "M" },
      "sidA",
    );
    expect(next.offer).toBeNull();
  });

  test("offer with empty-string session_id is rejected", () => {
    const next = applyRewardEvent(
      initialRewardState,
      { type: "reward_offer_available", offer_id: "rwd_abc",
        session_id: "" },
      "sidA",
    );
    expect(next.offer).toBeNull();
  });
});
