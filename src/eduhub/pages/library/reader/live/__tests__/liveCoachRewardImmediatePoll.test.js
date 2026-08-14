/**
 * liveCoachRewardImmediatePoll.test.js — Blocker C coverage.
 *
 * Tests that bounded polling is started IMMEDIATELY on every unresolved
 * state arriving via REST or WebSocket, so a confirmed grant is
 * discovered without requiring page reload or socket reconnect.
 *
 * The pure shared helpers are exercised directly; the actual
 * ``EduTalkLiveCoach.jsx`` component is asserted statically so the
 * production component IS the integration under test — not a
 * standalone helper or a divergent inline state machine. The static
 * assertions match the existing ``liveCoachRewardRecovery.test.js``
 * pattern used elsewhere in this repo.
 *
 * v7 update: REST and WebSocket claim-failure handling was refactored to
 * delegate inline state checks to the shared normalizers
 * ``normalizeAuthoritativeClaimOutcome`` and ``normalizeWsClaimFailedOutcome``
 * in ``liveCoachRewardPanelLogic``. Assertions now verify integration with
 * those normalizers rather than the v6 inline string literals they replaced.
 */
import fs from "fs";
import path from "path";
import {
  initialRewardState,
  applyRewardEvent,
  applyRecoveredOffer,
  isPollableRecoveredState,
  isTerminalRecoveredState,
  RECOVERY_POLL,
  nextPollDelayMs,
} from "../liveCoachRewardLogic";
import {
  normalizeAuthoritativeClaimOutcome,
  normalizeWsClaimFailedOutcome,
} from "../liveCoachRewardPanelLogic";

const SID = "sid-poll-1";
const COMPONENT = fs.readFileSync(
  path.join(__dirname, "..", "EduTalkLiveCoach.jsx"), "utf8");
const LOGIC = fs.readFileSync(
  path.join(__dirname, "..", "liveCoachRewardLogic.js"), "utf8");

describe("Immediate polling — REST pending/retryable/unknown (Blocker C)", () => {
  test("REST pending starts polling", () => {
    // v7: all unresolved REST states are handled by normalizeAuthoritativeClaimOutcome,
    // which maps pending_confirmation / pending / claim_reserved /
    // grant_dispatching → "claiming". The component uses the shared canonical
    // mapping instead of inline state-string comparisons.
    expect(COMPONENT).toContain("normalizeAuthoritativeClaimOutcome(data && data.state)");
    // A "claiming" outcome arms the bounded poll cycle immediately.
    expect(COMPONENT).toContain('armResilientPollCycle("pending_confirmation", offerId)');
    // Authoritative status is applied via statusFromRestClaimOutcome before
    // the coalesced refresh poke — stale claimability is never restored.
    expect(COMPONENT).toContain("statusFromRestClaimOutcome(");
    // The same-session status revision is incremented for every authoritative
    // REST outcome so a concurrent in-flight poll response cannot overwrite it.
    expect(COMPONENT).toMatch(/statusRevisionRef\.current \+= 1/);
    // One coalesced status refresh is queued after applying the outcome.
    expect(COMPONENT).toContain("statusPollControllerRef.current?.poke()");
    // Shared helper confirms all pending REST states normalise to "claiming".
    ["pending_confirmation", "pending", "claim_reserved",
     "grant_dispatching"].forEach((st) => {
      expect(normalizeAuthoritativeClaimOutcome(st)).toBe("claiming");
    });
    // isPollableRecoveredState still covers the legacy recovery-poll states.
    expect(isPollableRecoveredState("pending_confirmation")).toBe(true);
  });

  test("REST retryable starts polling", () => {
    // v7: retryable states normalise to "claiming" via the shared helper;
    // a "claiming" outcome triggers armResilientPollCycle.
    ["grant_retryable", "retryable"].forEach((st) => {
      expect(normalizeAuthoritativeClaimOutcome(st)).toBe("claiming");
    });
    expect(COMPONENT).toContain('armResilientPollCycle("pending_confirmation", offerId)');
    // Non-claiming authoritative outcomes (unavailable, disabled, expired,
    // terminal) do NOT arm polling — they dispatch claim_local_failed so the
    // spinner clears and the panel remains non-clickable.
    ["unavailable", "disabled", "expired", "terminal"].forEach((st) => {
      const outcome = normalizeAuthoritativeClaimOutcome(st);
      expect(outcome).not.toBeNull();
      expect(outcome).not.toBe("claiming");
    });
    expect(COMPONENT).toContain('kind: "claim_local_failed"');
  });

  test("REST unknown starts polling", () => {
    // v7: unknown states normalise to "claiming" via the shared helper.
    ["grant_unknown", "unknown"].forEach((st) => {
      expect(normalizeAuthoritativeClaimOutcome(st)).toBe("claiming");
    });
    expect(COMPONENT).toContain('armResilientPollCycle("pending_confirmation", offerId)');
    // Non-authoritative raw values (internal_error, network strings, null)
    // return null from the normaliser — the component falls through to the
    // ordinary retryable-failure path without fabricating a lifecycle state.
    expect(normalizeAuthoritativeClaimOutcome("internal_error")).toBeNull();
    expect(normalizeAuthoritativeClaimOutcome("network_error")).toBeNull();
    expect(normalizeAuthoritativeClaimOutcome(null)).toBeNull();
    // The ordinary fallback dispatches claim_local_failed with a user-visible reason.
    expect(COMPONENT).toContain('"Network error"');
    // The revision barrier (reconcileStatusRevision) prevents a concurrent stale
    // poll response from restoring claimability after an authoritative outcome.
    expect(COMPONENT).toContain("reconcileStatusRevision(");
  });
});

describe("Immediate polling — WebSocket pending/retryable/unknown (Blocker C)", () => {
  test("WebSocket pending starts polling", () => {
    // The WS handler dispatches the event AND starts the poll loop
    // for any reward_claim_pending message.
    expect(COMPONENT).toContain('case "reward_claim_pending":');
    // Schedule call is invoked from the same WS handler branch.
    const wsBlock = COMPONENT.split('case "reward_claim_pending":')[1];
    expect(wsBlock).toMatch(
      /armResilientPollCycle\(\s*"pending_confirmation", msg\.offer_id \|\| null\)/);
  });

  test("WebSocket retryable/unknown failure reasons start polling", () => {
    // v7: reward_claim_failed reason handling is delegated to the shared
    // normalizeWsClaimFailedOutcome. Retryable / unknown reasons map to
    // "claiming", which triggers armResilientPollCycle — the student is
    // never left stranded waiting for a provider response.
    expect(COMPONENT).toContain("normalizeWsClaimFailedOutcome(msg)");
    // The primary poll-arm check uses the canonical normaliser result.
    expect(COMPONENT).toContain('normalizeWsClaimFailedOutcome(msg) === "claiming"');
    // A "claiming" WS outcome arms the bounded poll cycle.
    expect(COMPONENT).toContain("armResilientPollCycle(");
    // The same-session revision is bumped for any authoritative WS outcome
    // before the coalesced status refresh, preventing stale overwrites.
    expect(COMPONENT).toMatch(
      /wsClaimOutcome[\s\S]{1,400}statusRevisionRef\.current \+= 1/);
    // Authoritative status is applied via statusFromWsClaimFailed.
    expect(COMPONENT).toContain("statusFromWsClaimFailed(");
    // Shared helper: retryable/unknown reasons → "claiming".
    ["claim_reserved", "grant_dispatching", "grant_retryable", "retryable",
     "grant_unknown", "unknown", "pending_confirmation", "pending"].forEach(
      (reason) => {
        expect(normalizeWsClaimFailedOutcome({
          type: "reward_claim_failed",
          offer_id: "test-offer",
          reason,
        })).toBe("claiming");
      });
    // Non-authoritative reasons return null (no spurious lifecycle state set).
    expect(normalizeWsClaimFailedOutcome({
      type: "reward_claim_failed",
      offer_id: "test-offer",
      reason: "internal_error",
    })).toBeNull();
    // All three WS reward event types are still handled in the same switch branch.
    expect(COMPONENT).toContain('case "reward_claim_pending":');
    expect(COMPONENT).toContain('case "reward_claim_failed":');
    expect(COMPONENT).toContain('case "reward_claim_confirmed":');
  });

  test("WS pending dispatch flows through shared reducer (not divergent)", () => {
    // The reducer call is the single source of truth.
    expect(COMPONENT).toContain('dispatchReward({ kind: "event", event: msg })');
  });
});

describe("Single bounded loop guarantees (Blocker C)", () => {
  test("only one poll request is active at a time", () => {
    // The component delegates to the SHARED production controller, which
    // owns the no-overlap (single in-flight request) invariant.
    expect(COMPONENT).toContain("createRewardPollController");
    expect(COMPONENT).toContain("rewardPollControllerRef");
    // and the controller aborts overlapping immediate requests.
    expect(LOGIC).toMatch(/requestImmediate[\s\S]*?if \(state\.inflight\) return/);
  });

  test("repeated pending events do not create duplicate loops", () => {
    // The controller's timer-starvation gate: a pending timer is the
    // single scheduled work — a duplicate hint never schedules another.
    expect(LOGIC).toMatch(/if \(state\.timer\) return false;/);
  });

  test("session change cancels old polling", () => {
    // cleanup() cancels the controller (clears timer + bounded budget).
    expect(COMPONENT).toContain("rewardPollControllerRef.current?.cancel()");
    expect(LOGIC).toMatch(/function cancel\(\)/);
  });

  test("unmount cancels polling", () => {
    // cleanup() is invoked from the unmount effect.
    expect(COMPONENT).toMatch(/useEffect\(\(\) => \(\) => cleanup\(\)/);
  });

  test("stale-session response is ignored", () => {
    // The recover function captures sid at request time and discards
    // stale responses after a session change.
    expect(COMPONENT).toContain("const sidAtRequest = s.session_id");
    expect(COMPONENT).toMatch(
      /sessionRef\.current\.session_id !== sidAtRequest/);
  });
});

describe("Terminal/expired states never reveal success (Blocker C)", () => {
  test("granted stops polling and reveals exactly once", () => {
    // Reveal once via shared reducer dedup.
    const granted = applyRewardEvent(
      initialRewardState,
      { type: "reward_claim_confirmed", offer_id: "g1", session_id: SID,
        reward_amount: 5 },
      SID);
    expect(granted.revealOpen).toBe(true);
    expect(granted.claimedOfferIds).toContain("g1");
    // A second granted event does not replay.
    const again = applyRewardEvent(
      { ...granted, revealOpen: false },
      { type: "reward_claim_confirmed", offer_id: "g1", session_id: SID },
      SID);
    expect(again.revealOpen).toBe(false);
    // And granted is not pollable.
    expect(isPollableRecoveredState("granted")).toBe(false);
    expect(isTerminalRecoveredState("granted")).toBe(true);
  });

  test("terminal stops polling and never reveals success", () => {
    const s = applyRecoveredOffer(
      initialRewardState,
      { offer_id: "t1", session_id: SID, state: "grant_terminal_failed" },
      SID);
    expect(s.revealOpen).toBe(false);
    expect(s.result).toBeNull();
    expect(isPollableRecoveredState("grant_terminal_failed")).toBe(false);
  });

  test("expired stops polling and never reveals success", () => {
    const s = applyRecoveredOffer(
      initialRewardState,
      { offer_id: "e1", session_id: SID, state: "expired" },
      SID);
    expect(s.revealOpen).toBe(false);
    expect(s.result).toBeNull();
    expect(isPollableRecoveredState("expired")).toBe(false);
  });
});

describe("Polling honesty (Blocker C)", () => {
  test("pending/retryable/unknown never reveal success via the reducer", () => {
    ["pending_confirmation", "grant_retryable", "grant_unknown"].forEach(
      (st) => {
        const s = applyRecoveredOffer(
          initialRewardState,
          { offer_id: "p1", session_id: SID, state: st },
          SID);
        expect(s.revealOpen).toBe(false);
        expect(s.result).toBeNull();
        expect(s.claiming).toBe(true);
      });
  });

  test("backoff is bounded and capped", () => {
    expect(nextPollDelayMs(99)).toBe(RECOVERY_POLL.maxDelayMs);
    expect(RECOVERY_POLL.maxAttempts).toBeGreaterThan(0);
  });

  test("component does NOT dispatch a local failure on still-confirming", () => {
    // Old broken behavior dispatched ``claim_local_failed`` with reason
    // "Still confirming — please wait." — this must NOT be present any
    // longer; the unresolved state is represented honestly via the
    // shared reducer's reward_claim_pending event.
    expect(COMPONENT).not.toContain('"Still confirming — please wait."');
  });

  test("polling does NOT create a new offer", () => {
    // Polling reuses the existing active-offer API (read-only) — not a
    // new offer creation route.
    expect(COMPONENT).toContain("getActiveRewardOffer");
    expect(COMPONENT).not.toContain("createRewardOffer");
  });
});
